/**
 * الملف: shared/idempotency.js
 * وش يفعل: يمنع تنفيذ نفس الدفعة مرتين باستخدام مفتاح فريد لكل عملية
 * يستدعيه: payments/send.js، transfer/agentToAgent.js، transfer/external.js
 * يستدعي: shared/db.js — يقرأ ويكتب في جدول idempotency_keys
 * يحدّث DB: نعم — جدول idempotency_keys
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: هو نفسه
 * rollback: لا — المفتاح يبقى حتى بعد الـ rollback (دليل على إن الدفعة صارت)
 * لو عدّلته يتأثر: payments/send.js، transfer/agentToAgent.js، transfer/external.js
 */

import supabase from './db.js'
import { DuplicateTransactionError } from './errors.js'

// ── مدة صلاحية الـ key: 24 ساعة ──────────────────────────────────────────
// بعدها يُعتبر الـ key منتهياً ويمكن إعادة استخدامه (حالة نادرة جداً)
const KEY_TTL_HOURS = 24

// ══════════════════════════════════════════════════════════════════════════════
// checkAndReserve — الخطوة الأولى قبل كل دفعة
// ══════════════════════════════════════════════════════════════════════════════

/**
 * يتحقق من الـ key — لو موجود يطلع DuplicateTransactionError
 * لو غير موجود يحجزه بحالة 'pending' ويكمل
 *
 * @param {string} idempotencyKey - مفتاح فريد يرسله الـ client مع كل دفعة
 * @param {string} agentId        - الـ agent اللي ينفّذ الدفعة
 * @throws {DuplicateTransactionError} لو الـ key مكرر
 */
export async function checkAndReserve(idempotencyKey, agentId) {
  // ── ١. نبحث عن الـ key في DB ───────────────────────────────────────────
  const { data: existing, error: fetchError } = await supabase
    .from('idempotency_keys')
    .select('status, result')
    .eq('key', idempotencyKey)
    .eq('agent_id', agentId)
    .maybeSingle() // يرجع null لو ما وجد، بدون error

  if (fetchError) {
    throw new Error(`[shared/idempotency.js] فشل البحث عن الـ key: ${fetchError.message}`)
  }

  // ── ٢. لو الـ key موجود — نرفض الطلب ─────────────────────────────────
  if (existing) {
    throw new DuplicateTransactionError(idempotencyKey)
  }

  // ── ٣. لو الـ key جديد — نحجزه بحالة 'pending' ────────────────────────
  // نسجّله قبل تنفيذ الدفعة — لو المشروع وقع في المنتصف، الـ key محجوز
  const expiresAt = new Date(Date.now() + KEY_TTL_HOURS * 60 * 60 * 1000).toISOString()

  const { error: insertError } = await supabase
    .from('idempotency_keys')
    .insert({
      key:        idempotencyKey,
      agent_id:   agentId,
      status:     'pending',
      result:     null,
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
    })

  if (insertError) {
    // لو صار race condition وكُتب الـ key من طلب ثانٍ في نفس اللحظة
    if (insertError.code === '23505') { // unique violation
      throw new DuplicateTransactionError(idempotencyKey)
    }
    throw new Error(`[shared/idempotency.js] فشل حجز الـ key: ${insertError.message}`)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// markComplete — الخطوة الأخيرة بعد اكتمال الدفعة
// ══════════════════════════════════════════════════════════════════════════════

/**
 * يحدّث حالة الـ key لـ 'completed' ويحفظ نتيجة الدفعة
 * يُستدعى بعد نجاح الدفعة مباشرة
 *
 * @param {string} idempotencyKey - نفس الـ key اللي حُجز في checkAndReserve
 * @param {string} agentId        - نفس الـ agentId
 * @param {object} result         - نتيجة الدفعة (txHash, amount, status...)
 */
export async function markComplete(idempotencyKey, agentId, result = {}) {
  const { error } = await supabase
    .from('idempotency_keys')
    .update({
      status:       'completed',
      result:       result,
      completed_at: new Date().toISOString(),
    })
    .eq('key', idempotencyKey)
    .eq('agent_id', agentId)

  if (error) {
    // الدفعة نجحت لكن التحديث فشل — نسجّل تحذير بدون ما نوقف شيء
    // الـ key يبقى 'pending' وينتهي صلاحيته بعد 24 ساعة
    console.warn(`[shared/idempotency.js] تحذير: فشل تحديث الـ key بعد الاكتمال — ${error.message}`)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// markFailed — لو الدفعة فشلت — يحرر الـ key للمحاولة مرة ثانية
// ══════════════════════════════════════════════════════════════════════════════

/**
 * يحذف الـ key لو فشلت الدفعة — يتيح للـ client إعادة المحاولة بنفس الـ key
 * ⚠️ استخدم هذا فقط لو الدفعة فشلت قبل الإرسال للـ blockchain
 * لو وصلت للـ blockchain وفشلت — لا تحذف الـ key
 *
 * @param {string} idempotencyKey
 * @param {string} agentId
 */
export async function markFailed(idempotencyKey, agentId) {
  const { error } = await supabase
    .from('idempotency_keys')
    .delete()
    .eq('key', idempotencyKey)
    .eq('agent_id', agentId)
    .eq('status', 'pending') // نحذف فقط لو لسا pending — ما نحذف completed أبداً

  if (error) {
    console.warn(`[shared/idempotency.js] تحذير: فشل حذف الـ key الفاشل — ${error.message}`)
  }
}

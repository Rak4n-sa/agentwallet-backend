/**
 * الملف: notifications/rollback.js
 * وش يفعل: يرسل إشعار للمطور عند بدء عملية rollback
 * يستدعيه: events/onRollbackInitiated.js
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم — جدول notification_logs
 * يطلق Supabase event: لا
 * يسمع Supabase event: نعم — onRollbackInitiated
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: dashboard/overview.js
 */

import supabase                 from '../shared/db.js'
import logger                   from '../shared/logger.js'
import { ExternalServiceError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// notifyRollback — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} rollbackId
 * @returns {{ sent: boolean }}
 */
export async function notifyRollback(rollbackId) {
  const source = 'notifications/rollback.js'

  // ── ١. جلب بيانات الـ rollback ───────────────────────────────────────
  const { data: rollback, error: rollbackError } = await supabase
    .from('rollbacks')
    .select('id, wallet_id, developer_id, amount, reason')
    .eq('id', rollbackId)
    .single()

  if (rollbackError) {
    throw new ExternalServiceError('Supabase', rollbackError.message)
  }
  if (!rollback) {
    logger.warn(source, 'rollback غير موجود', { rollbackId })
    return { sent: false }
  }

  // ── ٢. جلب اسم المحفظة ───────────────────────────────────────────────
  const { data: wallet } = await supabase
    .from('wallets')
    .select('name')
    .eq('id', rollback.wallet_id)
    .single()

  // ── ٣. بناء الإشعار ───────────────────────────────────────────────────
  const message = `بدأت عملية إرجاع بمبلغ ${rollback.amount} USDC من محفظة "${wallet?.name ?? rollback.wallet_id}" — السبب: ${rollback.reason}`

  // ── ٤. تسجيل الإشعار في notification_logs ────────────────────────────
  const { error: logError } = await supabase
    .from('notification_logs')
    .insert({
      developer_id: rollback.developer_id,
      wallet_id:    rollback.wallet_id,
      type:         'rollback_initiated',
      message,
      metadata:     { rollback_id: rollbackId, amount: rollback.amount, reason: rollback.reason },
    })

  if (logError) {
    logger.warn(source, 'فشل تسجيل إشعار الـ rollback', { rollbackId, error: logError.message })
    return { sent: false }
  }

  logger.info(source, 'إشعار rollback مُسجَّل', { rollbackId, developerId: rollback.developer_id })

  return { sent: true }
}

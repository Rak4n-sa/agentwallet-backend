/**
 * الملف: rollback/execute.js
 * وش يفعل: ينفّذ عملية الإرجاع — يُعيد المبلغ للمحفظة ويحدّث حالة الـ rollback
 * يستدعيه: events/onRollbackInitiated.js
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم — جدول rollbacks + جدول wallets
 * يطلق Supabase event: لا
 * يسمع Supabase event: نعم — onRollbackInitiated
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: rollback/log.js، dashboard/overview.js
 */

import supabase                              from '../shared/db.js'
import logger                                from '../shared/logger.js'
import { NotFoundError, ExternalServiceError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// executeRollback — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} rollbackId
 * @returns {{ rollback_id: string, refunded_amount: number, status: string }}
 */
export async function executeRollback(rollbackId) {
  const source = 'rollback/execute.js'

  // ── ١. جلب الـ rollback ───────────────────────────────────────────────
  const { data: rollback, error: fetchError } = await supabase
    .from('rollbacks')
    .select('id, wallet_id, developer_id, amount, status, attempts, max_attempts')
    .eq('id', rollbackId)
    .single()

  if (fetchError) {
    throw new ExternalServiceError('Supabase', fetchError.message)
  }
  if (!rollback) {
    throw new NotFoundError('rollback')
  }

  // ── ٢. التحقق إن الـ rollback لسا pending ────────────────────────────
  if (rollback.status !== 'pending') {
    logger.warn(source, 'rollback مش pending — تم تجاهله', { rollbackId, status: rollback.status })
    return { rollback_id: rollbackId, refunded_amount: 0, status: rollback.status }
  }

  // ── ٣. جلب الرصيد الحالي للمحفظة ─────────────────────────────────────
  const { data: wallet, error: walletError } = await supabase
    .from('wallets')
    .select('balance')
    .eq('id', rollback.wallet_id)
    .single()

  if (walletError) {
    throw new ExternalServiceError('Supabase', walletError.message)
  }
  if (!wallet) {
    throw new NotFoundError('محفظة')
  }

  try {
    // ── ٤. تحديث الـ rollback لـ completed أولاً ───────────────────────
    const { error: rollbackUpdateError } = await supabase
      .from('rollbacks')
      .update({
        status:       'completed',
        completed_at: new Date().toISOString(),
        attempts:     rollback.attempts + 1,
      })
      .eq('id', rollbackId)
      .eq('status', 'pending')  // فقط لو لا يزال pending

    if (rollbackUpdateError) {
      throw new ExternalServiceError('Supabase', rollbackUpdateError.message)
    }

    // ── ٥. إعادة المبلغ للمحفظة ────────────────────────────────────────
    const newBalance = Math.round((wallet.balance + rollback.amount) * 1_000_000) / 1_000_000

    const { error: balanceError } = await supabase
      .from('wallets')
      .update({ balance: newBalance })
      .eq('id', rollback.wallet_id)

    if (balanceError) {
      throw new ExternalServiceError('Supabase', balanceError.message)
    }

  } catch (err) {
    // نجلب الـ attempts الحالي من DB — لأن خطوة ٤ ربما حدّثته بالفعل
    const { data: currentRollback } = await supabase
      .from('rollbacks')
      .select('attempts')
      .eq('id', rollbackId)
      .single()

    const newAttempts = (currentRollback?.attempts ?? rollback.attempts) + 1
    const newStatus   = newAttempts >= rollback.max_attempts ? 'failed' : 'pending'

    await supabase
      .from('rollbacks')
      .update({
        status:       newStatus,
        attempts:     newAttempts,
        completed_at: null,
      })
      .eq('id', rollbackId)

    if (newStatus === 'failed') {
      await logger.audit('rollback/execute.js', 'rollback.failed', {
        walletId:  rollback.wallet_id,
        actorId:   rollback.developer_id,
        metadata:  { rollback_id: rollbackId, attempts: newAttempts },
        status:    'failed',
      })
    }

    throw err
  }

  // ── ٦. audit log ──────────────────────────────────────────────────────
  await logger.audit(source, 'rollback.executed', {
    walletId:  rollback.wallet_id,
    actorId:   rollback.developer_id,
    metadata:  { rollback_id: rollbackId, refunded_amount: rollback.amount },
    status:    'success',
  })

  return {
    rollback_id:     rollbackId,
    refunded_amount: rollback.amount,
    status:          'completed',
  }
}

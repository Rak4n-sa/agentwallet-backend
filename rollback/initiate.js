/**
 * الملف: rollback/initiate.js
 * وش يفعل: يبدأ عملية إرجاع transaction — يسجّل في DB → Supabase يطلق onRollbackInitiated
 * يستدعيه: HTTP POST /rollback/initiate
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم — جدول rollbacks + جدول transactions
 * يطلق Supabase event: نعم — onRollbackInitiated
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: هو نفسه
 * لو عدّلته يتأثر: rollback/execute.js، rollback/log.js، events/onRollbackInitiated.js
 */

import supabase                                              from '../shared/db.js'
import logger                                                from '../shared/logger.js'
import {
  ValidationError,
  NotFoundError,
  ExternalServiceError,
  formatError,
} from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// initiateRollback — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} developerId
 * @param {object} input
 * @param {string} input.transaction_id  - الـ transaction المراد إرجاعها
 * @param {string} input.reason          - سبب الإرجاع
 * @returns {{ rollback_id: string, transaction_id: string, status: string }}
 */
export async function initiateRollback(developerId, input) {
  const source = 'rollback/initiate.js'
  const { transaction_id, reason } = input

  // ── ١. التحقق من البيانات ──────────────────────────────────────────────
  if (!transaction_id || typeof transaction_id !== 'string') {
    throw new ValidationError('transaction_id مطلوب')
  }
  if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
    throw new ValidationError('reason مطلوب (٣ أحرف على الأقل)')
  }

  // ── ٢. جلب الـ transaction والتحقق من الملكية ─────────────────────────
  const { data: transaction, error: fetchError } = await supabase
    .from('transactions')
    .select('id, wallet_id, amount, status, type')
    .eq('id', transaction_id)
    .eq('developer_id', developerId)
    .single()

  if (fetchError) {
    throw new ExternalServiceError('Supabase', fetchError.message)
  }
  if (!transaction) {
    throw new NotFoundError('transaction')
  }

  // ── ٣. التحقق إن الـ transaction قابلة للإرجاع ────────────────────────
  if (transaction.status !== 'confirmed') {
    throw new ValidationError(`لا يمكن إرجاع transaction بحالة ${transaction.status}`)
  }
  if (transaction.type === 'rollback') {
    throw new ValidationError('لا يمكن إرجاع عملية rollback')
  }

  // ── ٤. إنشاء سجل rollback في DB → Supabase يطلق onRollbackInitiated ──
  const { data: rollback, error: rollbackError } = await supabase
    .from('rollbacks')
    .insert({
      transaction_id,
      wallet_id:    transaction.wallet_id,
      developer_id: developerId,
      amount:       transaction.amount,
      reason:       reason.trim(),
      status:       'pending',
    })
    .select('id')
    .single()

  if (rollbackError) {
    throw new ExternalServiceError('Supabase', rollbackError.message)
  }

  // ── ٥. تحديث الـ transaction لـ rolled_back ───────────────────────────
  const { error: updateError } = await supabase
    .from('transactions')
    .update({ status: 'rolled_back' })
    .eq('id', transaction_id)

  if (updateError) {
    throw new ExternalServiceError('Supabase', updateError.message)
  }

  // ── ٦. audit log ──────────────────────────────────────────────────────
  await logger.audit(source, 'rollback.initiated', {
    walletId:  transaction.wallet_id,
    actorId:   developerId,
    metadata:  { rollback_id: rollback.id, transaction_id, reason },
    status:    'success',
  })

  return {
    rollback_id:    rollback.id,
    transaction_id,
    status:         'pending',
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /rollback/initiate
 * Body: { transaction_id, reason }
 * يحتاج: auth middleware يضيف req.user
 */
export async function initiateRollbackHandler(req, res) {
  try {
    const result = await initiateRollback(req.user.id, req.body)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

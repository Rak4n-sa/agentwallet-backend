/**
 * الملف: notifications/receive.js
 * وش يفعل: يرسل إشعار للمطور عند تأكيد استلام دفعة
 * يستدعيه: events/onTransactionConfirmed.js
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم — جدول notification_logs
 * يطلق Supabase event: لا
 * يسمع Supabase event: نعم — onTransactionConfirmed
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: dashboard/overview.js
 */

import supabase             from '../shared/db.js'
import logger               from '../shared/logger.js'
import { ExternalServiceError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// notifyReceived — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} transactionId
 * @returns {{ sent: boolean }}
 */
export async function notifyReceived(transactionId) {
  const source = 'notifications/receive.js'

  // ── ١. جلب الـ transaction ────────────────────────────────────────────
  const { data: transaction, error: txError } = await supabase
    .from('transactions')
    .select('id, wallet_id, developer_id, type, amount, currency, confirmed_at')
    .eq('id', transactionId)
    .single()

  if (txError) {
    throw new ExternalServiceError('Supabase', txError.message)
  }
  if (!transaction) {
    logger.warn(source, 'transaction غير موجودة', { transactionId })
    return { sent: false }
  }

  // ── ٢. جلب اسم المحفظة ───────────────────────────────────────────────
  const { data: wallet } = await supabase
    .from('wallets')
    .select('name')
    .eq('id', transaction.wallet_id)
    .single()

  // ── ٣. بناء الإشعار ───────────────────────────────────────────────────
  const message = `استلمت ${transaction.amount} ${transaction.currency} في محفظة "${wallet?.name ?? transaction.wallet_id}"`

  // ── ٤. تسجيل الإشعار في notification_logs ────────────────────────────
  const { error: logError } = await supabase
    .from('notification_logs')
    .insert({
      developer_id:   transaction.developer_id,
      wallet_id:      transaction.wallet_id,
      transaction_id: transactionId,
      type:           'payment_received',
      message,
      metadata: {
        amount:   transaction.amount,
        currency: transaction.currency,
        type:     transaction.type,
      },
    })

  if (logError) {
    logger.warn(source, 'فشل تسجيل الإشعار', { transactionId, error: logError.message })
    return { sent: false }
  }

  logger.info(source, 'إشعار استلام مُسجَّل', { transactionId, developerId: transaction.developer_id })

  return { sent: true }
}

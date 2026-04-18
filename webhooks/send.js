/**
 * الملف: webhooks/send.js
 * وش يفعل: يرسل webhook للمطور عند تأكيد كل transaction
 * يستدعيه: events/onTransactionConfirmed.js
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم — جدول webhook_logs
 * يطلق Supabase event: لا
 * يسمع Supabase event: نعم — onTransactionConfirmed
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: webhooks/retry.js
 */

import crypto    from 'crypto'
import supabase  from '../shared/db.js'
import logger    from '../shared/logger.js'
import { ExternalServiceError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// sendWebhook — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {{ id, wallet_id, developer_id, type, amount, currency, status, created_at }} transaction
 * @returns {{ sent: boolean, webhook_log_id: string }}
 */
export async function sendWebhook(transaction) {
  const source = 'webhooks/send.js'

  // ── ١. جلب webhook URL من جدول developers ────────────────────────────
  const { data: developer, error: devError } = await supabase
    .from('developers')
    .select('webhook_url, webhook_secret')
    .eq('id', transaction.developer_id)
    .single()

  if (devError) {
    throw new ExternalServiceError('Supabase', devError.message)
  }

  // لو المطور ما ضبط webhook URL — نتجاهل بهدوء
  if (!developer?.webhook_url) {
    logger.info(source, 'لا يوجد webhook URL — تم تجاهله', { developerId: transaction.developer_id })
    return { sent: false, webhook_log_id: null }
  }

  // ── ٣. بناء الـ payload ────────────────────────────────────────────────
  const payload = {
    event:       'transaction.confirmed',
    transaction: {
      id:         transaction.id,
      wallet_id:  transaction.wallet_id,
      type:       transaction.type,
      amount:     transaction.amount,
      currency:   transaction.currency,
      status:     transaction.status,
      created_at: transaction.created_at,
    },
  }

  // ── ٤. توقيع الـ payload بـ HMAC ──────────────────────────────────────
  const signature = developer.webhook_secret
    ? crypto
        .createHmac('sha256', developer.webhook_secret)
        .update(JSON.stringify(payload))
        .digest('hex')
    : null

  // ── ٥. إرسال الـ webhook ──────────────────────────────────────────────
  let responseStatus = null
  let errorMessage   = null
  let success        = false

  try {
    const headers = {
      'Content-Type': 'application/json',
      ...(signature && { 'x-agentwallet-signature': signature }),
    }

    const response = await fetch(developer.webhook_url, {
      method:  'POST',
      headers,
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(10_000), // 10 ثانية timeout
    })

    responseStatus = response.status
    success        = response.ok

  } catch (err) {
    errorMessage = err.message
  }

  // ── ٦. تسجيل النتيجة في webhook_logs ─────────────────────────────────
  const { data: log, error: logError } = await supabase
    .from('webhook_logs')
    .insert({
      transaction_id:  transaction.id,
      developer_id:    transaction.developer_id,
      url:             developer.webhook_url,
      payload,
      response_status: responseStatus,
      success,
      error_message:   errorMessage,
      attempts:        1,
    })
    .select('id')
    .single()

  if (logError) {
    logger.warn(source, 'فشل تسجيل webhook log', { transactionId: transaction.id, error: logError.message })
  }

  if (success) {
    logger.info(source, 'webhook أُرسل بنجاح', { transactionId: transaction.id, url: developer.webhook_url })
  } else {
    logger.warn(source, 'webhook فشل', { transactionId: transaction.id, responseStatus, errorMessage })
  }

  return {
    sent:           success,
    webhook_log_id: log?.id ?? null,
  }
}

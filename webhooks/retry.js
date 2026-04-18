/**
 * الملف: webhooks/retry.js
 * وش يفعل: يعيد إرسال الـ webhooks الفاشلة — يتحقق من عدد المحاولات ويوقف بعد الحد
 * يستدعيه: cron job أو يدوياً
 * يستدعي: webhooks/send.js، shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم — جدول webhook_logs
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: webhooks/send.js
 */

import supabase             from '../shared/db.js'
import logger               from '../shared/logger.js'
import { sendWebhook }      from './send.js'
import { ExternalServiceError, NotFoundError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// Config
// ══════════════════════════════════════════════════════════════════════════════

const MAX_ATTEMPTS = 5

// ══════════════════════════════════════════════════════════════════════════════
// retryFailedWebhooks — يُشغَّل بـ cron
// ══════════════════════════════════════════════════════════════════════════════

/**
 * يجلب كل الـ webhooks الفاشلة ويعيد إرسالها
 * @returns {{ retried: number, succeeded: number, failed: number }}
 */
export async function retryFailedWebhooks() {
  const source = 'webhooks/retry.js'

  // ── ١. جلب الـ webhooks الفاشلة القابلة للإعادة ───────────────────────
  const { data: failedLogs, error: fetchError } = await supabase
    .from('webhook_logs')
    .select('id, transaction_id, attempts')
    .eq('success', false)
    .lt('attempts', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(50)

  if (fetchError) {
    throw new ExternalServiceError('Supabase', fetchError.message)
  }

  if (!failedLogs || failedLogs.length === 0) {
    logger.info(source, 'لا توجد webhooks فاشلة للإعادة')
    return { retried: 0, succeeded: 0, failed: 0 }
  }

  let succeeded = 0
  let failed    = 0

  // ── ٢. إعادة الإرسال لكل webhook ──────────────────────────────────────
  for (const log of failedLogs) {
    try {
      const result = await sendWebhook(log.transaction_id)

      // ── ٣. تحديث الـ log ──────────────────────────────────────────────
      await supabase
        .from('webhook_logs')
        .update({
          success:   result.sent,
          attempts:  log.attempts + 1,
          retried_at: new Date().toISOString(),
        })
        .eq('id', log.id)

      if (result.sent) {
        succeeded++
      } else {
        failed++
      }

    } catch (err) {
      failed++

      await supabase
        .from('webhook_logs')
        .update({
          attempts:      log.attempts + 1,
          error_message: err.message,
          retried_at:    new Date().toISOString(),
        })
        .eq('id', log.id)

      logger.warn(source, 'فشلت إعادة الإرسال', { logId: log.id, error: err.message })
    }
  }

  logger.info(source, 'retry مكتمل', {
    retried: failedLogs.length,
    succeeded,
    failed,
  })

  return { retried: failedLogs.length, succeeded, failed }
}

// ══════════════════════════════════════════════════════════════════════════════
// retrySingle — إعادة إرسال webhook واحد يدوياً
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} webhookLogId
 * @returns {{ sent: boolean }}
 */
export async function retrySingle(webhookLogId) {
  const source = 'webhooks/retry.js'

  const { data: log, error: fetchError } = await supabase
    .from('webhook_logs')
    .select('id, transaction_id, attempts')
    .eq('id', webhookLogId)
    .single()

  if (fetchError) {
    throw new ExternalServiceError('Supabase', fetchError.message)
  }
  if (!log) {
    throw new NotFoundError('webhook log')
  }

  if (log.attempts >= MAX_ATTEMPTS) {
    logger.warn(source, 'تجاوز الحد الأقصى للمحاولات', { webhookLogId, attempts: log.attempts })
    return { sent: false }
  }

  const result = await sendWebhook(log.transaction_id)

  await supabase
    .from('webhook_logs')
    .update({
      success:    result.sent,
      attempts:   log.attempts + 1,
      retried_at: new Date().toISOString(),
    })
    .eq('id', webhookLogId)

  return { sent: result.sent }
}

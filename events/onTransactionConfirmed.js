/**
 * الملف: events/onTransactionConfirmed.js
 * وش يفعل: يستمع لـ Supabase Realtime — لما تتأكد transaction يستدعي الـ handlers
 * يستدعيه: يُشغَّل مرة واحدة عند بدء السيرفر
 * يستدعي: shared/logger.js، webhooks/send.js (مرحلة ١٣)، notifications/receive.js (مرحلة ١٤)، dashboard/overview.js (مرحلة ٤)
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: لا
 * يسمع Supabase event: نعم — UPDATE على جدول transactions حين status = 'confirmed'
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: webhooks/send.js، notifications/receive.js، dashboard/overview.js
 */

import supabase from '../shared/db.js'
import logger from '../shared/logger.js'

// ── الملفات التالية تُبنى في مراحل لاحقة ─────────────────────────────────
// مرحلة ٤:  import { refreshOverview } from '../dashboard/overview.js'
// مرحلة ١٣: import { sendWebhook }     from '../webhooks/send.js'
// مرحلة ١٤: import { notifyDeveloper } from '../notifications/receive.js'

// ══════════════════════════════════════════════════════════════════════════════
// Handler — يُنفَّذ لكل transaction تتأكد
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {object} transaction - بيانات الـ transaction بعد التأكيد
 * @param {string} transaction.id
 * @param {string} transaction.agent_id
 * @param {number} transaction.amount
 * @param {string} transaction.type       - 'payment' | 'transfer' | 'onramp'
 * @param {string} transaction.status     - 'confirmed'
 * @param {string} transaction.tx_hash    - hash الـ blockchain
 * @param {string} transaction.created_at
 */
async function handleTransactionConfirmed(transaction) {
  const source = 'events/onTransactionConfirmed.js'

  // ── ١. تسجيل الحدث في الـ audit log ──────────────────────────────────
  await logger.audit(source, 'transaction.confirmed', {
    agentId:  transaction.agent_id,
    actorId:  'system',
    metadata: {
      transactionId: transaction.id,
      amount:        transaction.amount,
      type:          transaction.type,
      txHash:        transaction.tx_hash,
    },
    status: 'success',
  })

  // ── ٢. إرسال Webhook للـ agent الخارجي ───────────────────────────────
  // TODO (مرحلة ١٣): فعّل هذا الكود لما تُبنى webhooks/send.js
  //
  // try {
  //   await sendWebhook(transaction)
  // } catch (err) {
  //   logger.warn(source, 'فشل إرسال webhook — سيُعاد المحاولة', {
  //     transactionId: transaction.id,
  //     error: err.message,
  //   })
  // }

  // ── ٣. إشعار المطور ───────────────────────────────────────────────────
  // TODO (مرحلة ١٤): فعّل هذا الكود لما تُبنى notifications/receive.js
  //
  // try {
  //   await notifyDeveloper(transaction)
  // } catch (err) {
  //   logger.warn(source, 'فشل إرسال الإشعار للمطور', {
  //     transactionId: transaction.id,
  //     error: err.message,
  //   })
  // }

  // ── ٤. تحديث الـ Dashboard ────────────────────────────────────────────
  // TODO (مرحلة ٤): فعّل هذا الكود لما تُبنى dashboard/overview.js
  //
  // try {
  //   await refreshOverview(transaction.agent_id)
  // } catch (err) {
  //   logger.warn(source, 'فشل تحديث الـ dashboard', {
  //     agentId: transaction.agent_id,
  //     error: err.message,
  //   })
  // }

  logger.info(source, 'transaction.confirmed تمت معالجته', {
    transactionId: transaction.id,
    agentId:       transaction.agent_id,
  })
}

// ══════════════════════════════════════════════════════════════════════════════
// start — يُشغَّل مرة واحدة عند بدء السيرفر
// ══════════════════════════════════════════════════════════════════════════════

/**
 * يفتح قناة Supabase Realtime ويبدأ الاستماع
 * مثال الاستخدام في السيرفر:
 *   import { start } from './events/onTransactionConfirmed.js'
 *   start()
 */
export function start() {
  const source = 'events/onTransactionConfirmed.js'

  const channel = supabase
    .channel('on-transaction-confirmed')
    .on(
      'postgres_changes',
      {
        event:  'UPDATE',         // نسمع UPDATE — لما status يتغير لـ 'confirmed'
        schema: 'public',
        table:  'transactions',
        filter: 'status=eq.confirmed', // فقط الـ rows اللي status فيها = 'confirmed'
      },
      async (payload) => {
        // payload.new = بيانات الـ row بعد التحديث
        const transaction = payload.new

        try {
          await handleTransactionConfirmed(transaction)
        } catch (err) {
          // نسجّل الخطأ لكن ما نوقف الـ channel — الـ listener يبقى شغّال
          logger.error(source, 'خطأ في معالجة transaction.confirmed', {
            transactionId: transaction?.id,
            error:         err.message,
          })
        }
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        logger.info(source, 'يستمع لـ transaction.confirmed ✓')
      } else if (status === 'CHANNEL_ERROR') {
        logger.error(source, 'فشل الاتصال بـ Supabase Realtime', { status })
      }
    })

  return channel
}

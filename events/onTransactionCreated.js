/**
 * الملف: events/onTransactionCreated.js
 * وش يفعل: يستمع لـ Supabase Realtime — لما تُنشأ transaction جديدة يستدعي الـ handlers
 * يستدعيه: يُشغَّل مرة واحدة عند بدء السيرفر
 * يستدعي: shared/db.js، shared/logger.js، rules/limits.js (مرحلة ١٢)
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: لا
 * يسمع Supabase event: نعم — INSERT على جدول transactions
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: rules/limits.js، shared/logger.js
 */

import supabase from '../shared/db.js'
import logger from '../shared/logger.js'

// ── rules/limits.js يُبنى في المرحلة ١٢ ─────────────────────────────────
// لما يُبنى، أضف هذا الـ import:
// import { checkLimits } from '../rules/limits.js'

// ══════════════════════════════════════════════════════════════════════════════
// Handler — يُنفَّذ لكل transaction جديدة
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {object} transaction - بيانات الـ transaction من DB
 * @param {string} transaction.id
 * @param {string} transaction.agent_id
 * @param {number} transaction.amount
 * @param {string} transaction.type       - 'payment' | 'transfer' | 'onramp'
 * @param {string} transaction.status     - 'pending' | 'confirmed' | 'failed'
 * @param {string} transaction.created_at
 */
async function handleTransactionCreated(transaction) {
  const source = 'events/onTransactionCreated.js'

  // ── ١. تسجيل الحدث في الـ audit log ──────────────────────────────────
  await logger.audit(source, 'transaction.created', {
    agentId:  transaction.agent_id,
    actorId:  'system',
    metadata: {
      transactionId: transaction.id,
      amount:        transaction.amount,
      type:          transaction.type,
      status:        transaction.status,
    },
    status: 'success',
  })

  // ── ٢. التحقق من الحدود ───────────────────────────────────────────────
  // TODO (مرحلة ١٢): فعّل هذا الكود لما تُبنى rules/limits.js
  //
  // try {
  //   await checkLimits(transaction)
  // } catch (err) {
  //   // LimitExceededError → Supabase يطلق onLimitExceeded تلقائياً لما نحدّث DB
  //   logger.warn(source, 'تجاوز الحد — سيتم إيقاف الـ agent', {
  //     agentId: transaction.agent_id,
  //     error:   err.message,
  //   })
  //   throw err
  // }

  logger.info(source, 'transaction.created تمت معالجته', {
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
 *   import { start } from './events/onTransactionCreated.js'
 *   start()
 */
export function start() {
  const source = 'events/onTransactionCreated.js'

  const channel = supabase
    .channel('on-transaction-created')
    .on(
      'postgres_changes',
      {
        event:  'INSERT',      // فقط الـ INSERT — مش UPDATE أو DELETE
        schema: 'public',
        table:  'transactions',
      },
      async (payload) => {
        // payload.new = بيانات الـ row الجديدة كما هي في DB
        const transaction = payload.new

        try {
          await handleTransactionCreated(transaction)
        } catch (err) {
          // نسجّل الخطأ لكن ما نوقف الـ channel — الـ listener يبقى شغّال
          logger.error(source, 'خطأ في معالجة transaction.created', {
            transactionId: transaction?.id,
            error:         err.message,
          })
        }
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        logger.info(source, 'يستمع لـ transaction.created ✓')
      } else if (status === 'CHANNEL_ERROR') {
        logger.error(source, 'فشل الاتصال بـ Supabase Realtime', { status })
      }
    })

  // نرجع الـ channel لمن يريد إيقافه لاحقاً (اختبارات، shutdown)
  return channel
}

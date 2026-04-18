/**
 * الملف: events/onAgentFunded.js
 * وش يفعل: يستمع لـ Supabase Realtime — لما يُموَّل agent يستدعي الـ handlers
 * يستدعيه: يُشغَّل مرة واحدة عند بدء السيرفر
 * يستدعي: shared/logger.js، notifications/receive.js (مرحلة ١٤)، dashboard/overview.js (مرحلة ٤)
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: لا
 * يسمع Supabase event: نعم — INSERT على جدول transactions حين type = 'onramp'
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: notifications/receive.js، dashboard/overview.js
 */

import supabase from '../shared/db.js'
import logger from '../shared/logger.js'

// ── الملفات التالية تُبنى في مراحل لاحقة ─────────────────────────────────
// مرحلة ٤:  import { refreshOverview } from '../dashboard/overview.js'
// مرحلة ١٤: import { notifyDeveloper } from '../notifications/receive.js'

// ══════════════════════════════════════════════════════════════════════════════
// Handler — يُنفَّذ لكل مرة يُموَّل agent
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {object} transaction - بيانات الـ transaction من DB
 * @param {string} transaction.id
 * @param {string} transaction.agent_id
 * @param {number} transaction.amount
 * @param {string} transaction.type       - 'onramp'
 * @param {string} transaction.status     - 'confirmed'
 * @param {string} transaction.created_at
 */
async function handleAgentFunded(transaction) {
  const source = 'events/onAgentFunded.js'

  // ── ١. تسجيل الحدث في الـ audit log ──────────────────────────────────
  await logger.audit(source, 'agent.funded', {
    agentId:  transaction.agent_id,
    actorId:  'system',
    metadata: {
      transactionId: transaction.id,
      amount:        transaction.amount,
    },
    status: 'success',
  })

  // ── ٢. إشعار المطور ───────────────────────────────────────────────────
  // TODO (مرحلة ١٤): فعّل هذا الكود لما تُبنى notifications/receive.js
  //
  // try {
  //   await notifyDeveloper(transaction)
  // } catch (err) {
  //   logger.warn(source, 'فشل إرسال إشعار التمويل للمطور', {
  //     agentId: transaction.agent_id,
  //     error:   err.message,
  //   })
  // }

  // ── ٣. تحديث الـ Dashboard ────────────────────────────────────────────
  // TODO (مرحلة ٤): فعّل هذا الكود لما تُبنى dashboard/overview.js
  //
  // try {
  //   await refreshOverview(transaction.agent_id)
  // } catch (err) {
  //   logger.warn(source, 'فشل تحديث الـ dashboard بعد التمويل', {
  //     agentId: transaction.agent_id,
  //     error:   err.message,
  //   })
  // }

  logger.info(source, 'agent.funded تمت معالجته', {
    transactionId: transaction.id,
    agentId:       transaction.agent_id,
    amount:        transaction.amount,
  })
}

// ══════════════════════════════════════════════════════════════════════════════
// start — يُشغَّل مرة واحدة عند بدء السيرفر
// ══════════════════════════════════════════════════════════════════════════════

export function start() {
  const source = 'events/onAgentFunded.js'

  const channel = supabase
    .channel('on-agent-funded')
    .on(
      'postgres_changes',
      {
        event:  'INSERT',           // onramp يُنشئ transaction جديدة
        schema: 'public',
        table:  'transactions',
        filter: 'type=eq.onramp',   // فقط تحويلات الـ onramp
      },
      async (payload) => {
        const transaction = payload.new

        try {
          await handleAgentFunded(transaction)
        } catch (err) {
          logger.error(source, 'خطأ في معالجة agent.funded', {
            transactionId: transaction?.id,
            error:         err.message,
          })
        }
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        logger.info(source, 'يستمع لـ agent.funded ✓')
      } else if (status === 'CHANNEL_ERROR') {
        logger.error(source, 'فشل الاتصال بـ Supabase Realtime', { status })
      }
    })

  return channel
}

/**
 * الملف: events/onRollbackInitiated.js
 * وش يفعل: يستمع لـ Supabase Realtime — لما يبدأ rollback يستدعي الـ handlers
 * يستدعيه: يُشغَّل مرة واحدة عند بدء السيرفر
 * يستدعي: shared/logger.js، rollback/execute.js (مرحلة ٩)، rollback/log.js (مرحلة ٩)، notifications/rollback.js (مرحلة ١٤)
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: لا
 * يسمع Supabase event: نعم — INSERT على جدول rollbacks
 * idempotency: لا
 * rollback: لا — هو نفسه جزء من الـ rollback flow
 * لو عدّلته يتأثر: rollback/execute.js، rollback/log.js، notifications/rollback.js
 */

import supabase from '../shared/db.js'
import logger from '../shared/logger.js'

// ── الملفات التالية تُبنى في مراحل لاحقة ─────────────────────────────────
// مرحلة ٩:  import { executeRollback } from '../rollback/execute.js'
// مرحلة ٩:  import { logRollback }     from '../rollback/log.js'
// مرحلة ١٤: import { notifyRollback }  from '../notifications/rollback.js'

// ══════════════════════════════════════════════════════════════════════════════
// Handler — يُنفَّذ لكل rollback جديد
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {object} rollback - بيانات الـ rollback من DB
 * @param {string} rollback.id
 * @param {string} rollback.agent_id
 * @param {string} rollback.transaction_id  - الـ transaction الأصلية
 * @param {number} rollback.amount
 * @param {string} rollback.reason          - سبب الـ rollback
 * @param {string} rollback.status          - 'initiated'
 * @param {string} rollback.created_at
 */
async function handleRollbackInitiated(rollback) {
  const source = 'events/onRollbackInitiated.js'

  // ── ١. تسجيل الحدث في الـ audit log ──────────────────────────────────
  await logger.audit(source, 'rollback.initiated', {
    agentId:  rollback.agent_id,
    actorId:  'system',
    metadata: {
      rollbackId:    rollback.id,
      transactionId: rollback.transaction_id,
      amount:        rollback.amount,
      reason:        rollback.reason,
    },
    status: 'success',
  })

  // ── ٢. تنفيذ الـ rollback ─────────────────────────────────────────────
  // TODO (مرحلة ٩): فعّل هذا الكود لما تُبنى rollback/execute.js
  // ⚠️ هذا الأهم — ما نُشعر المطور قبل ما نتأكد من التنفيذ
  //
  // try {
  //   await executeRollback(rollback)
  // } catch (err) {
  //   logger.error(source, 'فشل تنفيذ الـ rollback', {
  //     rollbackId: rollback.id,
  //     error:      err.message,
  //   })
  //   throw err // نوقف هنا — ما نُشعر بـ rollback فاشل
  // }

  // ── ٣. تسجيل الـ rollback في السجل ──────────────────────────────────
  // TODO (مرحلة ٩): فعّل هذا الكود لما تُبنى rollback/log.js
  //
  // try {
  //   await logRollback(rollback)
  // } catch (err) {
  //   logger.warn(source, 'فشل تسجيل الـ rollback في السجل', {
  //     rollbackId: rollback.id,
  //     error:      err.message,
  //   })
  // }

  // ── ٤. إشعار المطور ───────────────────────────────────────────────────
  // TODO (مرحلة ١٤): فعّل هذا الكود لما تُبنى notifications/rollback.js
  //
  // try {
  //   await notifyRollback(rollback)
  // } catch (err) {
  //   logger.warn(source, 'فشل إرسال إشعار الـ rollback للمطور', {
  //     rollbackId: rollback.id,
  //     error:      err.message,
  //   })
  // }

  logger.info(source, 'rollback.initiated تمت معالجته', {
    rollbackId:    rollback.id,
    transactionId: rollback.transaction_id,
    agentId:       rollback.agent_id,
  })
}

// ══════════════════════════════════════════════════════════════════════════════
// start — يُشغَّل مرة واحدة عند بدء السيرفر
// ══════════════════════════════════════════════════════════════════════════════

export function start() {
  const source = 'events/onRollbackInitiated.js'

  const channel = supabase
    .channel('on-rollback-initiated')
    .on(
      'postgres_changes',
      {
        event:  'INSERT',   // rollback/initiate.js يُنشئ row جديدة في rollbacks
        schema: 'public',
        table:  'rollbacks',
      },
      async (payload) => {
        const rollback = payload.new

        try {
          await handleRollbackInitiated(rollback)
        } catch (err) {
          logger.error(source, 'خطأ في معالجة rollback.initiated', {
            rollbackId: rollback?.id,
            error:      err.message,
          })
        }
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        logger.info(source, 'يستمع لـ rollback.initiated ✓')
      } else if (status === 'CHANNEL_ERROR') {
        logger.error(source, 'فشل الاتصال بـ Supabase Realtime', { status })
      }
    })

  return channel
}

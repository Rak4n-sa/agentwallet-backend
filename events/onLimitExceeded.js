/**
 * الملف: events/onLimitExceeded.js
 * وش يفعل: يستمع لـ Supabase Realtime — لما يتجاوز agent حده يستدعي الـ handlers
 * يستدعيه: يُشغَّل مرة واحدة عند بدء السيرفر
 * يستدعي: shared/logger.js، rules/autoStop.js (مرحلة ١٢)، notifications/limit.js (مرحلة ١٤)
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: لا
 * يسمع Supabase event: نعم — UPDATE على جدول agent_limits حين status = 'exceeded'
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: rules/autoStop.js، notifications/limit.js
 */

import supabase from '../shared/db.js'
import logger from '../shared/logger.js'

// ── الملفات التالية تُبنى في مراحل لاحقة ─────────────────────────────────
// مرحلة ١٢: import { autoStop }         from '../rules/autoStop.js'
// مرحلة ١٤: import { notifyLimitAlert } from '../notifications/limit.js'

// ══════════════════════════════════════════════════════════════════════════════
// Handler — يُنفَّذ لكل مرة يتجاوز agent حده
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {object} limitRecord - بيانات الحد المتجاوز من DB
 * @param {string} limitRecord.id
 * @param {string} limitRecord.agent_id
 * @param {string} limitRecord.limit_type  - 'per_transaction' | 'daily' | 'monthly'
 * @param {number} limitRecord.limit_value - الحد المسموح به
 * @param {number} limitRecord.current     - القيمة الحالية التي تجاوزت الحد
 * @param {string} limitRecord.status      - 'exceeded'
 */
async function handleLimitExceeded(limitRecord) {
  const source = 'events/onLimitExceeded.js'

  // ── ١. تسجيل الحدث في الـ audit log ──────────────────────────────────
  await logger.audit(source, 'limit.exceeded', {
    agentId:  limitRecord.agent_id,
    actorId:  'system',
    metadata: {
      limitId:    limitRecord.id,
      limitType:  limitRecord.limit_type,
      limitValue: limitRecord.limit_value,
      current:    limitRecord.current,
    },
    status: 'success',
  })

  // ── ٢. إيقاف الـ agent تلقائياً ──────────────────────────────────────
  // TODO (مرحلة ١٢): فعّل هذا الكود لما تُبنى rules/autoStop.js
  //
  // try {
  //   await autoStop(limitRecord.agent_id)
  // } catch (err) {
  //   logger.error(source, 'فشل إيقاف الـ agent تلقائياً', {
  //     agentId: limitRecord.agent_id,
  //     error:   err.message,
  //   })
  // }

  // ── ٣. إشعار المطور بتجاوز الحد ──────────────────────────────────────
  // TODO (مرحلة ١٤): فعّل هذا الكود لما تُبنى notifications/limit.js
  //
  // try {
  //   await notifyLimitAlert(limitRecord)
  // } catch (err) {
  //   logger.warn(source, 'فشل إرسال إشعار تجاوز الحد', {
  //     agentId: limitRecord.agent_id,
  //     error:   err.message,
  //   })
  // }

  logger.info(source, 'limit.exceeded تمت معالجته', {
    agentId:   limitRecord.agent_id,
    limitType: limitRecord.limit_type,
  })
}

// ══════════════════════════════════════════════════════════════════════════════
// start — يُشغَّل مرة واحدة عند بدء السيرفر
// ══════════════════════════════════════════════════════════════════════════════

export function start() {
  const source = 'events/onLimitExceeded.js'

  const channel = supabase
    .channel('on-limit-exceeded')
    .on(
      'postgres_changes',
      {
        event:  'UPDATE',              // rules/budget.js يحدّث الحالة لـ 'exceeded'
        schema: 'public',
        table:  'agent_limits',
        filter: 'status=eq.exceeded',  // فقط لما يتجاوز الحد
      },
      async (payload) => {
        const limitRecord = payload.new

        try {
          await handleLimitExceeded(limitRecord)
        } catch (err) {
          logger.error(source, 'خطأ في معالجة limit.exceeded', {
            agentId: limitRecord?.agent_id,
            error:   err.message,
          })
        }
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        logger.info(source, 'يستمع لـ limit.exceeded ✓')
      } else if (status === 'CHANNEL_ERROR') {
        logger.error(source, 'فشل الاتصال بـ Supabase Realtime', { status })
      }
    })

  return channel
}

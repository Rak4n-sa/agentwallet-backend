/**
 * الملف: notifications/limit.js
 * وش يفعل: يرسل إشعار للمطور عند تجاوز الميزانية اليومية أو الشهرية
 * يستدعيه: events/onLimitExceeded.js
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم — جدول notification_logs
 * يطلق Supabase event: لا
 * يسمع Supabase event: نعم — onLimitExceeded
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: dashboard/overview.js
 */

import supabase                 from '../shared/db.js'
import logger                   from '../shared/logger.js'
import { ExternalServiceError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// notifyLimitExceeded — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} walletId
 * @param {string} limitType - 'daily' | 'monthly'
 * @returns {{ sent: boolean }}
 */
export async function notifyLimitExceeded(walletId, limitType) {
  const source = 'notifications/limit.js'

  // ── ١. جلب بيانات المحفظة ─────────────────────────────────────────────
  const { data: wallet, error: walletError } = await supabase
    .from('wallets')
    .select('id, name, developer_id')
    .eq('id', walletId)
    .single()

  if (walletError) {
    throw new ExternalServiceError('Supabase', walletError.message)
  }
  if (!wallet) {
    logger.warn(source, 'محفظة غير موجودة', { walletId })
    return { sent: false }
  }

  // ── ٢. بناء الإشعار ───────────────────────────────────────────────────
  const limitLabel = limitType === 'daily' ? 'اليومية' : 'الشهرية'
  const message    = `تجاوزت محفظة "${wallet.name}" الميزانية ${limitLabel} — تم إيقافها تلقائياً`

  // ── ٣. تسجيل الإشعار في notification_logs ────────────────────────────
  const { error: logError } = await supabase
    .from('notification_logs')
    .insert({
      developer_id: wallet.developer_id,
      wallet_id:    walletId,
      type:         'limit_exceeded',
      message,
      metadata:     { limit_type: limitType },
    })

  if (logError) {
    logger.warn(source, 'فشل تسجيل إشعار الحد', { walletId, error: logError.message })
    return { sent: false }
  }

  logger.info(source, 'إشعار تجاوز الحد مُسجَّل', { walletId, limitType })

  return { sent: true }
}

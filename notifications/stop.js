/**
 * الملف: notifications/stop.js
 * وش يفعل: يرسل إشعار للمطور عند إيقاف المحفظة تلقائياً
 * يستدعيه: rules/autoStop.js
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم — جدول notification_logs
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: dashboard/overview.js
 */

import supabase                 from '../shared/db.js'
import logger                   from '../shared/logger.js'
import { ExternalServiceError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// notifyAutoStop — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} walletId
 * @returns {{ sent: boolean }}
 */
export async function notifyAutoStop(walletId) {
  const source = 'notifications/stop.js'

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
  const message = `تم إيقاف محفظة "${wallet.name}" تلقائياً بسبب تجاوز الحد المسموح`

  // ── ٣. تسجيل الإشعار في notification_logs ────────────────────────────
  const { error: logError } = await supabase
    .from('notification_logs')
    .insert({
      developer_id: wallet.developer_id,
      wallet_id:    walletId,
      type:         'wallet_auto_stopped',
      message,
      metadata:     { reason: 'limit_exceeded' },
    })

  if (logError) {
    logger.warn(source, 'فشل تسجيل إشعار الإيقاف', { walletId, error: logError.message })
    return { sent: false }
  }

  logger.info(source, 'إشعار إيقاف تلقائي مُسجَّل', { walletId })

  return { sent: true }
}

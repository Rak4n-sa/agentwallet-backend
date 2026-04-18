/**
 * الملف: rules/autoStop.js
 * وش يفعل: يوقف المحفظة تلقائياً لما تتجاوز الميزانية — يحدّث is_active: false
 * يستدعيه: events/onLimitExceeded.js
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم — جدول wallets
 * يطلق Supabase event: لا
 * يسمع Supabase event: نعم — onLimitExceeded
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: notifications/stop.js، dashboard/overview.js
 */

import supabase                              from '../shared/db.js'
import logger                                from '../shared/logger.js'
import { ExternalServiceError, NotFoundError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// autoStopWallet — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * يوقف المحفظة تلقائياً بتحديث is_active: false
 *
 * @param {string} walletId
 * @returns {{ wallet_id: string, stopped: boolean }}
 */
export async function autoStopWallet(walletId) {
  const source = 'rules/autoStop.js'

  // ── ١. جلب المحفظة ────────────────────────────────────────────────────
  const { data: wallet, error: fetchError } = await supabase
    .from('wallets')
    .select('id, developer_id, is_active, name')
    .eq('id', walletId)
    .single()

  if (fetchError) {
    throw new ExternalServiceError('Supabase', fetchError.message)
  }
  if (!wallet) {
    throw new NotFoundError('محفظة')
  }

  // ── ٢. لو المحفظة موقوفة بالفعل — لا شيء ────────────────────────────
  if (!wallet.is_active) {
    logger.info(source, 'المحفظة موقوفة بالفعل — تم تجاهله', { walletId })
    return { wallet_id: walletId, stopped: false }
  }

  // ── ٣. إيقاف المحفظة ──────────────────────────────────────────────────
  const { error: updateError } = await supabase
    .from('wallets')
    .update({ is_active: false })
    .eq('id', walletId)

  if (updateError) {
    throw new ExternalServiceError('Supabase', updateError.message)
  }

  // ── ٤. audit log ──────────────────────────────────────────────────────
  await logger.audit(source, 'wallet.auto_stopped', {
    walletId,
    actorId:  wallet.developer_id,
    metadata: { name: wallet.name, reason: 'limit_exceeded' },
    status:   'success',
  })

  logger.warn(source, 'تم إيقاف المحفظة تلقائياً', { walletId, name: wallet.name })

  return { wallet_id: walletId, stopped: true }
}

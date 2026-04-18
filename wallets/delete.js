/**
 * الملف: wallets/delete.js
 * وش يفعل: يعطّل محفظة موجودة بتحديث is_active: false
 * يستدعيه: HTTP DELETE /wallets/:id
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم — جدول wallets
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: wallets/list.js، dashboard/overview.js
 */

import supabase from '../shared/db.js'
import logger from '../shared/logger.js'
import { NotFoundError, ExternalServiceError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// deleteWallet — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} developerId
 * @param {string} walletId
 * @returns {{ id: string }}
 */
export async function deleteWallet(developerId, walletId) {
  const source = 'wallets/delete.js'

  // ── ١. نتأكد إن المحفظة موجودة وتخص هذا المطور ──────────────────────
  const { data: existing, error: fetchError } = await supabase
    .from('wallets')
    .select('id, name')
    .eq('id', walletId)
    .eq('developer_id', developerId)
    .single()

  if (fetchError) {
    throw new ExternalServiceError('Supabase', fetchError.message)
  }
  if (!existing) {
    throw new NotFoundError('محفظة')
  }

  // ── ٢. تعطيل المحفظة بدل الحذف الكامل ───────────────────────────────
  const { error: updateError } = await supabase
    .from('wallets')
    .update({ is_active: false })
    .eq('id', walletId)

  if (updateError) {
    throw new ExternalServiceError('Supabase', updateError.message)
  }

  // ── ٣. audit log ──────────────────────────────────────────────────────
  await logger.audit(source, 'wallet.deleted', {
    walletId: walletId,
    actorId:  developerId,
    metadata: { name: existing.name },
    status:   'success',
  })

  return { id: walletId }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * DELETE /wallets/:id
 * يحتاج: auth middleware يضيف req.user
 */
export async function deleteWalletHandler(req, res) {
  try {
    const result = await deleteWallet(req.user.id, req.params.id)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

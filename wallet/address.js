/**
 * الملف: wallet/address.js
 * وش يفعل: يرجع Smart Account address والـ salt للمحفظة
 * يستدعيه: HTTP GET /wallets/:id/address
 * يستدعي: shared/db.js، shared/errors.js
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: receive/link.js، payments/send.js
 */

import supabase                                              from '../shared/db.js'
import { ExternalServiceError, NotFoundError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// getWalletAddress — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} walletId
 * @param {string} developerId
 * @returns {{ smart_account_address: string, salt: string }}
 */
export async function getWalletAddress(walletId, developerId) {
  // ── ١. التحقق من الملكية وجلب tba_address ────────────────────────────
  const { data: wallet, error: fetchError } = await supabase
    .from('wallets')
    .select('id, tba_address')
    .eq('id', walletId)
    .eq('developer_id', developerId)
    .single()

  if (fetchError) {
    throw new ExternalServiceError('Supabase', fetchError.message)
  }
  if (!wallet) {
    throw new NotFoundError('محفظة')
  }
  if (!wallet.tba_address) {
    throw new NotFoundError('Smart Account address — شغّل POST /wallets/:id/blockchain أولاً')
  }

  // ── ٢. جلب salt من agent_wallets ─────────────────────────────────────
  const { data: agentWallet, error: awError } = await supabase
    .from('agent_wallets')
    .select('token_id')
    .eq('wallet_id', walletId)
    .single()

  if (awError) {
    throw new ExternalServiceError('Supabase', awError.message)
  }
  if (!agentWallet) {
    throw new NotFoundError('بيانات البلوكشين — شغّل POST /wallets/:id/blockchain أولاً')
  }

  return {
    smart_account_address: wallet.tba_address,
    salt:                  agentWallet.token_id,  // salt مخزون في حقل token_id
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /wallets/:id/address
 * يحتاج: auth middleware يضيف req.user
 */
export async function walletAddressHandler(req, res) {
  try {
    const result = await getWalletAddress(req.params.id, req.user.id)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

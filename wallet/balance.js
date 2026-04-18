/**
 * الملف: wallet/balance.js
 * وش يفعل: يرجع رصيد USDC للـ Smart Account address من البلوكشين + رصيد DB
 * يستدعيه: HTTP GET /wallets/:id/balance
 * يستدعي: shared/tokenbound.js، shared/db.js، shared/errors.js
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: dashboard/overview.js، dashboard/stats.js
 */

import { publicClient }                                      from '../shared/tokenbound.js'
import supabase                                              from '../shared/db.js'
import { ExternalServiceError, NotFoundError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// USDC Contract على Base Sepolia
// ══════════════════════════════════════════════════════════════════════════════

const USDC_CONTRACT  = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const USDC_DECIMALS  = 6

const ERC20_BALANCE_ABI = [{
  name:    'balanceOf',
  type:    'function',
  inputs:  [{ name: 'account', type: 'address' }],
  outputs: [{ name: '',        type: 'uint256' }],
  stateMutability: 'view',
}]

// ══════════════════════════════════════════════════════════════════════════════
// getWalletBalance — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} walletId
 * @param {string} developerId
 * @returns {{
 *   db_balance:         number,
 *   onchain_balance:    number,
 *   smart_account_address: string,
 * }}
 */
export async function getWalletBalance(walletId, developerId) {
  // ── ١. جلب المحفظة والتحقق من الملكية ────────────────────────────────
  const { data: wallet, error: fetchError } = await supabase
    .from('wallets')
    .select('id, balance, tba_address')
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

  // ── ٢. جلب رصيد USDC من البلوكشين ────────────────────────────────────
  let onchainBalance = 0

  try {
    const raw = await publicClient.readContract({
      address:      USDC_CONTRACT,
      abi:          ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args:         [wallet.tba_address],
    })
    onchainBalance = Number(raw) / 10 ** USDC_DECIMALS
  } catch (err) {
    throw new ExternalServiceError('Blockchain', err.message)
  }

  return {
    db_balance:      wallet.balance ?? 0,
    onchain_balance: Math.round(onchainBalance * 100) / 100,
    smart_account_address: wallet.tba_address,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /wallets/:id/balance
 * يحتاج: auth middleware يضيف req.user
 */
export async function walletBalanceHandler(req, res) {
  try {
    const result = await getWalletBalance(req.params.id, req.user.id)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

/**
 * الملف: wallet/balance.js
 * وش يفعل: يرجع رصيد USDC من Base mainnet + رصيد DB
 * يستدعيه: HTTP GET /wallets/:id/balance
 */

import { publicClient }                                      from '../shared/tokenbound.js'
import supabase                                              from '../shared/db.js'
import { ExternalServiceError, NotFoundError, formatError } from '../shared/errors.js'

// USDC على Base mainnet
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDC_DECIMALS = 6

const ERC20_ABI = [{
  name:            'balanceOf',
  type:            'function',
  inputs:          [{ name: 'account', type: 'address' }],
  outputs:         [{ name: '',        type: 'uint256' }],
  stateMutability: 'view',
}]

// ══════════════════════════════════════════════════════════════════════════════
// getWalletBalance
// ══════════════════════════════════════════════════════════════════════════════

export async function getWalletBalance(walletId, developerId) {
  const { data: wallet, error } = await supabase
    .from('wallets')
    .select('id, balance, tba_address')
    .eq('id', walletId)
    .eq('developer_id', developerId)
    .single()

  if (error)   throw new ExternalServiceError('Supabase', error.message)
  if (!wallet) throw new NotFoundError('محفظة')
  if (!wallet.tba_address) {
    throw new NotFoundError('عنوان المحفظة — شغّل POST /wallets/:id/blockchain أولاً')
  }

  let onchainBalance = 0
  try {
    const raw = await publicClient.readContract({
      address:      USDC_CONTRACT,
      abi:          ERC20_ABI,
      functionName: 'balanceOf',
      args:         [wallet.tba_address],
    })
    onchainBalance = Number(raw) / 10 ** USDC_DECIMALS
  } catch (err) {
    // في mock mode يرجع 0 بدون خطأ
    onchainBalance = 0
  }

  return {
    db_balance:      wallet.balance ?? 0,
    onchain_balance: Math.round(onchainBalance * 1_000_000) / 1_000_000,
    address:         wallet.tba_address,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler
// ══════════════════════════════════════════════════════════════════════════════

export async function walletBalanceHandler(req, res) {
  try {
    const result = await getWalletBalance(req.params.id, req.user.id)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

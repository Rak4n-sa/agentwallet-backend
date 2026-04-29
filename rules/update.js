/**
 * الملف: rules/update.js
 * وش يفعل: يحدّث كل قواعد المحفظة في طلب واحد — limits + budget + allowlist
 * يستدعيه: HTTP PATCH /wallets/:id/rules
 * يستدعي: shared/db.js، shared/errors.js، shared/logger.js
 * يحدّث DB: نعم — جدول wallet_limits + جدول wallets (allowlist)
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: dashboard/walletProfile.js
 */

import supabase from '../shared/db.js'
import logger   from '../shared/logger.js'
import { NotFoundError, ExternalServiceError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// updateWalletRules — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} developerId
 * @param {string} walletId
 * @param {object} input
 * @param {number}   [input.maxPerTransaction]
 * @param {number}   [input.dailyLimit]
 * @param {number}   [input.monthlyLimit]
 * @param {string[]} [input.allowlist]
 * @param {boolean}  [input.allowlistEnabled]
 */
export async function updateWalletRules(developerId, walletId, input) {
  const source = 'rules/update.js'

  // ── ١. تحقق إن المحفظة تخص هذا المطور ───────────────────────────────
  const { data: wallet, error: walletErr } = await supabase
    .from('wallets')
    .select('id')
    .eq('id', walletId)
    .eq('developer_id', developerId)
    .maybeSingle()

  if (walletErr) throw new ExternalServiceError('Supabase', walletErr.message)
  if (!wallet)   throw new NotFoundError('محفظة')

  const promises = []

  // ── ٢. تحديث wallet_limits لو في تغييرات ─────────────────────────────
  const limitsPayload = { wallet_id: walletId, is_active: true }
  let hasLimits = false

  if (input.maxPerTransaction !== undefined) {
    limitsPayload.max_transaction_amount = input.maxPerTransaction
    hasLimits = true
  }
  if (input.dailyLimit !== undefined) {
    limitsPayload.daily_budget = input.dailyLimit
    hasLimits = true
  }
  if (input.monthlyLimit !== undefined) {
    limitsPayload.monthly_budget = input.monthlyLimit
    hasLimits = true
  }

  if (hasLimits) {
    promises.push(
      supabase
        .from('wallet_limits')
        .upsert(limitsPayload, { onConflict: 'wallet_id' })
        .then(({ error }) => {
          if (error) throw new ExternalServiceError('Supabase', error.message)
        })
    )
  }

  // ── ٣. تحديث allowlist في جدول wallets لو في تغييرات ─────────────────
  const walletsPayload = {}
  if (input.allowlist        !== undefined) walletsPayload.allowlist         = input.allowlist
  if (input.allowlistEnabled !== undefined) walletsPayload.allowlist_enabled = input.allowlistEnabled

  if (Object.keys(walletsPayload).length > 0) {
    promises.push(
      supabase
        .from('wallets')
        .update(walletsPayload)
        .eq('id', walletId)
        .then(({ error }) => {
          if (error) throw new ExternalServiceError('Supabase', error.message)
        })
    )
  }

  await Promise.all(promises)

  // ── ٤. اجلب القيم المحدّثة وارجعها ──────────────────────────────────
  const [{ data: updatedLimits }, { data: updatedWallet }] = await Promise.all([
    supabase.from('wallet_limits').select('*').eq('wallet_id', walletId).maybeSingle(),
    supabase.from('wallets').select('allowlist, allowlist_enabled').eq('id', walletId).single(),
  ])

  logger.info(source, 'rules updated', { walletId, input })

  return {
    walletId,
    maxPerTransaction: updatedLimits?.max_transaction_amount ?? null,
    dailyLimit:        updatedLimits?.daily_budget           ?? null,
    monthlyLimit:      updatedLimits?.monthly_budget         ?? null,
    allowlist:         updatedWallet?.allowlist              ?? [],
    allowlistEnabled:  updatedWallet?.allowlist_enabled      ?? false,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

export async function updateWalletRulesHandler(req, res) {
  try {
    const result = await updateWalletRules(req.user.id, req.params.id, req.body)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

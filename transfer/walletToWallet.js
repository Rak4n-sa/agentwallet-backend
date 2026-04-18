/**
 * الملف: transfer/walletToWallet.js
 * وش يفعل: يحوّل USDC من محفظة لمحفظة أخرى داخل النظام
 * يستدعيه: HTTP POST /transfer/wallet-to-wallet
 * يستدعي: shared/db.js، shared/logger.js، shared/idempotency.js، payments/verify.js، shared/errors.js
 * يحدّث DB: نعم — جدول transactions + جدول wallets (محفظتين)
 * يطلق Supabase event: نعم — onTransactionCreated، onTransactionConfirmed
 * يسمع Supabase event: لا
 * idempotency: نعم — يمنع تنفيذ نفس التحويل مرتين
 * rollback: لا — يُبنى في rollback/initiate.js
 * لو عدّلته يتأثر: dashboard/overview.js، events/onTransactionConfirmed.js
 */

import supabase                                      from '../shared/db.js'
import logger                                        from '../shared/logger.js'
import { checkAndReserve, markComplete, markFailed } from '../shared/idempotency.js'
import { verifyBalance }                             from '../payments/verify.js'
import {
  ValidationError,
  NotFoundError,
  ExternalServiceError,
  formatError,
} from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// Validation
// ══════════════════════════════════════════════════════════════════════════════

function validateInput({ idempotency_key, from_wallet_id, to_wallet_id, amount }) {
  if (!idempotency_key || typeof idempotency_key !== 'string') {
    throw new ValidationError('idempotency_key مطلوب')
  }
  if (!from_wallet_id || typeof from_wallet_id !== 'string') {
    throw new ValidationError('from_wallet_id مطلوب')
  }
  if (!to_wallet_id || typeof to_wallet_id !== 'string') {
    throw new ValidationError('to_wallet_id مطلوب')
  }
  if (from_wallet_id === to_wallet_id) {
    throw new ValidationError('لا يمكن التحويل من محفظة لنفسها')
  }
  if (!amount || typeof amount !== 'number' || amount <= 0) {
    throw new ValidationError('amount مطلوب ويجب أن يكون أكبر من صفر')
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// transferWalletToWallet — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} developerId
 * @param {object} input
 * @param {string} input.idempotency_key
 * @param {string} input.from_wallet_id
 * @param {string} input.to_wallet_id
 * @param {number} input.amount
 * @param {string} input.description   - اختياري
 * @returns {{ transaction_id: string, from_balance: number, to_balance: number }}
 */
export async function transferWalletToWallet(developerId, input) {
  const source = 'transfer/walletToWallet.js'
  const {
    idempotency_key,
    from_wallet_id,
    to_wallet_id,
    amount,
    description = '',
  } = input

  // ── ١. التحقق من البيانات ──────────────────────────────────────────────
  validateInput({ idempotency_key, from_wallet_id, to_wallet_id, amount })

  // ── ٢. التحقق إن المحفظة المرسِلة تخص هذا المطور ────────────────────
  const { balance: fromBalance } = await verifyBalance(from_wallet_id, developerId, amount)

  // ── ٣. التحقق إن المحفظة المستقبِلة موجودة ───────────────────────────
  const { data: toWallet, error: toError } = await supabase
    .from('wallets')
    .select('id, balance')
    .eq('id', to_wallet_id)
    .eq('developer_id', developerId)
    .eq('is_active', true)
    .single()

  if (toError) {
    throw new ExternalServiceError('Supabase', toError.message)
  }
  if (!toWallet) {
    throw new NotFoundError('المحفظة المستقبِلة')
  }

  // ── ٤. idempotency ────────────────────────────────────────────────────
  await checkAndReserve(idempotency_key, from_wallet_id)

  try {
    // ── ٥. تسجيل transaction outbound للمرسِل ─────────────────────────
    const { data: transaction, error: txError } = await supabase
      .from('transactions')
      .insert({
        idempotency_key,
        wallet_id:    from_wallet_id,
        developer_id: developerId,
        direction:    'outbound',
        type:         'transfer',
        amount,
        fee:          0,
        net_amount:   amount,
        currency:     'USDC',
        counterparty: to_wallet_id,
        description:  description || `تحويل إلى محفظة ${to_wallet_id}`,
        status:       'confirmed',
        confirmed_at: new Date().toISOString(),
        metadata:     { to_wallet_id },
      })
      .select('id')
      .single()

    if (txError) {
      throw new ExternalServiceError('Supabase', txError.message)
    }

    // ── ٦. تسجيل transaction inbound للمستقبِل ────────────────────────
    const { error: inboundError } = await supabase
      .from('transactions')
      .insert({
        wallet_id:    to_wallet_id,
        developer_id: developerId,
        direction:    'inbound',
        type:         'transfer',
        amount,
        fee:          0,
        net_amount:   amount,
        currency:     'USDC',
        counterparty: from_wallet_id,
        description:  description || `تحويل من محفظة ${from_wallet_id}`,
        status:       'confirmed',
        confirmed_at: new Date().toISOString(),
        metadata:     { from_wallet_id },
      })

    if (inboundError) {
      throw new ExternalServiceError('Supabase', inboundError.message)
    }

    // ── ٧. تحديث الرصيدين في نفس الوقت ───────────────────────────────
    const newFromBalance = Math.round((fromBalance - amount)            * 1_000_000) / 1_000_000
    const newToBalance   = Math.round((toWallet.balance + amount)       * 1_000_000) / 1_000_000

    const [fromResult, toResult] = await Promise.all([
      supabase.from('wallets').update({ balance: newFromBalance }).eq('id', from_wallet_id),
      supabase.from('wallets').update({ balance: newToBalance   }).eq('id', to_wallet_id),
    ])

    if (fromResult.error) {
      throw new ExternalServiceError('Supabase', fromResult.error.message)
    }
    if (toResult.error) {
      throw new ExternalServiceError('Supabase', toResult.error.message)
    }

    // ── ٨. إتمام الـ idempotency key ──────────────────────────────────
    await markComplete(idempotency_key, from_wallet_id, { transaction_id: transaction.id })

    // ── ٩. audit log ──────────────────────────────────────────────────
    await logger.audit(source, 'transfer.completed', {
      walletId:  from_wallet_id,
      actorId:   developerId,
      metadata:  { transaction_id: transaction.id, to_wallet_id, amount },
      status:    'success',
    })

    return {
      transaction_id: transaction.id,
      from_balance:   newFromBalance,
      to_balance:     newToBalance,
    }

  } catch (err) {
    await markFailed(idempotency_key, from_wallet_id)
    throw err
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /transfer/wallet-to-wallet
 * Body: { idempotency_key, from_wallet_id, to_wallet_id, amount, description? }
 * يحتاج: auth middleware يضيف req.user
 */
export async function walletToWalletHandler(req, res) {
  try {
    const result = await transferWalletToWallet(req.user.id, req.body)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

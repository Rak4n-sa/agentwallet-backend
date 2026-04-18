/**
 * الملف: transfer/external.js
 * وش يفعل: يحوّل USDC من محفظة داخلية لعنوان خارجي على البلوكشين
 * يستدعيه: HTTP POST /transfer/external
 * يستدعي: shared/db.js، shared/logger.js، shared/idempotency.js، payments/verify.js، shared/tokenbound.js، shared/errors.js
 * يحدّث DB: نعم — جدول transactions + جدول wallets
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
  ExternalServiceError,
  formatError,
} from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// Validation
// ══════════════════════════════════════════════════════════════════════════════

function validateInput({ idempotency_key, from_wallet_id, to_address, amount }) {
  if (!idempotency_key || typeof idempotency_key !== 'string') {
    throw new ValidationError('idempotency_key مطلوب')
  }
  if (!from_wallet_id || typeof from_wallet_id !== 'string') {
    throw new ValidationError('from_wallet_id مطلوب')
  }
  if (!to_address || typeof to_address !== 'string') {
    throw new ValidationError('to_address مطلوب')
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(to_address)) {
    throw new ValidationError('to_address عنوان Ethereum غير صالح')
  }
  if (!amount || typeof amount !== 'number' || amount <= 0) {
    throw new ValidationError('amount مطلوب ويجب أن يكون أكبر من صفر')
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// transferExternal — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} developerId
 * @param {object} input
 * @param {string} input.idempotency_key
 * @param {string} input.from_wallet_id
 * @param {string} input.to_address      - عنوان Ethereum خارجي
 * @param {number} input.amount
 * @param {string} input.description     - اختياري
 * @returns {{ transaction_id: string, balance: number, tx_hash: string }}
 */
export async function transferExternal(developerId, input) {
  const source = 'transfer/external.js'
  const {
    idempotency_key,
    from_wallet_id,
    to_address,
    amount,
    description = '',
  } = input

  // ── ١. التحقق من البيانات ──────────────────────────────────────────────
  validateInput({ idempotency_key, from_wallet_id, to_address, amount })

  // ── ٢. التحقق من الرصيد ───────────────────────────────────────────────
  const { balance } = await verifyBalance(from_wallet_id, developerId, amount)

  // ── ٣. idempotency ────────────────────────────────────────────────────
  await checkAndReserve(idempotency_key, from_wallet_id)

  try {
    // ── ٤. تسجيل الـ transaction بحالة pending ────────────────────────
    // ملاحظة: في WALLET_MODE=erc6551 — هنا يُضاف إرسال USDC عبر البلوكشين
    const { data: transaction, error: txError } = await supabase
      .from('transactions')
      .insert({
        idempotency_key,
        wallet_id:    from_wallet_id,
        developer_id: developerId,
        direction:    'outbound',
        type:         'external',
        amount,
        fee:          0,
        net_amount:   amount,
        currency:     'USDC',
        counterparty: to_address,
        description:  description || `تحويل خارجي إلى ${to_address}`,
        status:       'pending',
        metadata:     { to_address },
      })
      .select('id')
      .single()

    if (txError) {
      throw new ExternalServiceError('Supabase', txError.message)
    }

    // ── ٥. خصم الرصيد وتأكيد الـ transaction في نفس الوقت ────────────
    const newBalance = Math.round((balance - amount) * 1_000_000) / 1_000_000

    const [updateResult, confirmResult] = await Promise.all([
      supabase.from('wallets')
        .update({ balance: newBalance })
        .eq('id', from_wallet_id),
      supabase.from('transactions')
        .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
        .eq('id', transaction.id),
    ])

    if (updateResult.error) {
      throw new ExternalServiceError('Supabase', updateResult.error.message)
    }
    if (confirmResult.error) {
      throw new ExternalServiceError('Supabase', confirmResult.error.message)
    }

    // ── ٦. إتمام الـ idempotency key ──────────────────────────────────
    await markComplete(idempotency_key, from_wallet_id, { transaction_id: transaction.id })

    // ── ٧. audit log ──────────────────────────────────────────────────
    await logger.audit(source, 'transfer.external.completed', {
      walletId:  from_wallet_id,
      actorId:   developerId,
      metadata:  { transaction_id: transaction.id, to_address, amount },
      status:    'success',
    })

    return {
      transaction_id: transaction.id,
      balance:        newBalance,
      tx_hash:        null, // يُملأ لما WALLET_MODE=erc6551
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
 * POST /transfer/external
 * Body: { idempotency_key, from_wallet_id, to_address, amount, description? }
 * يحتاج: auth middleware يضيف req.user
 */
export async function transferExternalHandler(req, res) {
  try {
    const result = await transferExternal(req.user.id, req.body)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

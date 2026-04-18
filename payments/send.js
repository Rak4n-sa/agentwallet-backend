/**
 * الملف: payments/send.js
 * وش يفعل: ينفّذ دفعة x402 من محفظة لـ API خارجي — يتحقق من الرصيد، يسجّل، يخصم
 * يستدعيه: HTTP POST /payments/send
 * يستدعي: payments/verify.js، shared/db.js، shared/logger.js، shared/idempotency.js، shared/errors.js، shared/tokenbound.js (لاحقاً لما WALLET_MODE=erc6551)
 * يحدّث DB: نعم — جدول transactions + جدول wallets
 * يطلق Supabase event: نعم — onTransactionCreated، onTransactionConfirmed
 * يسمع Supabase event: لا
 * idempotency: نعم — يمنع تنفيذ نفس الدفعة مرتين
 * rollback: لا — يُبنى في rollback/initiate.js
 * لو عدّلته يتأثر: rules/limits.js، events/onTransactionCreated.js، dashboard/overview.js
 */

import supabase                                        from '../shared/db.js'
import logger                                          from '../shared/logger.js'
import { checkAndReserve, markComplete, markFailed }   from '../shared/idempotency.js'
import { verifyBalance }                               from './verify.js'
import {
  ValidationError,
  ExternalServiceError,
  formatError,
} from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// Validation
// ══════════════════════════════════════════════════════════════════════════════

function validateInput({ idempotency_key, amount, service_url, wallet_id }) {
  if (!idempotency_key || typeof idempotency_key !== 'string') {
    throw new ValidationError('idempotency_key مطلوب')
  }
  if (!amount || typeof amount !== 'number' || amount <= 0) {
    throw new ValidationError('amount مطلوب ويجب أن يكون أكبر من صفر')
  }
  if (!service_url || typeof service_url !== 'string') {
    throw new ValidationError('service_url مطلوب')
  }
  if (!wallet_id || typeof wallet_id !== 'string') {
    throw new ValidationError('wallet_id مطلوب')
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// sendPayment — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} developerId
 * @param {object} input
 * @param {string} input.idempotency_key
 * @param {string} input.wallet_id
 * @param {number} input.amount
 * @param {string} input.service_url     - الـ API اللي يُدفع لها
 * @param {string} input.counterparty    - عنوان المستلم على البلوكشين
 * @param {string} input.description     - اختياري
 * @returns {{ transaction_id: string, balance: number }}
 */
export async function sendPayment(developerId, input) {
  const source = 'payments/send.js'
  const {
    idempotency_key,
    wallet_id,
    amount,
    service_url,
    counterparty = '',
    description  = '',
  } = input

  // ── ١. التحقق من البيانات ──────────────────────────────────────────────
  validateInput({ idempotency_key, amount, service_url, wallet_id })

  // ── ٢. التحقق من الرصيد ───────────────────────────────────────────────
  const { balance } = await verifyBalance(wallet_id, developerId, amount)

  // ── ٣. idempotency — يمنع تنفيذ نفس الدفعة مرتين ─────────────────────
  await checkAndReserve(idempotency_key, wallet_id)

  try {
    // ملاحظة: في WALLET_MODE=erc6551 — هنا يُضاف استدعاء x402 قبل تسجيل الـ transaction

    // ── ٤. تسجيل الـ transaction بحالة pending ────────────────────────────
    const { data: transaction, error: txError } = await supabase
      .from('transactions')
      .insert({
        idempotency_key,
        wallet_id,
        developer_id: developerId,
        direction:    'outbound',
        type:         'payment',
        amount,
        fee:          0,
        net_amount:   amount,
        currency:     'USDC',
        counterparty,
        service_url,
        description:  description || `دفعة لـ ${service_url}`,
        status:       'pending',
        metadata:     { service_url },
      })
      .select('id')
      .single()

    if (txError) {
      throw new ExternalServiceError('Supabase', txError.message)
    }

    // ── ٥+٦. خصم الرصيد وتأكيد الـ transaction في نفس الوقت ────────────────
    const newBalance = Math.round((balance - amount) * 1_000_000) / 1_000_000

    const [updateResult, confirmResult] = await Promise.all([
      supabase.from('wallets').update({ balance: newBalance }).eq('id', wallet_id),
      supabase.from('transactions').update({
        status:       'confirmed',
        confirmed_at: new Date().toISOString(),
      }).eq('id', transaction.id),
    ])

    if (updateResult.error) {
      throw new ExternalServiceError('Supabase', updateResult.error.message)
    }
    if (confirmResult.error) {
      throw new ExternalServiceError('Supabase', confirmResult.error.message)
    }

    // ── ٧. إتمام الـ idempotency key ──────────────────────────────────────
    await markComplete(idempotency_key, wallet_id, { transaction_id: transaction.id })

    // ── ٨. audit log ──────────────────────────────────────────────────────
    await logger.audit(source, 'payment.sent', {
      walletId:  wallet_id,
      actorId:   developerId,
      metadata:  { transaction_id: transaction.id, amount, service_url, counterparty },
      status:    'success',
    })

    return {
      transaction_id: transaction.id,
      balance:        newBalance,
    }

  } catch (err) {
    await markFailed(idempotency_key, wallet_id)
    throw err
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /payments/send
 * Body: { idempotency_key, wallet_id, amount, service_url, counterparty?, description? }
 * يحتاج: auth middleware يضيف req.user
 */
export async function sendPaymentHandler(req, res) {
  try {
    const result = await sendPayment(req.user.id, req.body)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

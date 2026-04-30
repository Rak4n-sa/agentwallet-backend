/**
 * الملف: receive/confirm.js
 * وش يفعل: يؤكد استلام دفعة onramp → يكتب transaction → يحدّث balance → Supabase يطلق event
 * يستدعيه: HTTP POST /wallets/:id/confirm (webhook من Transak/MoonPay)
 * يستدعي: shared/db.js، shared/logger.js، shared/idempotency.js، shared/errors.js
 * يحدّث DB: نعم — جدول transactions + جدول wallets
 * يطلق Supabase event: نعم — onTransactionConfirmed، onAgentFunded
 * يسمع Supabase event: لا
 * idempotency: نعم — يمنع تأكيد نفس الدفعة مرتين
 * rollback: لا
 * لو عدّلته يتأثر: events/onTransactionConfirmed.js، events/onAgentFunded.js، dashboard/overview.js
 */

import supabase                        from '../shared/db.js'
import logger                          from '../shared/logger.js'
import { calcDepositFee }              from '../shared/fees.js'
import { checkAndReserve, markComplete, markFailed } from '../shared/idempotency.js'
import {
  ValidationError,
  NotFoundError,
  ExternalServiceError,
  formatError,
} from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// Validation
// ══════════════════════════════════════════════════════════════════════════════

function validateInput({ idempotency_key, amount, tx_hash, provider }) {
  if (!idempotency_key || typeof idempotency_key !== 'string') {
    throw new ValidationError('idempotency_key مطلوب')
  }
  if (!amount || typeof amount !== 'number' || amount <= 0) {
    throw new ValidationError('amount مطلوب ويجب أن يكون أكبر من صفر')
  }
  if (!tx_hash || typeof tx_hash !== 'string') {
    throw new ValidationError('tx_hash مطلوب')
  }
  if (!provider || typeof provider !== 'string') {
    throw new ValidationError('provider مطلوب (transak أو moonpay)')
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// confirmPayment — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} walletId
 * @param {string} developerId
 * @param {object} input
 * @param {string} input.idempotency_key
 * @param {number} input.amount
 * @param {string} input.tx_hash
 * @param {string} input.provider        - transak | moonpay
 * @param {string} input.description     - اختياري
 * @returns {{ transaction_id: string, balance: number }}
 */
export async function confirmPayment(walletId, developerId, input) {
  const source = 'receive/confirm.js'
  const { idempotency_key, amount, tx_hash, provider, description = '' } = input

  // ── ١. التحقق من البيانات ──────────────────────────────────────────────
  validateInput({ idempotency_key, amount, tx_hash, provider })

  // ── ٢. التحقق إن الـ wallet موجود ويخص هذا المطور ───────────────────
  const { data: wallet, error: fetchError } = await supabase
    .from('wallets')
    .select('id, balance, developer_id')
    .eq('id', walletId)
    .eq('developer_id', developerId)
    .single()

  if (fetchError) {
    throw new ExternalServiceError('Supabase', fetchError.message)
  }
  if (!wallet) {
    throw new NotFoundError('محفظة')
  }

  // ── ٣. idempotency — يمنع تأكيد نفس الدفعة مرتين ────────────────────
  await checkAndReserve(idempotency_key, walletId)

  try {
    // ── ٤. حساب الرسوم والمبلغ الصافي ────────────────────────────────────
    const depositFee = calcDepositFee(amount)
    const netAmount  = Math.round((amount - depositFee) * 1_000_000) / 1_000_000

    // ── ٥. كتابة الـ transaction في DB ────────────────────────────────────
    const { data: transaction, error: txError } = await supabase
      .from('transactions')
      .insert({
        idempotency_key,
        wallet_id:    walletId,
        developer_id: developerId,
        direction:    'inbound',
        type:         'onramp',
        amount,
        fee:          depositFee,
        net_amount:   netAmount,
        currency:     'USDC',
        counterparty: provider,
        description:  description || `دفعة من ${provider}`,
        status:       'confirmed',
        tx_hash,
        metadata:     { provider, deposit_fee: depositFee },
        confirmed_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (txError) {
      throw new ExternalServiceError('Supabase', txError.message)
    }

    // ── ٦. تحديث الرصيد في wallets (صافي بعد الرسوم) ─────────────────────
    const newBalance = Math.round((wallet.balance + netAmount) * 1_000_000) / 1_000_000

    const { error: updateError } = await supabase
      .from('wallets')
      .update({ balance: newBalance })
      .eq('id', walletId)

    if (updateError) {
      throw new ExternalServiceError('Supabase', updateError.message)
    }

    // ── ٧. تسجيل ربح المنصة ──────────────────────────────────────────────
    await supabase.from('platform_earnings').insert({
      transaction_id: transaction.id,
      wallet_id:      walletId,
      developer_id:   developerId,
      fee_type:       'deposit',
      gross_amount:   amount,
      fee_amount:     depositFee,
      fee_rate:       process.env.DEPOSIT_FEE_RATE ?? 0.005,
    })

    // ── ٨. إتمام الـ idempotency key ──────────────────────────────────────
    await markComplete(idempotency_key, walletId, { transaction_id: transaction.id })

    // ── ٨. audit log ──────────────────────────────────────────────────────
    await logger.audit(source, 'payment.confirmed', {
      walletId,
      actorId:  developerId,
      metadata: { transaction_id: transaction.id, amount, depositFee, netAmount, provider, tx_hash },
      status:   'success',
    })

    return {
      transaction_id: transaction.id,
      balance:        newBalance,
      fee:            depositFee,
    }

  } catch (err) {
    // لو الخطأ صار قبل الـ blockchain — نحرر الـ key للمحاولة مرة ثانية
    await markFailed(idempotency_key, walletId)
    throw err
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /wallets/:id/confirm
 * Body: { idempotency_key, amount, tx_hash, provider, description? }
 * يحتاج: auth middleware يضيف req.user
 */
export async function confirmPaymentHandler(req, res) {
  try {
    const result = await confirmPayment(req.params.id, req.user.id, req.body)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

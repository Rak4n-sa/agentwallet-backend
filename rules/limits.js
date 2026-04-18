/**
 * الملف: rules/limits.js
 * وش يفعل: يتحقق إن الـ transaction لا تتجاوز الحد الأقصى المضبوط لكل محفظة
 * يستدعيه: events/onTransactionCreated.js
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: لا
 * يسمع Supabase event: نعم — onTransactionCreated
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: events/onTransactionCreated.js، rules/budget.js
 */

import supabase                              from '../shared/db.js'
import logger                                from '../shared/logger.js'
import { LimitExceededError, ExternalServiceError, NotFoundError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// checkTransactionLimit — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * يتحقق إن مبلغ الـ transaction لا يتجاوز الحد الأقصى للمحفظة
 *
 * @param {string} walletId
 * @param {number} amount
 * @returns {{ allowed: boolean }}
 * @throws {LimitExceededError} لو تجاوز الحد
 */
export async function checkTransactionLimit(walletId, amount) {
  const source = 'rules/limits.js'

  // ── ١. جلب الـ limit المضبوط للمحفظة ─────────────────────────────────
  const { data: limit, error: fetchError } = await supabase
    .from('wallet_limits')
    .select('max_transaction_amount')
    .eq('wallet_id', walletId)
    .maybeSingle()

  if (fetchError) {
    throw new ExternalServiceError('Supabase', fetchError.message)
  }

  // ── ٢. لو ما في limit مضبوط — مسموح ──────────────────────────────────
  if (!limit || limit.max_transaction_amount === null) {
    return { allowed: true }
  }

  // ── ٣. التحقق من الحد ────────────────────────────────────────────────
  if (amount > limit.max_transaction_amount) {
    logger.warn(source, 'تجاوز الحد الأقصى للمعاملة', {
      walletId,
      amount,
      max: limit.max_transaction_amount,
    })
    throw new LimitExceededError('الحد الأقصى للمعاملة الواحدة')
  }

  return { allowed: true }
}

// ══════════════════════════════════════════════════════════════════════════════
// setTransactionLimit — يضبط أو يحدّث الحد الأقصى
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} walletId
 * @param {string} developerId
 * @param {number} maxAmount
 * @returns {{ wallet_id: string, max_transaction_amount: number }}
 */
export async function setTransactionLimit(walletId, developerId, maxAmount) {
  const source = 'rules/limits.js'

  // ── ١. التحقق إن المحفظة تخص هذا المطور ─────────────────────────────
  const { data: wallet, error: walletError } = await supabase
    .from('wallets')
    .select('id')
    .eq('id', walletId)
    .eq('developer_id', developerId)
    .single()

  if (walletError) {
    throw new ExternalServiceError('Supabase', walletError.message)
  }
  if (!wallet) {
    throw new NotFoundError('محفظة')
  }

  // ── ٢. upsert الـ limit ───────────────────────────────────────────────
  const { data, error: upsertError } = await supabase
    .from('wallet_limits')
    .upsert({
      wallet_id:              walletId,
      max_transaction_amount: maxAmount,
    }, { onConflict: 'wallet_id' })
    .select()
    .single()

  if (upsertError) {
    throw new ExternalServiceError('Supabase', upsertError.message)
  }

  logger.info(source, 'transaction limit تم ضبطه', { walletId, maxAmount })

  return {
    wallet_id:              walletId,
    max_transaction_amount: data.max_transaction_amount,
  }
}

/**
 * الملف: rules/budget.js
 * وش يفعل: يتحقق إن الإنفاق اليومي/الشهري لم يتجاوز الميزانية المضبوطة للمحفظة
 * يستدعيه: events/onTransactionCreated.js
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: نعم — يحدّث agent_limits → Supabase يطلق onLimitExceeded
 * يسمع Supabase event: نعم — onTransactionCreated
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: rules/autoStop.js، events/onLimitExceeded.js، notifications/limit.js
 */

import supabase                                              from '../shared/db.js'
import logger                                                from '../shared/logger.js'
import { LimitExceededError, ExternalServiceError, NotFoundError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// checkBudget — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * يتحقق إن الإنفاق اليومي/الشهري لم يتجاوز الميزانية
 *
 * @param {string} walletId
 * @param {number} amount
 * @returns {{ allowed: boolean }}
 * @throws {LimitExceededError} لو تجاوز الميزانية
 */
export async function checkBudget(walletId, amount) {
  const source = 'rules/budget.js'

  // ── ١. جلب الميزانية المضبوطة ─────────────────────────────────────────
  const { data: limits, error: limitsError } = await supabase
    .from('wallet_limits')
    .select('daily_budget, monthly_budget, is_active')
    .eq('wallet_id', walletId)
    .maybeSingle()

  if (limitsError) {
    throw new ExternalServiceError('Supabase', limitsError.message)
  }

  // لو ما في limits أو غير مفعّلة — مسموح
  if (!limits || !limits.is_active) {
    return { allowed: true }
  }

  // ── ٢. حساب الإنفاق اليومي الحالي ────────────────────────────────────
  if (limits.daily_budget !== null) {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)

    const { data: dailyTxs, error: dailyError } = await supabase
      .from('transactions')
      .select('amount')
      .eq('wallet_id', walletId)
      .eq('direction', 'outbound')
      .eq('status', 'confirmed')
      .gte('created_at', startOfDay.toISOString())

    if (dailyError) {
      throw new ExternalServiceError('Supabase', dailyError.message)
    }

    const dailySpent = (dailyTxs ?? []).reduce((sum, tx) => sum + tx.amount, 0)

    if (dailySpent + amount > limits.daily_budget) {
      logger.warn(source, 'تجاوز الميزانية اليومية', {
        walletId,
        dailySpent,
        amount,
        dailyBudget: limits.daily_budget,
      })

      await flagLimitExceeded(walletId, 'daily')
      throw new LimitExceededError('الميزانية اليومية')
    }
  }

  // ── ٣. حساب الإنفاق الشهري الحالي ────────────────────────────────────
  if (limits.monthly_budget !== null) {
    const startOfMonth = new Date()
    startOfMonth.setDate(1)
    startOfMonth.setHours(0, 0, 0, 0)

    const { data: monthlyTxs, error: monthlyError } = await supabase
      .from('transactions')
      .select('amount')
      .eq('wallet_id', walletId)
      .eq('direction', 'outbound')
      .eq('status', 'confirmed')
      .gte('created_at', startOfMonth.toISOString())

    if (monthlyError) {
      throw new ExternalServiceError('Supabase', monthlyError.message)
    }

    const monthlySpent = (monthlyTxs ?? []).reduce((sum, tx) => sum + tx.amount, 0)

    if (monthlySpent + amount > limits.monthly_budget) {
      logger.warn(source, 'تجاوز الميزانية الشهرية', {
        walletId,
        monthlySpent,
        amount,
        monthlyBudget: limits.monthly_budget,
      })

      await flagLimitExceeded(walletId, 'monthly')
      throw new LimitExceededError('الميزانية الشهرية')
    }
  }

  return { allowed: true }
}

// ══════════════════════════════════════════════════════════════════════════════
// flagLimitExceeded — يحدّث agent_limits → Supabase يطلق onLimitExceeded
// ══════════════════════════════════════════════════════════════════════════════

async function flagLimitExceeded(walletId, type) {
  const { error } = await supabase
    .from('agent_limits')
    .upsert({
      wallet_id:  walletId,
      limit_type: type,
      status:     'exceeded',
      exceeded_at: new Date().toISOString(),
    }, { onConflict: 'wallet_id, limit_type' })

  if (error) {
    // نسجّل تحذير بدون ما نوقف العملية — الأهم إن الـ LimitExceededError اتطلع
    logger.warn('rules/budget.js', 'فشل تحديث agent_limits', { walletId, type, error: error.message })
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// setBudget — يضبط أو يحدّث الميزانية
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} walletId
 * @param {string} developerId
 * @param {object} budget
 * @param {number} budget.daily_budget    - اختياري
 * @param {number} budget.monthly_budget  - اختياري
 * @returns {{ wallet_id: string, daily_budget: number, monthly_budget: number }}
 */
export async function setBudget(walletId, developerId, budget) {
  const source = 'rules/budget.js'

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

  // ── ٢. upsert الميزانية ───────────────────────────────────────────────
  const payload = { wallet_id: walletId, is_active: true }
  if (budget.daily_budget   !== undefined) payload.daily_budget   = budget.daily_budget
  if (budget.monthly_budget !== undefined) payload.monthly_budget = budget.monthly_budget

  const { data, error: upsertError } = await supabase
    .from('wallet_limits')
    .upsert(payload, { onConflict: 'wallet_id' })
    .select()
    .single()

  if (upsertError) {
    throw new ExternalServiceError('Supabase', upsertError.message)
  }

  logger.info(source, 'budget تم ضبطه', { walletId, budget })

  return {
    wallet_id:      walletId,
    daily_budget:   data.daily_budget,
    monthly_budget: data.monthly_budget,
  }
}

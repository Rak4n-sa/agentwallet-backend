/**
 * الملف: dashboard/walletProfile.js
 * وش يفعل: يرجع ملف مالي كامل لمحفظة واحدة — transactions، إحصائيات، rules، تجاوزات
 * يستدعيه: HTTP GET /dashboard/wallet/:id
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: الـ frontend اللي يعرض صفحة تفاصيل المحفظة
 */

import supabase from '../shared/db.js'
import logger   from '../shared/logger.js'
import { ExternalServiceError, NotFoundError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

/** يقرّب الرقم لخانتين عشريتين */
function round2(n) {
  return Math.round(n * 100) / 100
}

/** يرجع بداية اليوم الحالي بصيغة ISO */
function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

/** يرجع بداية الشهر الحالي بصيغة ISO */
function startOfMonth() {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

// ══════════════════════════════════════════════════════════════════════════════
// getWalletProfile — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} walletId
 * @param {string} developerId
 * @returns {{
 *   wallet:          { id, name, description, balance, tba_address, is_active, created_at },
 *   totals:          { total_received, total_spent, net_balance, tx_count },
 *   top_apis:        { service_url, count, total_spent }[],
 *   rules:           { max_transaction_amount, daily_budget, monthly_budget, is_active } | null,
 *   budget_usage:    { daily_spent, daily_budget, daily_pct, monthly_spent, monthly_budget, monthly_pct },
 *   limit_exceeded_count: number,
 *   last_auto_stop:  string | null,
 * }}
 */
export async function getWalletProfile(walletId, developerId) {
  const source = 'dashboard/walletProfile.js'

  // ── ١. جلب بيانات المحفظة والتحقق من الملكية ──────────────────────────
  const { data: wallet, error: walletError } = await supabase
    .from('wallets')
    .select('id, name, description, balance, tba_address, is_active, created_at')
    .eq('id', walletId)
    .eq('developer_id', developerId)
    .single()

  if (walletError) {
    throw new ExternalServiceError('Supabase', walletError.message)
  }
  if (!wallet) {
    throw new NotFoundError('محفظة')
  }

  // ── ٢. جلب كل الـ transactions المؤكدة ───────────────────────────────
  const { data: transactions, error: txError } = await supabase
    .from('transactions')
    .select('direction, type, amount, service_url, created_at')
    .eq('wallet_id', walletId)
    .eq('status', 'confirmed')

  if (txError) {
    throw new ExternalServiceError('Supabase', txError.message)
  }

  const txList = transactions ?? []

  // ── ٣. حساب الإجماليات ────────────────────────────────────────────────
  let totalReceived = 0
  let totalSpent    = 0

  for (const tx of txList) {
    if (tx.direction === 'inbound') {
      totalReceived += tx.amount
    } else if (tx.direction === 'outbound') {
      totalSpent += tx.amount
    }
  }

  const totals = {
    total_received: round2(totalReceived),
    total_spent:    round2(totalSpent),
    net_balance:    round2(totalReceived - totalSpent),
    tx_count:       txList.length,
  }

  // ── ٤. أكثر API استخداماً (outbound payments فقط) ────────────────────
  const apiMap = {}

  for (const tx of txList) {
    if (tx.direction !== 'outbound' || !tx.service_url) continue
    if (!apiMap[tx.service_url]) {
      apiMap[tx.service_url] = { service_url: tx.service_url, count: 0, total_spent: 0 }
    }
    apiMap[tx.service_url].count++
    apiMap[tx.service_url].total_spent = round2(apiMap[tx.service_url].total_spent + tx.amount)
  }

  // نرتّبهم من الأكثر استخداماً — أعلى 5
  const top_apis = Object.values(apiMap)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)

  // ── ٥. Rules المضبوطة ─────────────────────────────────────────────────
  const { data: limits, error: limitsError } = await supabase
    .from('wallet_limits')
    .select('max_transaction_amount, daily_budget, monthly_budget, is_active')
    .eq('wallet_id', walletId)
    .maybeSingle()

  if (limitsError) {
    throw new ExternalServiceError('Supabase', limitsError.message)
  }

  // ── ٦. نسبة استهلاك الميزانية ─────────────────────────────────────────
  // نحسب الإنفاق اليومي والشهري من الـ transactions
  const todayStart = startOfToday()
  const monthStart = startOfMonth()

  let dailySpent   = 0
  let monthlySpent = 0

  for (const tx of txList) {
    if (tx.direction !== 'outbound') continue
    if (tx.created_at >= monthStart) monthlySpent += tx.amount
    if (tx.created_at >= todayStart) dailySpent   += tx.amount
  }

  const budget_usage = {
    daily_spent:    round2(dailySpent),
    daily_budget:   limits?.daily_budget   ?? null,
    daily_pct:      limits?.daily_budget
                      ? round2((dailySpent   / limits.daily_budget)   * 100)
                      : null,
    monthly_spent:  round2(monthlySpent),
    monthly_budget: limits?.monthly_budget ?? null,
    monthly_pct:    limits?.monthly_budget
                      ? round2((monthlySpent / limits.monthly_budget) * 100)
                      : null,
  }

  // ── ٧. عدد مرات تجاوز الحد ───────────────────────────────────────────
  const { count: limitExceededCount, error: limitError } = await supabase
    .from('notification_logs')
    .select('id', { count: 'exact', head: true })
    .eq('wallet_id', walletId)
    .eq('type', 'limit_exceeded')

  if (limitError) {
    throw new ExternalServiceError('Supabase', limitError.message)
  }

  // ── ٨. آخر مرة أُوقفت المحفظة تلقائياً ──────────────────────────────
  const { data: lastStop, error: stopError } = await supabase
    .from('notification_logs')
    .select('created_at')
    .eq('wallet_id', walletId)
    .eq('type', 'wallet_auto_stopped')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (stopError) {
    throw new ExternalServiceError('Supabase', stopError.message)
  }

  // ── ٩. تجميع النتيجة ──────────────────────────────────────────────────
  logger.info(source, 'wallet profile جُلب بنجاح', { walletId, txCount: txList.length })

  return {
    wallet,
    totals,
    top_apis,
    rules:                limits ?? null,
    budget_usage,
    limit_exceeded_count: limitExceededCount ?? 0,
    last_auto_stop:       lastStop?.created_at ?? null,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /dashboard/wallet/:id
 * يحتاج: auth middleware يضيف req.user
 */
export async function walletProfileHandler(req, res) {
  try {
    const result = await getWalletProfile(req.params.id, req.user.id)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

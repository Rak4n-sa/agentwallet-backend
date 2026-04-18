/**
 * الملف: dashboard/stats.js
 * وش يفعل: يرجع إحصائيات المطور — كسب، إنفاق، نشاط يومي وشهري، توزيع الـ transactions
 * يستدعيه: HTTP GET /dashboard/stats
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: الـ frontend اللي يعرض الرسوم البيانية
 */

import supabase from '../shared/db.js'
import logger from '../shared/logger.js'
import { ExternalServiceError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

/** يرجع تاريخ قبل N يوم بصيغة ISO */
function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

/** يرجع تاريخ قبل N شهر بصيغة ISO */
function monthsAgo(n) {
  const d = new Date()
  d.setMonth(d.getMonth() - n)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

/** يختصر ISO date لـ YYYY-MM-DD */
function toDateKey(isoString) {
  return isoString.slice(0, 10)
}

/** يختصر ISO date لـ YYYY-MM */
function toMonthKey(isoString) {
  return isoString.slice(0, 7)
}

// ══════════════════════════════════════════════════════════════════════════════
// getStats — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} developerId
 * @param {object} options
 * @param {number} options.dailyDays    - عدد أيام النشاط اليومي (default: 30)
 * @param {number} options.monthlyCount - عدد الأشهر (default: 12)
 * @returns {{
 *   summary:     { totalEarnings, totalSpent, totalTransactions, netBalance },
 *   daily:       { date, earnings, spent, count }[],
 *   monthly:     { month, earnings, spent, count }[],
 *   byType:      { type, count, total }[],
 * }}
 */
export async function getStats(developerId, options = {}) {
  const source     = 'dashboard/stats.js'
  const dailyDays  = options.dailyDays    ?? 30
  const monthCount = options.monthlyCount ?? 12

  // ── ١. جلب IDs الـ wallets الخاصة بالمطور ────────────────────────────
  const { data: wallets, error: walletsError } = await supabase
    .from('wallets')
    .select('id')
    .eq('developer_id', developerId)

  if (walletsError) {
    throw new ExternalServiceError('Supabase', walletsError.message)
  }

  const walletIds = (wallets ?? []).map(w => w.id)

  // مطور جديد بدون wallets
  if (walletIds.length === 0) {
    return buildEmptyStats()
  }

  // ── ٢. جلب كل الـ transactions المؤكدة ─────────────────────────────────
  const { data: transactions, error: txError } = await supabase
    .from('transactions')
    .select('amount, type, created_at')
    .in('wallet_id', walletIds)
    .eq('status', 'confirmed')
    .gte('created_at', monthsAgo(monthCount))
    .order('created_at', { ascending: true })

  if (txError) {
    throw new ExternalServiceError('Supabase', txError.message)
  }

  const txList = transactions ?? []

  // ── ٣. حساب الـ summary ───────────────────────────────────────────────
  let totalEarnings = 0
  let totalSpent    = 0

  for (const tx of txList) {
    if (tx.type === 'onramp') {
      totalEarnings += tx.amount
    } else if (tx.type === 'payment' || tx.type === 'transfer') {
      totalSpent += tx.amount
    }
  }

  const summary = {
    totalEarnings:    round2(totalEarnings),
    totalSpent:       round2(totalSpent),
    totalTransactions: txList.length,
    netBalance:       round2(totalEarnings - totalSpent),
  }

  // ── ٤. النشاط اليومي — آخر N يوم ─────────────────────────────────────
  const dailyCutoff  = daysAgo(dailyDays)
  const dailyMap     = {}

  // نهيّئ كل الأيام بـ 0 مسبقاً — عشان الأيام الفارغة تظهر في الـ chart
  for (let i = dailyDays - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const key = toDateKey(d.toISOString())
    dailyMap[key] = { date: key, earnings: 0, spent: 0, count: 0 }
  }

  for (const tx of txList) {
    if (tx.created_at < dailyCutoff) continue
    const key = toDateKey(tx.created_at)
    if (!dailyMap[key]) continue

    dailyMap[key].count++
    if (tx.type === 'onramp') {
      dailyMap[key].earnings = round2(dailyMap[key].earnings + tx.amount)
    } else if (tx.type === 'payment' || tx.type === 'transfer') {
      dailyMap[key].spent = round2(dailyMap[key].spent + tx.amount)
    }
  }

  const daily = Object.values(dailyMap)

  // ── ٥. النشاط الشهري — آخر N شهر ────────────────────────────────────
  const monthlyMap = {}

  for (let i = monthCount - 1; i >= 0; i--) {
    const d = new Date()
    d.setMonth(d.getMonth() - i)
    const key = toMonthKey(d.toISOString())
    monthlyMap[key] = { month: key, earnings: 0, spent: 0, count: 0 }
  }

  for (const tx of txList) {
    const key = toMonthKey(tx.created_at)
    if (!monthlyMap[key]) continue

    monthlyMap[key].count++
    if (tx.type === 'onramp') {
      monthlyMap[key].earnings = round2(monthlyMap[key].earnings + tx.amount)
    } else if (tx.type === 'payment' || tx.type === 'transfer') {
      monthlyMap[key].spent = round2(monthlyMap[key].spent + tx.amount)
    }
  }

  const monthly = Object.values(monthlyMap)

  // ── ٦. توزيع حسب النوع ────────────────────────────────────────────────
  const typeMap = {}
  for (const tx of txList) {
    if (!typeMap[tx.type]) {
      typeMap[tx.type] = { type: tx.type, count: 0, total: 0 }
    }
    typeMap[tx.type].count++
    typeMap[tx.type].total = round2(typeMap[tx.type].total + tx.amount)
  }
  const byType = Object.values(typeMap)

  logger.info(source, 'stats جُلبت بنجاح', {
    developerId,
    txCount: txList.length,
  })

  return { summary, daily, monthly, byType }
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers داخلية
// ══════════════════════════════════════════════════════════════════════════════

function round2(n) {
  return Math.round(n * 100) / 100
}

function buildEmptyStats() {
  return {
    summary: { totalEarnings: 0, totalSpent: 0, totalTransactions: 0, netBalance: 0 },
    daily:   [],
    monthly: [],
    byType:  [],
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /dashboard/stats
 * Query params: dailyDays (default 30)، monthlyCount (default 12)
 * يحتاج: API Key في الـ header (x-api-key)
 */
export async function statsHandler(req, res) {
  try {
    const options = {
      dailyDays:    parseInt(req.query.dailyDays)    || 30,
      monthlyCount: parseInt(req.query.monthlyCount) || 12,
    }
    const result = await getStats(req.user.id, options)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

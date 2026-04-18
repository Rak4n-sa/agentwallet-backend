/**
 * الملف: dashboard/overview.js
 * وش يفعل: يجمع إحصائيات المطور — رصيد كل محفظة، إجمالي الكسب والإنفاق، عدد المحافظ
 * يستدعيه: HTTP GET /dashboard/overview، events/onTransactionConfirmed.js، events/onAgentFunded.js
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: الـ frontend اللي يعرض الـ dashboard
 */

import supabase from '../shared/db.js'
import logger from '../shared/logger.js'
import { ExternalServiceError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// getOverview — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} developerId
 * @returns {{
 *   wallets:        { id, name, balance, txCount, isActive }[],
 *   totalEarnings:  number,
 *   totalSpent:     number,
 *   activeWallets:  number,
 * }}
 */
export async function getOverview(developerId) {
  const source = 'dashboard/overview.js'

  // ── ١. جلب كل محافظ المطور ────────────────────────────────────────────
  const { data: wallets, error: walletsError } = await supabase
    .from('wallets')
    .select('id, name, balance, is_active')
    .eq('developer_id', developerId)
    .order('created_at', { ascending: false })

  if (walletsError) {
    throw new ExternalServiceError('Supabase', walletsError.message)
  }

  if (!wallets || wallets.length === 0) {
    return { wallets: [], totalEarnings: 0, totalSpent: 0, activeWallets: 0 }
  }

  const walletIds = wallets.map(w => w.id)

  // ── ٢. جلب عدد الـ transactions لكل محفظة ────────────────────────────
  const { data: txCounts, error: txError } = await supabase
    .from('transactions')
    .select('wallet_id')
    .in('wallet_id', walletIds)
    .eq('status', 'confirmed')

  if (txError) {
    throw new ExternalServiceError('Supabase', txError.message)
  }

  const txCountMap = {}
  for (const tx of txCounts ?? []) {
    txCountMap[tx.wallet_id] = (txCountMap[tx.wallet_id] ?? 0) + 1
  }

  // ── ٣. حساب الإجماليات ────────────────────────────────────────────────
  const { data: earnings, error: earningsError } = await supabase
    .from('transactions')
    .select('amount, type')
    .in('wallet_id', walletIds)
    .eq('status', 'confirmed')

  if (earningsError) {
    throw new ExternalServiceError('Supabase', earningsError.message)
  }

  let totalEarnings = 0
  let totalSpent    = 0

  for (const tx of earnings ?? []) {
    if (tx.type === 'onramp') {
      totalEarnings += tx.amount
    } else if (tx.type === 'payment' || tx.type === 'transfer') {
      totalSpent += tx.amount
    }
  }

  // ── ٤. تجميع النتيجة ──────────────────────────────────────────────────
  const walletsWithStats = wallets.map(w => ({
    id:       w.id,
    name:     w.name,
    balance:  w.balance ?? 0,
    txCount:  txCountMap[w.id] ?? 0,
    isActive: w.is_active,
  }))

  logger.info(source, 'overview جُلب بنجاح', {
    developerId,
    walletCount: wallets.length,
  })

  return {
    wallets:       walletsWithStats,
    totalEarnings: Math.round(totalEarnings * 100) / 100,
    totalSpent:    Math.round(totalSpent    * 100) / 100,
    activeWallets: wallets.filter(w => w.is_active).length,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// refreshOverview — يُستدعى من events عند كل تغيير
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} walletId - ID المحفظة اللي تغيّرت
 */
export async function refreshOverview(walletId) {
  const source = 'dashboard/overview.js'

  const { data: wallet, error } = await supabase
    .from('wallets')
    .select('developer_id')
    .eq('id', walletId)
    .single()

  if (error || !wallet) {
    logger.warn(source, 'refreshOverview: محفظة غير موجودة', { walletId })
    return
  }

  await getOverview(wallet.developer_id)
  logger.info(source, 'overview تم تحديثه', { walletId })
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /dashboard/overview
 * يحتاج: auth middleware يضيف req.user
 */
export async function overviewHandler(req, res) {
  try {
    const result = await getOverview(req.user.id)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

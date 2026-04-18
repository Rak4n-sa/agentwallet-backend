/**
 * الملف: payments/history.js
 * وش يفعل: يرجع سجل المدفوعات لمحفظة معينة مع pagination وفلاتر
 * يستدعيه: HTTP GET /payments/history
 * يستدعي: shared/db.js، shared/errors.js
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: dashboard/transactions.js
 */

import supabase                                              from '../shared/db.js'
import { ValidationError, ExternalServiceError, NotFoundError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// getPaymentHistory — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} developerId
 * @param {object} options
 * @param {string}  options.wallet_id  - إلزامي
 * @param {number}  options.page       - default: 1
 * @param {number}  options.limit      - default: 20، max: 100
 * @param {string}  options.status     - اختياري: pending | confirmed | failed | rolled_back
 * @param {string}  options.type       - اختياري: payment | transfer | onramp | external | rollback
 * @param {string}  options.from       - اختياري: ISO date
 * @param {string}  options.to         - اختياري: ISO date
 * @returns {{ transactions: object[], total: number, page: number, limit: number }}
 */
export async function getPaymentHistory(developerId, options = {}) {
  const {
    wallet_id,
    page  = 1,
    limit = 20,
    status,
    type,
    from,
    to,
  } = options

  // ── ١. التحقق من البيانات ──────────────────────────────────────────────
  if (!wallet_id) {
    throw new ValidationError('wallet_id مطلوب')
  }

  const safePage  = Math.max(1, parseInt(page)  || 1)
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit) || 20))
  const offset    = (safePage - 1) * safeLimit

  // ── ٢. التحقق إن المحفظة تخص هذا المطور ─────────────────────────────
  const { data: wallet, error: walletError } = await supabase
    .from('wallets')
    .select('id')
    .eq('id', wallet_id)
    .eq('developer_id', developerId)
    .single()

  if (walletError) {
    throw new ExternalServiceError('Supabase', walletError.message)
  }
  if (!wallet) {
    throw new NotFoundError('محفظة')
  }

  // ── ٣. بناء الـ query مع الفلاتر ─────────────────────────────────────
  let query = supabase
    .from('transactions')
    .select('*', { count: 'exact' })
    .eq('wallet_id', wallet_id)
    .order('created_at', { ascending: false })
    .range(offset, offset + safeLimit - 1)

  if (status) query = query.eq('status', status)
  if (type)   query = query.eq('type', type)
  if (from)   query = query.gte('created_at', from)
  if (to)     query = query.lte('created_at', to)

  const { data: transactions, error: txError, count } = await query

  if (txError) {
    throw new ExternalServiceError('Supabase', txError.message)
  }

  return {
    transactions: transactions ?? [],
    total:        count ?? 0,
    page:         safePage,
    limit:        safeLimit,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /payments/history
 * Query: wallet_id، page، limit، status، type، from، to
 * يحتاج: auth middleware يضيف req.user
 */
export async function paymentHistoryHandler(req, res) {
  try {
    const result = await getPaymentHistory(req.user.id, {
      wallet_id: req.query.wallet_id,
      page:      req.query.page,
      limit:     req.query.limit,
      status:    req.query.status,
      type:      req.query.type,
      from:      req.query.from,
      to:        req.query.to,
    })
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

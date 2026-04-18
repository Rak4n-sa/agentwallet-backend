/**
 * الملف: rollback/log.js
 * وش يفعل: يرجع سجل الـ rollbacks لمحفظة معينة مع pagination
 * يستدعيه: HTTP GET /rollback/log
 * يستدعي: shared/db.js، shared/errors.js
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: dashboard/transactions.js
 */

import supabase                                                        from '../shared/db.js'
import { ValidationError, NotFoundError, ExternalServiceError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// getRollbackLog — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} developerId
 * @param {object} options
 * @param {string}  options.wallet_id  - إلزامي
 * @param {number}  options.page       - default: 1
 * @param {number}  options.limit      - default: 20، max: 100
 * @param {string}  options.status     - اختياري: pending | completed | failed
 * @returns {{ rollbacks: object[], total: number, page: number, limit: number }}
 */
export async function getRollbackLog(developerId, options = {}) {
  const { wallet_id, page = 1, limit = 20, status } = options

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

  // ── ٣. جلب الـ rollbacks ──────────────────────────────────────────────
  let query = supabase
    .from('rollbacks')
    .select('*', { count: 'exact' })
    .eq('wallet_id', wallet_id)
    .order('created_at', { ascending: false })
    .range(offset, offset + safeLimit - 1)

  if (status) query = query.eq('status', status)

  const { data: rollbacks, error: rollbacksError, count } = await query

  if (rollbacksError) {
    throw new ExternalServiceError('Supabase', rollbacksError.message)
  }

  return {
    rollbacks: rollbacks ?? [],
    total:     count ?? 0,
    page:      safePage,
    limit:     safeLimit,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /rollback/log
 * Query: wallet_id، page، limit، status
 * يحتاج: auth middleware يضيف req.user
 */
export async function rollbackLogHandler(req, res) {
  try {
    const result = await getRollbackLog(req.user.id, {
      wallet_id: req.query.wallet_id,
      page:      req.query.page,
      limit:     req.query.limit,
      status:    req.query.status,
    })
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

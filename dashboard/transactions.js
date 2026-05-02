/**
 * الملف: dashboard/transactions.js
 * وش يفعل: يرجع سجل transactions كامل للمطور مع pagination وفلترة
 * يستدعيه: HTTP GET /dashboard/transactions
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: الـ frontend اللي يعرض سجل الـ transactions
 */

import supabase from '../shared/db.js'
import logger from '../shared/logger.js'
import { ValidationError, ExternalServiceError, formatError } from '../shared/errors.js'

// ── ثوابت ────────────────────────────────────────────────────────────────────
const DEFAULT_LIMIT = 20
const MAX_LIMIT     = 100

// ══════════════════════════════════════════════════════════════════════════════
// getTransactions — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string}  developerId       - ID المطور (إلزامي)
 * @param {object}  filters           - فلاتر اختيارية
 * @param {string}  filters.walletId  - فلترة بـ wallet محددة
 * @param {string}  filters.type      - 'payment' | 'transfer' | 'onramp' | 'external' | 'rollback'
 * @param {string}  filters.status    - 'pending' | 'confirmed' | 'failed'
 * @param {string}  filters.from      - تاريخ البداية ISO (مثال: 2025-01-01)
 * @param {string}  filters.to        - تاريخ النهاية ISO
 * @param {number}  filters.page      - رقم الصفحة (يبدأ من 1)
 * @param {number}  filters.limit     - عدد النتائج في الصفحة (max 100)
 * @returns {{
 *   transactions: object[],
 *   pagination:   { page, limit, total, totalPages }
 * }}
 */
export async function getTransactions(developerId, filters = {}) {
  const source = 'dashboard/transactions.js'

  // ── ١. تحضير الـ pagination ────────────────────────────────────────────
  const page  = Math.max(1, parseInt(filters.page)  || 1)
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(filters.limit) || DEFAULT_LIMIT))
  const from  = (page - 1) * limit
  const to    = from + limit - 1

  // ── ٢. التحقق من الفلاتر ──────────────────────────────────────────────
  const validTypes    = ['payment', 'transfer', 'onramp', 'external', 'rollback']
  const validStatuses = ['pending', 'confirmed', 'failed']

  if (filters.type && !validTypes.includes(filters.type)) {
    throw new ValidationError(`type غير صحيح — القيم المقبولة: ${validTypes.join(', ')}`)
  }
  if (filters.status && !validStatuses.includes(filters.status)) {
    throw new ValidationError(`status غير صحيح — القيم المقبولة: ${validStatuses.join(', ')}`)
  }

  // ── ٣. جلب IDs الـ wallets الخاصة بالمطور ────────────────────────────
  // نتأكد إن المطور يشوف فقط transactions wallets حقته
  let walletIds

  if (filters.walletId) {
    // نتحقق إن الـ wallet تخص هذا المطور
    const { data: wallet, error } = await supabase
      .from('wallets')
      .select('id')
      .eq('id', filters.walletId)
      .eq('developer_id', developerId)
      .single()

    if (error) {
      throw new ExternalServiceError('Supabase', error.message)
    }
    if (!wallet) {
      throw new ValidationError('المحفظة غير موجودة أو لا تخصك')
    }
    walletIds = [filters.walletId]
  } else {
    // جلب كل wallets المطور
    const { data: wallets, error } = await supabase
      .from('wallets')
      .select('id')
      .eq('developer_id', developerId)

    if (error) {
      throw new ExternalServiceError('Supabase', error.message)
    }
    walletIds = (wallets ?? []).map(w => w.id)
  }

  // لو ما عنده wallets — نرجع فارغ
  if (walletIds.length === 0) {
    return {
      transactions: [],
      pagination:   { page, limit, total: 0, totalPages: 0 },
    }
  }

  // ── ٤. بناء الـ query ─────────────────────────────────────────────────
  let query = supabase
    .from('transactions')
    .select('id, wallet_id, amount, type, status, tx_hash, service_url, counterparty, description, created_at', { count: 'exact' })
    .in('wallet_id', walletIds)
    .order('created_at', { ascending: false })
    .range(from, to)

  // تطبيق الفلاتر الاختيارية
  if (filters.type)   query = query.eq('type',   filters.type)
  if (filters.status) query = query.eq('status', filters.status)
  if (filters.from)   query = query.gte('created_at', filters.from)
  if (filters.to)     query = query.lte('created_at', filters.to)

  // ── ٥. تنفيذ الـ query ────────────────────────────────────────────────
  const { data: transactions, error: txError, count } = await query

  if (txError) {
    throw new ExternalServiceError('Supabase', txError.message)
  }

  const total      = count ?? 0
  const totalPages = Math.ceil(total / limit)

  logger.info(source, 'transactions جُلبت بنجاح', {
    developerId,
    count: transactions?.length ?? 0,
    page,
  })

  return {
    transactions: transactions ?? [],
    pagination:   { page, limit, total, totalPages },
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /dashboard/transactions
 * Query params: walletId, type, status, from, to, page, limit
 * يحتاج: API Key في الـ header (x-api-key)
 */
export async function transactionsHandler(req, res) {
  try {
    const result = await getTransactions(req.user.id, req.query)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

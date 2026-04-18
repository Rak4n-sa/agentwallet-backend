/**
 * الملف: wallets/list.js
 * وش يفعل: يرجع كل المحافظ المرتبطة بحساب المطور
 * يستدعيه: HTTP GET /wallets
 * يستدعي: shared/db.js، shared/errors.js
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: dashboard/overview.js، أي ملف يعرض قائمة المحافظ
 */

import supabase from '../shared/db.js'
import { ExternalServiceError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// listWallets — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} developerId
 * @returns {{ wallets: object[] }}
 */
export async function listWallets(developerId) {
  const { data: wallets, error } = await supabase
    .from('wallets')
    .select()
    .eq('developer_id', developerId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })

  if (error) {
    throw new ExternalServiceError('Supabase', error.message)
  }

  return { wallets: wallets ?? [] }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /wallets
 * يحتاج: auth middleware يضيف req.user
 */
export async function listWalletsHandler(req, res) {
  try {
    const result = await listWallets(req.user.id)
    return res.status(200).json({ success: true, data: result.wallets })
  } catch (err) {
    return formatError(err, res)
  }
}

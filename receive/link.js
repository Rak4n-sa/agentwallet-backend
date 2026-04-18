/**
 * الملف: receive/link.js
 * وش يفعل: يرجع روابط الدفع للمحفظة — رابط للبشر (كارت) ورابط للـ agents (x402)
 * يستدعيه: HTTP GET /wallets/:id/link
 * يستدعي: shared/db.js، shared/errors.js
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: receive/widget.js، أي أداة تستخدم الرابط (n8n, LangChain, ...)
 */

import supabase                                              from '../shared/db.js'
import { ExternalServiceError, NotFoundError, formatError } from '../shared/errors.js'

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000'

// ══════════════════════════════════════════════════════════════════════════════
// getPaymentLinks — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} walletId
 * @param {string} developerId
 * @returns {{
 *   human_link:  string,
 *   agent_link:  string,
 *   tba_address: string,
 *   wallet_name: string,
 * }}
 */
export async function getPaymentLinks(walletId, developerId) {
  // ── ١. التحقق من الملكية وجلب البيانات ───────────────────────────────
  const { data: wallet, error: fetchError } = await supabase
    .from('wallets')
    .select('id, name, tba_address')
    .eq('id', walletId)
    .eq('developer_id', developerId)
    .single()

  if (fetchError) {
    throw new ExternalServiceError('Supabase', fetchError.message)
  }
  if (!wallet) {
    throw new NotFoundError('محفظة')
  }
  if (!wallet.tba_address) {
    throw new NotFoundError('TBA address — شغّل POST /wallets/:id/blockchain أولاً')
  }

  // ── ٢. بناء الروابط ───────────────────────────────────────────────────
  return {
    human_link:  `${APP_URL}/pay/${walletId}`,
    agent_link:  `${APP_URL}/x402/${walletId}`,
    tba_address: wallet.tba_address,
    wallet_name: wallet.name,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /wallets/:id/link
 * يحتاج: auth middleware يضيف req.user
 */
export async function paymentLinksHandler(req, res) {
  try {
    const result = await getPaymentLinks(req.params.id, req.user.id)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

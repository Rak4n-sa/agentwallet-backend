/**
 * الملف: payments/verify.js
 * وش يفعل: يتحقق إن الـ wallet عنده رصيد كافٍ قبل تنفيذ أي دفعة
 * يستدعيه: payments/send.js
 * يستدعي: shared/db.js، shared/errors.js
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: payments/send.js
 */

import supabase                                                        from '../shared/db.js'
import { ExternalServiceError, NotFoundError, InsufficientBalanceError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// verifyBalance — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} walletId
 * @param {string} developerId
 * @param {number} amount      - المبلغ المطلوب دفعه
 * @returns {{ balance: number }} - الرصيد الحالي لو كافٍ
 * @throws {InsufficientBalanceError} لو الرصيد غير كافٍ
 */
export async function verifyBalance(walletId, developerId, amount) {
  // ── ١. جلب الرصيد الحالي ──────────────────────────────────────────────
  const { data: wallet, error: fetchError } = await supabase
    .from('wallets')
    .select('id, balance')
    .eq('id', walletId)
    .eq('developer_id', developerId)
    .single()

  if (fetchError) {
    throw new ExternalServiceError('Supabase', fetchError.message)
  }
  if (!wallet) {
    throw new NotFoundError('محفظة')
  }

  // ── ٢. التحقق من الرصيد ───────────────────────────────────────────────
  const balance = wallet.balance ?? 0

  if (balance < amount) {
    throw new InsufficientBalanceError(amount, balance)
  }

  return { balance }
}

/**
 * الملف: wallets/create.js
 * وش يفعل: ينشئ محفظة جديدة تحت حساب المطور
 * يستدعيه: HTTP POST /wallets
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم — جدول wallets
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: wallets/list.js، dashboard/overview.js
 */

import supabase from '../shared/db.js'
import logger from '../shared/logger.js'
import { ValidationError, ExternalServiceError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// Validation
// ══════════════════════════════════════════════════════════════════════════════

function validateInput({ name, description }) {
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    throw new ValidationError('اسم المحفظة مطلوب ويجب أن يكون حرفين على الأقل')
  }
  if (name.trim().length > 50) {
    throw new ValidationError('اسم المحفظة لا يتجاوز 50 حرفاً')
  }
  if (description && description.length > 500) {
    throw new ValidationError('وصف المحفظة لا يتجاوز 500 حرف')
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// createWallet — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} developerId
 * @param {object} input
 * @param {string} input.name        - اسم المحفظة (إلزامي)
 * @param {string} input.description - وصف المحفظة (اختياري)
 * @returns {{ wallet }}
 */
export async function createWallet(developerId, { name, description = '' }) {
  const source = 'wallets/create.js'

  // ── ١. التحقق من البيانات ──────────────────────────────────────────────
  validateInput({ name, description })

  // ── ٢. إنشاء سجل wallet في DB ─────────────────────────────────────────
  const { data: wallet, error } = await supabase
    .from('wallets')
    .insert({
      developer_id: developerId,
      name:         name.trim(),
      description:  description.trim(),
      is_active:    true,
    })
    .select()
    .single()

  if (error) {
    throw new ExternalServiceError('Supabase', error.message)
  }

  // ── ٣. audit log ──────────────────────────────────────────────────────
  await logger.audit(source, 'wallet.created', {
    walletId: wallet.id,
    actorId:  developerId,
    metadata: { name: wallet.name },
    status:   'success',
  })

  return { wallet }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /wallets
 * Body: { name, description }
 * يحتاج: auth middleware يضيف req.user
 */
export async function createWalletHandler(req, res) {
  try {
    const { name, description } = req.body
    const result = await createWallet(req.user.id, { name, description })
    return res.status(201).json({ success: true, data: result.wallet })
  } catch (err) {
    return formatError(err, res)
  }
}

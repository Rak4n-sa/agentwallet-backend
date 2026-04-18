/**
 * الملف: wallets/update.js
 * وش يفعل: يعدّل بيانات محفظة موجودة (name, description, is_active)
 * يستدعيه: HTTP PATCH /wallets/:id
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
import { ValidationError, NotFoundError, ExternalServiceError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// Validation
// ══════════════════════════════════════════════════════════════════════════════

function validateInput({ name, description }) {
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length < 2) {
      throw new ValidationError('اسم المحفظة يجب أن يكون حرفين على الأقل')
    }
    if (name.trim().length > 50) {
      throw new ValidationError('اسم المحفظة لا يتجاوز 50 حرفاً')
    }
  }
  if (description !== undefined && description.length > 500) {
    throw new ValidationError('وصف المحفظة لا يتجاوز 500 حرف')
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// updateWallet — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} developerId
 * @param {string} walletId
 * @param {object} updates
 * @param {string}  updates.name        - اختياري
 * @param {string}  updates.description - اختياري
 * @param {boolean} updates.is_active   - اختياري
 * @returns {{ wallet }}
 */
export async function updateWallet(developerId, walletId, updates) {
  const source = 'wallets/update.js'

  // ── ١. التحقق من البيانات ──────────────────────────────────────────────
  validateInput(updates)

  // ── ٢. نتأكد إن المحفظة موجودة وتخص هذا المطور ──────────────────────
  const { data: existing, error: fetchError } = await supabase
    .from('wallets')
    .select('id')
    .eq('id', walletId)
    .eq('developer_id', developerId)
    .single()

  if (fetchError) {
    throw new ExternalServiceError('Supabase', fetchError.message)
  }
  if (!existing) {
    throw new NotFoundError('محفظة')
  }

  // ── ٣. بناء الـ update object — فقط الحقول المُرسلة ──────────────────
  const payload = {}
  if (updates.name        !== undefined) payload.name        = updates.name.trim()
  if (updates.description !== undefined) payload.description = updates.description.trim()
  if (updates.is_active   !== undefined) payload.is_active   = updates.is_active

  if (Object.keys(payload).length === 0) {
    throw new ValidationError('لم يُرسل أي حقل للتعديل')
  }

  // ── ٤. تنفيذ التعديل ──────────────────────────────────────────────────
  const { data: wallet, error: updateError } = await supabase
    .from('wallets')
    .update(payload)
    .eq('id', walletId)
    .select()
    .single()

  if (updateError) {
    throw new ExternalServiceError('Supabase', updateError.message)
  }

  // ── ٥. audit log ──────────────────────────────────────────────────────
  await logger.audit(source, 'wallet.updated', {
    walletId: wallet.id,
    actorId:  developerId,
    metadata: payload,
    status:   'success',
  })

  return { wallet }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * PATCH /wallets/:id
 * Body: { name?, description?, is_active? }
 * يحتاج: auth middleware يضيف req.user
 */
export async function updateWalletHandler(req, res) {
  try {
    const result = await updateWallet(req.user.id, req.params.id, req.body)
    return res.status(200).json({ success: true, data: result.wallet })
  } catch (err) {
    return formatError(err, res)
  }
}

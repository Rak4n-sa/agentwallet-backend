/**
 * الملف: agents/update.js
 * وش يفعل: يعدّل بيانات agent موجود (name, description, is_active)
 * يستدعيه: HTTP PATCH /agents/:id
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم — جدول agents
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: agents/list.js، dashboard/overview.js
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
      throw new ValidationError('اسم الـ agent يجب أن يكون حرفين على الأقل')
    }
    if (name.trim().length > 50) {
      throw new ValidationError('اسم الـ agent لا يتجاوز 50 حرفاً')
    }
  }
  if (description !== undefined && description.length > 500) {
    throw new ValidationError('وصف الـ agent لا يتجاوز 500 حرف')
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// updateAgent — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} developerId
 * @param {string} agentId
 * @param {object} updates
 * @param {string}  updates.name        - اختياري
 * @param {string}  updates.description - اختياري
 * @param {boolean} updates.is_active   - اختياري
 * @returns {{ agent }}
 */
export async function updateAgent(developerId, agentId, updates) {
  const source = 'agents/update.js'

  // ── ١. التحقق من البيانات ──────────────────────────────────────────────
  validateInput(updates)

  // ── ٢. نتأكد إن الـ agent موجود ويخص هذا المطور ──────────────────────
  const { data: existing, error: fetchError } = await supabase
    .from('agents')
    .select('id')
    .eq('id', agentId)
    .eq('developer_id', developerId)
    .single()

  if (fetchError) {
    throw new ExternalServiceError('Supabase', fetchError.message)
  }
  if (!existing) {
    throw new NotFoundError('agent')
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
  const { data: agent, error: updateError } = await supabase
    .from('agents')
    .update(payload)
    .eq('id', agentId)
    .select()
    .single()

  if (updateError) {
    throw new ExternalServiceError('Supabase', updateError.message)
  }

  // ── ٥. audit log ──────────────────────────────────────────────────────
  await logger.audit(source, 'agent.updated', {
    agentId:  agent.id,
    actorId:  developerId,
    metadata: payload,
    status:   'success',
  })

  return { agent }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * PATCH /agents/:id
 * Body: { name?, description?, is_active? }
 * يحتاج: auth middleware يضيف req.user
 */
export async function updateAgentHandler(req, res) {
  try {
    const result = await updateAgent(req.user.id, req.params.id, req.body)
    return res.status(200).json({ success: true, data: result.agent })
  } catch (err) {
    return formatError(err, res)
  }
}

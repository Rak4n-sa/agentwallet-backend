/**
 * الملف: agents/create.js
 * وش يفعل: ينشئ agent جديد تحت حساب المطور
 * يستدعيه: HTTP POST /agents
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم — جدول agents
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: agents/list.js، wallet/create.js، dashboard/overview.js
 */

import supabase from '../shared/db.js'
import logger from '../shared/logger.js'
import { ValidationError, ExternalServiceError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// Validation
// ══════════════════════════════════════════════════════════════════════════════

function validateInput({ name, description }) {
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    throw new ValidationError('اسم الـ agent مطلوب ويجب أن يكون حرفين على الأقل')
  }
  if (name.trim().length > 50) {
    throw new ValidationError('اسم الـ agent لا يتجاوز 50 حرفاً')
  }
  if (description && description.length > 500) {
    throw new ValidationError('وصف الـ agent لا يتجاوز 500 حرف')
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// createAgent — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} developerId
 * @param {object} input
 * @param {string} input.name        - اسم الـ agent (إلزامي)
 * @param {string} input.description - وصف الـ agent (اختياري)
 * @returns {{ agent }}
 */
export async function createAgent(developerId, { name, description = '' }) {
  const source = 'agents/create.js'

  // ── ١. التحقق من البيانات ──────────────────────────────────────────────
  validateInput({ name, description })

  // ── ٢. إنشاء سجل agent في DB ──────────────────────────────────────────
  const { data: agent, error } = await supabase
    .from('agents')
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
  await logger.audit(source, 'agent.created', {
    agentId:  agent.id,
    actorId:  developerId,
    metadata: { name: agent.name },
    status:   'success',
  })

  return { agent }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /agents
 * Body: { name, description }
 * يحتاج: auth middleware يضيف req.user
 */
export async function createAgentHandler(req, res) {
  try {
    const { name, description } = req.body
    const developerId = req.user.id

    const result = await createAgent(developerId, { name, description })
    return res.status(201).json({ success: true, data: result.agent })
  } catch (err) {
    return formatError(err, res)
  }
}

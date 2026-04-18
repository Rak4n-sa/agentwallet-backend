/**
 * الملف: agents/delete.js
 * وش يفعل: يحذف agent موجود من حساب المطور
 * يستدعيه: HTTP DELETE /agents/:id
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
import { NotFoundError, ExternalServiceError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// deleteAgent — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} developerId
 * @param {string} agentId
 * @returns {{ id: string }}
 */
export async function deleteAgent(developerId, agentId) {
  const source = 'agents/delete.js'

  // ── ١. نتأكد إن الـ agent موجود ويخص هذا المطور ──────────────────────
  const { data: existing, error: fetchError } = await supabase
    .from('agents')
    .select('id, name')
    .eq('id', agentId)
    .eq('developer_id', developerId)
    .single()

  if (fetchError) {
    throw new ExternalServiceError('Supabase', fetchError.message)
  }
  if (!existing) {
    throw new NotFoundError('agent')
  }

  // ── ٢. تعطيل الـ agent بدل الحذف الكامل ─────────────────────────────
  const { error: updateError } = await supabase
    .from('agents')
    .update({ is_active: false })
    .eq('id', agentId)

  if (updateError) {
    throw new ExternalServiceError('Supabase', updateError.message)
  }

  // ── ٣. audit log ──────────────────────────────────────────────────────
  await logger.audit(source, 'agent.deleted', {
    agentId:  agentId,
    actorId:  developerId,
    metadata: { name: existing.name },
    status:   'success',
  })

  return { id: agentId }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * DELETE /agents/:id
 * يحتاج: auth middleware يضيف req.user
 */
export async function deleteAgentHandler(req, res) {
  try {
    const result = await deleteAgent(req.user.id, req.params.id)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

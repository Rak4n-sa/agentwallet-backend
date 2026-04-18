/**
 * الملف: agents/list.js
 * وش يفعل: يرجع كل agents المرتبطة بحساب المطور
 * يستدعيه: HTTP GET /agents
 * يستدعي: shared/db.js، shared/errors.js
 * يحدّث DB: لا — يقرأ فقط
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: dashboard/overview.js، أي ملف يعرض قائمة الـ agents
 */

import supabase from '../shared/db.js'
import { ExternalServiceError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// listAgents — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} developerId
 * @returns {{ agents: object[] }}
 */
export async function listAgents(developerId) {
  const { data: agents, error } = await supabase
    .from('agents')
    .select()
    .eq('developer_id', developerId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })

  if (error) {
    throw new ExternalServiceError('Supabase', error.message)
  }

  return { agents: agents ?? [] }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /agents
 * يحتاج: auth middleware يضيف req.user
 */
export async function listAgentsHandler(req, res) {
  try {
    const result = await listAgents(req.user.id)
    return res.status(200).json({ success: true, data: result.agents })
  } catch (err) {
    return formatError(err, res)
  }
}

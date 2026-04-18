/**
 * الملف: shared/logger.js
 * وش يفعل: يسجّل الأحداث — console للمطور، وDB للـ audit trail
 * يستدعيه: كل ملف يحتاج يسجّل حدث أو خطأ (payments, auth, rollback, events...)
 * يستدعي: shared/db.js — لكتابة audit_logs في DB
 * يحدّث DB: نعم — جدول audit_logs
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا — الـ log يبقى حتى لو الـ transaction اتراجعت
 * لو عدّلته يتأثر: كل ملف يستخدم logger ⚠️
 */

import supabase from './db.js'

// ══════════════════════════════════════════════════════════════════════════════
// مستويات الـ Log
// ══════════════════════════════════════════════════════════════════════════════

const LEVELS = {
  info:  { label: 'INFO ', color: '\x1b[36m' }, // سماوي
  warn:  { label: 'WARN ', color: '\x1b[33m' }, // أصفر
  error: { label: 'ERROR', color: '\x1b[31m' }, // أحمر
  audit: { label: 'AUDIT', color: '\x1b[32m' }, // أخضر — يُكتب في DB أيضاً
}
const RESET = '\x1b[0m'

// ══════════════════════════════════════════════════════════════════════════════
// Console Logger — يطبع للمطور
// ══════════════════════════════════════════════════════════════════════════════

function consoleLog(level, source, message, meta = {}) {
  const { label, color } = LEVELS[level]
  const time = new Date().toISOString()
  const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''
  console.log(`${color}[${label}]${RESET} ${time} [${source}] ${message}${metaStr}`)
}

// ══════════════════════════════════════════════════════════════════════════════
// Audit Trail — يكتب في DB
// يُستخدم لكل حدث مالي أو أمني مهم
// ══════════════════════════════════════════════════════════════════════════════

/**
 * يكتب سجل في جدول audit_logs
 *
 * @param {object} entry
 * @param {string} entry.action     - وش صار (مثال: 'payment.sent', 'auth.login')
 * @param {string} entry.agentId    - ID الـ agent المعني (أو null لو مش مرتبط بـ agent)
 * @param {string} entry.actorId    - ID اللي نفّذ الحدث (developer أو system)
 * @param {object} entry.metadata   - تفاصيل إضافية (amount, txHash, ip...)
 * @param {string} entry.status     - 'success' | 'failure'
 */
async function writeAuditLog({ action, agentId = null, actorId = null, metadata = {}, status = 'success' }) {
  const { error } = await supabase
    .from('audit_logs')
    .insert({
      action,
      agent_id:  agentId,
      actor_id:  actorId,
      metadata,
      status,
      created_at: new Date().toISOString(),
    })

  // لو فشل الكتابة في DB — نطبع للـ console بدل ما نوقف المشروع
  // الـ audit trail مهم لكن ما يوقف العملية الرئيسية
  if (error) {
    consoleLog('error', 'shared/logger.js', 'فشل كتابة audit log في DB', { action, error: error.message })
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// الواجهة العامة — هذا اللي يستدعيه بقية الملفات
// ══════════════════════════════════════════════════════════════════════════════

const logger = {
  // ── Console فقط ───────────────────────────────────────────────────────────

  /** معلومة عادية — تدفق طبيعي */
  info(source, message, meta = {}) {
    consoleLog('info', source, message, meta)
  },

  /** تحذير — شيء غير متوقع لكن المشروع يكمل */
  warn(source, message, meta = {}) {
    consoleLog('warn', source, message, meta)
  },

  /** خطأ — شيء وقع غلط */
  error(source, message, meta = {}) {
    consoleLog('error', source, message, meta)
  },

  // ── Console + DB ──────────────────────────────────────────────────────────

  /**
   * Audit — حدث مهم يُسجّل في DB (إلزامي للعمليات المالية والأمنية)
   *
   * مثال:
   *   await logger.audit('payments/send.js', 'payment.sent', {
   *     agentId: 'abc',
   *     actorId: 'dev-xyz',
   *     metadata: { amount: 5, to: '0x...' },
   *     status: 'success'
   *   })
   */
  async audit(source, action, { agentId, actorId, metadata, status } = {}) {
    consoleLog('audit', source, action, { agentId, actorId, status, ...metadata })
    await writeAuditLog({ action, agentId, actorId, metadata, status })
  },
}

export default logger

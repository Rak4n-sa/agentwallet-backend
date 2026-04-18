/**
 * الملف: auth/login.js
 * وش يفعل: يسجّل دخول مطور موجود ويرجع access_token لاستخدامه في الطلبات التالية
 * يستدعيه: HTTP POST /auth/login
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: لا — Supabase Auth يتولى الـ session
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: أي middleware يتحقق من الـ token
 */

import { createClient } from '@supabase/supabase-js'
import supabase from '../shared/db.js'
import logger from '../shared/logger.js'
import { ValidationError, AuthenticationError, formatError } from '../shared/errors.js'

// client منفصل للـ signInWithPassword فقط — يمنع تلوث session الـ admin client
const authClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

// ══════════════════════════════════════════════════════════════════════════════
// Validation
// ══════════════════════════════════════════════════════════════════════════════

function validateInput({ email, password }) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new ValidationError('البريد الإلكتروني غير صحيح')
  }
  if (!password || typeof password !== 'string' || password.length < 1) {
    throw new ValidationError('كلمة المرور مطلوبة')
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// login — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} email
 * @param {string} password
 * @returns {{ access_token: string, developer: { id, name, email } }}
 * @throws {ValidationError}      لو البيانات ناقصة
 * @throws {AuthenticationError}  لو الـ email أو password خاطئ
 */
export async function login({ email, password }) {
  const source = 'auth/login.js'

  // ── ١. التحقق من البيانات ──────────────────────────────────────────────
  validateInput({ email, password })

  // ── ٢. تسجيل الدخول عبر Supabase Auth ────────────────────────────────
  // signInWithPassword يرجع session تحتوي على access_token
  const { data: authData, error: authError } = await authClient.auth.signInWithPassword({
    email:    email.toLowerCase().trim(),
    password,
  })

  if (authError) {
    // نرجع رسالة موحدة — ما نكشف إذا كان الـ email موجود أو لا (أمان)
    throw new AuthenticationError('البريد الإلكتروني أو كلمة المرور غير صحيحة')
  }

  const { session, user } = authData

  // ── ٣. جلب بيانات المطور من DB ────────────────────────────────────────
  // Supabase Auth يحفظ email + id فقط — البيانات الإضافية في جدول developers
  const { data: developer, error: dbError } = await supabase
    .from('developers')
    .select('id, name, email')
    .eq('id', user.id)
    .single()

  if (dbError || !developer) {
    throw new Error(`[auth/login.js] مطور موجود في Auth لكن غير موجود في DB — id: ${user.id}`)
  }

  // ── ٤. audit log ──────────────────────────────────────────────────────
  await logger.audit(source, 'developer.login', {
    actorId:  developer.id,
    metadata: { email: developer.email },
    status:   'success',
  })

  return {
    access_token: session.access_token,
    developer,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /auth/login
 * Body: { email, password }
 */
export async function loginHandler(req, res) {
  try {
    const { email, password } = req.body
    const result = await login({ email, password })

    return res.status(200).json({
      success: true,
      data:    result,
    })
  } catch (err) {
    return formatError(err, res)
  }
}

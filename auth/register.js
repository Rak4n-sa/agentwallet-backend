/**
 * الملف: auth/register.js
 * وش يفعل: يسجّل مطور جديد — ينشئ حساب في Supabase Auth وسجل في جدول developers
 * يستدعيه: HTTP POST /auth/register
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم — جدول developers
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا — الـ email unique في DB يمنع التكرار تلقائياً
 * rollback: لا
 * لو عدّلته يتأثر: auth/login.js، auth/apiKey.js
 */

import supabase from '../shared/db.js'
import logger from '../shared/logger.js'
import { ValidationError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// Validation — التحقق من البيانات قبل أي عملية
// ══════════════════════════════════════════════════════════════════════════════

/**
 * يتحقق من صحة بيانات التسجيل
 * @throws {ValidationError} لو أي حقل ناقص أو غير صحيح
 */
function validateInput({ name, email, password }) {
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    throw new ValidationError('الاسم مطلوب ويجب أن يكون حرفين على الأقل')
  }

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new ValidationError('البريد الإلكتروني غير صحيح')
  }

  if (!password || typeof password !== 'string' || password.length < 8) {
    throw new ValidationError('كلمة المرور مطلوبة ويجب أن تكون 8 أحرف على الأقل')
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// register — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} name     - اسم المطور
 * @param {string} email    - البريد الإلكتروني
 * @param {string} password - كلمة المرور (8 أحرف على الأقل)
 * @returns {{ developer: { id, name, email, created_at } }}
 * @throws {ValidationError}        لو البيانات غلط
 * @throws {Error}                  لو الـ email مستخدم مسبقاً
 */
export async function register({ name, email, password }) {
  const source = 'auth/register.js'

  // ── ١. التحقق من البيانات ──────────────────────────────────────────────
  validateInput({ name, email, password })

  // ── ٢. إنشاء المستخدم في Supabase Auth ───────────────────────────────
  // admin.createUser يعمل من الـ backend بـ SERVICE_ROLE_KEY
  // email_confirm: false — لا نحتاج تأكيد إيميل في الـ MVP
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email:            email.toLowerCase().trim(),
    password,
    email_confirm:    true,
    user_metadata:    { name: name.trim() },
  })

  if (authError) {
    // الـ email مستخدم مسبقاً
    if (authError.message?.includes('already been registered') || authError.code === 'email_exists') {
      throw new ValidationError('هذا البريد الإلكتروني مسجّل مسبقاً')
    }
    throw new Error(`[auth/register.js] فشل إنشاء المستخدم: ${authError.message}`)
  }

  const authUser = authData.user

  // ── ٣. إنشاء سجل developer في DB ─────────────────────────────────────
  // نحفظ بيانات إضافية عن المطور خارج Supabase Auth
  const { data: developer, error: dbError } = await supabase
    .from('developers')
    .insert({
      id:         authUser.id,        // نفس الـ ID من Supabase Auth
      name:       name.trim(),
      email:      email.toLowerCase().trim(),
      created_at: new Date().toISOString(),
    })
    .select('id, name, email, created_at')
    .single()

  if (dbError) {
    // لو فشل إنشاء السجل في DB — نحذف المستخدم من Auth لتجنب inconsistency
    await supabase.auth.admin.deleteUser(authUser.id)
    throw new Error(`[auth/register.js] فشل إنشاء سجل المطور: ${dbError.message}`)
  }

  // ── ٤. تسجيل الحدث في الـ audit log ──────────────────────────────────
  await logger.audit(source, 'developer.registered', {
    actorId:  developer.id,
    metadata: { email: developer.email },
    status:   'success',
  })

  return { developer }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — يُستخدم مع Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /auth/register
 * Body: { name, email, password }
 */
export async function registerHandler(req, res) {
  try {
    const { name, email, password } = req.body
    const result = await register({ name, email, password })

    return res.status(201).json({
      success: true,
      data:    result.developer,
    })
  } catch (err) {
    return formatError(err, res)
  }
}

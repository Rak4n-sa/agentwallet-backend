/**
 * الملف: shared/db.js
 * وش يفعل: ينشئ Supabase client واحد ويصدّره لكل المشروع
 * يستدعيه: كل ملف في المشروع (auth, agents, wallet, payments, events...)
 * يستدعي: @supabase/supabase-js فقط
 * يحدّث DB: لا — هو فقط يفتح الاتصال
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: كل المشروع ⚠️
 */

import { createClient } from '@supabase/supabase-js'

// ── التحقق من متغيرات البيئة ──────────────────────────────────────────────
// نتحقق مبكراً — لو ناقص شيء، المشروع كله يوقف فوراً مع رسالة واضحة
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL) {
  throw new Error(
    '[shared/db.js] SUPABASE_URL غير موجود في متغيرات البيئة.\n' +
    'أضفه في ملف .env — راجع .env.example للتفاصيل.'
  )
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    '[shared/db.js] SUPABASE_SERVICE_ROLE_KEY غير موجود في متغيرات البيئة.\n' +
    'أضفه في ملف .env — راجع .env.example للتفاصيل.'
  )
}

// ── إنشاء الـ Client ──────────────────────────────────────────────────────
// نستخدم SERVICE_ROLE_KEY (مش anon key) لأننا في الـ backend
// SERVICE_ROLE_KEY يتجاوز Row Level Security — لا تستخدمه في الـ frontend أبداً
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    // Backend لا يحتاج session أو cookies — كل طلب يتحقق بـ API Key
    persistSession: false,
    autoRefreshToken: false,
  },
})

export default supabase

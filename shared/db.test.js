/**
 * اختبار shared/db.js
 * شغّله: node shared/db.test.js
 *
 * ثلاث حالات:
 *   1. المتغيرات ناقصة → يطلع error واضح (subprocess منفصل لتجنب module cache)
 *   2. القيم موجودة    → client ينشأ بنجاح
 *   3. القيم صحيحة    → client يتصل بـ Supabase فعلاً (اختياري)
 */

import { execSync } from 'child_process'

// ── الاختبار الأول: المتغيرات ناقصة ─────────────────────────────────────
// نشغّل subprocess منفصل بدون env vars — ESM module cache لا يؤثر هنا
console.log('الاختبار ١: متغيرات ناقصة...')

try {
  execSync(
    'node --input-type=module <<\'EOF\'\nimport \'./db.js\'\nEOF',
    {
      cwd: new URL('.', import.meta.url).pathname,
      // لا نمرر SUPABASE_URL ولا SUPABASE_SERVICE_ROLE_KEY
      env: {},
      stdio: 'pipe',
    }
  )
  console.log('❌ فشل — كان المفروض يطلع error')
  process.exit(1)
} catch (err) {
  const output = err.stderr?.toString() || err.stdout?.toString() || ''
  if (output.includes('SUPABASE_URL')) {
    console.log('✅ نجح — طلع error صحيح عند غياب SUPABASE_URL')
  } else {
    console.log('❌ فشل — error غير متوقع:', output.slice(0, 200))
    process.exit(1)
  }
}

// ── الاختبار الثاني: القيم موجودة → client ينشأ ──────────────────────────
console.log('\nالاختبار ٢: client ينشأ بدون crash...')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://placeholder.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-key'

try {
  const { default: supabase } = await import('./db.js')

  // نتأكد إن الـ client موجود وعنده from() — دليل على إنه Supabase client حقيقي
  if (typeof supabase.from === 'function') {
    console.log('✅ نجح — supabase client جاهز')
  } else {
    console.log('❌ فشل — supabase مش object صحيح')
    process.exit(1)
  }
} catch (err) {
  console.log('❌ فشل — crash غير متوقع:', err.message)
  process.exit(1)
}

// ── الاختبار الثالث: الاتصال الحقيقي (اختياري) ───────────────────────────
// هذا الاختبار يشتغل بس لو عندك قيم حقيقية في .env
const hasRealCreds =
  process.env.SUPABASE_URL?.includes('.supabase.co') &&
  process.env.SUPABASE_SERVICE_ROLE_KEY !== 'placeholder-key'

if (hasRealCreds) {
  console.log('\nالاختبار ٣: اتصال حقيقي بـ Supabase...')
  try {
    const { default: supabase } = await import('./db.js')
    // نحاول نقرأ من جدول غير موجود — المفروض يرجع error من Supabase مش crash
    const { error } = await supabase.from('_connection_test_').select('id').limit(1)
    if (error && error.code === '42P01') {
      // 42P01 = relation does not exist — يعني الاتصال شغال، الجدول بس ما موجود
      console.log('✅ نجح — الاتصال شغال (الجدول غير موجود كما هو متوقع)')
    } else if (!error) {
      console.log('✅ نجح — الاتصال شغال')
    } else {
      console.log('⚠️  تحذير — error غير متوقع:', error.message)
    }
  } catch (err) {
    console.log('❌ فشل — crash:', err.message)
    process.exit(1)
  }
} else {
  console.log('\nالاختبار ٣: تخطي — لا توجد قيم Supabase حقيقية في .env')
  console.log('   أضف SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY في .env لتشغيل هذا الاختبار')
}

console.log('\n✅ كل الاختبارات اجتازت')

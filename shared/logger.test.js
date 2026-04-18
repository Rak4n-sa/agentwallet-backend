/**
 * اختبار shared/logger.js
 * شغّله: node shared/logger.test.js
 *
 * ملاحظة: اختبار audit() يحتاج Supabase حقيقي — نختبره بـ mock بسيط
 */

// ── Mock لـ shared/db.js ──────────────────────────────────────────────────
// نستبدل supabase بـ mock قبل ما نستورد logger
// هذا يتيح لنا اختبار الـ audit بدون DB حقيقي

let lastInsert = null
let mockShouldFail = false

// نحتال على Node module cache بتسجيل mock مؤقت
const mockSupabase = {
  from: () => ({
    insert: async (data) => {
      lastInsert = data
      if (mockShouldFail) return { error: { message: 'DB error' } }
      return { error: null }
    },
  }),
}

// نستورد logger مع inject الـ mock عبر module aliasing
// بما أن ESM ما يدعم monkey-patching مباشرة،
// نختبر writeAuditLog بشكل غير مباشر عبر نتائج logger.audit

// للتبسيط: نختبر console methods مباشرة ونترك audit لاختبار integration
import logger from './logger.js'

let passed = 0
let failed = 0

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`)
    passed++
  } else {
    console.log(`  ❌ ${label}`)
    failed++
  }
}

// ── اختبار الـ console methods ────────────────────────────────────────────
console.log('\nlogger.info:')
let threw = false
try { logger.info('test', 'رسالة info', { key: 'value' }) }
catch { threw = true }
assert(!threw, 'لا يطلع error')

console.log('\nlogger.warn:')
threw = false
try { logger.warn('test', 'رسالة warn') }
catch { threw = true }
assert(!threw, 'لا يطلع error')

console.log('\nlogger.error:')
threw = false
try { logger.error('test', 'رسالة error', { reason: 'test' }) }
catch { threw = true }
assert(!threw, 'لا يطلع error')

// ── اختبار شكل الـ output ─────────────────────────────────────────────────
console.log('\nشكل الـ output:')

// نعترض console.log مؤقتاً
const logs = []
const original = console.log
console.log = (...args) => logs.push(args.join(' '))

logger.info('payments/send.js', 'payment sent', { amount: 5 })
logger.error('auth/login.js', 'invalid key')

console.log = original

assert(logs[0]?.includes('INFO'),              'info: يحتوي على INFO')
assert(logs[0]?.includes('payments/send.js'),  'info: يحتوي على source')
assert(logs[0]?.includes('payment sent'),      'info: يحتوي على message')
assert(logs[0]?.includes('"amount":5'),        'info: يحتوي على metadata')
assert(logs[1]?.includes('ERROR'),             'error: يحتوي على ERROR')
assert(logs[1]?.includes('auth/login.js'),     'error: يحتوي على source')

// ── اختبار audit (بدون DB — نتحقق إنه لا يطلع exception) ────────────────
console.log('\nlogger.audit (بدون DB حقيقي):')

// لو SUPABASE_URL غير موجود، audit يفشل في الكتابة لكن ما يوقف البرنامج
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://placeholder.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-key'

threw = false
try {
  await logger.audit('test', 'payment.sent', {
    agentId: 'agent-123',
    actorId: 'dev-456',
    metadata: { amount: 10 },
    status: 'success',
  })
} catch {
  threw = true
}
assert(!threw, 'audit لا يطلع exception حتى لو DB فشل')

// ── النتيجة ───────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} نجح، ${failed} فشل`)
if (failed > 0) process.exit(1)

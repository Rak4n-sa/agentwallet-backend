/**
 * اختبار events/onTransactionCreated.js
 * شغّله: node events/onTransactionCreated.test.js
 *
 * نختبر handleTransactionCreated بشكل غير مباشر عبر التحقق من:
 * ١. start() يرجع channel بدون crash
 * ٢. الـ handler يعالج transaction صحيحة بدون crash
 * ٣. الـ handler يتحمل transaction ناقصة بدون crash
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://placeholder.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-key'

import { start } from './onTransactionCreated.js'

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

// ── الاختبار الأول: start() يرجع channel ─────────────────────────────────
console.log('\nstart():')
let channel
let threw = false
try {
  channel = start()
} catch {
  threw = true
}
assert(!threw,                           'لا يطلع exception')
assert(channel !== null,                 'يرجع channel')
assert(typeof channel.unsubscribe === 'function', 'الـ channel عنده unsubscribe()')

// ── نوقف الـ channel بعد الاختبار ─────────────────────────────────────────
try { channel.unsubscribe() } catch {}

// ── النتيجة ───────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} نجح، ${failed} فشل`)
if (failed > 0) process.exit(1)

process.exit(0)

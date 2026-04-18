/**
 * اختبار shared/errors.js
 * شغّله: node shared/errors.test.js
 */

import {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  DuplicatePaymentError,
  InsufficientFundsError,
  LimitExceededError,
  ExternalServiceError,
  handleError,
} from './errors.js'

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

// ── AppError Base ─────────────────────────────────────────────────────────
console.log('\nAppError:')
const base = new AppError('خطأ', 'TEST_ERROR', 418)
assert(base instanceof Error,    'instanceof Error')
assert(base instanceof AppError, 'instanceof AppError')
assert(base.code === 'TEST_ERROR', 'code صحيح')
assert(base.statusCode === 418,    'statusCode صحيح')
assert(base.name === 'AppError',   'name صحيح')

// ── كل نوع: statusCode + code + instanceof ────────────────────────────────
console.log('\nValidationError:')
const ve = new ValidationError('حقل مطلوب')
assert(ve instanceof AppError, 'instanceof AppError')
assert(ve.statusCode === 400,  'statusCode 400')
assert(ve.code === 'VALIDATION_ERROR', 'code صحيح')

console.log('\nUnauthorizedError:')
const ue = new UnauthorizedError()
assert(ue.statusCode === 401, 'statusCode 401')
assert(ue.code === 'UNAUTHORIZED', 'code صحيح')

console.log('\nForbiddenError:')
const fe = new ForbiddenError()
assert(fe.statusCode === 403, 'statusCode 403')
assert(fe.code === 'FORBIDDEN', 'code صحيح')

console.log('\nNotFoundError:')
const nfe = new NotFoundError('agent')
assert(nfe.statusCode === 404, 'statusCode 404')
assert(nfe.code === 'NOT_FOUND', 'code صحيح')
assert(nfe.message.includes('agent'), 'message يحتوي على اسم الـ resource')

console.log('\nDuplicatePaymentError:')
const dpe = new DuplicatePaymentError('key-abc-123')
assert(dpe.statusCode === 409, 'statusCode 409')
assert(dpe.code === 'DUPLICATE_PAYMENT', 'code صحيح')
assert(dpe.message.includes('key-abc-123'), 'message يحتوي على الـ idempotency key')

console.log('\nInsufficientFundsError:')
const ife = new InsufficientFundsError(50, 10)
assert(ife.statusCode === 422, 'statusCode 422')
assert(ife.code === 'INSUFFICIENT_FUNDS', 'code صحيح')
assert(ife.message.includes('50') && ife.message.includes('10'), 'message يحتوي على الأرقام')

console.log('\nLimitExceededError:')
const lee = new LimitExceededError('الحد اليومي')
assert(lee.statusCode === 422, 'statusCode 422')
assert(lee.code === 'LIMIT_EXCEEDED', 'code صحيح')

console.log('\nExternalServiceError:')
const ese = new ExternalServiceError('Transak', 'timeout')
assert(ese.statusCode === 503, 'statusCode 503')
assert(ese.code === 'EXTERNAL_SERVICE_ERROR', 'code صحيح')
assert(ese.message.includes('Transak'), 'message يحتوي على اسم الخدمة')

// ── handleError ───────────────────────────────────────────────────────────
console.log('\nhandleError:')

// Mock بسيط لـ Express res
function mockRes() {
  const res = { _status: null, _body: null }
  res.status = (code) => { res._status = code; return res }
  res.json   = (body) => { res._body = body;  return res }
  return res
}

// حالة ١: AppError → يرجع statusCode وcode الصحيح
const res1 = mockRes()
handleError(new NotFoundError('wallet'), res1)
assert(res1._status === 404, 'AppError: status 404')
assert(res1._body.success === false, 'AppError: success false')
assert(res1._body.error.code === 'NOT_FOUND', 'AppError: code صحيح')

// حالة ٢: Error عادي → يرجع 500 بدون تفاصيل
const res2 = mockRes()
handleError(new Error('database crashed'), res2)
assert(res2._status === 500, 'Unknown error: status 500')
assert(res2._body.error.code === 'INTERNAL_ERROR', 'Unknown error: code INTERNAL_ERROR')
assert(!res2._body.error.message.includes('database crashed'), 'Unknown error: لا تكشف التفاصيل للـ client')

// ── النتيجة ───────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} نجح، ${failed} فشل`)
if (failed > 0) process.exit(1)

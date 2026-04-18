/**
 * الملف: shared/errors.js
 * وش يفعل: يعرّف كل أنواع الـ errors في المشروع ويوحّد شكل الـ response
 * يستدعيه: كل ملف في المشروع يحتاج يرجع error (auth, payments, wallet, agents...)
 * يستدعي: لا أحد — يعرّف classes فقط
 * يحدّث DB: لا
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: كل ملف يستخدم errors ⚠️
 */

// ══════════════════════════════════════════════════════════════════════════════
// Base Class — كل الـ errors ترث منه
// ══════════════════════════════════════════════════════════════════════════════

export class AppError extends Error {
  /**
   * @param {string} message    - رسالة واضحة للمطور
   * @param {string} code       - كود مختصر للـ client (مثال: 'INSUFFICIENT_BALANCE')
   * @param {number} statusCode - HTTP status code (مثال: 400, 401, 404)
   * @param {object} context    - تفاصيل إضافية تساعد في التشخيص (اختياري)
   */
  constructor(message, code, statusCode = 500, context = {}) {
    super(message)
    this.name         = this.constructor.name // اسم الـ class تلقائياً (مثال: 'NotFoundError')
    this.code         = code
    this.statusCode   = statusCode
    this.context      = context    // تفاصيل إضافية — مش تترجم للـ client، للـ logging فقط
    this.isOperational = true      // خطأ متوقع — المشروع يكمل بعده
    // يحفظ stack trace بشكل صحيح في Node.js
    Error.captureStackTrace(this, this.constructor)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Errors محددة — كل نوع له statusCode وcode ثابتين
// ══════════════════════════════════════════════════════════════════════════════

// 400 — البيانات اللي أرسلها الـ client غلط أو ناقصة
export class ValidationError extends AppError {
  constructor(message, context = {}) {
    super(message, 'VALIDATION_ERROR', 400, context)
  }
}

// 401 — الـ client ما قدّم API Key أو الـ Key خاطئ (من هو؟ مجهول)
export class AuthenticationError extends AppError {
  constructor(message = 'غير مصرح — API Key مفقود أو غير صحيح', context = {}) {
    super(message, 'AUTHENTICATION_ERROR', 401, context)
  }
}

// 403 — الـ client موثوق لكن ما عنده صلاحية على هذا الـ resource (من هو؟ معروف)
export class AuthorizationError extends AppError {
  constructor(message = 'غير مسموح — ليس لديك صلاحية على هذا الـ resource', context = {}) {
    super(message, 'AUTHORIZATION_ERROR', 403, context)
  }
}

// 404 — المورد المطلوب ما موجود (agent, wallet, transaction...)
export class NotFoundError extends AppError {
  constructor(resource = 'المورد', context = {}) {
    super(`${resource} غير موجود`, 'NOT_FOUND', 404, context)
  }
}

// 409 — محاولة تنفيذ transaction سبق وتنفّذت (idempotency check)
export class DuplicateTransactionError extends AppError {
  constructor(idempotencyKey, context = {}) {
    super(
      `هذه العملية نُفّذت مسبقاً — idempotency key: ${idempotencyKey}`,
      'DUPLICATE_TRANSACTION',
      409,
      context
    )
  }
}

// 422 — الـ agent ما عنده رصيد كافٍ لإتمام العملية
export class InsufficientBalanceError extends AppError {
  constructor(required, available, context = {}) {
    super(
      `رصيد غير كافٍ — المطلوب: ${required} USDC، المتاح: ${available} USDC`,
      'INSUFFICIENT_BALANCE',
      422,
      context
    )
  }
}

// 422 — تجاوز حد الإنفاق المحدد في Rules Engine
export class LimitExceededError extends AppError {
  constructor(limitType = 'الحد', context = {}) {
    super(`تجاوزت ${limitType} المسموح به`, 'LIMIT_EXCEEDED', 422, context)
  }
}

// 503 — خدمة خارجية فشلت (Supabase, x402, Transak...)
// isOperational = false — خطأ غير متوقع، قد يحتاج تدخل يدوي
export class ExternalServiceError extends AppError {
  constructor(service, details = '', context = {}) {
    super(
      `خدمة ${service} غير متاحة حالياً${details ? ` — ${details}` : ''}`,
      'EXTERNAL_SERVICE_ERROR',
      503,
      context
    )
    this.isOperational = false // تلوّث خارجي — مش خطأنا لكن يحتاج مراقبة
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// formatError — يحوّل أي error لـ response موحد
// ══════════════════════════════════════════════════════════════════════════════

/**
 * يُستخدم في نهاية كل route handler لإرجاع response موحد
 *
 * مثال الاستخدام:
 *   try { ... }
 *   catch (err) { return formatError(err, res) }
 *
 * @param {Error}    err - الـ error اللي وقع
 * @param {object}   res - Express response object
 */
export function formatError(err, res) {
  // AppError وأنواعه — errors متوقعة، نرجعها كما هي
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code:    err.code,
        message: err.message,
      },
    })
  }

  // أي error غير متوقع — نخفي التفاصيل عن الـ client ونسجّلها للمطور
  console.error('[shared/errors.js] Unhandled error:', err)
  return res.status(500).json({
    success: false,
    error: {
      code:    'INTERNAL_ERROR',
      message: 'حدث خطأ داخلي — يرجى المحاولة لاحقاً',
    },
  })
}

/**
 * الملف: auth/apiKey.js
 * وش يفعل: يُصدر API Keys للمطورين ويتحقق منها في كل طلب
 * يستدعيه: HTTP POST /auth/api-key لإصدار key — وكل middleware يتحقق من الطلبات
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم — جدول api_keys
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: كل middleware يتحقق من الـ API Key في المشروع
 */

import crypto from 'crypto'
import supabase from '../shared/db.js'
import logger from '../shared/logger.js'
import { AuthenticationError, AuthorizationError, ExternalServiceError, formatError } from '../shared/errors.js'

// ── ثوابت ────────────────────────────────────────────────────────────────────
const KEY_PREFIX    = 'aw_'       // كل key يبدأ بـ aw_ (AgentWallet)
const KEY_BYTES     = 32          // 32 byte = 256 bit عشوائي
const HASH_ALG      = 'sha256'    // خوارزمية الـ hash

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

/** ينشئ API Key فريد — نصه الكامل يُعرض مرة واحدة فقط */
function generateRawKey() {
  return KEY_PREFIX + crypto.randomBytes(KEY_BYTES).toString('hex')
}

/** يحوّل الـ key لـ hash للحفظ في DB — لا يُحفظ النص الأصلي أبداً */
function hashKey(rawKey) {
  return crypto.createHash(HASH_ALG).update(rawKey).digest('hex')
}

// ══════════════════════════════════════════════════════════════════════════════
// generateApiKey — إصدار key جديد للمطور
// ══════════════════════════════════════════════════════════════════════════════

/**
 * يُصدر API Key جديد للمطور ويحفظ الـ hash في DB
 * ⚠️ الـ key يُعرض مرة واحدة فقط — ما يمكن استعادته لاحقاً
 *
 * @param {string} developerId - ID المطور من Supabase Auth
 * @returns {{ key: string, keyId: string }}
 *   key   — النص الكامل للـ key (يُعرض مرة واحدة فقط)
 *   keyId — ID السجل في DB (للإلغاء لاحقاً)
 */
export async function generateApiKey(developerId) {
  const source = 'auth/apiKey.js'

  // ── ١. إنشاء الـ key وتحويله لـ hash ──────────────────────────────────
  const rawKey    = generateRawKey()
  const hashedKey = hashKey(rawKey)

  // ── ٢. حفظ الـ hash في DB ─────────────────────────────────────────────
  const { data: keyRecord, error } = await supabase
    .from('api_keys')
    .insert({
      developer_id: developerId,
      key_hash:     hashedKey,
      key_prefix:   rawKey.slice(0, 10),   // أول 10 أحرف للعرض (aw_4f3a9b...)
      created_at:   new Date().toISOString(),
      is_active:    true,
    })
    .select('id, key_prefix, created_at')
    .single()

  if (error) {
    throw new ExternalServiceError('Supabase', error.message)
  }

  // ── ٣. audit log ──────────────────────────────────────────────────────
  await logger.audit(source, 'api_key.generated', {
    actorId:  developerId,
    metadata: { keyId: keyRecord.id, keyPrefix: keyRecord.key_prefix },
    status:   'success',
  })

  return {
    key:   rawKey,       // ⚠️ يُعرض مرة واحدة فقط — المطور يحفظه الآن
    keyId: keyRecord.id,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// verifyApiKey — يتحقق من الـ key ويرجع بيانات المطور
// يُستخدم في كل middleware للتحقق من الطلبات الواردة
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} rawKey - الـ key كما أرسله الـ client في الـ header
 * @returns {{ developerId: string, keyId: string }}
 * @throws {AuthenticationError} لو الـ key غير موجود أو غير فعّال
 */
export async function verifyApiKey(rawKey) {
  // ── ١. تحقق أساسي من الشكل ────────────────────────────────────────────
  if (!rawKey || !rawKey.startsWith(KEY_PREFIX)) {
    throw new AuthenticationError()
  }

  // ── ٢. نحسب الـ hash ونبحث عنه في DB ────────────────────────────────
  const hashedKey = hashKey(rawKey)

  const { data: keyRecord, error } = await supabase
    .from('api_keys')
    .select('id, developer_id, is_active')
    .eq('key_hash', hashedKey)
    .single()

  if (error || !keyRecord) {
    throw new AuthenticationError()
  }

  // ── ٣. نتحقق إن الـ key فعّال ─────────────────────────────────────────
  if (!keyRecord.is_active) {
    throw new AuthorizationError('هذا الـ API Key معطّل')
  }

  return {
    developerId: keyRecord.developer_id,
    keyId:       keyRecord.id,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /auth/api-key
 * يحتاج: access_token في الـ Authorization header (من auth/login.js)
 * يرجع: { key, keyId } — الـ key يُعرض مرة واحدة فقط
 */
export async function generateApiKeyHandler(req, res) {
  try {
    // req.user.id يُضاف من jwtAuth middleware في server.js
    const developerId = req.user.id
    if (!developerId) {
      throw new AuthenticationError()
    }

    const result = await generateApiKey(developerId)

    return res.status(201).json({
      success: true,
      data: {
        key:     result.key,    // ⚠️ احفظه الآن — لن يظهر مجدداً
        keyId:   result.keyId,
        warning: 'احفظ هذا الـ key الآن — لن يظهر مجدداً',
      },
    })
  } catch (err) {
    return formatError(err, res)
  }
}

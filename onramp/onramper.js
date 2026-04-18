/**
 * الملف: onramp/onramper.js
 * وش يفعل: يولّد رابط Onramper للدفع بكارت → USDC، ويستقبل webhook التأكيد
 * يستدعيه: HTTP GET /onramp/link، HTTP POST /onramp/webhook
 * يستدعي: receive/confirm.js، shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم (عبر confirm) — جدول transactions + جدول wallets
 * يطلق Supabase event: نعم — onTransactionConfirmed، onAgentFunded
 * يسمع Supabase event: لا
 * idempotency: نعم — عبر receive/confirm.js
 * rollback: لا
 * لو عدّلته يتأثر: receive/confirm.js، dashboard/overview.js
 */

import crypto                    from 'crypto'
import { confirmPayment }        from '../receive/confirm.js'
import logger                    from '../shared/logger.js'
import {
  ValidationError,
  ExternalServiceError,
  NotFoundError,
  formatError,
} from '../shared/errors.js'
import supabase                  from '../shared/db.js'

// ══════════════════════════════════════════════════════════════════════════════
// Config
// ══════════════════════════════════════════════════════════════════════════════

const ONRAMPER_API_KEY    = process.env.ONRAMPER_API_KEY    ?? ''
const ONRAMPER_WEBHOOK_SECRET = process.env.ONRAMPER_WEBHOOK_SECRET ?? ''
const APP_URL             = process.env.APP_URL             ?? 'http://localhost:3000'

// ══════════════════════════════════════════════════════════════════════════════
// getOnramperLink — يولّد رابط الدفع
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} walletId
 * @param {string} developerId
 * @returns {{ link: string, tba_address: string }}
 */
export async function getOnramperLink(walletId, developerId) {
  // ── ١. جلب المحفظة والتحقق من الملكية ────────────────────────────────
  const { data: wallet, error: fetchError } = await supabase
    .from('wallets')
    .select('id, tba_address')
    .eq('id', walletId)
    .eq('developer_id', developerId)
    .single()

  if (fetchError) {
    throw new ExternalServiceError('Supabase', fetchError.message)
  }
  if (!wallet) {
    throw new NotFoundError('محفظة')
  }
  if (!wallet.tba_address) {
    throw new NotFoundError('TBA address — شغّل POST /wallets/:id/blockchain أولاً')
  }

  // ── ٢. بناء رابط Onramper ─────────────────────────────────────────────
  const params = new URLSearchParams({
    apiKey:           ONRAMPER_API_KEY,
    defaultCrypto:    'USDC',
    defaultNetwork:   'base',
    walletAddress:    wallet.tba_address,
    webhookUrl:       `${APP_URL}/onramp/webhook`,
    externalId:       walletId,
    isAddressEditable: 'false',
  })

  const link = `https://buy.onramper.com?${params.toString()}`

  return {
    link,
    tba_address: wallet.tba_address,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// handleWebhook — يستقبل تأكيد Onramper ويحدّث DB
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {object} payload   - webhook body من Onramper
 * @param {string} signature - قيمة header x-onramper-signature
 */
export async function handleWebhook(payload, signature) {
  const source = 'onramp/onramper.js'

  // ── ١. التحقق من الـ signature ────────────────────────────────────────
  if (!ONRAMPER_WEBHOOK_SECRET) {
    throw new ExternalServiceError('Onramper', 'ONRAMPER_WEBHOOK_SECRET غير موجود في .env — لا يمكن التحقق من الـ webhook')
  }

  const expected = crypto
    .createHmac('sha256', ONRAMPER_WEBHOOK_SECRET)
    .update(JSON.stringify(payload))
    .digest('hex')

  if (signature !== expected) {
    throw new ValidationError('webhook signature غير صالح')
  }

  // ── ٢. التحقق إن الحالة completed ────────────────────────────────────
  if (payload.status !== 'COMPLETED') {
    logger.info(source, 'webhook غير مكتمل — تم تجاهله', { status: payload.status })
    return { ignored: true }
  }

  // ── ٣. استخراج البيانات من الـ payload ───────────────────────────────
  const walletId       = payload.externalId
  const amount         = parseFloat(payload.outCoinAmount ?? payload.cryptoAmount ?? 0)
  const tx_hash        = payload.txHash ?? payload.transactionId ?? ''
  const idempotency_key = `onramper_${payload.transactionId ?? payload.id}`

  if (!walletId || !amount || !tx_hash) {
    throw new ValidationError('payload ناقص: externalId، outCoinAmount، txHash مطلوبة')
  }

  // ── ٤. جلب developer_id من المحفظة ───────────────────────────────────
  const { data: wallet, error: walletError } = await supabase
    .from('wallets')
    .select('developer_id')
    .eq('id', walletId)
    .single()

  if (walletError) {
    throw new ExternalServiceError('Supabase', walletError.message)
  }
  if (!wallet) {
    throw new NotFoundError('محفظة')
  }

  // ── ٥. تأكيد الدفعة عبر receive/confirm.js ───────────────────────────
  const result = await confirmPayment(walletId, wallet.developer_id, {
    idempotency_key,
    amount,
    tx_hash,
    provider:    'onramper',
    description: `شحن عبر Onramper — ${amount} USDC`,
  })

  logger.info(source, 'onramp مؤكد', { walletId, amount, transaction_id: result.transaction_id })

  return result
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handlers — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /onramp/link
 * Query: wallet_id
 * يحتاج: auth middleware يضيف req.user
 */
export async function onramperLinkHandler(req, res) {
  try {
    if (!req.query.wallet_id) {
      throw new ValidationError('wallet_id مطلوب')
    }
    const result = await getOnramperLink(req.query.wallet_id, req.user.id)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

/**
 * POST /onramp/webhook
 * يُستدعى من Onramper — لا يحتاج auth
 */
export async function onramperWebhookHandler(req, res) {
  try {
    const signature = req.headers['x-onramper-signature'] ?? ''
    const result    = await handleWebhook(req.body, signature)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

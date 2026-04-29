/**
 * الملف: webhooks/alchemy.js
 * وش يفعل: يستقبل إشعارات Alchemy لما USDC يوصل لأي محفظة على Base mainnet
 *          يحسب رسوم الإيداع ويحدّث الرصيد تلقائياً
 * يستدعيه: HTTP POST /webhooks/alchemy (عام بدون API Key)
 * يستدعي: receive/confirm.js، shared/db.js
 * يحدّث DB: نعم — عبر confirmPayment
 * التحقق: HMAC-SHA256 من Alchemy
 */

import { createHmac }    from 'crypto'
import supabase          from '../shared/db.js'
import { confirmPayment } from '../receive/confirm.js'
import logger            from '../shared/logger.js'

const ALCHEMY_SIGNING_KEY = process.env.ALCHEMY_SIGNING_KEY ?? ''
const USDC_CONTRACT       = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

// ══════════════════════════════════════════════════════════════════════════════
// التحقق من توقيع Alchemy
// ══════════════════════════════════════════════════════════════════════════════

function verifySignature(rawBody, signature) {
  if (!ALCHEMY_SIGNING_KEY) return true // في dev بدون signing key نتجاوز التحقق
  const hmac   = createHmac('sha256', ALCHEMY_SIGNING_KEY)
  hmac.update(rawBody, 'utf8')
  return hmac.digest('hex') === signature
}

// ══════════════════════════════════════════════════════════════════════════════
// معالجة الـ webhook
// ══════════════════════════════════════════════════════════════════════════════

export async function alchemyWebhookHandler(req, res) {
  const source = 'webhooks/alchemy.js'

  // ── ١. التحقق من التوقيع ──────────────────────────────────────────────
  const signature = req.headers['x-alchemy-signature'] ?? ''
  const rawBody   = JSON.stringify(req.body)

  if (!verifySignature(rawBody, signature)) {
    logger.warn(source, 'توقيع Alchemy غير صحيح')
    return res.status(401).json({ error: 'Invalid signature' })
  }

  // ── ٢. استخراج الـ USDC transfers الواردة ────────────────────────────
  const activities = req.body?.event?.activity ?? []

  const usdcDeposits = activities.filter(a =>
    a.category === 'token' &&
    a.asset    === 'USDC'  &&
    a.rawContract?.address?.toLowerCase() === USDC_CONTRACT &&
    a.value > 0
  )

  if (usdcDeposits.length === 0) {
    return res.status(200).json({ received: true, processed: 0 })
  }

  let processed = 0

  for (const deposit of usdcDeposits) {
    try {
      const toAddress = deposit.toAddress?.toLowerCase()
      const amount    = deposit.value
      const txHash    = deposit.hash

      // ── ٣. ابحث عن المحفظة بالعنوان ───────────────────────────────────
      const { data: wallet } = await supabase
        .from('wallets')
        .select('id, developer_id')
        .ilike('tba_address', toAddress)
        .maybeSingle()

      if (!wallet) {
        logger.warn(source, 'عنوان USDC وصل لمحفظة غير مسجّلة', { toAddress })
        continue
      }

      // ── ٤. أضف الرصيد عبر confirmPayment (يحسب الرسوم تلقائياً) ───────
      await confirmPayment(wallet.id, wallet.developer_id, {
        idempotency_key: txHash,
        amount,
        tx_hash:         txHash,
        provider:        'alchemy',
        description:     `USDC deposit on Base (${txHash.slice(0, 10)}...)`,
      })

      logger.info(source, 'USDC deposit معالج', { walletId: wallet.id, amount, txHash })
      processed++

    } catch (err) {
      // idempotency error = نفس الـ tx وصل مرتين — نتجاهله
      if (err.message?.includes('idempotency')) continue
      logger.warn(source, 'خطأ في معالجة USDC deposit', { error: err.message })
    }
  }

  return res.status(200).json({ received: true, processed })
}

// ══════════════════════════════════════════════════════════════════════════════
// تسجيل عنوان جديد في Alchemy Webhook
// ══════════════════════════════════════════════════════════════════════════════

export async function registerAddressWithAlchemy(address) {
  const authToken = process.env.ALCHEMY_AUTH_TOKEN  ?? ''
  const webhookId = process.env.ALCHEMY_WEBHOOK_ID  ?? ''

  if (!authToken || !webhookId) return // لو ما في إعداد Alchemy — تجاوز

  try {
    const res = await fetch('https://dashboard.alchemy.com/api/update-webhook-addresses', {
      method:  'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'X-Alchemy-Token': authToken,
      },
      body: JSON.stringify({
        webhook_id:        webhookId,
        addresses_to_add:  [address],
        addresses_to_remove: [],
      }),
    })

    if (!res.ok) {
      logger.warn('webhooks/alchemy.js', 'فشل تسجيل العنوان في Alchemy', { address, status: res.status })
    }
  } catch (err) {
    logger.warn('webhooks/alchemy.js', 'خطأ في Alchemy API', { error: err.message })
  }
}

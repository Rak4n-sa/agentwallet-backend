/**
 * الملف: server.js
 * وش يفعل: نقطة دخول المشروع — يربط كل الـ routes ويشغّل الـ event listeners
 * يستدعيه: node server.js
 * يستدعي: كل الـ handlers في المشروع + events/
 * يحدّث DB: لا
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا — لكن يُشغّل كل الـ listeners عند البدء
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: كل المشروع ⚠️
 */

import 'dotenv/config'
import express from 'express'
import cors    from 'cors'

// ── Shared ────────────────────────────────────────────────────────────────────
import supabase                          from './shared/db.js'
import { AuthenticationError, formatError } from './shared/errors.js'
import logger                            from './shared/logger.js'

// ── Auth ──────────────────────────────────────────────────────────────────────
import { registerHandler }               from './auth/register.js'
import { loginHandler }                  from './auth/login.js'
import { verifyApiKey, generateApiKeyHandler } from './auth/apiKey.js'

// ── Dashboard ─────────────────────────────────────────────────────────────────
import { overviewHandler }               from './dashboard/overview.js'
import { transactionsHandler }           from './dashboard/transactions.js'
import { statsHandler }                  from './dashboard/stats.js'
import { walletProfileHandler }          from './dashboard/walletProfile.js'

// ── Wallets ───────────────────────────────────────────────────────────────────
import { createWalletHandler }           from './wallets/create.js'
import { listWalletsHandler }            from './wallets/list.js'
import { updateWalletHandler }           from './wallets/update.js'
import { deleteWalletHandler }           from './wallets/delete.js'

// ── Wallet (Blockchain) ───────────────────────────────────────────────────────
import { createWalletBlockchainHandler } from './wallet/create.js'
import { walletBalanceHandler }          from './wallet/balance.js'
import { walletAddressHandler }          from './wallet/address.js'

// ── Receive ───────────────────────────────────────────────────────────────────
import { paymentLinksHandler }           from './receive/link.js'
import { confirmPaymentHandler }         from './receive/confirm.js'

// ── Payments ──────────────────────────────────────────────────────────────────
import { sendPaymentHandler }            from './payments/send.js'
import { paymentHistoryHandler }         from './payments/history.js'
import { chargeWalletHandler }           from './payments/charge.js'

// ── Rollback ──────────────────────────────────────────────────────────────────
import { initiateRollbackHandler }       from './rollback/initiate.js'
import { rollbackLogHandler }            from './rollback/log.js'

// ── Transfer ──────────────────────────────────────────────────────────────────
import { walletToWalletHandler }         from './transfer/walletToWallet.js'
import { transferExternalHandler }       from './transfer/external.js'

// ── Onramp ────────────────────────────────────────────────────────────────────
import { onramperLinkHandler, onramperWebhookHandler } from './onramp/onramper.js'

// ── Rules ─────────────────────────────────────────────────────────────────────
import { setTransactionLimit }           from './rules/limits.js'
import { setBudget }                     from './rules/budget.js'
import { updateWalletRulesHandler }      from './rules/update.js'

// ── Webhooks ──────────────────────────────────────────────────────────────────
import { retrySingle }                   from './webhooks/retry.js'

// ── Events ────────────────────────────────────────────────────────────────────
import { start as startOnTransactionCreated }  from './events/onTransactionCreated.js'
import { start as startOnTransactionConfirmed } from './events/onTransactionConfirmed.js'
import { start as startOnAgentFunded }         from './events/onAgentFunded.js'
import { start as startOnLimitExceeded }       from './events/onLimitExceeded.js'
import { start as startOnRollbackInitiated }   from './events/onRollbackInitiated.js'

// ══════════════════════════════════════════════════════════════════════════════
// إعداد Express
// ══════════════════════════════════════════════════════════════════════════════

const app  = express()
const PORT = process.env.PORT ?? 3000

app.use(cors())
app.use(express.json())

// ══════════════════════════════════════════════════════════════════════════════
// Middleware — التحقق من الهوية
// ══════════════════════════════════════════════════════════════════════════════

/**
 * apiKeyAuth — يحمي كل الـ routes التشغيلية
 * يقرأ x-api-key من الـ header، يتحقق منه، يضيف req.user.id
 */
async function apiKeyAuth(req, res, next) {
  try {
    const rawKey = req.headers['x-api-key']
    if (!rawKey) throw new AuthenticationError()

    const { developerId } = await verifyApiKey(rawKey)
    req.user = { id: developerId }
    next()
  } catch (err) {
    return formatError(err, res)
  }
}

/**
 * jwtAuth — يحمي /auth/api-key فقط
 * يقرأ Bearer token من Authorization header، يتحقق منه عبر Supabase
 * يُستخدم بعد تسجيل الدخول لإصدار API Key
 */
async function jwtAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!token) throw new AuthenticationError()

    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) throw new AuthenticationError()

    req.user = { id: user.id }
    next()
  } catch (err) {
    return formatError(err, res)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Routes — Auth (عامة، بدون تحقق)
// ══════════════════════════════════════════════════════════════════════════════

app.post('/auth/register', registerHandler)
// POST { name, email, password } → { id, name, email }

app.post('/auth/login', loginHandler)
// POST { email, password } → { access_token, developer }

app.post('/auth/api-key', jwtAuth, generateApiKeyHandler)
// POST — header: Authorization: Bearer <token> → { key, keyId }

// ══════════════════════════════════════════════════════════════════════════════
// Routes — Dashboard
// ══════════════════════════════════════════════════════════════════════════════

app.get('/dashboard/overview', apiKeyAuth, overviewHandler)
// GET → { wallets[], totalEarnings, totalSpent, activeWallets }

app.get('/dashboard/transactions', apiKeyAuth, transactionsHandler)
// GET ?page&limit&type&status&from&to → { transactions[], pagination }

app.get('/dashboard/stats', apiKeyAuth, statsHandler)
// GET ?dailyDays&monthlyCount → { summary, daily[], monthly[], byType[] }

app.get('/dashboard/wallet/:id', apiKeyAuth, walletProfileHandler)
// GET → { wallet, totals, top_apis, rules, budget_usage, limit_exceeded_count, last_auto_stop }

// ══════════════════════════════════════════════════════════════════════════════
// Routes — Wallets (إدارة المحافظ)
// ══════════════════════════════════════════════════════════════════════════════

app.post('/wallets', apiKeyAuth, createWalletHandler)
// POST { name, description? } → wallet

app.get('/wallets', apiKeyAuth, listWalletsHandler)
// GET → wallets[]

app.patch('/wallets/:id', apiKeyAuth, updateWalletHandler)
// PATCH { name?, description?, is_active? } → wallet

app.delete('/wallets/:id', apiKeyAuth, deleteWalletHandler)
// DELETE → { id }

// ── Wallet Blockchain ─────────────────────────────────────────────────────────

app.post('/wallets/:id/blockchain', apiKeyAuth, createWalletBlockchainHandler)
// POST → { smart_account_address, salt, deploy_tx }

app.get('/wallets/:id/balance', apiKeyAuth, walletBalanceHandler)
// GET → { db_balance, onchain_balance, smart_account_address }

app.get('/wallets/:id/address', apiKeyAuth, walletAddressHandler)
// GET → { smart_account_address, salt }

app.get('/wallets/:id/link', apiKeyAuth, paymentLinksHandler)
// GET → { human_link, agent_link, tba_address, wallet_name }

app.post('/wallets/:id/confirm', apiKeyAuth, confirmPaymentHandler)
// POST { idempotency_key, amount, tx_hash, provider } → { transaction_id, balance }

// ══════════════════════════════════════════════════════════════════════════════
// Routes — Payments
// ══════════════════════════════════════════════════════════════════════════════

app.post('/payments/send', apiKeyAuth, sendPaymentHandler)
// POST { idempotency_key, wallet_id, amount, service_url, counterparty? } → { transaction_id, balance }

app.post('/wallets/:id/charge', apiKeyAuth, chargeWalletHandler)
// POST { service, amount } → { ok, txId, balance } | { ok, reason, txId }

app.get('/payments/history', apiKeyAuth, paymentHistoryHandler)
// GET ?wallet_id&page&limit&status&type&from&to → { transactions[], total, page, limit }

// ══════════════════════════════════════════════════════════════════════════════
// Routes — Rollback
// ══════════════════════════════════════════════════════════════════════════════

app.post('/rollback/initiate', apiKeyAuth, initiateRollbackHandler)
// POST { transaction_id, reason } → { rollback_id, transaction_id, status }

app.get('/rollback/log', apiKeyAuth, rollbackLogHandler)
// GET ?wallet_id&page&limit&status → { rollbacks[], total, page, limit }

// ══════════════════════════════════════════════════════════════════════════════
// Routes — Transfer
// ══════════════════════════════════════════════════════════════════════════════

app.post('/transfer/wallet-to-wallet', apiKeyAuth, walletToWalletHandler)
// POST { idempotency_key, from_wallet_id, to_wallet_id, amount } → { transaction_id, from_balance, to_balance }

app.post('/transfer/external', apiKeyAuth, transferExternalHandler)
// POST { idempotency_key, from_wallet_id, to_address, amount } → { transaction_id, balance, tx_hash }

// ══════════════════════════════════════════════════════════════════════════════
// Routes — Onramp
// ══════════════════════════════════════════════════════════════════════════════

app.get('/onramp/link', apiKeyAuth, onramperLinkHandler)
// GET ?wallet_id → { link, tba_address }

app.post('/onramp/webhook', onramperWebhookHandler)
// POST — عامة، من Onramper مباشرة، بدون API Key
// التحقق يصير داخلياً عبر HMAC signature

// ══════════════════════════════════════════════════════════════════════════════
// Routes — Rules
// ══════════════════════════════════════════════════════════════════════════════

app.patch('/wallets/:id/rules', apiKeyAuth, updateWalletRulesHandler)
// PATCH { maxPerTransaction?, dailyLimit?, monthlyLimit?, allowlist?, allowlistEnabled? } → rules

app.post('/rules/limits', apiKeyAuth, async (req, res) => {
  // POST { wallet_id, max_amount } → { wallet_id, max_transaction_amount }
  try {
    const { wallet_id, max_amount } = req.body
    const result = await setTransactionLimit(wallet_id, req.user.id, max_amount)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
})

app.post('/rules/budget', apiKeyAuth, async (req, res) => {
  // POST { wallet_id, daily_budget?, monthly_budget? } → { wallet_id, daily_budget, monthly_budget }
  try {
    const { wallet_id, daily_budget, monthly_budget } = req.body
    const result = await setBudget(wallet_id, req.user.id, { daily_budget, monthly_budget })
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// Routes — Webhooks
// ══════════════════════════════════════════════════════════════════════════════

app.post('/webhooks/retry/:logId', apiKeyAuth, async (req, res) => {
  // POST /webhooks/retry/:logId → { sent: boolean }
  try {
    const result = await retrySingle(req.params.logId)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// Health Check
// ══════════════════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  // GET → { status: 'ok', timestamp }
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ══════════════════════════════════════════════════════════════════════════════
// Event Listeners — يُشغَّلون مرة واحدة عند بدء السيرفر
// ══════════════════════════════════════════════════════════════════════════════

function startEventListeners() {
  startOnTransactionCreated()   // يستمع لـ INSERT على transactions
  startOnTransactionConfirmed() // يستمع لـ UPDATE status=confirmed على transactions
  startOnAgentFunded()          // يستمع لـ INSERT type=onramp على transactions
  startOnLimitExceeded()        // يستمع لـ UPDATE status=exceeded على agent_limits
  startOnRollbackInitiated()    // يستمع لـ INSERT على rollbacks

  logger.info('server.js', 'كل الـ event listeners شغّالة ✓')
}

// ══════════════════════════════════════════════════════════════════════════════
// تشغيل السيرفر
// ══════════════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  logger.info('server.js', `AgentWallet Backend شغّال على port ${PORT} ✓`)
  startEventListeners()
})

export default app

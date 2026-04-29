/**
 * الملف: payments/charge.js
 * وش يفعل: يفحص الـ rules بالترتيب وينفّذ الشحن — أو يسجّل blocked مع السبب
 * يستدعيه: HTTP POST /wallets/:id/charge
 * يستدعي: shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم — جدول transactions + جدول wallets
 * يطلق Supabase event: نعم — onTransactionCreated
 * idempotency: لا — charge بطبيعته يدوي/تجريبي
 * rollback: لا
 * لو عدّلته يتأثر: dashboard/walletProfile.js، dashboard/transactions.js
 */

import supabase               from '../shared/db.js'
import logger                 from '../shared/logger.js'
import { calcChargeFee }      from '../shared/fees.js'
import { NotFoundError, ExternalServiceError, ValidationError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// helpers
// ══════════════════════════════════════════════════════════════════════════════

function startOfDay() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function startOfMonth() {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

async function insertTransaction(walletId, developerId, { amount, fee = 0, service, status, reason }) {
  const { data, error } = await supabase
    .from('transactions')
    .insert({
      wallet_id:    walletId,
      developer_id: developerId,
      direction:    'outbound',
      type:         'payment',
      amount,
      fee,
      net_amount:   amount,
      currency:     'USDC',
      service_url:  service,
      description:  status === 'blocked' ? `محجوب — ${reason}` : `دفعة لـ ${service}`,
      status,
      metadata:     { service, reason: reason ?? null },
    })
    .select('id')
    .single()

  if (error) throw new ExternalServiceError('Supabase', error.message)
  return data.id
}

// ══════════════════════════════════════════════════════════════════════════════
// chargeWallet — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

export async function chargeWallet(developerId, walletId, { service, amount }) {
  const source = 'payments/charge.js'

  // ── ١. التحقق من المدخلات ─────────────────────────────────────────────
  if (!service || typeof service !== 'string') throw new ValidationError('service مطلوب')
  if (!amount  || typeof amount  !== 'number' || amount <= 0) throw new ValidationError('amount مطلوب وأكبر من صفر')

  // ── ٢. جلب المحفظة + الـ allowlist ────────────────────────────────────
  const { data: wallet, error: walletErr } = await supabase
    .from('wallets')
    .select('id, balance, is_active, allowlist_enabled, allowlist')
    .eq('id', walletId)
    .eq('developer_id', developerId)
    .maybeSingle()

  if (walletErr) throw new ExternalServiceError('Supabase', walletErr.message)
  if (!wallet)   throw new NotFoundError('محفظة')

  // ── ٣. جلب الـ limits ─────────────────────────────────────────────────
  const { data: limits } = await supabase
    .from('wallet_limits')
    .select('max_transaction_amount, daily_budget, monthly_budget')
    .eq('wallet_id', walletId)
    .maybeSingle()

  // ── ٤. حساب الإنفاق اليومي والشهري ───────────────────────────────────
  const [{ data: dailyTxs }, { data: monthlyTxs }] = await Promise.all([
    supabase
      .from('transactions')
      .select('amount')
      .eq('wallet_id', walletId)
      .eq('direction', 'outbound')
      .eq('status', 'confirmed')
      .gte('created_at', startOfDay()),
    supabase
      .from('transactions')
      .select('amount')
      .eq('wallet_id', walletId)
      .eq('direction', 'outbound')
      .eq('status', 'confirmed')
      .gte('created_at', startOfMonth()),
  ])

  const dailySpent   = (dailyTxs   ?? []).reduce((s, t) => s + t.amount, 0)
  const monthlySpent = (monthlyTxs ?? []).reduce((s, t) => s + t.amount, 0)

  // ══════════════════════════════════════════════════════════════════════
  // الفحوصات بالترتيب — أي فشل يسجّل blocked ويرجع { ok: false }
  // ══════════════════════════════════════════════════════════════════════

  const blocked = async (reason) => {
    const txId = await insertTransaction(walletId, developerId, { amount, service, status: 'blocked', reason })
    logger.warn(source, 'charge محجوب', { walletId, service, amount, reason })
    return { ok: false, reason, txId }
  }

  // فحص ١ — الـ wallet نشطة؟
  if (!wallet.is_active) {
    return blocked('Wallet paused or auto-stopped')
  }

  // فحص ٢ — الحد الأقصى للعملية
  if (limits?.max_transaction_amount != null && amount > limits.max_transaction_amount) {
    return blocked(`Exceeds max per transaction ($${limits.max_transaction_amount})`)
  }

  // فحص ٣ — الميزانية اليومية
  if (limits?.daily_budget != null && dailySpent + amount > limits.daily_budget) {
    const reason = `Exceeds daily limit ($${limits.daily_budget})`
    // auto-stop
    await supabase.from('wallets').update({ is_active: false }).eq('id', walletId)
    logger.warn(source, 'auto-stop — تجاوز الميزانية اليومية', { walletId })
    return blocked(`${reason} — wallet auto-stopped`)
  }

  // فحص ٤ — الميزانية الشهرية
  if (limits?.monthly_budget != null && monthlySpent + amount > limits.monthly_budget) {
    return blocked(`Exceeds monthly limit ($${limits.monthly_budget})`)
  }

  // فحص ٥ — الـ allowlist
  if (wallet.allowlist_enabled) {
    const list = wallet.allowlist ?? []
    if (!list.includes(service)) {
      return blocked(`Service "${service}" is not in the allowlist`)
    }
  }

  // فحص ٦ — الرصيد (يشمل الرسوم)
  const fee   = calcChargeFee(amount)
  const total = Math.round((amount + fee) * 1_000_000) / 1_000_000

  if (wallet.balance < total) {
    return blocked('Insufficient balance')
  }

  // ══════════════════════════════════════════════════════════════════════
  // ✅ نجحت — سجّل transaction + حدّث الرصيد
  // ══════════════════════════════════════════════════════════════════════

  const newBalance = Math.round((wallet.balance - total) * 1_000_000) / 1_000_000

  const [txId] = await Promise.all([
    insertTransaction(walletId, developerId, { amount, fee, service, status: 'confirmed' }),
    supabase.from('wallets').update({ balance: newBalance }).eq('id', walletId),
  ])

  await logger.audit(source, 'charge.success', {
    walletId,
    actorId:  developerId,
    metadata: { service, amount, fee, newBalance },
    status:   'success',
  })

  return { ok: true, txId, balance: newBalance, fee }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

export async function chargeWalletHandler(req, res) {
  try {
    const result = await chargeWallet(req.user.id, req.params.id, req.body)
    return res.status(200).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

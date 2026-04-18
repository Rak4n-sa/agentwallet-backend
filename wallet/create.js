/**
 * الملف: wallet/create.js
 * وش يفعل: ينشئ ERC-4337 Smart Account لمحفظة موجودة ويحفظ العنوان في DB
 * يستدعيه: HTTP POST /wallets/:id/blockchain
 * يستدعي: shared/tokenbound.js، shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم — جدول agent_wallets + جدول wallets
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: wallet/balance.js، wallet/address.js، receive/link.js
 */

import { randomBytes }                                 from 'crypto'
import { getSmartAccountAddress, deploySmartAccount } from '../shared/tokenbound.js'
import supabase                                        from '../shared/db.js'
import logger                                          from '../shared/logger.js'
import { ExternalServiceError, NotFoundError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// createWalletForAgent — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} walletId
 * @param {string} developerId
 * @returns {{ smart_account_address: string, salt: string, deploy_tx: string | null }}
 */
export async function createWalletForAgent(walletId, developerId) {
  const source = 'wallet/create.js'

  // ── ١. التحقق إن الـ wallet موجود ويخص هذا المطور ───────────────────
  const { data: wallet, error: fetchError } = await supabase
    .from('wallets')
    .select('id, name')
    .eq('id', walletId)
    .eq('developer_id', developerId)
    .single()

  if (fetchError) {
    throw new ExternalServiceError('Supabase', fetchError.message)
  }
  if (!wallet) {
    throw new NotFoundError('محفظة')
  }

  // ── ٢. التحقق من وجود Smart Account مسبقاً — نرجع البيانات الموجودة ──
  const { data: existing } = await supabase
    .from('agent_wallets')
    .select('tba_address, token_id, mint_tx')
    .eq('wallet_id', walletId)
    .maybeSingle()

  if (existing) {
    return {
      smart_account_address: existing.tba_address,
      salt:                  existing.token_id,
      deploy_tx:             existing.mint_tx,
    }
  }

  // ── ٣. توليد salt فريد — يحدد عنوان الـ Smart Account تحديداً كاملاً ──
  // نفس الـ owner + نفس الـ salt = نفس العنوان دائماً (ERC-4337 counterfactual)
  // crypto.randomBytes آمن تشفيرياً — أفضل من Math.random()
  const salt = BigInt('0x' + randomBytes(16).toString('hex'))

  // ── ٤. حساب Smart Account address (بدون deployment) ─────────────────
  const smartAccountAddress = await getSmartAccountAddress(salt.toString())

  // ── ٥. إنشاء Smart Account على البلوكشين ─────────────────────────────
  // في ERC-4337: الـ deployment يصير عند أول UserOperation تلقائياً
  // في mock: يرجع fake address + fake txHash
  let deployTx
  try {
    const result = await deploySmartAccount(salt.toString())
    deployTx = result.txHash
  } catch (err) {
    throw new ExternalServiceError('Blockchain', err.message)
  }

  // ── ٦. حفظ في agent_wallets وتحديث wallets في نفس الوقت ──────────────
  const [insertResult, updateResult] = await Promise.all([
    supabase.from('agent_wallets').insert({
      wallet_id:    walletId,
      token_id:     salt.toString(),     // salt مخزون في حقل token_id
      tba_address:  smartAccountAddress, // Smart Account address في حقل tba_address
      nft_contract: null,                // لا يوجد NFT في ERC-4337
      mint_tx:      deployTx,
    }),
    supabase.from('wallets').update({ tba_address: smartAccountAddress }).eq('id', walletId),
  ])

  if (insertResult.error) {
    throw new ExternalServiceError('Supabase', insertResult.error.message)
  }
  if (updateResult.error) {
    throw new ExternalServiceError('Supabase', updateResult.error.message)
  }

  // ── ٧. audit log ──────────────────────────────────────────────────────
  await logger.audit(source, 'wallet.blockchain_created', {
    actorId:  developerId,
    metadata: { smart_account_address: smartAccountAddress, salt: salt.toString(), deploy_tx: deployTx },
    status:   'success',
  })

  return {
    smart_account_address: smartAccountAddress,
    salt:                  salt.toString(),
    deploy_tx:             deployTx,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler — Express
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /wallets/:id/blockchain
 * يحتاج: auth middleware يضيف req.user
 */
export async function createWalletBlockchainHandler(req, res) {
  try {
    const result = await createWalletForAgent(req.params.id, req.user.id)
    return res.status(201).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

/**
 * الملف: wallet/create.js
 * وش يفعل: ينشئ EOA wallet لمحفظة موجودة — يولّد عنوان + يشفّر الـ private key
 * يستدعيه: HTTP POST /wallets/:id/blockchain
 * يستدعي: shared/tokenbound.js، shared/db.js، shared/logger.js، shared/errors.js
 * يحدّث DB: نعم — جدول agent_wallets + جدول wallets
 */

import { generateWallet, encryptPrivateKey }  from '../shared/tokenbound.js'
import { registerAddressWithAlchemy }         from '../webhooks/alchemy.js'
import supabase                               from '../shared/db.js'
import logger                                 from '../shared/logger.js'
import { ExternalServiceError, NotFoundError, formatError } from '../shared/errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// createWalletForAgent — المنطق الرئيسي
// ══════════════════════════════════════════════════════════════════════════════

export async function createWalletForAgent(walletId, developerId) {
  const source = 'wallet/create.js'

  // ── ١. التحقق إن الـ wallet موجود ويخص هذا المطور ───────────────────
  const { data: wallet, error: fetchError } = await supabase
    .from('wallets')
    .select('id, name')
    .eq('id', walletId)
    .eq('developer_id', developerId)
    .single()

  if (fetchError) throw new ExternalServiceError('Supabase', fetchError.message)
  if (!wallet)   throw new NotFoundError('محفظة')

  // ── ٢. لو عنده عنوان بالفعل — رجّع الموجود ──────────────────────────
  const { data: existing } = await supabase
    .from('agent_wallets')
    .select('tba_address, token_id')
    .eq('wallet_id', walletId)
    .maybeSingle()

  if (existing) {
    return { address: existing.tba_address, walletId }
  }

  // ── ٣. توليد EOA wallet جديد ──────────────────────────────────────────
  const { address, privateKey } = generateWallet()

  // ── ٤. تشفير الـ private key — لا يُحفظ plain text أبداً ─────────────
  const encryptedKey = encryptPrivateKey(privateKey)

  // ── ٥. حفظ في DB ──────────────────────────────────────────────────────
  const [insertResult, updateResult] = await Promise.all([
    supabase.from('agent_wallets').insert({
      wallet_id:             walletId,
      token_id:              address,
      tba_address:           address,
      nft_contract:          null,
      mint_tx:               null,
      encrypted_private_key: encryptedKey,
    }),
    supabase.from('wallets').update({ tba_address: address }).eq('id', walletId),
  ])

  if (insertResult.error) throw new ExternalServiceError('Supabase', insertResult.error.message)
  if (updateResult.error) throw new ExternalServiceError('Supabase', updateResult.error.message)

  await logger.audit(source, 'wallet.eoa_created', {
    actorId:  developerId,
    metadata: { address, walletId },
    status:   'success',
  })

  // سجّل العنوان في Alchemy — لو ما في إعداد يتجاوز بصمت
  await registerAddressWithAlchemy(address)

  return { address, walletId }
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handler
// ══════════════════════════════════════════════════════════════════════════════

export async function createWalletBlockchainHandler(req, res) {
  try {
    const result = await createWalletForAgent(req.params.id, req.user.id)
    return res.status(201).json({ success: true, data: result })
  } catch (err) {
    return formatError(err, res)
  }
}

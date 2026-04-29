/**
 * الملف: shared/tokenbound.js
 * وش يفعل: ينشئ EOA wallets حقيقية على Base mainnet أو وهمية في mock mode
 * يستدعيه: wallet/create.js، wallet/balance.js
 * WALLET_MODE=mock  → عناوين وهمية للتطوير
 * WALLET_MODE=eoa   → محافظ EOA حقيقية على Base mainnet
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, http }                from 'viem'
import { base }                                    from 'viem/chains'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { ExternalServiceError }                    from './errors.js'

const WALLET_MODE  = process.env.WALLET_MODE          ?? 'mock'
const MASTER_KEY   = process.env.WALLET_ENCRYPTION_KEY ?? ''

// ══════════════════════════════════════════════════════════════════════════════
// Encryption — AES-256-GCM
// ══════════════════════════════════════════════════════════════════════════════

export function encryptPrivateKey(privateKey) {
  if (!MASTER_KEY || MASTER_KEY.length !== 64) {
    throw new ExternalServiceError('Encryption', 'WALLET_ENCRYPTION_KEY غير موجود أو طوله غلط (يجب 64 hex char)')
  }
  const iv        = randomBytes(12)
  const key       = Buffer.from(MASTER_KEY, 'hex')
  const cipher    = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()])
  const tag       = cipher.getAuthTag()
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`
}

export function decryptPrivateKey(encryptedData) {
  if (!MASTER_KEY || MASTER_KEY.length !== 64) {
    throw new ExternalServiceError('Encryption', 'WALLET_ENCRYPTION_KEY غير موجود')
  }
  const [ivHex, encHex, tagHex] = encryptedData.split(':')
  const iv       = Buffer.from(ivHex,  'hex')
  const enc      = Buffer.from(encHex, 'hex')
  const tag      = Buffer.from(tagHex, 'hex')
  const key      = Buffer.from(MASTER_KEY, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(enc).toString('utf8') + decipher.final('utf8')
}

// ══════════════════════════════════════════════════════════════════════════════
// generateWallet — ينشئ EOA جديد
// ══════════════════════════════════════════════════════════════════════════════

export function generateWallet() {
  if (WALLET_MODE === 'mock') {
    const fakeKey  = '0x' + randomBytes(32).toString('hex')
    const fakeAddr = '0x' + randomBytes(20).toString('hex')
    return { address: fakeAddr, privateKey: fakeKey }
  }

  const privateKey = generatePrivateKey()
  const account    = privateKeyToAccount(privateKey)
  return { address: account.address, privateKey }
}

// ══════════════════════════════════════════════════════════════════════════════
// publicClient — للقراءة من البلوكشين
// ══════════════════════════════════════════════════════════════════════════════

export const publicClient = WALLET_MODE === 'eoa'
  ? createPublicClient({ chain: base, transport: http() })
  : { readContract: async () => 0n }

export { WALLET_MODE }

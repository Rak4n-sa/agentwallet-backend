/**
 * الملف: shared/tokenbound.js
 * وش يفعل: ينشئ clients للتعامل مع ERC-4337 Smart Accounts على Base Sepolia
 * يستدعيه: wallet/create.js، wallet/balance.js، wallet/address.js
 * يستدعي: shared/errors.js
 * يحدّث DB: لا
 * يطلق Supabase event: لا
 * يسمع Supabase event: لا
 * idempotency: لا
 * rollback: لا
 * لو عدّلته يتأثر: كل ملف يتعامل مع blockchain
 */

import { createPublicClient, http } from 'viem'
import { privateKeyToAccount }      from 'viem/accounts'
import { baseSepolia }              from 'viem/chains'
import { ExternalServiceError }     from './errors.js'

// ══════════════════════════════════════════════════════════════════════════════
// WALLET_MODE — mock أو erc4337
// ══════════════════════════════════════════════════════════════════════════════

const WALLET_MODE = process.env.WALLET_MODE ?? 'mock'

// ══════════════════════════════════════════════════════════════════════════════
// بناء الـ clients حسب الـ mode
// ══════════════════════════════════════════════════════════════════════════════

let _publicClient
let _getSmartAccountAddress  // (salt: string) → address: string
let _deploySmartAccount      // (salt: string) → { address: string, txHash: string | null }

if (WALLET_MODE === 'mock') {
  // ── Mock Mode — عناوين وهمية بدون Base ─────────────────────────────────

  _publicClient = {
    readContract: async () => 0n,
  }

  // نفس الـ salt دائماً يرجع نفس العنوان — يحاكي الـ counterfactual في ERC-4337
  _getSmartAccountAddress = (salt) => {
    const hex = BigInt(salt).toString(16).padStart(40, '0').slice(0, 40)
    return `0x${hex}`
  }

  _deploySmartAccount = async (salt) => {
    const address = _getSmartAccountAddress(salt)
    return {
      address,
      txHash: '0x' + '0'.repeat(64),  // fake tx في الـ mock
    }
  }

} else {
  // ── ERC-4337 Mode — Base Sepolia الحقيقي ─────────────────────────────────
  // يحتاج: permissionless (npm install permissionless)
  //        EXECUTOR_PRIVATE_KEY في .env
  //        BUNDLER_URL في .env (من Pimlico أو أي bundler آخر)
  //        PAYMASTER_URL في .env (اختياري — لو ما ضبطته المطور يدفع الـ gas)

  const rawKey     = process.env.EXECUTOR_PRIVATE_KEY
  const bundlerUrl = process.env.BUNDLER_URL

  if (!rawKey) {
    throw new ExternalServiceError('Blockchain', 'EXECUTOR_PRIVATE_KEY غير موجود في .env')
  }
  if (!bundlerUrl) {
    throw new ExternalServiceError('Blockchain', 'BUNDLER_URL غير موجود في .env')
  }

  const privateKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`
  const owner      = privateKeyToAccount(privateKey)

  _publicClient = createPublicClient({
    chain:     baseSepolia,
    transport: http(),
  })

  // ── ERC-4337 Smart Account functions ──────────────────────────────────────
  // نستورد permissionless بشكل dynamic — مش نكسر الـ mock mode لو الـ package غير مثبّت
  const { signerToSimpleSmartAccount } = await import('permissionless/accounts')

  // SimpleAccountFactory على Base Sepolia (ERC-4337 standard factory)
  const SIMPLE_ACCOUNT_FACTORY = '0x9406Cc6185a346906296840746125a0E44976454'
  const ENTRY_POINT            = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789'

  // يحسب Smart Account address بدون deployment (counterfactual)
  // نفس الـ owner + نفس الـ salt دائماً = نفس العنوان
  _getSmartAccountAddress = async (salt) => {
    const account = await signerToSimpleSmartAccount(_publicClient, {
      signer:         owner,
      factoryAddress: SIMPLE_ACCOUNT_FACTORY,
      entryPoint:     ENTRY_POINT,
      salt:           BigInt(salt),
    })
    return account.address
  }

  // في ERC-4337 الـ deployment يصير تلقائياً عند أول UserOperation
  // نرجع العنوان الـ counterfactual — txHash يظهر لاحقاً عند أول عملية
  _deploySmartAccount = async (salt) => {
    const address = await _getSmartAccountAddress(salt)
    return { address, txHash: null }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Exports
// ══════════════════════════════════════════════════════════════════════════════

export const publicClient           = _publicClient
export const getSmartAccountAddress = _getSmartAccountAddress
export const deploySmartAccount     = _deploySmartAccount

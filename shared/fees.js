/**
 * الملف: shared/fees.js
 * نسب الرسوم — مصدر واحد لكل الملفات
 * CHARGE_FEE_RATE:  رسوم على كل دفعة خارجة (micro-payment)
 * DEPOSIT_FEE_RATE: رسوم على كل إيداع داخل (prepaid)
 */

export const CHARGE_FEE_RATE  = parseFloat(process.env.CHARGE_FEE_RATE  ?? '0.01')  // 1%
export const DEPOSIT_FEE_RATE = parseFloat(process.env.DEPOSIT_FEE_RATE ?? '0.005') // 0.5%

export function calcChargeFee(amount) {
  return Math.round(amount * CHARGE_FEE_RATE * 1_000_000) / 1_000_000
}

export function calcDepositFee(amount) {
  return Math.round(amount * DEPOSIT_FEE_RATE * 1_000_000) / 1_000_000
}

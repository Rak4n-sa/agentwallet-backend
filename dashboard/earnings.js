import supabase      from '../shared/db.js'
import logger        from '../shared/logger.js'
import { ExternalServiceError, formatError } from '../shared/errors.js'

export async function platformEarningsHandler(req, res) {
  try {
    const { data, error } = await supabase
      .from('platform_earnings')
      .select('fee_type, fee_amount, gross_amount, created_at')
      .order('created_at', { ascending: false })
      .limit(500)

    if (error) throw new ExternalServiceError('Supabase', error.message)

    const total       = (data ?? []).reduce((s, r) => s + Number(r.fee_amount), 0)
    const byType      = { deposit: 0, charge: 0 }
    for (const r of data ?? []) byType[r.fee_type] = (byType[r.fee_type] ?? 0) + Number(r.fee_amount)

    logger.info('dashboard/earnings.js', 'platform earnings fetched', { total })
    return res.status(200).json({ success: true, data: { total, byType, records: data } })
  } catch (err) {
    return formatError(err, res)
  }
}

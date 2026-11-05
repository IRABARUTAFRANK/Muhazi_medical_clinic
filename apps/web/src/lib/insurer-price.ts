import { formatRwf } from '@mmc/shared'
import type { TFn } from '@/components/dash/kit-style'
import type { TariffRow } from '@/lib/api/insurers'

/**
 * The sentence a screen says under a line when the visit is on an insurer, before the line is
 * charged: "MMI price 40,000 · patient pays 6,000 · MMI pays 34,000", "not on MMI's list — cash
 * price 2,000 · …", "not covered: the patient pays 2,000" or "confirm with MMI first", by where
 * the insurer's price comes from (its tariff, the official list, the cash price) and its rule.
 * Amounts are for `quantity` units.
 */
export function insurerLineText(
  t: TFn,
  row: TariffRow | undefined,
  insurer: string,
  quantity = 1,
): string | null {
  if (!row || row.price == null) return row ? t('visit.insurerPrice.none') : null
  const q = Math.max(1, quantity)
  const price = Math.round(row.price * q)
  const insurerPays = Math.round((price * row.coveragePct) / 100)
  const vars = {
    insurer,
    price: formatRwf(price),
    patient: formatRwf(price - insurerPays),
    insurerPays: formatRwf(insurerPays),
  }
  if (row.source === 'excluded') return t('visit.insurerPrice.excluded', vars)
  if (row.source === 'preauth' || row.preauth) return t('visit.insurerPrice.preauth', vars)
  if (row.source === 'tariff') return t('visit.insurerPrice.priced', vars)
  if (row.source === 'reference') return t('visit.insurerPrice.reference', vars)
  if (row.ask) return t('visit.insurerPrice.ask', vars)
  if (row.coveragePct === 0) return t('visit.insurerPrice.notCovered', vars)
  return t('visit.insurerPrice.cashCovered', vars)
}

/** The tone of that sentence: the insurer's own price (teal), the cash price (amber), not covered (red). */
export function insurerLineTone(row: TariffRow | undefined): 'teal' | 'amber' | 'red' | null {
  if (!row || row.price == null) return null
  if (row.source === 'excluded') return 'red'
  if (row.source === 'preauth' || row.preauth) return 'amber'
  if (row.source === 'tariff' || row.source === 'reference') return 'teal'
  if (row.ask || row.coveragePct === 0) return 'red'
  return 'amber'
}

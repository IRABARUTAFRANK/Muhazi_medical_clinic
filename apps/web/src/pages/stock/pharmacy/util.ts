import type { TFunction } from 'i18next'
import type { StoreBatch } from '@/lib/api/rooms'
import type { StockItem } from '@/lib/api/stock'

/** The message of anything thrown (an ApiError's message is already in plain words). */
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** "35 years", "7 months" (under 2 years, when the months are known). */
export function ageText(
  t: TFunction,
  years: number | null | undefined,
  months?: number | null,
): string | null {
  if (years == null && months == null) return null
  if ((years == null || years < 2) && months != null)
    return t('pharmacy.ageMonths', { count: months })
  return years == null ? null : t('pharmacy.ageYears', { count: years })
}

/** "Female" / "Male" (other values as written). */
export function sexText(t: TFunction, sex: string | null | undefined): string | null {
  const s = (sex ?? '').trim().toLowerCase()
  if (!s) return null
  if (s === 'female' || s === 'f') return t('pharmacy.sexFemale')
  if (s === 'male' || s === 'm') return t('pharmacy.sexMale')
  return sex ?? null
}

/** A medicine's name with its strength. */
export const itemName = (i: Pick<StockItem, 'name' | 'strength'>) =>
  `${i.name}${i.strength ? ` ${i.strength}` : ''}`

/** Units of a medicine that are not expired in a store (an old database: all units there). */
export const usableIn = (i: StockItem, storeId: string | null | undefined): number =>
  storeId ? Math.max(0, i.byLocationUsable?.[storeId] ?? i.byLocation[storeId] ?? 0) : 0

/** The batches a quantity would take, earliest expiry first, never an expired batch (FEFO). */
export function fefoPlan(
  batches: readonly StoreBatch[],
  quantity: number,
): { take: { batchNo: string | null; expiry: string | null; quantity: number }[]; short: number } {
  const usable = batches
    .filter((b) => !b.expired && b.quantity > 0)
    .slice()
    .sort((a, b) => (a.expiry ?? '9999-12-31').localeCompare(b.expiry ?? '9999-12-31'))
  const take: { batchNo: string | null; expiry: string | null; quantity: number }[] = []
  let left = quantity
  for (const b of usable) {
    if (left <= 0) break
    const n = Math.min(left, b.quantity)
    take.push({ batchNo: b.batchNo, expiry: b.expiry, quantity: n })
    left -= n
  }
  return { take, short: Math.max(0, left) }
}

/** "03/2027" for an expiry date (yyyy-mm-dd). */
export const monthYear = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const [y, m] = iso.slice(0, 10).split('-')
  return y && m ? `${m}/${y}` : iso
}

/** Today in the clinic (yyyy-mm-dd, the device's day). */
export const dayOf = (ms: number): string => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Mobile money, card and bank payments need the transaction reference. */
export const needsReference = (method: string) => method !== 'cash'

/** A whole positive number typed in a quantity field, else 0. */
export const qty = (s: string): number => {
  const n = Number(s)
  return Number.isInteger(n) && n > 0 ? n : 0
}

export interface EditLine {
  key: string
  itemId: string
  quantity: string
}

let lineSeq = 0
/** An empty line for a lines editor. */
export const newLine = (itemId = '', quantity = ''): EditLine => ({
  key: `l${++lineSeq}`,
  itemId,
  quantity,
})

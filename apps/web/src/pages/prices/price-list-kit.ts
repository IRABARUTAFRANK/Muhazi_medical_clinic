import { formatDate, formatRwf } from '@mmc/shared'
import type { Cover } from '@/lib/api/price-lists'
import type { PriceListColumn } from '@/lib/price-list-file'

/** The red box of a refusal or a file problem. */
export const errorBox =
  'border-red/30 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium'

/** "2026-06-01" → 01/06/2026 (a calendar day, no time zone shift). */
export const day = (iso: string) =>
  iso ? formatDate(new Date(`${iso.slice(0, 10)}T00:00:00`)) : ''

/** A price, or a dash when there is none. */
export const price = (n: number | null | undefined) => (n == null ? '—' : formatRwf(n))

/** The badge colour of an insurer's cover of a line. */
export const coverTone = (c: Cover) =>
  c === 'not_covered' ? ('red' as const) : c === 'preauth' ? ('yellow' as const) : ('blue' as const)

/** The column a private patient pays: "Privates (Non insured)", "General Clinics", else the first. */
export function guessPrivateColumn(columns: PriceListColumn[]): string {
  const by = (re: RegExp) => columns.find((c) => re.test(c.label))?.key
  return (
    by(/non.?insur|uninsur|non.?assur/i) ??
    by(/general clinic|clinique g/i) ??
    by(/^privates?\b|private patient|cash|comptant/i) ??
    columns[0]?.key ??
    ''
  )
}

/** The column an insurer pays on its own list: its name, a price column, else the first. */
export function guessPayerColumn(columns: PriceListColumn[], insurer: string | undefined): string {
  if (columns.length === 1) return columns[0]!.key
  const name = (insurer ?? '').toLowerCase().split(/\s+/)[0] ?? ''
  return (
    (name ? columns.find((c) => c.label.toLowerCase().includes(name))?.key : undefined) ??
    columns.find((c) => /tarif|tariff|price|prix|amount|montant/i.test(c.label))?.key ??
    columns[0]?.key ??
    ''
  )
}

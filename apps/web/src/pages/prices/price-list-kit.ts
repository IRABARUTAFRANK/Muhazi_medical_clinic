import { formatDate, formatRwf } from '@mmc/shared'
import type { Cover } from '@/lib/api/price-lists'

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

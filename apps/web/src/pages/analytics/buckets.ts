import { isoDate } from '@mmc/shared'
import { dayLong, dayShort } from './format'
import { dayDate } from './url-period'

/**
 * The x axis of a chart over a period: one bar per day up to 92 days, one per month beyond
 * (a year of days would make bars too thin to see or to click).
 */
export interface Buckets {
  monthly: boolean
  /** yyyy-mm-dd (daily) or yyyy-mm (monthly). */
  keys: string[]
  long: string[]
  short: string[]
  /** The bucket of a day (yyyy-mm-dd). */
  of: (day: string) => string
  /** The first and last day of a bucket, inside the period. */
  span: (key: string) => { from: string; to: string }
}

export const MAX_DAYS = 92

export function bucketsOf(from: string, to: string): Buckets {
  const a = dayDate(from)
  const b = dayDate(to)
  const days = Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1
  if (days <= MAX_DAYS) {
    const keys = Array.from({ length: Math.max(0, days) }, (_, i) =>
      isoDate(new Date(a.getFullYear(), a.getMonth(), a.getDate() + i)),
    )
    return {
      monthly: false,
      keys,
      long: keys.map(dayLong),
      short: keys.map(dayShort),
      of: (d) => d.slice(0, 10),
      span: (k) => ({ from: k, to: k }),
    }
  }
  const keys: string[] = []
  for (let d = new Date(a.getFullYear(), a.getMonth(), 1); d <= b; d.setMonth(d.getMonth() + 1))
    keys.push(isoDate(d).slice(0, 7))
  const label = (k: string) => `${k.slice(5, 7)}/${k.slice(0, 4)}`
  return {
    monthly: true,
    keys,
    long: keys.map(label),
    short: keys.map((k) => `${k.slice(5, 7)}/${k.slice(2, 4)}`),
    of: (d) => d.slice(0, 7),
    span: (k) => {
      const [y, m] = k.split('-').map(Number)
      const first = isoDate(new Date(y!, m! - 1, 1))
      const last = isoDate(new Date(y!, m!, 0))
      return { from: first < from ? from : first, to: last > to ? to : last }
    },
  }
}

/** Sums `value(row)` per bucket. */
export function sumBy<R>(
  bk: Buckets,
  rows: readonly R[],
  day: (r: R) => string,
  value: (r: R) => number,
): number[] {
  const at = new Map(bk.keys.map((k, i) => [k, i]))
  const out = bk.keys.map(() => 0)
  for (const r of rows) {
    const i = at.get(bk.of(day(r)))
    if (i != null) out[i]! += value(r)
  }
  return out
}

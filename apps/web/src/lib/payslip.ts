/**
 * 0214: a pay slip worked out on this screen, the way the database's payslip_of() does it — for
 * the sample mode, and for the examples shown while the rules are typed (the database stays the
 * one that counts a salary paid):
 *   1. PAYE on the gross: each band taxes what falls in it (the casual worker: a flat rate above
 *      the free band; none: nothing)
 *   2. the rules on the gross, then those on the net (the gross less PAYE and the RRA/RSSB
 *      employee lines on the gross), each a percentage or a fixed amount, the employee's part and
 *      the clinic's part, at the rates in force on the pay date
 */
export type SlipMode = 'normal' | 'none' | 'casual'

export interface SlipRate {
  validFrom: string
  employeeRate: number | null
  employeeAmount: number | null
  employerRate: number | null
  employerAmount: number | null
}
export interface SlipRule {
  id: string
  code: string | null
  name: string
  agency: 'rra' | 'rssb' | 'other'
  base: 'gross' | 'net'
  active: boolean
  sortOrder: number
  rates: SlipRate[]
}
export interface SlipBandSet {
  validFrom: string
  casualRate: number | null
  bands: { lower: number; rate: number }[]
}
export interface SlipLine {
  code: string | null
  ruleId: string
  name: string
  agency: 'rra' | 'rssb' | 'other'
  base: 'gross' | 'net'
  employee: number
  employer: number
}
export interface Slip {
  gross: number
  paye: number
  lines: SlipLine[]
  employeeTotal: number
  net: number
  employerTotal: number
}

/** The set of bands in force on a date (the latest that started on or before it). */
export const setOn = <T extends { validFrom: string }>(sets: T[], on: string): T | null =>
  sets.filter((s) => s.validFrom <= on).sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1))[0] ??
  null

/** PAYE of a monthly gross with a set of bands. */
export function payeWith(
  bands: { lower: number; rate: number }[],
  gross: number,
  mode: SlipMode = 'normal',
  casualRate: number | null = 15,
): number {
  if (!(gross > 0) || mode === 'none' || bands.length === 0) return 0
  const sorted = [...bands].sort((a, b) => a.lower - b.lower)
  if (mode === 'casual') {
    const free = sorted.find((b) => b.rate > 0)?.lower ?? 0
    return Math.round((Math.max(gross - free, 0) * (casualRate ?? 15)) / 100)
  }
  let tax = 0
  sorted.forEach((b, i) => {
    const top = sorted[i + 1]?.lower ?? Infinity
    tax += (Math.max(Math.min(gross, top) - b.lower, 0) * b.rate) / 100
  })
  return Math.round(tax)
}

const share = (amount: number | null, rate: number | null, on: number) =>
  amount != null ? amount : rate != null ? Math.round((on * rate) / 100) : 0

/** The slip of a gross pay on a date, for the rules that apply (the database's payslip_of). */
export function slipOf<R extends SlipRule>(
  rules: R[],
  sets: SlipBandSet[],
  gross: number,
  on: string,
  mode: SlipMode,
  applies: (r: R) => boolean,
): Slip {
  const g = Math.round(Math.max(gross, 0))
  const lines: SlipLine[] = []
  let paye = 0
  const payeRule = rules.find((r) => r.code === 'paye')
  if (payeRule?.active && mode !== 'none') {
    const set = setOn(sets, on)
    const casual = setOn(
      sets.filter((s) => s.casualRate != null),
      on,
    )?.casualRate
    paye = set ? payeWith(set.bands, g, mode, casual ?? 15) : 0
    lines.push({
      code: 'paye',
      ruleId: payeRule.id,
      name: payeRule.name,
      agency: 'rra',
      base: 'gross',
      employee: paye,
      employer: 0,
    })
  }
  let withheld = paye
  let clinic = 0
  let statutory = 0
  let netBase: number | null = null
  const others = rules
    .filter((r) => r.active && r.code !== 'paye' && applies(r))
    .map((r) => ({ r, rate: setOn(r.rates, on) }))
    .filter((x): x is { r: R; rate: SlipRate } => x.rate != null)
    .sort(
      (a, b) =>
        (a.r.base === 'gross' ? 0 : 1) - (b.r.base === 'gross' ? 0 : 1) ||
        a.r.sortOrder - b.r.sortOrder ||
        a.r.name.localeCompare(b.r.name),
    )
  for (const { r, rate } of others) {
    if (r.base === 'net' && netBase == null) netBase = g - paye - statutory
    const on = r.base === 'net' ? (netBase ?? g) : g
    const e = share(rate.employeeAmount, rate.employeeRate, on)
    const y = share(rate.employerAmount, rate.employerRate, on)
    withheld += e
    clinic += y
    if (r.base === 'gross' && r.agency !== 'other') statutory += e
    lines.push({
      code: r.code,
      ruleId: r.id,
      name: r.name,
      agency: r.agency,
      base: r.base,
      employee: e,
      employer: y,
    })
  }
  return {
    gross: g,
    paye,
    lines,
    employeeTotal: withheld,
    net: g - withheld,
    employerTotal: clinic,
  }
}

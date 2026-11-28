import { describe, expect, it } from 'vitest'
import { payeWith, setOn, slipOf, type SlipBandSet, type SlipRule } from './payslip'

const rate = (validFrom: string, er: number | null, yr: number | null) => ({
  validFrom,
  employeeRate: er,
  employeeAmount: null,
  employerRate: yr,
  employerAmount: null,
})
const rule = (
  code: string,
  base: 'gross' | 'net',
  rates: SlipRule['rates'],
  extra: Partial<SlipRule> = {},
): SlipRule => ({
  id: code,
  code,
  name: code,
  agency: 'rssb',
  base,
  active: true,
  sortOrder: 10,
  rates,
  ...extra,
})
// Rwanda 2025–2026, as the database starts
const RULES: SlipRule[] = [
  rule('paye', 'gross', [], { agency: 'rra' }),
  rule('pension', 'gross', [rate('2025-01-01', 6, 6), rate('2027-01-01', 7, 7)], { sortOrder: 20 }),
  rule('maternity', 'gross', [rate('2025-01-01', 0.3, 0.3)], { sortOrder: 30 }),
  rule('cbhi', 'net', [rate('2025-01-01', 0.5, null)], { sortOrder: 40 }),
  rule('hazard', 'gross', [rate('2025-01-01', null, 2)], { sortOrder: 50 }),
  rule('rama', 'gross', [rate('2025-01-01', 7.5, 7.5)], { sortOrder: 60 }),
]
const SETS: SlipBandSet[] = [
  {
    validFrom: '2024-01-01',
    casualRate: 15,
    bands: [
      { lower: 0, rate: 0 },
      { lower: 60000, rate: 10 },
      { lower: 100000, rate: 20 },
      { lower: 200000, rate: 30 },
    ],
  },
]
const everyoneButRama = (r: SlipRule) => r.code !== 'rama'

describe('the pay slip worked out on the screen (0214), as the database does', () => {
  it('PAYE: each band taxes what falls in it; the casual worker a flat rate above the free band', () => {
    const b = SETS[0]!.bands
    expect(payeWith(b, 500000)).toBe(114000)
    expect(payeWith(b, 60000)).toBe(0)
    expect(payeWith(b, 100000)).toBe(4000)
    expect(payeWith(b, 500000, 'casual', 15)).toBe(66000)
    expect(payeWith(b, 500000, 'none')).toBe(0)
  })

  it('300,000 gross: the employee gives 74,036, the clinic adds 24,900', () => {
    const s = slipOf(RULES, SETS, 300000, '2026-11-28', 'normal', everyoneButRama)
    const by = Object.fromEntries(s.lines.map((l) => [l.code, l]))
    expect(by.paye?.employee).toBe(54000)
    expect(by.pension).toMatchObject({ employee: 18000, employer: 18000 })
    expect(by.maternity).toMatchObject({ employee: 900, employer: 900 })
    expect(by.hazard).toMatchObject({ employee: 0, employer: 6000 })
    // Mutuelle on the net after PAYE, pension and maternity: 0.5% of 227,100
    expect(by.cbhi?.employee).toBe(1136)
    expect(by.rama).toBeUndefined()
    expect(s.employeeTotal).toBe(74036)
    expect(s.net).toBe(225964)
    expect(s.employerTotal).toBe(24900)
  })

  it('500,000 gross: the same figures as the database check of 0186', () => {
    const s = slipOf(RULES, SETS, 500000, '2026-03-28', 'normal', everyoneButRama)
    expect(s.net).toBe(352727)
    expect(s.employerTotal).toBe(41500)
  })

  it('a rate from a date applies to the slips from that date only', () => {
    const before = slipOf(RULES, SETS, 500000, '2026-12-28', 'normal', everyoneButRama)
    const after = slipOf(RULES, SETS, 500000, '2027-01-28', 'normal', everyoneButRama)
    expect(before.lines.find((l) => l.code === 'pension')?.employee).toBe(30000)
    expect(after.lines.find((l) => l.code === 'pension')?.employee).toBe(35000)
  })

  it('a rule switched off, and PAYE switched off, leave no line', () => {
    const off = RULES.map((r) =>
      r.code === 'hazard' || r.code === 'paye' ? { ...r, active: false } : r,
    )
    const s = slipOf(off, SETS, 300000, '2026-11-28', 'normal', everyoneButRama)
    expect(s.lines.map((l) => l.code)).toEqual(['pension', 'maternity', 'cbhi'])
    expect(s.employerTotal).toBe(18900)
  })

  it('a fixed amount is taken as it is; an own rule does not lower the net Mutuelle counts on', () => {
    const loan = rule(
      'loan',
      'gross',
      [{ ...rate('2026-01-01', null, null), employeeAmount: 20000 }],
      { agency: 'other', code: null, id: 'loan', name: 'Staff loan', sortOrder: 70 },
    )
    const s = slipOf([...RULES, loan], SETS, 300000, '2026-11-28', 'normal', everyoneButRama)
    expect(s.lines.find((l) => l.name === 'Staff loan')?.employee).toBe(20000)
    expect(s.lines.find((l) => l.code === 'cbhi')?.employee).toBe(1136)
    expect(s.net).toBe(205964)
  })

  it('the set of bands in force is the latest that started on or before the date', () => {
    const sets = [...SETS, { validFrom: '2027-01-01', casualRate: 12, bands: SETS[0]!.bands }]
    expect(setOn(sets, '2026-12-31')?.validFrom).toBe('2024-01-01')
    expect(setOn(sets, '2027-01-01')?.validFrom).toBe('2027-01-01')
    expect(setOn(sets, '2023-12-31')).toBeNull()
    const c = slipOf(RULES, sets, 500000, '2027-02-01', 'casual', everyoneButRama)
    expect(c.paye).toBe(52800)
  })
})

/**
 * The clinic's accounts (0179): salaries, taxes (0184), expenses and the money summary, for the
 * cashier (the accountant) and the manager.
 *
 * Live: salary_overview, set_salary, remove_salary, pay_salary, unpay_salary, skip_salary,
 * tax_overview, set_tax, remove_tax, pay_tax, unpay_tax, skip_tax, add_expense, void_expense,
 * expenses_list, finance_summary, finance_alert_check; 0185: money_kinds, set_money_kind,
 * remove_money_kind, add_income, void_income, incomes_list. Sample mode: figures kept in memory
 * for the session.
 */
import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { kigaliToday } from '@/lib/clock'
import { apiError, isMissingFunction } from './errors'

export const SALARY_INTERVALS = [
  'weekly',
  'fortnightly',
  'monthly',
  'every2months',
  'quarterly',
  'halfyearly',
  'yearly',
  'custom',
] as const
export type SalaryInterval = (typeof SALARY_INTERVALS)[number]
export const CUSTOM_UNITS = ['days', 'weeks', 'months'] as const
export type CustomUnit = (typeof CUSTOM_UNITS)[number]

/** "Every month", or for a custom interval "Every 45 days" (0180). */
export const intervalWords = (
  t: (k: string, o?: Record<string, unknown>) => string,
  kind: SalaryInterval,
  every: number | null,
  unit: CustomUnit | null,
) =>
  kind === 'custom'
    ? t('accounts.intervals.customEvery', {
        count: every ?? 0,
        unit: t(`accounts.units.${unit ?? 'days'}`, { count: every ?? 0 }),
      })
    : t(`accounts.intervals.${kind}`)

export type PeriodStatus = 'due' | 'overdue' | 'paid' | 'skipped'

/** PAYE on a salary (0186): by the bands, not at all, or the casual worker's flat rate. */
export type PayeMode = 'normal' | 'none' | 'casual'
export const PAYE_MODES: readonly PayeMode[] = ['normal', 'none', 'casual']
export const AGENCIES = ['rra', 'rssb', 'other'] as const
export type Agency = (typeof AGENCIES)[number]

/** One line of a pay slip (0186): what the employee gives up and what the employer adds. */
export interface PayslipLine {
  code: string | null
  ruleId: string
  name: string
  agency: Agency
  base: 'gross' | 'net'
  employee: number
  employer: number
}

export interface SalaryPeriod {
  periodStart: string
  periodEnd: string
  dueOn: string
  amount: number
  status: PeriodStatus
  id: string | null
  paidOn: string | null
  paidAmount: number | null
  method: string | null
  reference: string | null
  note: string | null
  paidBy: string | null
  /** 0186: the pay slip — stored when paid, worked out on the pay date otherwise. */
  gross: number
  net: number
  employerTotal: number
  deductions: PayslipLine[]
}

export interface DeductionRate {
  validFrom: string
  employeeRate: number | null
  employeeAmount: number | null
  employerRate: number | null
  employerAmount: number | null
}
/** A deduction on salaries (0186): built in (code) or the accountant's; its rates by date. */
export interface DeductionRule {
  id: string
  code: string | null
  name: string
  agency: Agency
  base: 'gross' | 'net'
  defaultOn: boolean
  active: boolean
  note: string | null
  sortOrder: number
  current: DeductionRate | null
  rates: DeductionRate[]
  /** Employees it is switched on for by name. */
  people: number
}
export interface PayeBand {
  validFrom: string
  lower: number
  rate: number
}
export interface Deductions {
  rules: DeductionRule[]
  payeBands: PayeBand[]
  today: string
}
export const deductionName = (
  t: (k: string, o?: Record<string, unknown>) => string,
  r: Pick<DeductionRule, 'code' | 'name'>,
) => (r.code ? t(`accounts.deductions.builtinNames.${r.code}`, { defaultValue: r.name }) : r.name)
/** "6%" or "RWF 5,000" or "—". */
export const rateWords = (
  t: (k: string, o?: Record<string, unknown>) => string,
  rate: number | null,
  amount: number | null,
) =>
  amount != null ? t('accounts.deductions.fixedWords', { amount }) : rate != null ? `${rate}%` : '—'

/** A month's remittance to an agency (0186): the withheld part and the employer's share. */
export interface Remittance {
  month: string
  agency: Agency
  dueOn: string
  employeeTotal: number
  employerTotal: number
  total: number
  people: number
  lines: { code: string | null; name: string }[]
  status: PeriodStatus
  id: string | null
  paidOn: string | null
  paidAmount: number | null
  method: string | null
  reference: string | null
  note: string | null
  paidBy: string | null
}

export interface SalaryPerson {
  id: string
  name: string
  role: string
  staffId: string | null
  active: boolean
  amount: number
  intervalKind: SalaryInterval
  customEvery: number | null
  customUnit: CustomUnit | null
  anchorOn: string
  payDay: number | null
  /** 0186 */
  payeMode: PayeMode
  deductions: { ruleId: string; applies: boolean; until: string | null }[]
  note: string | null
  setAt: string | null
  setBy: string | null
  contractEnd: string | null
  periods: SalaryPeriod[]
  paidThisYear: number
  overdue: number
  nextDue: string | null
}

export interface SalaryOverview {
  year: number
  people: SalaryPerson[]
  withoutSalary: { id: string; name: string; role: string }[]
  today: string
}

/** A tax the clinic pays (0184): built like a salary; the amount is null when the accountant
 *  works it out each time and types it when paying. */
export interface TaxPeriod extends Omit<
  SalaryPeriod,
  'amount' | 'gross' | 'net' | 'employerTotal' | 'deductions'
> {
  amount: number | null
}
/** How a tax is computed (0187): on the profit, on the turnover, a fixed amount, withheld at
 *  source by a payer (a credit, not money out), or other. */
export const TAX_KINDS = ['profit', 'turnover', 'fixed', 'withheld', 'other'] as const
export type TaxKind = (typeof TAX_KINDS)[number]
export interface Tax {
  id: string
  name: string
  kind: TaxKind
  amount: number | null
  intervalKind: SalaryInterval
  customEvery: number | null
  customUnit: CustomUnit | null
  anchorOn: string
  payDay: number | null
  note: string | null
  setAt: string | null
  setBy: string | null
  periods: TaxPeriod[]
  paidThisYear: number
  overdue: number
  nextDue: string | null
}
/** The year's tax base (0187): the figures the income tax is estimated from. */
export interface TaxBase {
  moneyIn: number
  netRevenue: number
  otherIncome: number
  salaries: number
  statutory: number
  remittances: number
  otherExpenses: number
  stockBought: number
  expenses: number
  resultBeforeTax: number
  taxesPaid: number
  paidByKind: Partial<Record<TaxKind, number>>
}
export interface TaxOverview {
  year: number
  taxes: Tax[]
  base: TaxBase
  today: string
}

/** A kind of money in or out (0185). A code means built in: filled by the system, its name
 *  translated on the screens (kindName), only its description editable. */
export interface MoneyKind {
  id: string
  side: 'in' | 'out'
  code: string | null
  name: string
  description: string | null
  active: boolean
  sortOrder: number
  /** Entries recorded under it (an expense or money in). */
  inUse: number
}
/** The kinds the system fills: an expense cannot be recorded under them by hand. */
export const SYSTEM_OUT_KINDS = ['salary', 'statutory', 'remittance', 'stock']
export const kindName = (
  t: (k: string, o?: Record<string, unknown>) => string,
  k: Pick<MoneyKind, 'code' | 'name'>,
) => (k.code ? t(`accounts.kinds.builtinNames.${k.code}`, { defaultValue: k.name }) : k.name)

/** Money in that is not a patient's bill nor a walk-in sale (0185). */
export interface Income {
  id: string
  kindId: string
  kind: string
  amount: number
  method: string
  reference: string | null
  from: string | null
  note: string | null
  receivedOn: string
  recordedBy: string | null
  voided: boolean
  voidReason: string | null
}

export type ExpenseKind = 'salary' | 'tax' | 'other'
export interface Expense {
  id: string
  kind: ExpenseKind
  /** 0185: the kind of money out it was recorded under. */
  kindId?: string | null
  kindCode?: string | null
  kindName?: string | null
  label: string
  amount: number
  method: string
  reference: string | null
  note: string | null
  paidOn: string
  paidBy: string | null
  voided: boolean
  voidReason: string | null
  periodId: string | null
}

export interface FinanceSummary {
  from: string
  to: string
  revenue: number
  refunds: number
  netRevenue: number
  /** 0185: the walk-in sales among the payments; the other money in; all money in. */
  walkIn: number
  otherIncome: number
  moneyIn: number
  salaries: number
  /** 0186: the clinic's RSSB share; what was withheld and handed over. */
  statutory: number
  remittances: number
  /** 0184: the taxes paid — reported apart, never in the result (0185). */
  taxes: number
  otherExpenses: number
  stockBought: number
  expenses: number
  /** The result before tax. */
  net: number
  byMethod: { method: string; count: number; amount: number }[]
  byKindIn: { id: string; code: string | null; name: string; amount: number }[]
  byKindOut: { id: string; code: string | null; name: string; amount: number }[]
  byMonth: {
    month: string
    revenue: number
    refunds: number
    otherIncome: number
    /** salaries + statutory + remittances */
    salaries: number
    taxes: number
    other: number
    stock: number
  }[]
  salariesDue: number
  taxesDue: number
}

const KEY = ['accounts'] as const
const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v))
const numOrNull = (v: unknown) => (v == null || v === '' ? null : Number(v))

/* ---------------------------------------------------------------- sample mode */
const addMonths = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00')
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + n)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, last))
  return d.toISOString().slice(0, 10)
}
/** Rwanda 2025: PAYE by bands, pension 6% + 6%, maternity 0.3% + 0.3%, Mutuelle 0.5% of the net. */
const samplePaye = (g: number) =>
  Math.round(
    Math.max(Math.min(g, 100000) - 60000, 0) * 0.1 +
      Math.max(Math.min(g, 200000) - 100000, 0) * 0.2 +
      Math.max(g - 200000, 0) * 0.3,
  )
const sampleSlip = (
  gross: number,
): Pick<SalaryPeriod, 'gross' | 'net' | 'employerTotal' | 'deductions'> => {
  const paye = samplePaye(gross)
  const pension = Math.round(gross * 0.06)
  const maternity = Math.round(gross * 0.003)
  const cbhi = Math.round((gross - paye - pension - maternity) * 0.005)
  const hazard = Math.round(gross * 0.02)
  return {
    gross,
    net: gross - paye - pension - maternity - cbhi,
    employerTotal: pension + maternity + hazard,
    deductions: [
      {
        code: 'paye',
        ruleId: 'd-paye',
        name: 'PAYE (income tax)',
        agency: 'rra',
        base: 'gross',
        employee: paye,
        employer: 0,
      },
      {
        code: 'pension',
        ruleId: 'd-pension',
        name: 'RSSB pension',
        agency: 'rssb',
        base: 'gross',
        employee: pension,
        employer: pension,
      },
      {
        code: 'maternity',
        ruleId: 'd-maternity',
        name: 'Maternity leave fund',
        agency: 'rssb',
        base: 'gross',
        employee: maternity,
        employer: maternity,
      },
      {
        code: 'hazard',
        ruleId: 'd-hazard',
        name: 'Occupational hazards',
        agency: 'rssb',
        base: 'gross',
        employee: 0,
        employer: hazard,
      },
      {
        code: 'cbhi',
        ruleId: 'd-cbhi',
        name: 'Mutuelle de santé (CBHI)',
        agency: 'rssb',
        base: 'net',
        employee: cbhi,
        employer: 0,
      },
    ],
  }
}
const sampleRule = (
  id: string,
  code: string,
  name: string,
  agency: Agency,
  base: 'gross' | 'net',
  er: number | null,
  yr: number | null,
  defaultOn = true,
  note: string | null = null,
): DeductionRule => ({
  id,
  code,
  name,
  agency,
  base,
  defaultOn,
  active: true,
  note,
  sortOrder: 10,
  current: {
    validFrom: '2025-01-01',
    employeeRate: er,
    employeeAmount: null,
    employerRate: yr,
    employerAmount: null,
  },
  rates: [
    {
      validFrom: '2025-01-01',
      employeeRate: er,
      employeeAmount: null,
      employerRate: yr,
      employerAmount: null,
    },
  ],
  people: 2,
})
const sampleDeductions: Deductions = {
  today: kigaliToday(),
  rules: [
    sampleRule(
      'd-paye',
      'paye',
      'PAYE (income tax)',
      'rra',
      'gross',
      null,
      null,
      true,
      'By bands on the gross pay',
    ),
    sampleRule(
      'd-pension',
      'pension',
      'RSSB pension',
      'rssb',
      'gross',
      6,
      6,
      true,
      '7% + 7% from 1 January 2027',
    ),
    sampleRule('d-maternity', 'maternity', 'Maternity leave fund', 'rssb', 'gross', 0.3, 0.3),
    sampleRule('d-cbhi', 'cbhi', 'Mutuelle de santé (CBHI)', 'rssb', 'net', 0.5, null),
    sampleRule('d-hazard', 'hazard', 'Occupational hazards', 'rssb', 'gross', null, 2),
    sampleRule('d-rama', 'rama', 'RSSB medical (RAMA)', 'rssb', 'gross', 7.5, 7.5, false),
  ],
  payeBands: [
    { validFrom: '2024-01-01', lower: 0, rate: 0 },
    { validFrom: '2024-01-01', lower: 60000, rate: 10 },
    { validFrom: '2024-01-01', lower: 100000, rate: 20 },
    { validFrom: '2024-01-01', lower: 200000, rate: 30 },
  ],
}
const sampleRemittances = (year: number): Remittance[] =>
  ['01', '02', '03'].flatMap((m, i) => {
    const month = `${year}-${m}`
    const due = `${year}-${String(i + 2).padStart(2, '0')}-15`
    const paid = i < 2
    return [
      {
        month,
        agency: 'rra' as Agency,
        dueOn: due,
        employeeTotal: 162000,
        employerTotal: 0,
        total: 162000,
        people: 2,
        lines: [{ code: 'paye', name: 'PAYE (income tax)' }],
        status: (paid ? 'paid' : 'due') as PeriodStatus,
        id: paid ? `rm-${m}-rra` : null,
        paidOn: paid ? due : null,
        paidAmount: paid ? 162000 : null,
        method: paid ? 'bank' : null,
        reference: paid ? `RRA-${m}` : null,
        note: null,
        paidBy: paid ? 'Mugisha Samuel' : null,
      },
      {
        month,
        agency: 'rssb' as Agency,
        dueOn: due,
        employeeTotal: 56000,
        employerTotal: 69000,
        total: 125000,
        people: 2,
        lines: [
          { code: 'pension', name: 'RSSB pension' },
          { code: 'maternity', name: 'Maternity leave fund' },
          { code: 'cbhi', name: 'Mutuelle de santé (CBHI)' },
          { code: 'hazard', name: 'Occupational hazards' },
        ],
        status: (paid ? 'paid' : 'due') as PeriodStatus,
        id: paid ? `rm-${m}-rssb` : null,
        paidOn: paid ? due : null,
        paidAmount: paid ? 125000 : null,
        method: paid ? 'bank' : null,
        reference: paid ? `RSSB-${m}` : null,
        note: null,
        paidBy: paid ? 'Mugisha Samuel' : null,
      },
    ]
  })
const samplePeriods = (
  anchor: string,
  year: number,
  amount: number,
  paid: number,
): SalaryPeriod[] => {
  const out: SalaryPeriod[] = []
  const today = kigaliToday()
  for (let k = 0; k < 400; k++) {
    const start = addMonths(anchor, k)
    if (start > `${year}-12-31`) break
    if (!start.startsWith(String(year))) continue
    const next = addMonths(anchor, k + 1)
    const end = addMonths(next, 0)
    const n = out.length
    const isPaid = n < paid
    out.push({
      periodStart: start,
      periodEnd: new Date(new Date(end + 'T00:00:00').getTime() - 86_400_000)
        .toISOString()
        .slice(0, 10),
      dueOn: next,
      amount,
      status: isPaid ? 'paid' : next < today ? 'overdue' : 'due',
      id: isPaid ? `sp-${k}` : null,
      paidOn: isPaid ? next : null,
      paidAmount: isPaid ? amount : null,
      method: isPaid ? 'bank' : null,
      reference: isPaid ? `TRF-${year}-${String(k + 1).padStart(2, '0')}` : null,
      note: null,
      paidBy: isPaid ? 'Mugisha Samuel' : null,
      ...sampleSlip(amount),
    })
  }
  return out
}
const sampleYear = Number(kigaliToday().slice(0, 4))
const sampleOverview = (year: number): SalaryOverview => ({
  year,
  today: kigaliToday(),
  people: [
    {
      id: 'u-doc',
      name: 'Dr. Ndayisaba Félix',
      role: 'doctor',
      staffId: 'MMC-S-0002',
      active: true,
      amount: 650000,
      intervalKind: 'monthly',
      customEvery: null,
      customUnit: null,
      anchorOn: `${year}-02-02`,
      payDay: null,
      payeMode: 'normal',
      deductions: [],
      note: null,
      setAt: `${year}-02-02T09:00:00Z`,
      setBy: 'Mugisha Samuel',
      contractEnd: null,
      periods: samplePeriods(`${year}-02-02`, year, 650000, 7),
      paidThisYear: 650000 * 7,
      overdue: 2,
      nextDue: null,
    },
    {
      id: 'u-rec',
      name: 'Uwimana Josiane',
      role: 'receptionist',
      staffId: 'MMC-S-0001',
      active: true,
      amount: 180000,
      intervalKind: 'monthly',
      customEvery: null,
      customUnit: null,
      anchorOn: `${year}-01-05`,
      payDay: 28,
      payeMode: 'normal',
      deductions: [],
      note: null,
      setAt: `${year}-01-05T09:00:00Z`,
      setBy: 'Mugisha Samuel',
      contractEnd: null,
      periods: samplePeriods(`${year}-01-05`, year, 180000, 9),
      paidThisYear: 180000 * 9,
      overdue: 1,
      nextDue: null,
    },
  ],
  withoutSalary: [
    { id: 'u-nur', name: 'Nyirahabimana Chantal', role: 'nurse' },
    { id: 'u-lab', name: 'Uwera Diane', role: 'lab_tech' },
  ],
})
const sampleTaxOverview = (year: number): TaxOverview => ({
  year,
  today: kigaliToday(),
  taxes: [
    {
      id: 'tx-cit',
      name: 'Income tax (CIT) · quarterly prepayments',
      kind: 'profit',
      amount: null,
      intervalKind: 'quarterly',
      customEvery: null,
      customUnit: null,
      anchorOn: `${year}-04-01`,
      payDay: 30,
      note: 'Last year’s tax ÷ turnover × the quarter’s turnover',
      setAt: `${year}-01-05T09:00:00Z`,
      setBy: 'Mugisha Samuel',
      periods: [],
      paidThisYear: 2_100_000,
      overdue: 0,
      nextDue: `${year}-12-31`,
    },
    {
      id: 'tx-paye',
      name: 'PAYE (salaries)',
      kind: 'other',
      amount: 420000,
      intervalKind: 'monthly',
      customEvery: null,
      customUnit: null,
      anchorOn: `${year}-01-01`,
      payDay: 15,
      note: null,
      setAt: `${year}-01-05T09:00:00Z`,
      setBy: 'Mugisha Samuel',
      periods: samplePeriods(`${year}-01-01`, year, 420000, 9),
      paidThisYear: 420000 * 9,
      overdue: 1,
      nextDue: null,
    },
    {
      id: 'tx-vat',
      name: 'VAT',
      kind: 'turnover',
      amount: null,
      intervalKind: 'quarterly',
      customEvery: null,
      customUnit: null,
      anchorOn: `${year}-01-01`,
      payDay: 15,
      note: 'Worked out from the quarter’s sales',
      setAt: `${year}-01-05T09:00:00Z`,
      setBy: 'Mugisha Samuel',
      periods: [],
      paidThisYear: 0,
      overdue: 0,
      nextDue: `${year}-10-15`,
    },
    {
      id: 'tx-licence',
      name: 'Trading licence',
      kind: 'fixed',
      amount: 60000,
      intervalKind: 'yearly',
      customEvery: null,
      customUnit: null,
      anchorOn: `${year}-01-01`,
      payDay: 31,
      note: null,
      setAt: `${year}-01-05T09:00:00Z`,
      setBy: 'Mugisha Samuel',
      periods: [],
      paidThisYear: 60000,
      overdue: 0,
      nextDue: null,
    },
  ],
  base: {
    moneyIn: 58_300_000,
    netRevenue: 56_020_000,
    otherIncome: 2_280_000,
    salaries: 21_600_000,
    statutory: 2_700_000,
    remittances: 4_100_000,
    otherExpenses: 4_900_000,
    stockBought: 13_400_000,
    expenses: 46_700_000,
    resultBeforeTax: 11_600_000,
    taxesPaid: 5_940_000,
    paidByKind: { profit: 2_100_000, other: 3_780_000, fixed: 60_000 },
  },
})
const sampleKinds: MoneyKind[] = [
  {
    id: 'k-bills',
    side: 'in',
    code: 'bills',
    name: 'Patient bills',
    description: 'Payments taken on patients’ bills at the cash desk, less the refunds',
    active: true,
    sortOrder: 10,
    inUse: 0,
  },
  {
    id: 'k-walkin',
    side: 'in',
    code: 'walkin',
    name: 'Walk-in sales',
    description: 'Sold at the pharmacy to buyers without a visit',
    active: true,
    sortOrder: 20,
    inUse: 0,
  },
  {
    id: 'k-rent-in',
    side: 'in',
    code: null,
    name: 'Rent received',
    description: 'The shop space rented to the pharmacy next door',
    active: true,
    sortOrder: 50,
    inUse: 2,
  },
  {
    id: 'k-training',
    side: 'in',
    code: null,
    name: 'Training fees',
    description: 'Fees paid by students on placement',
    active: true,
    sortOrder: 50,
    inUse: 1,
  },
  {
    id: 'k-salary',
    side: 'out',
    code: 'salary',
    name: 'Salaries',
    description: 'The salaries paid to the employees',
    active: true,
    sortOrder: 10,
    inUse: 9,
  },
  {
    id: 'k-statutory',
    side: 'out',
    code: 'statutory',
    name: 'Statutory contributions',
    description: 'The clinic’s own share to RSSB',
    active: true,
    sortOrder: 20,
    inUse: 0,
  },
  {
    id: 'k-remit',
    side: 'out',
    code: 'remittance',
    name: 'Payroll remittances',
    description: 'Withheld from salaries and handed over to RRA and RSSB',
    active: true,
    sortOrder: 30,
    inUse: 0,
  },
  {
    id: 'k-stock',
    side: 'out',
    code: 'stock',
    name: 'Stock bought',
    description: 'Deliveries received, at cost',
    active: true,
    sortOrder: 40,
    inUse: 0,
  },
  {
    id: 'k-electricity',
    side: 'out',
    code: null,
    name: 'Electricity and water',
    description: 'Cash Power and WASAC',
    active: true,
    sortOrder: 50,
    inUse: 4,
  },
  {
    id: 'k-cleaning',
    side: 'out',
    code: null,
    name: 'Cleaning',
    description: 'Cleaning products and the cleaning company',
    active: true,
    sortOrder: 50,
    inUse: 1,
  },
  {
    id: 'k-tax',
    side: 'out',
    code: 'tax',
    name: 'Taxes',
    description: 'The taxes the clinic itself pays (kept apart from the result)',
    active: true,
    sortOrder: 90,
    inUse: 3,
  },
  {
    id: 'k-other',
    side: 'out',
    code: 'other',
    name: 'Other expenses',
    description: 'Expenses with no kind',
    active: true,
    sortOrder: 100,
    inUse: 0,
  },
]
const sampleIncomes: Income[] = [
  {
    id: 'i-1',
    kindId: 'k-rent-in',
    kind: 'Rent received',
    amount: 150000,
    method: 'bank',
    reference: 'TRF-RENT-11',
    from: 'Pharmacie La Grâce',
    note: null,
    receivedOn: kigaliToday(),
    recordedBy: 'Mugisha Samuel',
    voided: false,
    voidReason: null,
  },
  {
    id: 'i-2',
    kindId: 'k-training',
    kind: 'Training fees',
    amount: 40000,
    method: 'momo',
    reference: 'MP3390',
    from: 'Student placement · Uwase',
    note: 'October placement',
    receivedOn: kigaliToday(),
    recordedBy: 'Mugisha Samuel',
    voided: false,
    voidReason: null,
  },
]
const sampleExpenses: Expense[] = [
  {
    id: 'e-1',
    kind: 'other',
    label: 'Electricity (Cash Power)',
    amount: 85000,
    method: 'momo',
    reference: 'MP260211',
    note: null,
    paidOn: kigaliToday(),
    paidBy: 'Mugisha Samuel',
    voided: false,
    voidReason: null,
    periodId: null,
  },
  {
    id: 'e-2',
    kind: 'salary',
    label: 'Uwimana Josiane · 05/10 – 04/11',
    amount: 180000,
    method: 'bank',
    reference: 'TRF-10',
    note: null,
    paidOn: kigaliToday(),
    paidBy: 'Mugisha Samuel',
    voided: false,
    voidReason: null,
    periodId: 'sp-9',
  },
  {
    id: 'e-3',
    kind: 'tax',
    label: 'PAYE (salaries) · 01/10 – 31/10',
    amount: 420000,
    method: 'bank',
    reference: 'RRA-10',
    note: null,
    paidOn: kigaliToday(),
    paidBy: 'Mugisha Samuel',
    voided: false,
    voidReason: null,
    periodId: 'tp-9',
  },
]
const sampleSummary = (from: string, to: string): FinanceSummary => ({
  from,
  to,
  revenue: 4_860_000,
  refunds: 25_000,
  netRevenue: 4_835_000,
  walkIn: 610_000,
  otherIncome: 190_000,
  moneyIn: 5_025_000,
  salaries: 1_970_000,
  statutory: 0,
  remittances: 0,
  taxes: 1_260_000,
  otherExpenses: 412_000,
  stockBought: 1_120_000,
  expenses: 3_502_000,
  net: 1_523_000,
  byKindIn: [
    { id: 'k-bills', code: 'bills', name: 'Patient bills', amount: 4_225_000 },
    { id: 'k-walkin', code: 'walkin', name: 'Walk-in sales', amount: 610_000 },
    { id: 'k-rent-in', code: null, name: 'Rent received', amount: 150_000 },
    { id: 'k-training', code: null, name: 'Training fees', amount: 40_000 },
  ],
  byKindOut: [
    { id: 'k-salary', code: 'salary', name: 'Salaries', amount: 1_970_000 },
    { id: 'k-stock', code: 'stock', name: 'Stock bought', amount: 1_120_000 },
    { id: 'k-electricity', code: null, name: 'Electricity and water', amount: 262_000 },
    { id: 'k-cleaning', code: null, name: 'Cleaning', amount: 150_000 },
  ],
  byMethod: [
    { method: 'cash', count: 312, amount: 2_940_000 },
    { method: 'momo', count: 148, amount: 1_430_000 },
    { method: 'airtel', count: 31, amount: 290_000 },
    { method: 'insurer', count: 19, amount: 200_000 },
  ],
  byMonth: [
    {
      month: `${sampleYear}-09`,
      revenue: 1_520_000,
      refunds: 0,
      otherIncome: 150_000,
      salaries: 650_000,
      taxes: 420_000,
      other: 120_000,
      stock: 380_000,
    },
    {
      month: `${sampleYear}-10`,
      revenue: 1_640_000,
      refunds: 25_000,
      otherIncome: 150_000,
      salaries: 660_000,
      taxes: 420_000,
      other: 142_000,
      stock: 400_000,
    },
    {
      month: `${sampleYear}-11`,
      revenue: 1_700_000,
      refunds: 0,
      otherIncome: 190_000,
      salaries: 660_000,
      taxes: 420_000,
      other: 150_000,
      stock: 340_000,
    },
  ],
  salariesDue: 830_000,
  taxesDue: 420_000,
})

/* ---------------------------------------------------------------- reads */
// The fetchers are also the report centre's loaders (0181, reports-accounts.ts).
export async function fetchSalaryOverview(
  year: number,
  sample = !supabase,
): Promise<SalaryOverview> {
  if (sample || !supabase) return sampleOverview(year)
  const { data, error } = await supabase.rpc('salary_overview', { p_year: year })
  if (error) throw apiError(error)
  const d = data as Partial<SalaryOverview> & { people?: Partial<SalaryPerson>[] }
  return {
    year: Number(d.year ?? year),
    today: String(d.today ?? kigaliToday()),
    withoutSalary: d.withoutSalary ?? [],
    people: (d.people ?? []).map((p) => ({
      id: String(p.id),
      name: String(p.name ?? ''),
      role: String(p.role ?? ''),
      staffId: p.staffId ?? null,
      active: p.active !== false,
      amount: num(p.amount),
      intervalKind: (p.intervalKind ?? 'monthly') as SalaryInterval,
      customEvery: numOrNull(p.customEvery),
      customUnit: (p.customUnit ?? null) as CustomUnit | null,
      anchorOn: String(p.anchorOn ?? ''),
      payDay: numOrNull(p.payDay),
      payeMode: (p.payeMode ?? 'normal') as PayeMode,
      deductions: (p.deductions ?? []).map((d) => ({
        ruleId: String(d.ruleId),
        applies: d.applies !== false,
        until: d.until ?? null,
      })),
      note: p.note ?? null,
      setAt: p.setAt ?? null,
      setBy: p.setBy ?? null,
      contractEnd: p.contractEnd ?? null,
      periods: (p.periods ?? []).map((x) => ({
        periodStart: String(x.periodStart),
        periodEnd: String(x.periodEnd),
        dueOn: String(x.dueOn),
        amount: num(x.amount),
        status: (x.status ?? 'due') as PeriodStatus,
        id: x.id ?? null,
        paidOn: x.paidOn ?? null,
        paidAmount: numOrNull(x.paidAmount),
        method: x.method ?? null,
        reference: x.reference ?? null,
        note: x.note ?? null,
        paidBy: x.paidBy ?? null,
        gross: x.gross == null ? num(x.amount) : num(x.gross),
        net: x.net == null ? num(x.paidAmount ?? x.amount) : num(x.net),
        employerTotal: num(x.employerTotal),
        deductions: (x.deductions ?? []).map(toLine),
      })),
      paidThisYear: num(p.paidThisYear),
      overdue: num(p.overdue),
      nextDue: p.nextDue ?? null,
    })),
  }
}

const toLine = (l: Partial<PayslipLine>): PayslipLine => ({
  code: l.code ?? null,
  ruleId: String(l.ruleId ?? ''),
  name: String(l.name ?? ''),
  agency: (l.agency ?? 'other') as Agency,
  base: l.base === 'net' ? 'net' : 'gross',
  employee: num(l.employee),
  employer: num(l.employer),
})
const toRate = (x: Partial<DeductionRate>): DeductionRate => ({
  validFrom: String(x.validFrom ?? ''),
  employeeRate: numOrNull(x.employeeRate),
  employeeAmount: numOrNull(x.employeeAmount),
  employerRate: numOrNull(x.employerRate),
  employerAmount: numOrNull(x.employerAmount),
})

/** The deductions on salaries and the PAYE bands (0186). */
export async function fetchDeductions(sample = !supabase): Promise<Deductions> {
  if (sample || !supabase) return sampleDeductions
  const { data, error } = await supabase.rpc('deductions_list')
  if (error) throw apiError(error)
  const d = data as Partial<Deductions> & { rules?: Partial<DeductionRule>[] }
  return {
    today: String(d.today ?? kigaliToday()),
    rules: (d.rules ?? []).map((r) => ({
      id: String(r.id),
      code: r.code ?? null,
      name: String(r.name ?? ''),
      agency: (r.agency ?? 'other') as Agency,
      base: r.base === 'net' ? 'net' : 'gross',
      defaultOn: !!r.defaultOn,
      active: r.active !== false,
      note: r.note ?? null,
      sortOrder: num(r.sortOrder),
      current: r.current ? toRate(r.current) : null,
      rates: (r.rates ?? []).map(toRate),
      people: num(r.people),
    })),
    payeBands: (d.payeBands ?? []).map((b) => ({
      validFrom: String(b.validFrom ?? ''),
      lower: num(b.lower),
      rate: num(b.rate),
    })),
  }
}

export function useDeductions(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'deductions'],
    enabled,
    staleTime: 60_000,
    queryFn: () => fetchDeductions(),
  })
}

/** The payroll remittances of a year (0186). */
export async function fetchRemittances(year: number, sample = !supabase): Promise<Remittance[]> {
  if (sample || !supabase) return sampleRemittances(year)
  const { data, error } = await supabase.rpc('remittances_due', { p_year: year })
  if (error) throw apiError(error)
  return ((data ?? []) as Partial<Remittance>[]).map((r) => ({
    month: String(r.month ?? ''),
    agency: (r.agency ?? 'other') as Agency,
    dueOn: String(r.dueOn ?? ''),
    employeeTotal: num(r.employeeTotal),
    employerTotal: num(r.employerTotal),
    total: num(r.total),
    people: num(r.people),
    lines: (r.lines ?? []).map((l) => ({ code: l.code ?? null, name: String(l.name ?? '') })),
    status: (r.status ?? 'due') as PeriodStatus,
    id: r.id ?? null,
    paidOn: r.paidOn ?? null,
    paidAmount: numOrNull(r.paidAmount),
    method: r.method ?? null,
    reference: r.reference ?? null,
    note: r.note ?? null,
    paidBy: r.paidBy ?? null,
  }))
}

export function useRemittances(year: number, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'remittances', year],
    enabled,
    queryFn: () => fetchRemittances(year),
  })
}

export function useSalaryOverview(year: number, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'salaries', year],
    enabled,
    queryFn: () => fetchSalaryOverview(year),
  })
}

const toTaxPeriod = (x: Partial<TaxPeriod>): TaxPeriod => ({
  periodStart: String(x.periodStart),
  periodEnd: String(x.periodEnd),
  dueOn: String(x.dueOn),
  amount: numOrNull(x.amount),
  status: (x.status ?? 'due') as PeriodStatus,
  id: x.id ?? null,
  paidOn: x.paidOn ?? null,
  paidAmount: numOrNull(x.paidAmount),
  method: x.method ?? null,
  reference: x.reference ?? null,
  note: x.note ?? null,
  paidBy: x.paidBy ?? null,
})

const toTaxBase = (b: Partial<TaxBase>): TaxBase => ({
  moneyIn: num(b.moneyIn),
  netRevenue: num(b.netRevenue),
  otherIncome: num(b.otherIncome),
  salaries: num(b.salaries),
  statutory: num(b.statutory),
  remittances: num(b.remittances),
  otherExpenses: num(b.otherExpenses),
  stockBought: num(b.stockBought),
  expenses: num(b.expenses),
  resultBeforeTax: num(b.resultBeforeTax),
  taxesPaid: num(b.taxesPaid),
  paidByKind: Object.fromEntries(
    Object.entries(b.paidByKind ?? {}).map(([k, v]) => [k, num(v)]),
  ) as Partial<Record<TaxKind, number>>,
})

/** The taxes and their periods of a year (0184), with the year's tax base (0187). */
export async function fetchTaxOverview(year: number, sample = !supabase): Promise<TaxOverview> {
  if (sample || !supabase) return sampleTaxOverview(year)
  const { data, error } = await supabase.rpc('tax_overview', { p_year: year })
  if (error) throw apiError(error)
  const d = data as Partial<TaxOverview> & { taxes?: Partial<Tax>[] }
  return {
    year: Number(d.year ?? year),
    today: String(d.today ?? kigaliToday()),
    base: toTaxBase(d.base ?? {}),
    taxes: (d.taxes ?? [])
      .map((x) => ({
        id: String(x.id),
        name: String(x.name ?? ''),
        kind: (TAX_KINDS.includes(x.kind as TaxKind) ? x.kind : 'other') as TaxKind,
        amount: numOrNull(x.amount),
        intervalKind: (x.intervalKind ?? 'monthly') as SalaryInterval,
        customEvery: numOrNull(x.customEvery),
        customUnit: (x.customUnit ?? null) as CustomUnit | null,
        anchorOn: String(x.anchorOn ?? ''),
        payDay: numOrNull(x.payDay),
        note: x.note ?? null,
        setAt: x.setAt ?? null,
        setBy: x.setBy ?? null,
        periods: (x.periods ?? []).map(toTaxPeriod),
        paidThisYear: num(x.paidThisYear),
        overdue: num(x.overdue),
        nextDue: x.nextDue ?? null,
      }))
      .sort(
        (a, b) =>
          TAX_KINDS.indexOf(a.kind) - TAX_KINDS.indexOf(b.kind) || a.name.localeCompare(b.name),
      ),
  }
}

export function useTaxOverview(year: number, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'taxes', year],
    enabled,
    queryFn: () => fetchTaxOverview(year),
  })
}

const toKindAmount = (x: Partial<FinanceSummary['byKindIn'][number]>) => ({
  id: String(x.id ?? ''),
  code: x.code ?? null,
  name: String(x.name ?? ''),
  amount: num(x.amount),
})

export async function fetchFinanceSummary(
  from: string,
  to: string,
  sample = !supabase,
): Promise<FinanceSummary> {
  if (sample || !supabase) return sampleSummary(from, to)
  const { data, error } = await supabase.rpc('finance_summary', { p_from: from, p_to: to })
  if (error) throw apiError(error)
  const d = data as Partial<FinanceSummary>
  return {
    from,
    to,
    revenue: num(d.revenue),
    refunds: num(d.refunds),
    netRevenue: num(d.netRevenue),
    walkIn: num(d.walkIn),
    otherIncome: num(d.otherIncome),
    moneyIn: num(d.moneyIn),
    salaries: num(d.salaries),
    statutory: num(d.statutory),
    remittances: num(d.remittances),
    taxes: num(d.taxes),
    otherExpenses: num(d.otherExpenses),
    stockBought: num(d.stockBought),
    expenses: num(d.expenses),
    net: num(d.net),
    byMethod: (d.byMethod ?? []).map((x) => ({
      method: String(x.method),
      count: num(x.count),
      amount: num(x.amount),
    })),
    byKindIn: (d.byKindIn ?? []).map(toKindAmount),
    byKindOut: (d.byKindOut ?? []).map(toKindAmount),
    byMonth: (d.byMonth ?? []).map((x) => ({
      month: String(x.month),
      revenue: num(x.revenue),
      refunds: num(x.refunds),
      otherIncome: num(x.otherIncome),
      salaries: num(x.salaries),
      taxes: num(x.taxes),
      other: num(x.other),
      stock: num(x.stock),
    })),
    salariesDue: num(d.salariesDue),
    taxesDue: num(d.taxesDue),
  }
}

export function useFinanceSummary(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'summary', from, to],
    enabled,
    queryFn: () => fetchFinanceSummary(from, to),
  })
}

export async function fetchExpenses(
  from: string,
  to: string,
  sample = !supabase,
): Promise<Expense[]> {
  if (sample || !supabase) return sampleExpenses.filter((e) => e.paidOn >= from && e.paidOn <= to)
  const { data, error } = await supabase.rpc('expenses_list', { p_from: from, p_to: to })
  if (error) throw apiError(error)
  return ((data ?? []) as Partial<Expense>[]).map((e) => ({
    id: String(e.id),
    kind: e.kind === 'salary' ? 'salary' : e.kind === 'tax' ? 'tax' : 'other',
    kindId: e.kindId ?? null,
    kindCode: e.kindCode ?? null,
    kindName: e.kindName ?? null,
    label: String(e.label ?? ''),
    amount: num(e.amount),
    method: String(e.method ?? 'cash'),
    reference: e.reference ?? null,
    note: e.note ?? null,
    paidOn: String(e.paidOn ?? ''),
    paidBy: e.paidBy ?? null,
    voided: !!e.voided,
    voidReason: e.voidReason ?? null,
    periodId: e.periodId ?? null,
  }))
}

export function useExpenses(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'expenses', from, to],
    enabled,
    queryFn: () => fetchExpenses(from, to),
  })
}

/** The kinds of money (0185), built-in and the accountant's. */
export async function fetchMoneyKinds(sample = !supabase): Promise<MoneyKind[]> {
  if (sample || !supabase) return sampleKinds
  const { data, error } = await supabase.rpc('money_kinds')
  if (error) throw apiError(error)
  return ((data ?? []) as Partial<MoneyKind>[]).map((k) => ({
    id: String(k.id),
    side: k.side === 'in' ? 'in' : 'out',
    code: k.code ?? null,
    name: String(k.name ?? ''),
    description: k.description ?? null,
    active: k.active !== false,
    sortOrder: num(k.sortOrder),
    inUse: num(k.inUse),
  }))
}

export function useMoneyKinds(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'kinds'],
    enabled,
    staleTime: 60_000,
    queryFn: () => fetchMoneyKinds(),
  })
}

/** The other money in of a period (0185). */
export async function fetchIncomes(
  from: string,
  to: string,
  sample = !supabase,
): Promise<Income[]> {
  if (sample || !supabase)
    return sampleIncomes.filter((i) => i.receivedOn >= from && i.receivedOn <= to)
  const { data, error } = await supabase.rpc('incomes_list', { p_from: from, p_to: to })
  if (error) throw apiError(error)
  return ((data ?? []) as Partial<Income>[]).map((i) => ({
    id: String(i.id),
    kindId: String(i.kindId ?? ''),
    kind: String(i.kind ?? ''),
    amount: num(i.amount),
    method: String(i.method ?? 'cash'),
    reference: i.reference ?? null,
    from: i.from ?? null,
    note: i.note ?? null,
    receivedOn: String(i.receivedOn ?? ''),
    recordedBy: i.recordedBy ?? null,
    voided: !!i.voided,
    voidReason: i.voidReason ?? null,
  }))
}

export function useIncomes(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'incomes', from, to],
    enabled,
    queryFn: () => fetchIncomes(from, to),
  })
}

/* ---------------------------------------------------------------- actions */
/** A tax's settings (0184): the amount null when worked out each time. */
export interface TaxInput {
  kind: TaxKind
  amount: number | null
  interval: SalaryInterval
  customEvery?: number | null
  customUnit?: CustomUnit | null
  anchorOn: string
  payDay: number | null
  note?: string
}

export interface SalaryInput {
  amount: number
  interval: SalaryInterval
  /** 0180: a custom interval: every N days, weeks or months. */
  customEvery?: number | null
  customUnit?: CustomUnit | null
  anchorOn: string
  payDay: number | null
  /** 0186: PAYE by the bands, none, or the casual rate. */
  payeMode?: PayeMode
  note?: string
}

/**
 * The manager's salary fields on the employee form (0179): saved after the employee, with the
 * accounts function; a database before 0179 has none and the rest of the record is saved.
 */
export async function setSalaryQuietly(profileId: string, s: SalaryInput): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('set_salary', {
    p_profile: profileId,
    p_amount: s.amount,
    p_interval: s.interval,
    p_anchor_on: s.anchorOn,
    p_pay_day: s.payDay,
    p_note: s.note ?? null,
    p_custom_every: s.interval === 'custom' ? (s.customEvery ?? null) : null,
    p_custom_unit: s.interval === 'custom' ? (s.customUnit ?? null) : null,
    p_paye_mode: s.payeMode ?? 'normal',
  })
  if (error && !isMissingFunction(error)) throw apiError(error)
}

export function useAccountsActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEY })
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    if (!supabase) return null
    const { data, error } = await supabase.rpc(fn, args)
    if (error) throw apiError(error)
    return data
  }
  const setSalary = useMutation({
    mutationFn: (i: { profileId: string } & SalaryInput) =>
      rpc('set_salary', {
        p_profile: i.profileId,
        p_amount: i.amount,
        p_interval: i.interval,
        p_anchor_on: i.anchorOn,
        p_pay_day: i.payDay,
        p_note: i.note ?? null,
        p_custom_every: i.interval === 'custom' ? (i.customEvery ?? null) : null,
        p_custom_unit: i.interval === 'custom' ? (i.customUnit ?? null) : null,
        p_paye_mode: i.payeMode ?? 'normal',
      }),
    onSuccess: refresh,
  })
  // 0186: the deductions on salaries, per employee, the PAYE bands, the remittances
  const setDeduction = useMutation({
    mutationFn: (i: {
      id: string | null
      name: string
      agency: string
      base: string
      defaultOn: boolean
      employeeRate: number | null
      employeeAmount: number | null
      employerRate: number | null
      employerAmount: number | null
      validFrom: string | null
      note: string
      active: boolean
    }) =>
      rpc('set_deduction', {
        p_id: i.id,
        p_name: i.name,
        p_agency: i.agency,
        p_base: i.base,
        p_default_on: i.defaultOn,
        p_employee_rate: i.employeeRate,
        p_employee_amount: i.employeeAmount,
        p_employer_rate: i.employerRate,
        p_employer_amount: i.employerAmount,
        p_valid_from: i.validFrom,
        p_note: i.note || null,
        p_active: i.active,
      }),
    onSuccess: refresh,
  })
  const removeDeduction = useMutation({
    mutationFn: (id: string) => rpc('remove_deduction', { p_id: id }),
    onSuccess: refresh,
  })
  const setPayeBands = useMutation({
    mutationFn: (i: { validFrom: string; bands: { lower: number; rate: number }[] }) =>
      rpc('set_paye_bands', { p_valid_from: i.validFrom, p_bands: i.bands }),
    onSuccess: refresh,
  })
  const setStaffDeduction = useMutation({
    mutationFn: (i: {
      profileId: string
      ruleId: string
      applies: boolean
      until: string | null
    }) =>
      rpc('set_staff_deduction', {
        p_profile: i.profileId,
        p_rule: i.ruleId,
        p_applies: i.applies,
        p_until: i.until,
      }),
    onSuccess: refresh,
  })
  const payRemittance = useMutation({
    mutationFn: (i: {
      agency: string
      month: string
      paidOn: string
      amount: number
      method: string
      reference: string
      note: string
    }) =>
      rpc('pay_remittance', {
        p_agency: i.agency,
        p_month: i.month,
        p_paid_on: i.paidOn,
        p_amount: i.amount,
        p_method: i.method,
        p_reference: i.reference || null,
        p_note: i.note || null,
      }),
    onSuccess: refresh,
  })
  const unpayRemittance = useMutation({
    mutationFn: (i: { id: string; reason: string }) =>
      rpc('unpay_remittance', { p_id: i.id, p_reason: i.reason }),
    onSuccess: refresh,
  })
  const skipRemittance = useMutation({
    mutationFn: (i: { agency: string; month: string; reason: string }) =>
      rpc('skip_remittance', { p_agency: i.agency, p_month: i.month, p_reason: i.reason }),
    onSuccess: refresh,
  })
  const removeSalary = useMutation({
    mutationFn: (profileId: string) => rpc('remove_salary', { p_profile: profileId }),
    onSuccess: refresh,
  })
  const paySalary = useMutation({
    mutationFn: (i: {
      profileId: string
      periodStart: string
      paidOn: string
      amount: number | null
      method: string
      reference: string
      note: string
    }) =>
      rpc('pay_salary', {
        p_profile: i.profileId,
        p_period_start: i.periodStart,
        p_paid_on: i.paidOn,
        p_amount: i.amount,
        p_method: i.method,
        p_reference: i.reference || null,
        p_note: i.note || null,
      }),
    onSuccess: refresh,
  })
  const unpaySalary = useMutation({
    mutationFn: (i: { periodId: string; reason: string }) =>
      rpc('unpay_salary', { p_period: i.periodId, p_reason: i.reason }),
    onSuccess: refresh,
  })
  const skipSalary = useMutation({
    mutationFn: (i: { profileId: string; periodStart: string; reason: string }) =>
      rpc('skip_salary', {
        p_profile: i.profileId,
        p_period_start: i.periodStart,
        p_reason: i.reason,
      }),
    onSuccess: refresh,
  })
  // 0184: the taxes, built like the salaries
  const setTax = useMutation({
    mutationFn: (i: { id: string | null; name: string } & TaxInput) =>
      rpc('set_tax', {
        p_id: i.id,
        p_name: i.name,
        p_amount: i.amount,
        p_interval: i.interval,
        p_anchor_on: i.anchorOn,
        p_pay_day: i.payDay,
        p_note: i.note ?? null,
        p_custom_every: i.interval === 'custom' ? (i.customEvery ?? null) : null,
        p_custom_unit: i.interval === 'custom' ? (i.customUnit ?? null) : null,
        p_kind: i.kind,
      }),
    onSuccess: refresh,
  })
  const removeTax = useMutation({
    mutationFn: (id: string) => rpc('remove_tax', { p_id: id }),
    onSuccess: refresh,
  })
  const payTax = useMutation({
    mutationFn: (i: {
      taxId: string
      periodStart: string
      paidOn: string
      amount: number
      method: string
      reference: string
      note: string
    }) =>
      rpc('pay_tax', {
        p_tax: i.taxId,
        p_period_start: i.periodStart,
        p_paid_on: i.paidOn,
        p_amount: i.amount,
        p_method: i.method,
        p_reference: i.reference || null,
        p_note: i.note || null,
      }),
    onSuccess: refresh,
  })
  const unpayTax = useMutation({
    mutationFn: (i: { periodId: string; reason: string }) =>
      rpc('unpay_tax', { p_period: i.periodId, p_reason: i.reason }),
    onSuccess: refresh,
  })
  const skipTax = useMutation({
    mutationFn: (i: { taxId: string; periodStart: string; reason: string }) =>
      rpc('skip_tax', { p_tax: i.taxId, p_period_start: i.periodStart, p_reason: i.reason }),
    onSuccess: refresh,
  })
  const addExpense = useMutation({
    mutationFn: (i: {
      label: string
      amount: number
      method: string
      reference: string
      paidOn: string
      note: string
      /** 0185: the kind of money out chosen from the list (a one-off tax: the Taxes kind). */
      kindId: string
    }) =>
      rpc('add_expense', {
        p_label: i.label,
        p_amount: i.amount,
        p_method: i.method,
        p_reference: i.reference || null,
        p_paid_on: i.paidOn,
        p_note: i.note || null,
        p_kind: 'other',
        p_kind_id: i.kindId,
      }),
    onSuccess: refresh,
  })
  // 0185: the kinds of money and the other money in
  const setKind = useMutation({
    mutationFn: (i: {
      id: string | null
      side: 'in' | 'out'
      name: string
      description: string
      active: boolean
    }) =>
      rpc('set_money_kind', {
        p_id: i.id,
        p_side: i.side,
        p_name: i.name,
        p_description: i.description || null,
        p_active: i.active,
      }),
    onSuccess: refresh,
  })
  const removeKind = useMutation({
    mutationFn: (id: string) => rpc('remove_money_kind', { p_id: id }),
    onSuccess: refresh,
  })
  const addIncome = useMutation({
    mutationFn: (i: {
      kindId: string
      amount: number
      method: string
      receivedOn: string
      from: string
      reference: string
      note: string
    }) =>
      rpc('add_income', {
        p_kind: i.kindId,
        p_amount: i.amount,
        p_method: i.method,
        p_reference: i.reference || null,
        p_received_on: i.receivedOn,
        p_from: i.from || null,
        p_note: i.note || null,
      }),
    onSuccess: refresh,
  })
  const voidIncome = useMutation({
    mutationFn: (i: { id: string; reason: string }) =>
      rpc('void_income', { p_id: i.id, p_reason: i.reason }),
    onSuccess: refresh,
  })
  const voidExpense = useMutation({
    mutationFn: (i: { id: string; reason: string }) =>
      rpc('void_expense', { p_id: i.id, p_reason: i.reason }),
    onSuccess: refresh,
  })
  return {
    setSalary,
    removeSalary,
    paySalary,
    unpaySalary,
    skipSalary,
    setTax,
    removeTax,
    payTax,
    unpayTax,
    skipTax,
    addExpense,
    voidExpense,
    setKind,
    removeKind,
    addIncome,
    voidIncome,
    setDeduction,
    removeDeduction,
    setPayeBands,
    setStaffDeduction,
    payRemittance,
    unpayRemittance,
    skipRemittance,
  }
}

/** Once per Kigali day per person: the salary and tax notices (due within 3 days, overdue). */
export function useDailySalaryAlertCheck(enabled = true) {
  const qc = useQueryClient()
  const userId = useSession((s) => s.user?.id ?? null)
  useEffect(() => {
    if (!enabled || !userId || !supabase) return
    const key = `mmc-salary-alert-check:${userId}`
    const day = kigaliToday()
    try {
      if (sessionStorage.getItem(key) === day) return
      sessionStorage.setItem(key, day)
    } catch {
      // no storage: check on each visit
    }
    const client = supabase
    void client
      .rpc('finance_alert_check')
      .then(({ error }) => {
        // a database before 0184: the salary check alone
        if (error && isMissingFunction(error)) return client.rpc('salary_alert_check')
        return { error }
      })
      .then((r) => {
        if (!r.error) void qc.invalidateQueries({ queryKey: ['notifications'] })
      })
  }, [enabled, userId, qc])
}

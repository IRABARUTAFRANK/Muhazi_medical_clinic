/**
 * The clinic's accounts (0179): salaries, expenses and the money summary, for the cashier (the
 * accountant) and the manager.
 *
 * Live: salary_overview, set_salary, remove_salary, pay_salary, unpay_salary, skip_salary,
 * add_expense, void_expense, expenses_list, finance_summary, salary_alert_check. Sample mode:
 * figures kept in memory for the session.
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
] as const
export type SalaryInterval = (typeof SALARY_INTERVALS)[number]

export type PeriodStatus = 'due' | 'overdue' | 'paid' | 'skipped'

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
}

export interface SalaryPerson {
  id: string
  name: string
  role: string
  staffId: string | null
  active: boolean
  amount: number
  intervalKind: SalaryInterval
  anchorOn: string
  payDay: number | null
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

export interface Expense {
  id: string
  kind: 'salary' | 'other'
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
  salaries: number
  otherExpenses: number
  stockBought: number
  expenses: number
  net: number
  byMethod: { method: string; count: number; amount: number }[]
  byMonth: {
    month: string
    revenue: number
    refunds: number
    salaries: number
    other: number
    stock: number
  }[]
  salariesDue: number
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
      anchorOn: `${year}-02-02`,
      payDay: null,
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
      anchorOn: `${year}-01-05`,
      payDay: 28,
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
]
const sampleSummary = (from: string, to: string): FinanceSummary => ({
  from,
  to,
  revenue: 4_860_000,
  refunds: 25_000,
  netRevenue: 4_835_000,
  salaries: 1_970_000,
  otherExpenses: 412_000,
  stockBought: 1_120_000,
  expenses: 3_502_000,
  net: 1_333_000,
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
      salaries: 650_000,
      other: 120_000,
      stock: 380_000,
    },
    {
      month: `${sampleYear}-10`,
      revenue: 1_640_000,
      refunds: 25_000,
      salaries: 660_000,
      other: 142_000,
      stock: 400_000,
    },
    {
      month: `${sampleYear}-11`,
      revenue: 1_700_000,
      refunds: 0,
      salaries: 660_000,
      other: 150_000,
      stock: 340_000,
    },
  ],
  salariesDue: 830_000,
})

/* ---------------------------------------------------------------- reads */
export function useSalaryOverview(year: number, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'salaries', year],
    enabled,
    queryFn: async (): Promise<SalaryOverview> => {
      if (!supabase) return sampleOverview(year)
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
          anchorOn: String(p.anchorOn ?? ''),
          payDay: numOrNull(p.payDay),
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
          })),
          paidThisYear: num(p.paidThisYear),
          overdue: num(p.overdue),
          nextDue: p.nextDue ?? null,
        })),
      }
    },
  })
}

export function useFinanceSummary(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'summary', from, to],
    enabled,
    queryFn: async (): Promise<FinanceSummary> => {
      if (!supabase) return sampleSummary(from, to)
      const { data, error } = await supabase.rpc('finance_summary', { p_from: from, p_to: to })
      if (error) throw apiError(error)
      const d = data as Partial<FinanceSummary>
      return {
        from,
        to,
        revenue: num(d.revenue),
        refunds: num(d.refunds),
        netRevenue: num(d.netRevenue),
        salaries: num(d.salaries),
        otherExpenses: num(d.otherExpenses),
        stockBought: num(d.stockBought),
        expenses: num(d.expenses),
        net: num(d.net),
        byMethod: (d.byMethod ?? []).map((x) => ({
          method: String(x.method),
          count: num(x.count),
          amount: num(x.amount),
        })),
        byMonth: (d.byMonth ?? []).map((x) => ({
          month: String(x.month),
          revenue: num(x.revenue),
          refunds: num(x.refunds),
          salaries: num(x.salaries),
          other: num(x.other),
          stock: num(x.stock),
        })),
        salariesDue: num(d.salariesDue),
      }
    },
  })
}

export function useExpenses(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'expenses', from, to],
    enabled,
    queryFn: async (): Promise<Expense[]> => {
      if (!supabase) return sampleExpenses.filter((e) => e.paidOn >= from && e.paidOn <= to)
      const { data, error } = await supabase.rpc('expenses_list', { p_from: from, p_to: to })
      if (error) throw apiError(error)
      return ((data ?? []) as Partial<Expense>[]).map((e) => ({
        id: String(e.id),
        kind: e.kind === 'salary' ? 'salary' : 'other',
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
    },
  })
}

/* ---------------------------------------------------------------- actions */
export interface SalaryInput {
  amount: number
  interval: SalaryInterval
  anchorOn: string
  payDay: number | null
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
      }),
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
  const addExpense = useMutation({
    mutationFn: (i: {
      label: string
      amount: number
      method: string
      reference: string
      paidOn: string
      note: string
    }) =>
      rpc('add_expense', {
        p_label: i.label,
        p_amount: i.amount,
        p_method: i.method,
        p_reference: i.reference || null,
        p_paid_on: i.paidOn,
        p_note: i.note || null,
      }),
    onSuccess: refresh,
  })
  const voidExpense = useMutation({
    mutationFn: (i: { id: string; reason: string }) =>
      rpc('void_expense', { p_id: i.id, p_reason: i.reason }),
    onSuccess: refresh,
  })
  return { setSalary, removeSalary, paySalary, unpaySalary, skipSalary, addExpense, voidExpense }
}

/** Once per Kigali day per person: the salary notices (due within 3 days, overdue). */
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
    void supabase.rpc('salary_alert_check').then(({ error }) => {
      if (!error) void qc.invalidateQueries({ queryKey: ['notifications'] })
    })
  }, [enabled, userId, qc])
}

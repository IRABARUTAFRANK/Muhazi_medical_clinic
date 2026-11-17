import type { ReportContext, ReportFilterValues, ReportOption } from '@/lib/reports/defs/types'
import { kigaliToday } from '@/lib/clock'
import {
  fetchExpenses,
  fetchFinanceSummary,
  fetchSalaryOverview,
  fetchTaxOverview,
  type CustomUnit,
  type Expense,
  type PeriodStatus,
  type SalaryInterval,
} from './accounts'
import { chosen, inChosen, matches, searchText, selected, switchedOn } from './reports-options'

/**
 * The finance page's reports in the report centre (0181): the payroll (one row per pay period),
 * the taxes (one row per tax period, 0184), the expenses (one row per expense) and the money in
 * and out (one row per month). The rows come from the same functions as the Finance page
 * (salary_overview, tax_overview, expenses_list, finance_summary), so both always agree; the
 * filters are applied here. Sample mode: the page's sample figures.
 */

// ------------------------------------------------------------------ payroll

export const SALARY_STATUSES: readonly PeriodStatus[] = ['due', 'overdue', 'paid', 'skipped']
export const EXPENSE_KINDS = ['salary', 'tax', 'other'] as const

export interface PayrollRow {
  id: string
  profileId: string
  employee: string
  role: string
  staffId: string | null
  intervalKind: SalaryInterval
  customEvery: number | null
  customUnit: CustomUnit | null
  periodStart: string
  periodEnd: string
  dueOn: string
  amount: number
  status: PeriodStatus
  paidOn: string | null
  paidAmount: number | null
  method: string | null
  reference: string | null
  note: string | null
  paidBy: string | null
}

/** The years of the period, at most the four ending in the period's last year. */
const yearsOf = (from: string, to: string): number[] => {
  const last = Number(to.slice(0, 4))
  const first = Math.max(Number(from.slice(0, 4)), last - 3)
  const out: number[] = []
  for (let y = first; y <= last; y++) out.push(y)
  return out
}

export async function loadPayroll(
  f: ReportFilterValues,
  ctx: ReportContext,
): Promise<PayrollRow[]> {
  const { from, to } = f.period
  const overviews = await Promise.all(
    yearsOf(from, to).map((y) => fetchSalaryOverview(y, ctx.sample)),
  )
  const employee = selected(f, 'employee')
  const statuses = chosen(f, 'status')
  const q = searchText(f)
  const rows: PayrollRow[] = []
  for (const o of overviews)
    for (const p of o.people)
      for (const x of p.periods) {
        if (x.dueOn < from || x.dueOn > to) continue
        rows.push({
          id: `${p.id}:${x.periodStart}`,
          profileId: p.id,
          employee: p.name,
          role: p.role,
          staffId: p.staffId,
          intervalKind: p.intervalKind,
          customEvery: p.customEvery,
          customUnit: p.customUnit,
          periodStart: x.periodStart,
          periodEnd: x.periodEnd,
          dueOn: x.dueOn,
          amount: x.amount,
          status: x.status,
          paidOn: x.paidOn,
          paidAmount: x.paidAmount,
          method: x.method,
          reference: x.reference,
          note: x.note,
          paidBy: x.paidBy,
        })
      }
  return rows.filter(
    (r) =>
      (!employee || r.profileId === employee) &&
      inChosen(statuses, r.status) &&
      matches(q, r.employee, r.staffId, r.reference, r.paidBy, r.note),
  )
}

/** The employee filter: everyone with a salary this year, and those without one yet. */
export async function payrollEmployees(ctx: ReportContext): Promise<ReportOption[]> {
  const o = await fetchSalaryOverview(Number(kigaliToday().slice(0, 4)), ctx.sample)
  return [...o.people, ...o.withoutSalary]
    .map((p) => ({ value: p.id, label: p.name }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

// ------------------------------------------------------------------ taxes (0184)

export interface TaxRow {
  id: string
  taxId: string
  tax: string
  intervalKind: SalaryInterval
  customEvery: number | null
  customUnit: CustomUnit | null
  periodStart: string
  periodEnd: string
  dueOn: string
  /** The tax's amount, or what was paid; null for a tax worked out each time and not yet paid. */
  amount: number | null
  status: PeriodStatus
  paidOn: string | null
  paidAmount: number | null
  method: string | null
  reference: string | null
  note: string | null
  paidBy: string | null
}

export async function loadTaxRows(f: ReportFilterValues, ctx: ReportContext): Promise<TaxRow[]> {
  const { from, to } = f.period
  const overviews = await Promise.all(yearsOf(from, to).map((y) => fetchTaxOverview(y, ctx.sample)))
  const tax = selected(f, 'tax')
  const statuses = chosen(f, 'status')
  const q = searchText(f)
  const rows: TaxRow[] = []
  for (const o of overviews)
    for (const x of o.taxes)
      for (const p of x.periods) {
        if (p.dueOn < from || p.dueOn > to) continue
        rows.push({
          id: `${x.id}:${p.periodStart}`,
          taxId: x.id,
          tax: x.name,
          intervalKind: x.intervalKind,
          customEvery: x.customEvery,
          customUnit: x.customUnit,
          periodStart: p.periodStart,
          periodEnd: p.periodEnd,
          dueOn: p.dueOn,
          amount: p.amount,
          status: p.status,
          paidOn: p.paidOn,
          paidAmount: p.paidAmount,
          method: p.method,
          reference: p.reference,
          note: p.note,
          paidBy: p.paidBy,
        })
      }
  return rows.filter(
    (r) =>
      (!tax || r.taxId === tax) &&
      inChosen(statuses, r.status) &&
      matches(q, r.tax, r.reference, r.paidBy, r.note),
  )
}

/** The tax filter: every tax set this year. */
export async function taxOptions(ctx: ReportContext): Promise<ReportOption[]> {
  const o = await fetchTaxOverview(Number(kigaliToday().slice(0, 4)), ctx.sample)
  return o.taxes.map((x) => ({ value: x.id, label: x.name }))
}

// ------------------------------------------------------------------ expenses

export type ExpenseRow = Expense

export async function loadExpenseRows(
  f: ReportFilterValues,
  ctx: ReportContext,
): Promise<ExpenseRow[]> {
  const rows = await fetchExpenses(f.period.from, f.period.to, ctx.sample)
  const kinds = chosen(f, 'kind')
  const methods = chosen(f, 'method')
  const voided = switchedOn(f, 'includeVoided')
  const q = searchText(f)
  return rows.filter(
    (r) =>
      (voided || !r.voided) &&
      inChosen(kinds, r.kind) &&
      inChosen(methods, r.method) &&
      matches(q, r.label, r.reference, r.paidBy, r.note),
  )
}

// ------------------------------------------------------------------ money in and out

export interface MoneyRow {
  /** yyyy-mm */
  month: string
  revenue: number
  refunds: number
  netRevenue: number
  salaries: number
  taxes: number
  other: number
  stock: number
  /** salaries + taxes + other expenses + stock bought */
  moneyOut: number
  net: number
}

export async function loadMoney(f: ReportFilterValues, ctx: ReportContext): Promise<MoneyRow[]> {
  const s = await fetchFinanceSummary(f.period.from, f.period.to, ctx.sample)
  return s.byMonth.map((m) => {
    const moneyOut = m.salaries + m.taxes + m.other + m.stock
    return {
      month: m.month,
      revenue: m.revenue,
      refunds: m.refunds,
      netRevenue: m.revenue - m.refunds,
      salaries: m.salaries,
      taxes: m.taxes,
      other: m.other,
      stock: m.stock,
      moneyOut,
      net: m.revenue - m.refunds - moneyOut,
    }
  })
}

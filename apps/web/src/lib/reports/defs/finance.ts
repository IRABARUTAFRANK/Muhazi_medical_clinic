import i18n from '@/i18n'
import {
  BILL_STATUSES,
  CLAIM_STATUSES,
  COUNTER_SALE_STATUSES,
  DEBT_AGES,
  DEBT_STATUSES,
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  debtAge,
  loadBills,
  loadCashCounts,
  loadCharges,
  loadClaims,
  loadCounterSales,
  loadDebts,
  loadPayments,
  loadRefunds,
  type BillRow,
  type CashCountRow,
  type ChargeRow,
  type ClaimRow,
  type CounterSaleRow,
  type DebtRow,
  type PaymentRow,
  type RefundRow,
} from '@/lib/api/reports-finance'
import {
  AGENCIES,
  TAX_KINDS,
  intervalWords,
  lossWords,
  rateWorkWords,
  taxHowWords,
} from '@/lib/api/accounts'
import {
  EXPENSE_KINDS,
  SALARY_STATUSES,
  loadExpenseRows,
  loadMoney,
  inKindOptions,
  loadIncomeRows,
  loadPayroll,
  loadRemittanceRows,
  loadTaxRows,
  outKindOptions,
  payrollEmployees,
  taxOptions,
  type ExpenseRow,
  type MoneyRow,
  type IncomeRow,
  type PayrollRow,
  type RemittanceRow,
  type TaxRow,
} from '@/lib/api/reports-accounts'
import {
  categoryName,
  keyOptions,
  pharmacyTakesMoney,
  readsAllMoney,
  reportFilterOptions,
  seesMoney,
  toOptions,
} from '@/lib/api/reports-options'
import { careHead } from '../access'
import type {
  AnyReportDef,
  ReportColumnDef,
  ReportContext,
  ReportDef,
  ReportFilterDef,
  ReportGroupDef,
  ReportOption,
} from './types'

/**
 * The finance reports (migration 0111): revenue (the payments), revenue by service (the charge
 * lines), bills, unpaid bills, refunds, walk-in sales, cash counts and insurer claims. The
 * manager and billing.read see the whole clinic; someone who only takes payments (and the
 * pharmacy taking its walk-in money) their own payments, refunds and cash counts; a head the
 * charges of their department. The database checks the same rights again.
 */

const t = (key: string, o?: Record<string, unknown>) => i18n.t(key, o)
const K = 'financeReports'

// ------------------------------------------------------------------ words of the cells

const methodLabel = (m: string | null | undefined) =>
  m ? t(`visit.payment.methods.${m}`, { defaultValue: m }) : ''
/** The Kigali day of a timestamp (yyyy-mm-dd). */
const kigaliDay = (iso: string | null | undefined) =>
  iso ? new Date(Date.parse(iso) + 2 * 3_600_000).toISOString().slice(0, 10) : ''
/** dd/mm/yyyy of a yyyy-mm-dd day (group headings). */
const dayLabel = (day: string) =>
  day ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : ''
const insurerLabel = (name: string | null | undefined) => name || t(`${K}.noInsurer`)
const buyerLabel = (name: string | null | undefined) => name || t(`${K}.walkInBuyer`)
const chargeCategory = (c: ChargeRow) =>
  c.categoryKey === 'medicine' || c.categoryKey === 'supply' || !c.categoryId
    ? t(
        `${K}.categories.${c.categoryKey === 'supply' ? 'supply' : c.categoryKey === 'medicine' ? 'medicine' : 'other'}`,
      )
    : categoryName({ nameEn: c.categoryEn, nameKin: c.categoryKin, nameFr: c.categoryFr })
const chargeStatus = (c: ChargeRow) =>
  c.source === 'sale'
    ? t(`counterSale.status.${c.billStatus}`, { defaultValue: c.billStatus ?? '' })
    : t(`${K}.lineStatus.${c.billStatus}`, { defaultValue: c.billStatus ?? '' })
const sum = <R>(rows: R[], f: (r: R) => number) => rows.reduce((s, r) => s + (f(r) || 0), 0)

// ------------------------------------------------------------------ shared filters and groups

const periodFilter = (range: 'today' | 'week' | 'month' | 'all'): ReportFilterDef => ({
  key: 'period',
  label: 'report.period',
  kind: 'period',
  default: range,
})
const methodFilter: ReportFilterDef = {
  key: 'method',
  label: `${K}.filters.method`,
  kind: 'multi',
  options: keyOptions('visit.payment.methods', PAYMENT_METHODS),
}
const cashierFilter: ReportFilterDef = {
  key: 'cashier',
  label: `${K}.filters.cashier`,
  kind: 'select',
  loadOptions: async (ctx) => toOptions((await reportFilterOptions(ctx)).cashiers),
  allowed: readsAllMoney,
}
const insurerFilter = (withNone = true): ReportFilterDef => ({
  key: 'insurer',
  label: `${K}.filters.insurer`,
  kind: 'select',
  loadOptions: async (ctx): Promise<ReportOption[]> => [
    ...(withNone ? [{ value: 'none', label: `${K}.noInsurer`, labelIsKey: true }] : []),
    ...toOptions((await reportFilterOptions(ctx)).insurers),
  ],
})
const searchFilter = (placeholder: string): ReportFilterDef => ({
  key: 'search',
  label: `${K}.filters.search`,
  kind: 'text',
  placeholder: `${K}.placeholders.${placeholder}`,
})
const byDay = <R>(at: (r: R) => string | null | undefined): ReportGroupDef<R> => ({
  key: 'day',
  label: `${K}.groups.day`,
  value: (r) => dayLabel(kigaliDay(at(r))),
  order: (r) => kigaliDay(at(r)),
})
const byMethod = <R extends { method: string | null }>(): ReportGroupDef<R> => ({
  key: 'method',
  label: `${K}.groups.method`,
  value: (r) => methodLabel(r.method) || t(`${K}.notPaid`),
  order: (r) => {
    const i = (PAYMENT_METHODS as readonly string[]).indexOf(r.method ?? '')
    return i < 0 ? 99 : i
  },
})
const byCashier = <R extends { cashier: string | null }>(): ReportGroupDef<R> => ({
  key: 'cashier',
  label: `${K}.groups.cashier`,
  value: (r) => r.cashier ?? '',
})
const byInsurer = <R extends { insurer: string | null }>(): ReportGroupDef<R> => ({
  key: 'insurer',
  label: `${K}.groups.insurer`,
  value: (r) => insurerLabel(r.insurer),
  // the patients without insurance first, then the insurers by name
  order: (r) => (r.insurer ? `1${r.insurer}` : '0'),
})

// ------------------------------------------------------------------ 1 revenue (payments)

const revenue: ReportDef<PaymentRow> = {
  id: 'finance.revenue',
  group: 'finance',
  title: `${K}.revenue.title`,
  description: `${K}.revenue.description`,
  code: 'REV',
  load: loadPayments,
  allowed: seesMoney,
  filters: [
    periodFilter('today'),
    methodFilter,
    {
      key: 'kind',
      label: `${K}.filters.kind`,
      kind: 'multi',
      options: keyOptions(`${K}.kinds`, PAYMENT_KINDS),
    },
    cashierFilter,
    insurerFilter(),
    searchFilter('payments'),
  ],
  columns: [
    {
      key: 'at',
      label: `${K}.cols.at`,
      kind: 'datetime',
      default: true,
      value: (r) => r.at,
      nowrap: true,
    },
    {
      key: 'receiptNo',
      label: `${K}.cols.receiptNo`,
      default: true,
      value: (r) => r.receiptNo,
      nowrap: true,
    },
    {
      key: 'patient',
      label: `${K}.cols.patient`,
      default: true,
      value: (r) => buyerLabel(r.patient),
    },
    {
      key: 'fileNumber',
      label: `${K}.cols.fileNumber`,
      default: true,
      value: (r) => r.fileNumber,
      nowrap: true,
    },
    { key: 'visitNo', label: `${K}.cols.visitNo`, value: (r) => r.visitNo, nowrap: true },
    { key: 'billNo', label: `${K}.cols.billNo`, value: (r) => r.billNo, nowrap: true },
    {
      key: 'kind',
      label: `${K}.cols.kind`,
      default: true,
      value: (r) => t(`${K}.kinds.${r.kind}`),
    },
    {
      key: 'method',
      label: `${K}.cols.method`,
      default: true,
      value: (r) => methodLabel(r.method),
      nowrap: true,
    },
    { key: 'reference', label: `${K}.cols.reference`, value: (r) => r.reference, nowrap: true },
    { key: 'insurer', label: `${K}.cols.insurer`, value: (r) => r.insurer },
    { key: 'store', label: `${K}.cols.store`, value: (r) => r.store },
    { key: 'cashier', label: `${K}.cols.cashier`, default: true, value: (r) => r.cashier },
    {
      key: 'amount',
      label: `${K}.cols.amount`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.amount,
    },
    {
      key: 'refunded',
      label: `${K}.cols.refunded`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.refunded,
    },
    {
      key: 'net',
      label: `${K}.cols.net`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.net,
    },
    { key: 'counted', label: `${K}.cols.counted`, kind: 'yesno', value: (r) => r.counted },
  ],
  figures: (rows) => [
    { label: `${K}.figures.payments`, value: rows.length },
    { label: `${K}.figures.collected`, value: sum(rows, (r) => r.amount), unit: 'RWF' },
    { label: `${K}.figures.givenBack`, value: sum(rows, (r) => r.refunded), unit: 'RWF' },
    { label: `${K}.figures.net`, value: sum(rows, (r) => r.net), unit: 'RWF' },
    {
      label: `${K}.figures.inCash`,
      value: sum(
        rows.filter((r) => r.method === 'cash'),
        (r) => r.net,
      ),
      unit: 'RWF',
    },
  ],
  groups: [
    byMethod<PaymentRow>(),
    byDay<PaymentRow>((r) => r.at),
    byCashier<PaymentRow>(),
    {
      key: 'kind',
      label: `${K}.groups.kind`,
      value: (r) => t(`${K}.kinds.${r.kind}`),
      order: (r) => PAYMENT_KINDS.indexOf(r.kind),
    },
    byInsurer<PaymentRow>(),
  ],
  defaultSort: { key: 'at', dir: 'asc' },
  notes: [`${K}.revenue.note1`, `${K}.revenue.note2`, `${K}.revenue.note3`],
  wide: true,
  countLabel: `${K}.count.payments`,
}

// ------------------------------------------------------------------ 2 revenue by service

const services: ReportDef<ChargeRow> = {
  id: 'finance.services',
  group: 'finance',
  title: `${K}.services.title`,
  description: `${K}.services.description`,
  code: 'SRV',
  load: loadCharges,
  // a head of a treating department: their department's services (0182: not the finance head)
  allowed: (ctx) => readsAllMoney(ctx) || careHead(ctx),
  filters: [
    periodFilter('month'),
    {
      key: 'department',
      label: `${K}.filters.department`,
      kind: 'select',
      loadOptions: async (ctx) => toOptions((await reportFilterOptions(ctx)).departments),
    },
    {
      key: 'category',
      label: `${K}.filters.category`,
      kind: 'select',
      loadOptions: async (ctx): Promise<ReportOption[]> => [
        ...(await reportFilterOptions(ctx)).categories.map((c) => ({
          value: c.id,
          label: categoryName(c),
        })),
        { value: 'medicine', label: `${K}.categories.medicine`, labelIsKey: true },
        { value: 'supply', label: `${K}.categories.supply`, labelIsKey: true },
      ],
    },
    insurerFilter(),
    {
      key: 'includeOpen',
      label: `${K}.filters.includeOpen`,
      kind: 'toggle',
      default: false,
      hint: `${K}.filters.includeOpenHint`,
    },
    searchFilter('services'),
  ],
  columns: [
    {
      key: 'at',
      label: `${K}.cols.day`,
      kind: 'date',
      default: true,
      value: (r) => r.at,
      nowrap: true,
    },
    { key: 'code', label: `${K}.cols.code`, value: (r) => r.code, nowrap: true },
    {
      key: 'description',
      label: `${K}.cols.service`,
      default: true,
      value: (r) => r.description,
      width: '26%',
    },
    { key: 'category', label: `${K}.cols.category`, default: true, value: chargeCategory },
    { key: 'department', label: `${K}.cols.department`, default: true, value: (r) => r.department },
    {
      key: 'desk',
      label: `${K}.cols.desk`,
      value: (r) => (r.desk ? t(`desks.names.${r.desk}`, { defaultValue: r.desk }) : r.store),
    },
    {
      key: 'patient',
      label: `${K}.cols.patient`,
      value: (r) => (r.source === 'sale' ? buyerLabel(r.patient) : r.patient),
    },
    { key: 'fileNumber', label: `${K}.cols.fileNumber`, value: (r) => r.fileNumber, nowrap: true },
    { key: 'billNo', label: `${K}.cols.billNo`, value: (r) => r.billNo, nowrap: true },
    { key: 'visitNo', label: `${K}.cols.visitNo`, value: (r) => r.visitNo, nowrap: true },
    {
      key: 'units',
      label: `${K}.cols.quantity`,
      kind: 'number',
      default: true,
      total: 'sum',
      value: (r) => r.units,
    },
    {
      key: 'quantity',
      label: `${K}.cols.quantityCharged`,
      kind: 'number',
      value: (r) => r.quantity,
    },
    { key: 'packSize', label: `${K}.cols.packSize`, kind: 'number', value: (r) => r.packSize },
    { key: 'unitPrice', label: `${K}.cols.unitPrice`, kind: 'money', value: (r) => r.unitPrice },
    { key: 'listPrice', label: `${K}.cols.listPrice`, kind: 'money', value: (r) => r.listPrice },
    {
      key: 'discount',
      label: `${K}.cols.discount`,
      kind: 'money',
      total: 'sum',
      value: (r) => r.discount,
    },
    { key: 'discountReason', label: `${K}.cols.discountReason`, value: (r) => r.discountReason },
    {
      key: 'total',
      label: `${K}.cols.total`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.total,
    },
    {
      key: 'insurerShare',
      label: `${K}.cols.insurerShare`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.insurerShare,
    },
    {
      key: 'patientShare',
      label: `${K}.cols.patientShare`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.patientShare,
    },
    { key: 'insurer', label: `${K}.cols.insurer`, value: (r) => r.insurer },
    { key: 'enteredBy', label: `${K}.cols.enteredBy`, value: (r) => r.enteredBy },
    { key: 'status', label: `${K}.cols.status`, value: chargeStatus },
  ],
  figures: (rows) => [
    { label: `${K}.figures.lines`, value: rows.length },
    { label: `${K}.figures.charged`, value: sum(rows, (r) => r.total), unit: 'RWF' },
    { label: `${K}.figures.insurerShare`, value: sum(rows, (r) => r.insurerShare), unit: 'RWF' },
    { label: `${K}.figures.patientShare`, value: sum(rows, (r) => r.patientShare), unit: 'RWF' },
    { label: `${K}.figures.discounts`, value: sum(rows, (r) => r.discount), unit: 'RWF' },
  ],
  groups: [
    { key: 'service', label: `${K}.groups.service`, value: (r) => r.description },
    { key: 'category', label: `${K}.groups.category`, value: chargeCategory },
    {
      key: 'department',
      label: `${K}.groups.department`,
      value: (r) => r.department ?? t(`${K}.noDepartment`),
    },
    byDay<ChargeRow>((r) => r.at),
    byInsurer<ChargeRow>(),
  ],
  defaultGroup: { key: 'service', mode: 'summary' },
  defaultSort: { key: 'at', dir: 'asc' },
  notes: [`${K}.services.note1`, `${K}.services.note2`, `${K}.services.note3`],
  wide: true,
  countLabel: `${K}.count.lines`,
}

// ------------------------------------------------------------------ 3 bills

const bills: ReportDef<BillRow> = {
  id: 'finance.bills',
  group: 'finance',
  title: `${K}.bills.title`,
  description: `${K}.bills.description`,
  code: 'BIL',
  load: loadBills,
  allowed: readsAllMoney,
  filters: [
    periodFilter('month'),
    {
      key: 'status',
      label: `${K}.filters.status`,
      kind: 'multi',
      options: keyOptions(`${K}.billStatus`, BILL_STATUSES),
    },
    insurerFilter(),
    searchFilter('bills'),
  ],
  columns: [
    {
      key: 'at',
      label: `${K}.cols.day`,
      kind: 'date',
      default: true,
      value: (r) => r.at,
      nowrap: true,
    },
    {
      key: 'billNo',
      label: `${K}.cols.billNo`,
      default: true,
      value: (r) => r.billNo,
      nowrap: true,
    },
    { key: 'visitNo', label: `${K}.cols.visitNo`, value: (r) => r.visitNo, nowrap: true },
    { key: 'patient', label: `${K}.cols.patient`, default: true, value: (r) => r.patient },
    {
      key: 'fileNumber',
      label: `${K}.cols.fileNumber`,
      default: true,
      value: (r) => r.fileNumber,
      nowrap: true,
    },
    { key: 'insurer', label: `${K}.cols.insurer`, default: true, value: (r) => r.insurer },
    { key: 'memberNo', label: `${K}.cols.memberNo`, value: (r) => r.memberNo, nowrap: true },
    { key: 'lines', label: `${K}.cols.lines`, kind: 'number', total: 'sum', value: (r) => r.lines },
    {
      key: 'total',
      label: `${K}.cols.total`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.total,
    },
    {
      key: 'insurerShare',
      label: `${K}.cols.insurerShare`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.insurerShare,
    },
    {
      key: 'patientShare',
      label: `${K}.cols.patientShare`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.patientShare,
    },
    {
      key: 'paid',
      label: `${K}.cols.paid`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.paid,
    },
    {
      key: 'refunded',
      label: `${K}.cols.refunded`,
      kind: 'money',
      total: 'sum',
      value: (r) => r.refunded,
    },
    {
      key: 'credited',
      label: `${K}.cols.credited`,
      kind: 'money',
      total: 'sum',
      value: (r) => r.credited,
    },
    {
      key: 'balance',
      label: `${K}.cols.balance`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.balance,
    },
    {
      key: 'status',
      label: `${K}.cols.status`,
      default: true,
      value: (r) => t(`${K}.billStatus.${r.status}`),
      nowrap: true,
    },
  ],
  figures: (rows) => [
    { label: `${K}.figures.bills`, value: rows.length },
    { label: `${K}.figures.billed`, value: sum(rows, (r) => r.total), unit: 'RWF' },
    { label: `${K}.figures.patientShare`, value: sum(rows, (r) => r.patientShare), unit: 'RWF' },
    { label: `${K}.figures.paid`, value: sum(rows, (r) => r.paid), unit: 'RWF' },
    { label: `${K}.figures.balance`, value: sum(rows, (r) => r.balance), unit: 'RWF' },
  ],
  groups: [
    {
      key: 'status',
      label: `${K}.groups.status`,
      value: (r) => t(`${K}.billStatus.${r.status}`),
      order: (r) => BILL_STATUSES.indexOf(r.status),
    },
    byInsurer<BillRow>(),
    byDay<BillRow>((r) => r.at),
  ],
  defaultSort: { key: 'at', dir: 'asc' },
  notes: [`${K}.bills.note1`, `${K}.bills.note2`],
  wide: true,
  countLabel: `${K}.count.bills`,
}

// ------------------------------------------------------------------ 4 unpaid bills

const debts: ReportDef<DebtRow> = {
  id: 'finance.debts',
  group: 'finance',
  title: `${K}.debts.title`,
  description: `${K}.debts.description`,
  code: 'DBT',
  load: loadDebts,
  allowed: readsAllMoney,
  filters: [
    periodFilter('all'),
    {
      key: 'status',
      label: `${K}.filters.status`,
      kind: 'multi',
      options: keyOptions(`${K}.debtStatus`, DEBT_STATUSES),
    },
    insurerFilter(),
    searchFilter('debts'),
  ],
  columns: [
    {
      key: 'visitAt',
      label: `${K}.cols.visitDay`,
      kind: 'date',
      default: true,
      value: (r) => r.visitAt,
      nowrap: true,
    },
    { key: 'visitNo', label: `${K}.cols.visitNo`, value: (r) => r.visitNo, nowrap: true },
    {
      key: 'billNo',
      label: `${K}.cols.billNo`,
      default: true,
      value: (r) => r.billNo,
      nowrap: true,
    },
    { key: 'patient', label: `${K}.cols.patient`, default: true, value: (r) => r.patient },
    {
      key: 'fileNumber',
      label: `${K}.cols.fileNumber`,
      default: true,
      value: (r) => r.fileNumber,
      nowrap: true,
    },
    { key: 'phone', label: `${K}.cols.phone`, default: true, value: (r) => r.phone, nowrap: true },
    { key: 'insurer', label: `${K}.cols.insurer`, value: (r) => r.insurer },
    {
      key: 'total',
      label: `${K}.cols.patientShare`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.total,
    },
    {
      key: 'paid',
      label: `${K}.cols.paid`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.paid,
    },
    {
      key: 'due',
      label: `${K}.cols.due`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.due,
    },
    {
      key: 'days',
      label: `${K}.cols.days`,
      kind: 'number',
      default: true,
      total: 'avg',
      value: (r) => r.days,
    },
    {
      key: 'status',
      label: `${K}.cols.status`,
      default: true,
      value: (r) => t(`${K}.debtStatus.${r.status}`),
    },
    { key: 'reason', label: `${K}.cols.reason`, value: (r) => r.reason },
    {
      key: 'closedAt',
      label: `${K}.cols.closedAt`,
      kind: 'datetime',
      value: (r) => r.closedAt,
      nowrap: true,
    },
    { key: 'closedBy', label: `${K}.cols.closedBy`, value: (r) => r.closedBy },
  ],
  figures: (rows) => [
    { label: `${K}.figures.unpaidBills`, value: rows.length },
    { label: `${K}.figures.due`, value: sum(rows, (r) => r.due), unit: 'RWF' },
    {
      label: `${K}.figures.oldest`,
      value: rows.reduce((m, r) => Math.max(m, r.days), 0),
      unit: `${K}.units.days`,
    },
    {
      label: `${K}.figures.over30`,
      value: sum(
        rows.filter((r) => r.days > 30),
        (r) => r.due,
      ),
      unit: 'RWF',
    },
  ],
  groups: [
    {
      key: 'age',
      label: `${K}.groups.age`,
      value: (r) => t(`${K}.ages.${debtAge(r.days)}`),
      order: (r) => DEBT_AGES.indexOf(debtAge(r.days)),
    },
    {
      key: 'status',
      label: `${K}.groups.status`,
      value: (r) => t(`${K}.debtStatus.${r.status}`),
      order: (r) => DEBT_STATUSES.indexOf(r.status),
    },
    byInsurer<DebtRow>(),
  ],
  defaultSort: { key: 'visitAt', dir: 'desc' },
  notes: [`${K}.debts.note1`, `${K}.debts.note2`],
  wide: true,
  countLabel: `${K}.count.bills`,
}

// ------------------------------------------------------------------ 5 refunds

const refunds: ReportDef<RefundRow> = {
  id: 'finance.refunds',
  group: 'finance',
  title: `${K}.refunds.title`,
  description: `${K}.refunds.description`,
  code: 'RFD',
  load: loadRefunds,
  allowed: seesMoney,
  filters: [periodFilter('month'), methodFilter, cashierFilter, searchFilter('refunds')],
  columns: [
    {
      key: 'at',
      label: `${K}.cols.at`,
      kind: 'datetime',
      default: true,
      value: (r) => r.at,
      nowrap: true,
    },
    { key: 'patient', label: `${K}.cols.patient`, default: true, value: (r) => r.patient },
    {
      key: 'fileNumber',
      label: `${K}.cols.fileNumber`,
      default: true,
      value: (r) => r.fileNumber,
      nowrap: true,
    },
    { key: 'visitNo', label: `${K}.cols.visitNo`, value: (r) => r.visitNo, nowrap: true },
    {
      key: 'billNo',
      label: `${K}.cols.billNo`,
      default: true,
      value: (r) => r.billNo,
      nowrap: true,
    },
    {
      key: 'method',
      label: `${K}.cols.method`,
      default: true,
      value: (r) => methodLabel(r.method),
      nowrap: true,
    },
    { key: 'reference', label: `${K}.cols.reference`, value: (r) => r.reference, nowrap: true },
    {
      key: 'reason',
      label: `${K}.cols.reason`,
      default: true,
      value: (r) => r.reason,
      width: '28%',
    },
    { key: 'cashier', label: `${K}.cols.givenBackBy`, default: true, value: (r) => r.cashier },
    {
      key: 'amount',
      label: `${K}.cols.amount`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.amount,
    },
  ],
  figures: (rows) => [
    { label: `${K}.figures.refunds`, value: rows.length },
    { label: `${K}.figures.givenBack`, value: sum(rows, (r) => r.amount), unit: 'RWF' },
    {
      label: `${K}.figures.patients`,
      value: new Set(rows.map((r) => r.fileNumber ?? r.patient)).size,
    },
  ],
  groups: [byMethod<RefundRow>(), byCashier<RefundRow>(), byDay<RefundRow>((r) => r.at)],
  defaultSort: { key: 'at', dir: 'asc' },
  notes: [`${K}.refunds.note1`],
  countLabel: `${K}.count.refunds`,
}

// ------------------------------------------------------------------ 6 walk-in sales

const walkIn: ReportDef<CounterSaleRow> = {
  id: 'pharmacy.walkInSales',
  group: 'pharmacy',
  title: `${K}.walkIn.title`,
  description: `${K}.walkIn.description`,
  code: 'WLK',
  load: loadCounterSales,
  allowed: (ctx: ReportContext) =>
    readsAllMoney(ctx) ||
    pharmacyTakesMoney(ctx) ||
    (ctx.can('stock.sell_walkin') && ctx.holdsStore),
  filters: [
    periodFilter('today'),
    {
      key: 'status',
      label: `${K}.filters.status`,
      kind: 'multi',
      options: keyOptions('counterSale.status', COUNTER_SALE_STATUSES),
      default: ['open', 'paid', 'handed_over'],
    },
    {
      key: 'store',
      label: `${K}.filters.store`,
      kind: 'select',
      loadOptions: async (ctx) => toOptions((await reportFilterOptions(ctx)).stores),
    },
    methodFilter,
    searchFilter('sales'),
  ],
  columns: [
    {
      key: 'at',
      label: `${K}.cols.at`,
      kind: 'datetime',
      default: true,
      value: (r) => r.at,
      nowrap: true,
    },
    {
      key: 'number',
      label: `${K}.cols.saleNo`,
      default: true,
      value: (r) => r.number,
      nowrap: true,
    },
    { key: 'buyer', label: `${K}.cols.buyer`, default: true, value: (r) => buyerLabel(r.buyer) },
    { key: 'phone', label: `${K}.cols.phone`, value: (r) => r.phone, nowrap: true },
    { key: 'store', label: `${K}.cols.store`, default: true, value: (r) => r.store },
    { key: 'items', label: `${K}.cols.items`, default: true, value: (r) => r.items, width: '30%' },
    { key: 'lines', label: `${K}.cols.lines`, kind: 'number', total: 'sum', value: (r) => r.lines },
    { key: 'units', label: `${K}.cols.units`, kind: 'number', total: 'sum', value: (r) => r.units },
    {
      key: 'total',
      label: `${K}.cols.total`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.total,
    },
    {
      key: 'status',
      label: `${K}.cols.status`,
      default: true,
      value: (r) => t(`counterSale.status.${r.status}`),
    },
    { key: 'method', label: `${K}.cols.method`, value: (r) => methodLabel(r.method), nowrap: true },
    { key: 'receiptNo', label: `${K}.cols.receiptNo`, value: (r) => r.receiptNo, nowrap: true },
    {
      key: 'paidAt',
      label: `${K}.cols.paidAt`,
      kind: 'datetime',
      value: (r) => r.paidAt,
      nowrap: true,
    },
    { key: 'cashier', label: `${K}.cols.cashier`, value: (r) => r.cashier },
    { key: 'seller', label: `${K}.cols.seller`, default: true, value: (r) => r.seller },
    {
      key: 'handedOverAt',
      label: `${K}.cols.handedOverAt`,
      kind: 'datetime',
      value: (r) => r.handedOverAt,
      nowrap: true,
    },
    { key: 'handedOverBy', label: `${K}.cols.handedOverBy`, value: (r) => r.handedOverBy },
    { key: 'cancelReason', label: `${K}.cols.cancelReason`, value: (r) => r.cancelReason },
  ],
  figures: (rows) => {
    const live = rows.filter((r) => r.status !== 'cancelled')
    const paid = rows.filter((r) => r.status === 'paid' || r.status === 'handed_over')
    return [
      { label: `${K}.figures.sales`, value: live.length },
      { label: `${K}.figures.paidSales`, value: sum(paid, (r) => r.total), unit: 'RWF' },
      {
        label: `${K}.figures.waiting`,
        value: sum(
          rows.filter((r) => r.status === 'open'),
          (r) => r.total,
        ),
        unit: 'RWF',
      },
      { label: `${K}.figures.cancelled`, value: rows.length - live.length },
    ]
  },
  groups: [
    { key: 'store', label: `${K}.groups.store`, value: (r) => r.store },
    {
      key: 'status',
      label: `${K}.groups.status`,
      value: (r) => t(`counterSale.status.${r.status}`),
      order: (r) => COUNTER_SALE_STATUSES.indexOf(r.status),
    },
    { key: 'seller', label: `${K}.groups.seller`, value: (r) => r.seller ?? '' },
    byMethod<CounterSaleRow>(),
    byDay<CounterSaleRow>((r) => r.at),
  ],
  defaultSort: { key: 'at', dir: 'asc' },
  notes: [`${K}.walkIn.note1`, `${K}.walkIn.note2`],
  wide: true,
  countLabel: `${K}.count.sales`,
}

// ------------------------------------------------------------------ 7 cash counts

const cashCounts: ReportDef<CashCountRow> = {
  id: 'finance.cashCounts',
  group: 'finance',
  title: `${K}.cashCounts.title`,
  description: `${K}.cashCounts.description`,
  code: 'CSH',
  load: loadCashCounts,
  allowed: seesMoney,
  filters: [periodFilter('week'), cashierFilter, methodFilter],
  columns: [
    {
      key: 'day',
      label: `${K}.cols.day`,
      kind: 'date',
      default: true,
      value: (r) => r.day,
      nowrap: true,
    },
    { key: 'cashier', label: `${K}.cols.cashier`, default: true, value: (r) => r.cashier },
    {
      key: 'method',
      label: `${K}.cols.method`,
      default: true,
      value: (r) => methodLabel(r.method),
      nowrap: true,
    },
    {
      key: 'expected',
      label: `${K}.cols.expected`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.expected,
    },
    {
      key: 'counted',
      label: `${K}.cols.countedAmount`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.counted,
    },
    {
      key: 'difference',
      label: `${K}.cols.difference`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.difference,
    },
    { key: 'at', label: `${K}.cols.countedAt`, kind: 'datetime', value: (r) => r.at, nowrap: true },
    { key: 'note', label: `${K}.cols.note`, value: (r) => r.note, width: '26%' },
  ],
  figures: (rows) => [
    { label: `${K}.figures.closes`, value: new Set(rows.map((r) => r.closeId)).size },
    { label: `${K}.figures.expected`, value: sum(rows, (r) => r.expected), unit: 'RWF' },
    { label: `${K}.figures.counted`, value: sum(rows, (r) => r.counted), unit: 'RWF' },
    { label: `${K}.figures.difference`, value: sum(rows, (r) => r.difference), unit: 'RWF' },
    {
      label: `${K}.figures.short`,
      value: new Set(rows.filter((r) => r.difference < 0).map((r) => r.closeId)).size,
    },
  ],
  groups: [
    byCashier<CashCountRow>(),
    {
      key: 'day',
      label: `${K}.groups.day`,
      value: (r) => dayLabel(r.day),
      order: (r) => r.day,
    },
    byMethod<CashCountRow>(),
  ],
  defaultSort: { key: 'day', dir: 'asc' },
  notes: [`${K}.cashCounts.note1`, `${K}.cashCounts.note2`],
  countLabel: `${K}.count.counts`,
}

// ------------------------------------------------------------------ 8 insurer claims

const claims: ReportDef<ClaimRow> = {
  id: 'finance.claims',
  group: 'finance',
  title: `${K}.claims.title`,
  description: `${K}.claims.description`,
  code: 'CLM',
  load: loadClaims,
  allowed: readsAllMoney,
  filters: [
    periodFilter('month'),
    insurerFilter(false),
    {
      key: 'status',
      label: `${K}.filters.claimStatus`,
      kind: 'multi',
      options: keyOptions(`${K}.claimStatus`, CLAIM_STATUSES),
    },
    searchFilter('claims'),
  ],
  columns: [
    {
      key: 'postedAt',
      label: `${K}.cols.day`,
      kind: 'date',
      default: true,
      value: (r) => r.postedAt,
      nowrap: true,
    },
    { key: 'insurer', label: `${K}.cols.insurer`, default: true, value: (r) => r.insurer },
    { key: 'patient', label: `${K}.cols.patient`, default: true, value: (r) => r.patient },
    { key: 'fileNumber', label: `${K}.cols.fileNumber`, value: (r) => r.fileNumber, nowrap: true },
    {
      key: 'memberNo',
      label: `${K}.cols.memberNo`,
      default: true,
      value: (r) => r.memberNo,
      nowrap: true,
    },
    { key: 'visitNo', label: `${K}.cols.visitNo`, value: (r) => r.visitNo, nowrap: true },
    {
      key: 'billNo',
      label: `${K}.cols.billNo`,
      default: true,
      value: (r) => r.billNo,
      nowrap: true,
    },
    { key: 'total', label: `${K}.cols.total`, kind: 'money', total: 'sum', value: (r) => r.total },
    {
      key: 'coveragePct',
      label: `${K}.cols.coveragePct`,
      kind: 'percent',
      value: (r) => r.coveragePct,
    },
    {
      key: 'insurerShare',
      label: `${K}.cols.insurerShare`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.insurerShare,
    },
    {
      key: 'patientShare',
      label: `${K}.cols.patientShare`,
      kind: 'money',
      total: 'sum',
      value: (r) => r.patientShare,
    },
    {
      key: 'claimed',
      label: `${K}.cols.claimed`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.claimed,
    },
    {
      key: 'status',
      label: `${K}.cols.claimStatus`,
      default: true,
      value: (r) => t(`${K}.claimStatus.${r.status}`, { defaultValue: r.status }),
    },
    { key: 'batchNo', label: `${K}.cols.batchNo`, value: (r) => r.batchNo, nowrap: true },
    { key: 'rejection', label: `${K}.cols.rejection`, value: (r) => r.rejection },
  ],
  figures: (rows) => [
    { label: `${K}.figures.bills`, value: rows.length },
    { label: `${K}.figures.insurers`, value: new Set(rows.map((r) => r.insurerId)).size },
    { label: `${K}.figures.insurerShare`, value: sum(rows, (r) => r.insurerShare), unit: 'RWF' },
    {
      label: `${K}.figures.notClaimed`,
      value: sum(
        rows.filter((r) => r.status === 'open'),
        (r) => r.claimed,
      ),
      unit: 'RWF',
    },
  ],
  groups: [
    { key: 'insurer', label: `${K}.groups.insurer`, value: (r) => r.insurer },
    {
      key: 'status',
      label: `${K}.groups.status`,
      value: (r) => t(`${K}.claimStatus.${r.status}`, { defaultValue: r.status }),
      order: (r) => (CLAIM_STATUSES as readonly string[]).indexOf(r.status),
    },
    byDay<ClaimRow>((r) => r.postedAt),
  ],
  defaultGroup: { key: 'insurer', mode: 'details' },
  defaultSort: { key: 'postedAt', dir: 'asc' },
  notes: [`${K}.claims.note1`, `${K}.claims.note2`],
  wide: true,
  countLabel: `${K}.count.bills`,
}

// ------------------------------------------------------------------ 9 the accounts (0181)

/** The accountant (the cashier role) and the manager: the Finance page's reports. */
const keepsAccounts = (ctx: ReportContext) => ctx.isManager || ctx.user.role === 'cashier'
/** mm/yyyy of a yyyy-mm month. */
const monthLabel = (m: string) => (m ? `${m.slice(5, 7)}/${m.slice(0, 4)}` : '')
const byMonth = <R>(day: (r: R) => string): ReportGroupDef<R> => ({
  key: 'month',
  label: `${K}.groups.month`,
  value: (r) => monthLabel(day(r).slice(0, 7)),
  order: (r) => day(r).slice(0, 7),
})
const money = (
  key: string,
  value: (r: MoneyRow) => number,
  dflt = true,
): ReportColumnDef<MoneyRow> => ({
  key,
  label: `${K}.cols.${key}`,
  kind: 'money',
  default: dflt,
  total: 'sum',
  value,
})

const payroll: ReportDef<PayrollRow> = {
  id: 'finance.payroll',
  group: 'finance',
  title: `${K}.payroll.title`,
  description: `${K}.payroll.description`,
  code: 'PAY',
  load: loadPayroll,
  allowed: keepsAccounts,
  filters: [
    periodFilter('month'),
    {
      key: 'employee',
      label: `${K}.filters.employee`,
      kind: 'select',
      loadOptions: payrollEmployees,
    },
    {
      key: 'status',
      label: `${K}.filters.salaryStatus`,
      kind: 'multi',
      options: keyOptions('accounts.status', SALARY_STATUSES),
    },
    searchFilter('payroll'),
  ],
  columns: [
    { key: 'employee', label: `${K}.cols.employee`, default: true, value: (r) => r.employee },
    {
      key: 'role',
      label: `${K}.cols.role`,
      default: true,
      value: (r) => t(`staff.roles.${r.role}`, { defaultValue: r.role }),
    },
    { key: 'staffId', label: `${K}.cols.staffId`, value: (r) => r.staffId, nowrap: true },
    {
      key: 'period',
      label: `${K}.cols.period`,
      default: true,
      value: (r) => `${dayLabel(r.periodStart)} – ${dayLabel(r.periodEnd)}`,
      nowrap: true,
    },
    {
      key: 'dueOn',
      label: `${K}.cols.dueOn`,
      kind: 'date',
      default: true,
      value: (r) => r.dueOn,
      nowrap: true,
    },
    {
      key: 'interval',
      label: `${K}.cols.interval`,
      value: (r) => intervalWords(t, r.intervalKind, r.customEvery, r.customUnit),
    },
    {
      key: 'amount',
      label: `${K}.cols.amount`,
      kind: 'money',
      default: false,
      total: 'sum',
      value: (r) => r.amount,
    },
    {
      key: 'gross',
      label: `${K}.cols.gross`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.gross,
    },
    {
      key: 'deductionsTotal',
      label: `${K}.cols.deductionsTotal`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.deductionsTotal,
    },
    {
      key: 'net',
      label: `${K}.cols.net`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.net,
    },
    {
      key: 'employerTotal',
      label: `${K}.cols.employerTotal`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.employerTotal,
    },
    {
      key: 'payeMode',
      label: `${K}.cols.payeMode`,
      value: (r) => t(`accounts.salaries.payeModes.${r.payeMode}`),
      nowrap: true,
    },
    {
      key: 'status',
      label: `${K}.cols.status`,
      default: true,
      value: (r) => t(`accounts.status.${r.status}`),
      nowrap: true,
    },
    {
      key: 'paidOn',
      label: `${K}.cols.paidOn`,
      kind: 'date',
      default: true,
      value: (r) => r.paidOn,
      nowrap: true,
    },
    {
      key: 'paidAmount',
      label: `${K}.cols.paidAmount`,
      kind: 'money',
      default: false,
      total: 'sum',
      value: (r) => r.paidAmount,
    },
    {
      key: 'method',
      label: `${K}.cols.method`,
      default: true,
      value: (r) => methodLabel(r.method),
      nowrap: true,
    },
    { key: 'reference', label: `${K}.cols.reference`, value: (r) => r.reference, nowrap: true },
    { key: 'paidBy', label: `${K}.cols.paidBy`, value: (r) => r.paidBy },
    { key: 'note', label: `${K}.cols.note`, value: (r) => r.note },
  ],
  figures: (rows) => [
    { label: `${K}.figures.payPeriods`, value: rows.length },
    {
      label: `${K}.figures.salariesPaid`,
      value: sum(rows, (r) => (r.status === 'paid' ? (r.paidAmount ?? r.net) : 0)),
      unit: 'RWF',
    },
    {
      label: `${K}.figures.salariesDue`,
      value: sum(rows, (r) => (r.status === 'due' || r.status === 'overdue' ? r.net : 0)),
      unit: 'RWF',
    },
    {
      label: `${K}.figures.withheld`,
      value: sum(rows, (r) => (r.status === 'paid' ? r.deductionsTotal : 0)),
      unit: 'RWF',
    },
    {
      label: `${K}.figures.employerShare`,
      value: sum(rows, (r) => (r.status === 'paid' ? r.employerTotal : 0)),
      unit: 'RWF',
    },
    {
      label: `${K}.figures.overduePeriods`,
      value: rows.filter((r) => r.status === 'overdue').length,
    },
  ],
  groups: [
    { key: 'employee', label: `${K}.groups.employee`, value: (r) => r.employee },
    {
      key: 'status',
      label: `${K}.groups.status`,
      value: (r) => t(`accounts.status.${r.status}`),
      order: (r) => SALARY_STATUSES.indexOf(r.status),
    },
    byMonth<PayrollRow>((r) => r.dueOn),
  ],
  defaultSort: { key: 'dueOn', dir: 'asc' },
  notes: [`${K}.payroll.note1`, `${K}.payroll.note2`],
  wide: true,
  countLabel: `${K}.count.periods`,
}

/** 0186: the payroll remittances, per month and agency. */
const remittances: ReportDef<RemittanceRow> = {
  id: 'finance.remittances',
  group: 'finance',
  title: `${K}.remittances.title`,
  description: `${K}.remittances.description`,
  code: 'RMT',
  load: loadRemittanceRows,
  allowed: keepsAccounts,
  filters: [
    periodFilter('month'),
    {
      key: 'agency',
      label: `${K}.filters.agency`,
      kind: 'multi',
      options: keyOptions('accounts.deductions.agencies', AGENCIES),
    },
    {
      key: 'status',
      label: `${K}.filters.salaryStatus`,
      kind: 'multi',
      options: keyOptions('accounts.status', SALARY_STATUSES),
    },
  ],
  columns: [
    {
      key: 'month',
      label: `${K}.cols.month`,
      default: true,
      value: (r) => monthLabel(r.month),
      nowrap: true,
    },
    {
      key: 'agency',
      label: `${K}.cols.agency`,
      default: true,
      value: (r) => t(`accounts.deductions.agencies.${r.agency}`),
      nowrap: true,
    },
    {
      key: 'lines',
      label: `${K}.cols.deductions`,
      default: true,
      value: (r) => r.lines.map((l) => l.name).join(', '),
    },
    {
      key: 'people',
      label: `${K}.cols.people`,
      kind: 'number',
      default: true,
      value: (r) => r.people,
    },
    {
      key: 'withheld',
      label: `${K}.cols.withheld`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.employeeTotal,
    },
    {
      key: 'employerShare',
      label: `${K}.cols.employerShare`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.employerTotal,
    },
    {
      key: 'total',
      label: `${K}.cols.total`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.total,
    },
    {
      key: 'dueOn',
      label: `${K}.cols.dueOn`,
      kind: 'date',
      default: true,
      value: (r) => r.dueOn,
      nowrap: true,
    },
    {
      key: 'status',
      label: `${K}.cols.status`,
      default: true,
      value: (r) => t(`accounts.status.${r.status}`),
      nowrap: true,
    },
    {
      key: 'paidOn',
      label: `${K}.cols.paidOn`,
      kind: 'date',
      default: true,
      value: (r) => r.paidOn,
      nowrap: true,
    },
    {
      key: 'paidAmount',
      label: `${K}.cols.paidAmount`,
      kind: 'money',
      total: 'sum',
      value: (r) => r.paidAmount,
    },
    { key: 'method', label: `${K}.cols.method`, value: (r) => methodLabel(r.method), nowrap: true },
    { key: 'reference', label: `${K}.cols.reference`, value: (r) => r.reference, nowrap: true },
    { key: 'paidBy', label: `${K}.cols.paidBy`, value: (r) => r.paidBy },
  ],
  figures: (rows) => [
    { label: `${K}.figures.withheld`, value: sum(rows, (r) => r.employeeTotal), unit: 'RWF' },
    { label: `${K}.figures.employerShare`, value: sum(rows, (r) => r.employerTotal), unit: 'RWF' },
    {
      label: `${K}.figures.remitDue`,
      value: sum(rows, (r) => (r.status === 'due' || r.status === 'overdue' ? r.total : 0)),
      unit: 'RWF',
    },
  ],
  groups: [
    {
      key: 'agency',
      label: `${K}.groups.agency`,
      value: (r) => t(`accounts.deductions.agencies.${r.agency}`),
    },
    byMonth<RemittanceRow>((r) => r.dueOn),
  ],
  defaultSort: { key: 'dueOn', dir: 'asc' },
  notes: [`${K}.remittances.note1`, `${K}.remittances.note2`],
  wide: true,
  countLabel: `${K}.count.remittances`,
}

/** 0184: the taxes' periods, like the payroll. */
const taxes: ReportDef<TaxRow> = {
  id: 'finance.taxes',
  group: 'finance',
  title: `${K}.taxes.title`,
  description: `${K}.taxes.description`,
  code: 'TAX',
  load: loadTaxRows,
  allowed: keepsAccounts,
  filters: [
    periodFilter('month'),
    { key: 'tax', label: `${K}.filters.tax`, kind: 'select', loadOptions: taxOptions },
    {
      key: 'kind',
      label: `${K}.filters.taxKind`,
      kind: 'multi',
      options: keyOptions('accounts.taxes.kinds', TAX_KINDS),
    },
    {
      key: 'status',
      label: `${K}.filters.salaryStatus`,
      kind: 'multi',
      options: keyOptions('accounts.status', SALARY_STATUSES),
    },
    searchFilter('taxes'),
  ],
  columns: [
    { key: 'tax', label: `${K}.cols.tax`, default: true, value: (r) => r.tax },
    {
      key: 'kind',
      label: `${K}.cols.taxKind`,
      default: true,
      value: (r) => t(`accounts.taxes.kinds.${r.kind}`),
      nowrap: true,
    },
    {
      key: 'period',
      label: `${K}.cols.period`,
      default: true,
      value: (r) => `${dayLabel(r.periodStart)} – ${dayLabel(r.periodEnd)}`,
      nowrap: true,
    },
    {
      key: 'dueOn',
      label: `${K}.cols.dueOn`,
      kind: 'date',
      default: true,
      value: (r) => r.dueOn,
      nowrap: true,
    },
    {
      key: 'interval',
      label: `${K}.cols.interval`,
      value: (r) => intervalWords(t, r.intervalKind, r.customEvery, r.customUnit),
    },
    {
      key: 'amount',
      label: `${K}.cols.amount`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.amount,
    },
    // 0194: how a percentage period is worked out ("28% of RWF 800,000")
    {
      key: 'work',
      label: `${K}.cols.taxWork`,
      value: (r) =>
        r.rate == null
          ? null
          : r.baseAmount != null && r.baseAmount < 0
            ? lossWords(t, r)
            : r.baseAmount != null
              ? rateWorkWords(t, r.rate, r.baseAmount)
              : taxHowWords(t, { amount: null, rate: r.rate, rateBase: r.rateBase }),
    },
    {
      key: 'status',
      label: `${K}.cols.status`,
      default: true,
      value: (r) => t(`accounts.status.${r.status}`),
      nowrap: true,
    },
    {
      key: 'paidOn',
      label: `${K}.cols.paidOn`,
      kind: 'date',
      default: true,
      value: (r) => r.paidOn,
      nowrap: true,
    },
    {
      key: 'paidAmount',
      label: `${K}.cols.paidAmount`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.paidAmount,
    },
    {
      key: 'method',
      label: `${K}.cols.method`,
      default: true,
      value: (r) => methodLabel(r.method),
      nowrap: true,
    },
    { key: 'reference', label: `${K}.cols.reference`, value: (r) => r.reference, nowrap: true },
    { key: 'paidBy', label: `${K}.cols.paidBy`, value: (r) => r.paidBy },
    { key: 'note', label: `${K}.cols.note`, value: (r) => r.note },
  ],
  figures: (rows) => [
    { label: `${K}.figures.taxPeriods`, value: rows.length },
    {
      label: `${K}.figures.taxesPaid`,
      value: sum(rows, (r) => (r.status === 'paid' ? (r.paidAmount ?? r.amount ?? 0) : 0)),
      unit: 'RWF',
    },
    {
      label: `${K}.figures.taxesDue`,
      value: sum(rows, (r) => (r.status === 'due' || r.status === 'overdue' ? (r.amount ?? 0) : 0)),
      unit: 'RWF',
    },
    {
      label: `${K}.figures.overduePeriods`,
      value: rows.filter((r) => r.status === 'overdue').length,
    },
  ],
  groups: [
    { key: 'tax', label: `${K}.groups.tax`, value: (r) => r.tax },
    {
      key: 'kind',
      label: `${K}.groups.taxKind`,
      value: (r) => t(`accounts.taxes.kinds.${r.kind}`),
      order: (r) => TAX_KINDS.indexOf(r.kind as (typeof TAX_KINDS)[number]),
    },
    {
      key: 'status',
      label: `${K}.groups.status`,
      value: (r) => t(`accounts.status.${r.status}`),
      order: (r) => SALARY_STATUSES.indexOf(r.status),
    },
    byMonth<TaxRow>((r) => r.dueOn),
  ],
  defaultSort: { key: 'dueOn', dir: 'asc' },
  notes: [`${K}.taxes.note1`, `${K}.taxes.note2`],
  wide: true,
  countLabel: `${K}.count.taxPeriods`,
}

const expenses: ReportDef<ExpenseRow> = {
  id: 'finance.expenses',
  group: 'finance',
  title: `${K}.expenses.title`,
  description: `${K}.expenses.description`,
  code: 'EXP',
  load: loadExpenseRows,
  allowed: keepsAccounts,
  filters: [
    periodFilter('month'),
    {
      key: 'kind',
      label: `${K}.filters.expenseKind`,
      kind: 'multi',
      options: keyOptions('accounts.expenses.kinds', EXPENSE_KINDS),
    },
    { key: 'kindId', label: `${K}.filters.kindName`, kind: 'select', loadOptions: outKindOptions },
    methodFilter,
    {
      key: 'includeVoided',
      label: `${K}.filters.includeVoided`,
      kind: 'toggle',
      default: false,
      hint: `${K}.filters.includeVoidedHint`,
    },
    searchFilter('expenses'),
  ],
  columns: [
    {
      key: 'paidOn',
      label: `${K}.cols.paidOn`,
      kind: 'date',
      default: true,
      value: (r) => r.paidOn,
      nowrap: true,
    },
    { key: 'kindName', label: `${K}.cols.kind`, default: true, value: (r) => r.kindName },
    {
      key: 'label',
      label: `${K}.cols.whatFor`,
      default: true,
      value: (r) => r.label,
      width: '30%',
    },
    {
      key: 'kind',
      label: `${K}.cols.kind`,
      default: true,
      value: (r) => t(`accounts.expenses.kinds.${r.kind}`),
      nowrap: true,
    },
    {
      key: 'amount',
      label: `${K}.cols.amount`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.amount,
    },
    {
      key: 'method',
      label: `${K}.cols.method`,
      default: true,
      value: (r) => methodLabel(r.method),
      nowrap: true,
    },
    { key: 'reference', label: `${K}.cols.reference`, value: (r) => r.reference, nowrap: true },
    { key: 'paidBy', label: `${K}.cols.paidBy`, default: true, value: (r) => r.paidBy },
    { key: 'note', label: `${K}.cols.note`, value: (r) => r.note },
    { key: 'voided', label: `${K}.cols.voided`, kind: 'yesno', value: (r) => r.voided },
    { key: 'voidReason', label: `${K}.cols.voidReason`, value: (r) => r.voidReason },
  ],
  figures: (rows) => {
    const live = rows.filter((r) => !r.voided)
    return [
      { label: `${K}.figures.expensesCount`, value: live.length },
      { label: `${K}.figures.expensesTotal`, value: sum(live, (r) => r.amount), unit: 'RWF' },
      {
        label: `${K}.figures.salariesTotal`,
        value: sum(live, (r) => (r.kind === 'salary' ? r.amount : 0)),
        unit: 'RWF',
      },
      {
        label: `${K}.figures.otherTotal`,
        value: sum(live, (r) => (r.kind === 'other' ? r.amount : 0)),
        unit: 'RWF',
      },
    ]
  },
  groups: [
    {
      key: 'kind',
      label: `${K}.groups.expenseKind`,
      value: (r) => t(`accounts.expenses.kinds.${r.kind}`),
      order: (r) => EXPENSE_KINDS.indexOf(r.kind),
    },
    byMethod<ExpenseRow>(),
    byDay<ExpenseRow>((r) => r.paidOn),
    byMonth<ExpenseRow>((r) => r.paidOn),
  ],
  defaultSort: { key: 'paidOn', dir: 'asc' },
  notes: [`${K}.expenses.note1`, `${K}.expenses.note2`],
  countLabel: `${K}.count.expenses`,
}

/** 0185: the other money in — rent received, training fees, donations… */
const otherIncome: ReportDef<IncomeRow> = {
  id: 'finance.income',
  group: 'finance',
  title: `${K}.income.title`,
  description: `${K}.income.description`,
  code: 'INC',
  load: loadIncomeRows,
  allowed: keepsAccounts,
  filters: [
    periodFilter('month'),
    { key: 'kindId', label: `${K}.filters.kindName`, kind: 'select', loadOptions: inKindOptions },
    methodFilter,
    {
      key: 'includeVoided',
      label: `${K}.filters.includeVoided`,
      kind: 'toggle',
      hint: `${K}.filters.includeVoidedHint`,
    },
    searchFilter('income'),
  ],
  columns: [
    {
      key: 'receivedOn',
      label: `${K}.cols.receivedOn`,
      kind: 'date',
      default: true,
      value: (r) => r.receivedOn,
      nowrap: true,
    },
    { key: 'kind', label: `${K}.cols.kind`, default: true, value: (r) => r.kind },
    { key: 'from', label: `${K}.cols.from`, default: true, value: (r) => r.from },
    {
      key: 'amount',
      label: `${K}.cols.amount`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.amount,
    },
    {
      key: 'method',
      label: `${K}.cols.method`,
      default: true,
      value: (r) => methodLabel(r.method),
      nowrap: true,
    },
    { key: 'reference', label: `${K}.cols.reference`, value: (r) => r.reference, nowrap: true },
    { key: 'recordedBy', label: `${K}.cols.paidBy`, default: true, value: (r) => r.recordedBy },
    { key: 'note', label: `${K}.cols.note`, value: (r) => r.note },
    { key: 'voided', label: `${K}.cols.voided`, kind: 'yesno', value: (r) => r.voided },
    { key: 'voidReason', label: `${K}.cols.voidReason`, value: (r) => r.voidReason },
  ],
  figures: (rows) => [
    { label: `${K}.figures.incomeCount`, value: rows.filter((r) => !r.voided).length },
    {
      label: `${K}.figures.incomeTotal`,
      value: sum(rows, (r) => (r.voided ? 0 : r.amount)),
      unit: 'RWF',
    },
  ],
  groups: [
    { key: 'kind', label: `${K}.groups.kindName`, value: (r) => r.kind },
    byMethod<IncomeRow>(),
    byDay<IncomeRow>((r) => r.receivedOn),
    byMonth<IncomeRow>((r) => r.receivedOn),
  ],
  defaultSort: { key: 'receivedOn', dir: 'asc' },
  notes: [`${K}.income.note1`, `${K}.income.note2`],
  countLabel: `${K}.count.incomes`,
}

const moneyInOut: ReportDef<MoneyRow> = {
  id: 'finance.money',
  group: 'finance',
  title: `${K}.money.title`,
  description: `${K}.money.description`,
  code: 'MNY',
  load: loadMoney,
  allowed: keepsAccounts,
  filters: [periodFilter('month')],
  columns: [
    {
      key: 'month',
      label: `${K}.cols.month`,
      default: true,
      value: (r) => monthLabel(r.month),
      nowrap: true,
    },
    money('revenue', (r) => r.revenue, false),
    money('refunds', (r) => r.refunds, false),
    money('netRevenue', (r) => r.netRevenue),
    money('otherIncome', (r) => r.otherIncome),
    money('moneyIn', (r) => r.moneyIn, false),
    money('salaries', (r) => r.salaries),
    money('otherExpenses', (r) => r.other),
    money('stockBought', (r) => r.stock),
    money('moneyOut', (r) => r.moneyOut, false),
    money('netResult', (r) => r.net),
    // the taxes paid, apart: off by default and never inside the result (0185)
    money('taxes', (r) => r.taxes, false),
  ],
  figures: (rows) => [
    { label: `${K}.figures.moneyIn`, value: sum(rows, (r) => r.moneyIn), unit: 'RWF' },
    { label: `${K}.figures.moneyOut`, value: sum(rows, (r) => r.moneyOut), unit: 'RWF' },
    { label: `${K}.figures.netResult`, value: sum(rows, (r) => r.net), unit: 'RWF' },
    { label: `${K}.figures.taxesApart`, value: sum(rows, (r) => r.taxes), unit: 'RWF' },
  ],
  defaultSort: { key: 'month', dir: 'asc' },
  notes: [`${K}.money.note1`, `${K}.money.note2`],
  countLabel: `${K}.count.months`,
}

/** The finance reports, in the order the report centre lists them. */
export const FINANCE_REPORTS: AnyReportDef[] = [
  revenue,
  services,
  bills,
  debts,
  refunds,
  cashCounts,
  claims,
  walkIn,
  moneyInOut,
  otherIncome,
  payroll,
  remittances,
  taxes,
  expenses,
]

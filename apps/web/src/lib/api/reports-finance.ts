import type { ReportContext, ReportFilterValues } from '@/lib/reports/defs/types'
import {
  chosen,
  inChosen,
  matches,
  readsAllMoney,
  reportRpc,
  sampleScopeDepartments,
  searchText,
  selected,
  switchedOn,
} from './reports-options'
import {
  sampleBills,
  sampleCashCounts,
  sampleCharges,
  sampleClaims,
  sampleCounterSales,
  sampleDebts,
  samplePayments,
  sampleRefunds,
} from './reports-finance-sample'

/**
 * The finance reports' rows (migration 0111): report_payments, report_charges, report_bills,
 * report_debts, report_refunds, report_counter_sales, report_cash_counts, report_claims. The
 * database gives the period's rows within the person's rights (all, or their own payments, or
 * their department's charges); the loaders here apply the other filters (method, kind, cashier,
 * insurer, status, search…). Sample mode: ./reports-finance-sample.
 */

// ------------------------------------------------------------------ rows

export type PaymentKind = 'visit' | 'debt' | 'pharmacy' | 'walkin'
export const PAYMENT_KINDS: readonly PaymentKind[] = ['visit', 'debt', 'pharmacy', 'walkin']
/** The methods a payment is taken with (insurer, credit: never at the desk). */
export const PAYMENT_METHODS = ['cash', 'momo', 'airtel', 'card', 'bank', 'deposit'] as const

export interface PaymentRow {
  id: string
  at: string
  receiptNo: string | null
  billNo: string | null
  visitNo: string | null
  encounterId: string | null
  counterSaleId: string | null
  /** The patient, or the walk-in buyer. */
  patient: string | null
  fileNumber: string | null
  kind: PaymentKind
  method: string
  reference: string | null
  amount: number
  /** Given back from this payment (the bill's refunds, latest payments first). */
  refunded: number
  net: number
  cashierId: string | null
  cashier: string | null
  insurerId: string | null
  insurer: string | null
  store: string | null
  /** Counted in a day close. */
  counted: boolean
}

export interface ChargeRow {
  id: string
  /** A bill's line, or a walk-in sale's. */
  source: 'bill' | 'sale'
  at: string
  chargedAt: string
  billNo: string | null
  /** draft, posted, credited (bills); open, paid, handed_over (sales). */
  billStatus: string | null
  visitNo: string | null
  encounterId: string | null
  patient: string | null
  fileNumber: string | null
  description: string
  serviceId: string | null
  itemId: string | null
  code: string | null
  categoryId: string | null
  /** The service category's group, or 'medicine' / 'supply'. */
  categoryKey: string
  categoryEn: string | null
  categoryKin: string | null
  categoryFr: string | null
  departmentId: string | null
  department: string | null
  desk: string | null
  store: string | null
  /** As charged: a bill line by the pack counts packs; a walk-in sale line pieces. */
  quantity: number
  /** Pieces in one pack (a line charged by the pack). */
  packSize: number | null
  /** The pieces (or the times a service was given). */
  units: number
  unitPrice: number
  listPrice: number
  discount: number
  discountPct: number | null
  discountReason: string | null
  total: number
  insurerShare: number
  patientShare: number
  insurerId: string | null
  insurer: string | null
  enteredById: string | null
  enteredBy: string | null
}

export type BillStatus = 'open' | 'paid' | 'part' | 'unpaid' | 'credited'
export const BILL_STATUSES: readonly BillStatus[] = ['open', 'paid', 'part', 'unpaid', 'credited']

export interface BillRow {
  id: string
  billNo: string | null
  at: string
  visitAt: string | null
  postedAt: string | null
  visitNo: string | null
  encounterId: string | null
  visitOpen: boolean
  patient: string
  fileNumber: string | null
  insurerId: string | null
  insurer: string | null
  memberNo: string | null
  total: number
  insurerShare: number
  patientShare: number
  paid: number
  refunded: number
  credited: number
  balance: number
  lines: number
  status: BillStatus
}

export type DebtStatus = 'closed' | 'left' | 'open'
export const DEBT_STATUSES: readonly DebtStatus[] = ['closed', 'left', 'open']

export interface DebtRow {
  id: string
  encounterId: string
  patientId: string | null
  patient: string
  fileNumber: string | null
  phone: string | null
  visitNo: string | null
  visitAt: string
  closedAt: string | null
  billNo: string | null
  insurerId: string | null
  insurer: string | null
  /** The patient's share of the bill. */
  total: number
  paid: number
  due: number
  /** Days since the visit ended. */
  days: number
  status: DebtStatus
  reason: string | null
  closedBy: string | null
}

export interface RefundRow {
  id: string
  at: string
  amount: number
  method: string
  reference: string | null
  reason: string | null
  patient: string
  fileNumber: string | null
  visitNo: string | null
  encounterId: string | null
  billNo: string | null
  cashierId: string | null
  cashier: string | null
}

export type CounterSaleStatus = 'open' | 'paid' | 'handed_over' | 'cancelled'
export const COUNTER_SALE_STATUSES: readonly CounterSaleStatus[] = [
  'open',
  'paid',
  'handed_over',
  'cancelled',
]

export interface CounterSaleRow {
  id: string
  number: string
  at: string
  status: CounterSaleStatus
  buyer: string | null
  phone: string | null
  storeId: string
  store: string
  roomStore: boolean
  total: number
  note: string | null
  lines: number
  units: number
  /** "Amoxicillin 500 mg capsule × 15; ORS × 2" */
  items: string | null
  paidAt: string | null
  method: string | null
  receiptNo: string | null
  reference: string | null
  cashierId: string | null
  cashier: string | null
  sellerId: string | null
  seller: string | null
  handedOverAt: string | null
  handedOverBy: string | null
  cancelledAt: string | null
  cancelReason: string | null
}

export interface CashCountRow {
  /** close id and method */
  id: string
  closeId: string
  day: string
  at: string | null
  cashierId: string | null
  cashier: string | null
  method: string
  /** Payments less refunds. */
  expected: number
  counted: number
  /** counted − expected */
  difference: number
  /** The whole close's difference. */
  variance: number
  note: string | null
}

export const CLAIM_STATUSES = [
  'open',
  'batched',
  'submitted',
  'paid',
  'rejected',
  'resubmitted',
  'written_off',
] as const

export interface ClaimRow {
  id: string
  insurerId: string
  insurer: string
  patient: string
  fileNumber: string | null
  memberNo: string | null
  visitNo: string | null
  encounterId: string | null
  visitAt: string | null
  billNo: string | null
  postedAt: string | null
  billStatus: string | null
  total: number
  insurerShare: number
  patientShare: number
  coveragePct: number | null
  claimed: number
  status: string
  batchNo: string | null
  rejection: string | null
}

// ------------------------------------------------------------------ reading the answers

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const numOrNull = (v: unknown) => (v == null || v === '' ? null : num(v))
/** Money and counts from jsonb (numeric may come as a string). */
function numbers<T>(row: T, keys: (keyof T)[]): T {
  const r = row as Record<keyof T, unknown>
  for (const k of keys) r[k] = num(r[k])
  return row
}

const periodArgs = (f: ReportFilterValues) => ({ p_from: f.period.from, p_to: f.period.to })

/** Sample mode: who "I" am among the sample cashiers (a pharmacist is the sample pharmacy's). */
const sampleMe = (ctx: ReportContext) =>
  ctx.user.role === 'pharmacist' || ctx.user.dbRole === 'pharmacist' ? 'p-pha' : ctx.user.id

// ------------------------------------------------------------------ 1 revenue: the payments

export async function loadPayments(
  f: ReportFilterValues,
  ctx: ReportContext,
): Promise<PaymentRow[]> {
  const rows = ctx.sample
    ? samplePayments(f.period.from, f.period.to).filter(
        (p) => readsAllMoney(ctx) || p.cashierId === sampleMe(ctx),
      )
    : (await reportRpc<PaymentRow>('report_payments', periodArgs(f))).rows.map((p) => {
        numbers(p, ['amount', 'refunded'])
        p.net = p.amount - p.refunded
        p.counted = !!p.counted
        return p
      })
  const methods = chosen(f, 'method')
  const kinds = chosen(f, 'kind')
  const cashier = selected(f, 'cashier')
  const insurer = selected(f, 'insurer')
  const q = searchText(f)
  return rows.filter(
    (p) =>
      inChosen(methods, p.method) &&
      inChosen(kinds, p.kind) &&
      (!cashier || p.cashierId === cashier) &&
      (!insurer || (insurer === 'none' ? !p.insurerId : p.insurerId === insurer)) &&
      matches(q, p.patient, p.fileNumber, p.receiptNo, p.billNo, p.visitNo, p.reference),
  )
}

// ------------------------------------------------------------------ 2 revenue by service

export async function loadCharges(f: ReportFilterValues, ctx: ReportContext): Promise<ChargeRow[]> {
  const department = selected(f, 'department')
  const open = switchedOn(f, 'includeOpen')
  let rows: ChargeRow[]
  if (ctx.sample) {
    const scope = sampleScopeDepartments(ctx)
    rows = sampleCharges(f.period.from, f.period.to, open).filter(
      (c) =>
        (!department || c.departmentId === department) &&
        (!scope || (c.departmentId != null && scope.includes(c.departmentId))),
    )
  } else {
    rows = (
      await reportRpc<ChargeRow>('report_charges', {
        ...periodArgs(f),
        p_department: department,
        p_open: open,
      })
    ).rows.map((c) => {
      numbers(c, [
        'quantity',
        'units',
        'unitPrice',
        'listPrice',
        'discount',
        'total',
        'insurerShare',
        'patientShare',
      ])
      c.discountPct = numOrNull(c.discountPct)
      c.packSize = numOrNull(c.packSize)
      return c
    })
  }
  const category = selected(f, 'category')
  const insurer = selected(f, 'insurer')
  const q = searchText(f)
  return rows.filter(
    (c) =>
      (!category ||
        (category === 'medicine' || category === 'supply'
          ? c.categoryKey === category
          : c.categoryId === category)) &&
      (!insurer || (insurer === 'none' ? !c.insurerId : c.insurerId === insurer)) &&
      matches(q, c.description, c.code, c.patient, c.fileNumber, c.billNo, c.visitNo),
  )
}

// ------------------------------------------------------------------ 3 bills

export async function loadBills(f: ReportFilterValues, ctx: ReportContext): Promise<BillRow[]> {
  const rows = ctx.sample
    ? sampleBills(f.period.from, f.period.to)
    : (await reportRpc<BillRow>('report_bills', periodArgs(f))).rows.map((b) =>
        numbers(b, [
          'total',
          'insurerShare',
          'patientShare',
          'paid',
          'refunded',
          'credited',
          'balance',
          'lines',
        ]),
      )
  const statuses = chosen(f, 'status')
  const insurer = selected(f, 'insurer')
  const q = searchText(f)
  return rows.filter(
    (b) =>
      inChosen(statuses, b.status) &&
      (!insurer || (insurer === 'none' ? !b.insurerId : b.insurerId === insurer)) &&
      matches(q, b.patient, b.fileNumber, b.billNo, b.visitNo, b.memberNo),
  )
}

// ------------------------------------------------------------------ 4 unpaid bills

export async function loadDebts(f: ReportFilterValues, ctx: ReportContext): Promise<DebtRow[]> {
  const rows = ctx.sample
    ? sampleDebts(f.period.from, f.period.to)
    : (await reportRpc<DebtRow>('report_debts', periodArgs(f))).rows.map((d) =>
        numbers(d, ['total', 'paid', 'due', 'days']),
      )
  const statuses = chosen(f, 'status')
  const insurer = selected(f, 'insurer')
  const q = searchText(f)
  return rows.filter(
    (d) =>
      inChosen(statuses, d.status) &&
      (!insurer || (insurer === 'none' ? !d.insurerId : d.insurerId === insurer)) &&
      matches(q, d.patient, d.fileNumber, d.phone, d.billNo, d.visitNo),
  )
}

/** How long a bill has been unpaid: the age bands of the unpaid bills report. */
export const DEBT_AGES = ['d7', 'd30', 'd90', 'older'] as const
export const debtAge = (days: number): (typeof DEBT_AGES)[number] =>
  days <= 7 ? 'd7' : days <= 30 ? 'd30' : days <= 90 ? 'd90' : 'older'

// ------------------------------------------------------------------ 5 refunds

export async function loadRefunds(f: ReportFilterValues, ctx: ReportContext): Promise<RefundRow[]> {
  const rows = ctx.sample
    ? sampleRefunds(f.period.from, f.period.to).filter(
        (r) => readsAllMoney(ctx) || r.cashierId === sampleMe(ctx),
      )
    : (await reportRpc<RefundRow>('report_refunds', periodArgs(f))).rows.map((r) =>
        numbers(r, ['amount']),
      )
  const methods = chosen(f, 'method')
  const cashier = selected(f, 'cashier')
  const q = searchText(f)
  return rows.filter(
    (r) =>
      inChosen(methods, r.method) &&
      (!cashier || r.cashierId === cashier) &&
      matches(q, r.patient, r.fileNumber, r.billNo, r.visitNo, r.reason, r.reference),
  )
}

// ------------------------------------------------------------------ 6 walk-in sales

export async function loadCounterSales(
  f: ReportFilterValues,
  ctx: ReportContext,
): Promise<CounterSaleRow[]> {
  let rows: CounterSaleRow[]
  if (ctx.sample) {
    const all = readsAllMoney(ctx)
    const pharmacy = all || ctx.canDesk('pharmacy') || ctx.user.role === 'pharmacist'
    const rooms = ctx.can('stock.sell_walkin') && ctx.holdsStore
    rows = sampleCounterSales(f.period.from, f.period.to).filter(
      (s) => all || (pharmacy && !s.roomStore) || (rooms && s.roomStore),
    )
  } else {
    rows = (await reportRpc<CounterSaleRow>('report_counter_sales', periodArgs(f))).rows.map(
      (s) => {
        numbers(s, ['total', 'lines', 'units'])
        s.roomStore = !!s.roomStore
        return s
      },
    )
  }
  const statuses = chosen(f, 'status')
  const store = selected(f, 'store')
  const methods = chosen(f, 'method')
  const q = searchText(f)
  return rows.filter(
    (s) =>
      inChosen(statuses, s.status) &&
      (!store || s.storeId === store) &&
      (!methods.length || (s.method != null && methods.includes(s.method))) &&
      matches(q, s.number, s.buyer, s.phone, s.items, s.receiptNo, s.seller),
  )
}

// ------------------------------------------------------------------ 7 cash counts

export async function loadCashCounts(
  f: ReportFilterValues,
  ctx: ReportContext,
): Promise<CashCountRow[]> {
  const rows = ctx.sample
    ? sampleCashCounts(f.period.from, f.period.to).filter(
        (c) => readsAllMoney(ctx) || c.cashierId === sampleMe(ctx),
      )
    : (await reportRpc<CashCountRow>('report_cash_counts', periodArgs(f))).rows.map((c) =>
        numbers(c, ['expected', 'counted', 'difference', 'variance']),
      )
  const cashier = selected(f, 'cashier')
  const methods = chosen(f, 'method')
  return rows.filter((c) => (!cashier || c.cashierId === cashier) && inChosen(methods, c.method))
}

// ------------------------------------------------------------------ 8 insurer claims

export async function loadClaims(f: ReportFilterValues, ctx: ReportContext): Promise<ClaimRow[]> {
  const rows = ctx.sample
    ? sampleClaims(f.period.from, f.period.to)
    : (await reportRpc<ClaimRow>('report_claims', periodArgs(f))).rows.map((c) => {
        numbers(c, ['total', 'insurerShare', 'patientShare', 'claimed'])
        c.coveragePct = numOrNull(c.coveragePct)
        return c
      })
  const insurer = selected(f, 'insurer')
  const statuses = chosen(f, 'status')
  const q = searchText(f)
  return rows.filter(
    (c) =>
      (!insurer || c.insurerId === insurer) &&
      inChosen(statuses, c.status) &&
      matches(q, c.patient, c.fileNumber, c.memberNo, c.billNo, c.visitNo, c.batchNo),
  )
}

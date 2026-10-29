import { useQuery } from '@tanstack/react-query'
import type { StaffUser } from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { apiError, isMissingFunction } from './errors'
import {
  sampleAccess,
  sampleRevenueAnalysis,
  sampleStaffActivity,
  sampleStaffActivityDetail,
  sampleVisitsAnalysis,
  sampleWaitTimeStats,
} from './analytics-sample'

/**
 * The Analytics page (migration 0086): the detailed views behind the dashboard cards.
 *
 * Live: analytics_access, revenue_analysis, staff_activity, staff_activity_detail,
 * visits_analysis, wait_time_stats. The manager sees the whole clinic (or one department he
 * picks) with money; the head or assistant of a department sees that department only and never
 * money; anyone else is refused (42501). Dates are ISO yyyy-mm-dd, Kigali days, both included.
 *
 * Before 0086 (PGRST202) every view comes back empty with `needsUpdate: true`, so the page shows
 * "needs the latest database update" instead of failing. Sample mode builds a realistic clinic
 * (several staff, months of revenue, waits per desk) in ./analytics-sample.
 *
 * The desk views reuse the hooks that already exist: useLabSummary (lab), usePharmacySummary and
 * useStockSales (pharmacy), useStockAlerts and useReorderSuggestions (stock), useDeskSummary
 * (triage), and the revenue day drawer useCashierSummary(day) from ./finance.
 */

// ------------------------------------------------------------------ vocabulary

/**
 * The views. The first nine are the manager's and the heads' (0086); the others belong to the
 * desk dashboards (0102): the cash desk, the pharmacy, the laboratory, the doctor's and nurse's
 * own work, reception. Each dashboard lists its own in its own order (analytics_access).
 */
export const ANALYTICS_VIEWS = [
  'revenue',
  'staff',
  'visits',
  'treatments',
  'lab',
  'pharmacy',
  'triage',
  'stock',
  'waiting',
  // the manager and the heads (0102)
  'receipts',
  'documents',
  // the cash desk
  'collections',
  'methods',
  'openBills',
  'refunds',
  // the pharmacy
  'handovers',
  'walkIn',
  'expiry',
  'outside',
  // the laboratory
  'tests',
  'turnaround',
  'verification',
  'byTest',
  // the doctor's and nurse's desk, reception
  'myPatients',
  'vitals',
  'waitingNow',
  'diagnoses',
  'prescriptions',
  'orders',
  'tasks',
  'registrations',
  'bookings',
  'arrivals',
] as const
export type AnalyticsView = (typeof ANALYTICS_VIEWS)[number]
export const isAnalyticsView = (v: unknown): v is AnalyticsView =>
  typeof v === 'string' && (ANALYTICS_VIEWS as readonly string[]).includes(v)

/** The dashboards, each with its own Analytics structure. */
export const ANALYTICS_DASHBOARDS = [
  'manager',
  'head',
  'cashier',
  'pharmacy',
  'lab',
  'doctor',
  'nurse',
  'reception',
] as const
export type AnalyticsDashboard = (typeof ANALYTICS_DASHBOARDS)[number]
const isDashboard = (v: unknown): v is AnalyticsDashboard =>
  typeof v === 'string' && (ANALYTICS_DASHBOARDS as readonly string[]).includes(v)

/**
 * The views of each desk dashboard, in the dashboard's order (the same list as analytics_access
 * gives; used before 0102 and in sample mode). The manager's and a head's come from the server
 * (a head's depend on the department's desks).
 */
export const DASHBOARD_VIEWS: Record<Exclude<AnalyticsDashboard, 'head'>, AnalyticsView[]> = {
  manager: [
    'visits',
    'waiting',
    'revenue',
    'receipts',
    'staff',
    'treatments',
    'stock',
    'lab',
    'pharmacy',
    'triage',
    'documents',
  ],
  cashier: ['collections', 'receipts', 'methods', 'openBills', 'refunds'],
  pharmacy: ['handovers', 'walkIn', 'stock', 'expiry', 'outside'],
  lab: ['tests', 'turnaround', 'verification', 'byTest'],
  doctor: ['myPatients', 'waitingNow', 'diagnoses', 'prescriptions', 'orders', 'tasks'],
  nurse: ['myPatients', 'vitals', 'waitingNow', 'tasks'],
  reception: ['registrations', 'bookings', 'waitingNow', 'arrivals'],
}

/** The dashboard of a signed-in person, from their role (the server says the same). */
export function dashboardOf(user: StaffUser | null): AnalyticsDashboard | null {
  if (!user) return null
  if (user.role === 'manager' || user.dashboard === 'manager') return 'manager'
  if (user.dashboard === 'head') return 'head'
  switch (user.role) {
    case 'cashier':
      return 'cashier'
    case 'pharmacist':
      return 'pharmacy'
    case 'lab_tech':
      return 'lab'
    case 'doctor':
      return 'doctor'
    case 'nurse':
      return 'nurse'
    case 'receptionist':
      return 'reception'
    default:
      return null
  }
}

/** A head's views in the department section's order (patients, waiting, the lab, people, services…). */
export const headDashboardViews = (desks: string[]): AnalyticsView[] => [
  'visits',
  'waiting',
  ...(desks.some((x) => x === 'laboratory' || x === 'ultrasound') ? (['lab'] as const) : []),
  'staff',
  'treatments',
  ...(desks.includes('pharmacy') ? (['pharmacy', 'stock'] as const) : []),
  ...(desks.includes('triage') ? (['triage'] as const) : []),
  'documents',
]

/** May this person open the view: listed by the server, or a view of their own dashboard. */
export const canOpenView = (access: AnalyticsAccess | undefined, view: AnalyticsView): boolean =>
  !!access && (access.views.includes(view) || access.dashboardViews.includes(view))

/** The kinds of work, in display order (staff_activity.kinds). */
export const WORK_KINDS = [
  'registered',
  'vitals',
  'patientsSeen',
  'diagnoses',
  'prescriptions',
  'orders',
  'results',
  'procedures',
  'medicinesGiven',
  'charges',
  'admissions',
  'tasksDone',
  'vaccinations',
  'hivTests',
  'familyPlanning',
] as const
/** Money kinds: the manager only, always after the others. */
export const MONEY_KINDS = ['payments', 'refunds', 'voided', 'handovers'] as const
export type WorkKind = (typeof WORK_KINDS)[number]
export type MoneyKind = (typeof MONEY_KINDS)[number]
export type ActivityKind = WorkKind | MoneyKind
export const ACTIVITY_KINDS: readonly ActivityKind[] = [...WORK_KINDS, ...MONEY_KINDS]
export const isActivityKind = (v: unknown): v is ActivityKind =>
  typeof v === 'string' && (ACTIVITY_KINDS as readonly string[]).includes(v)
export const isMoneyKind = (k: string): k is MoneyKind =>
  (MONEY_KINDS as readonly string[]).includes(k)
/** The kinds left out of "records written": patients seen (a visit, not a record) and money. */
export const countsAsRecord = (k: string) => k !== 'patientsSeen' && !isMoneyKind(k)

/** The desks where a wait is measured, in display order (wait_time_stats.desks). */
export const WAIT_STATIONS = [
  'triage',
  'consultation',
  'dental',
  'theatre',
  'nursing',
  'laboratory',
  'ultrasound',
  'pharmacy',
  'cashier',
] as const
export type WaitStation = (typeof WAIT_STATIONS)[number]

/** Below minN waits a figure shows "Not enough data", never 0. */
export const WAIT_RULES = { minN: 5, maxHours: 12 } as const
export interface WaitRules {
  minN: number
  maxHours: number
}
/** The figure to show, or null for "Not enough data". */
export const waitFigure = (
  stat: { n: number; median?: number | null; p90?: number | null },
  which: 'median' | 'p90' = 'median',
  rules: WaitRules = WAIT_RULES,
): number | null => (stat.n >= rules.minN ? (stat[which] ?? null) : null)

/** A period: ISO dates, both included. */
export interface AnalyticsPeriod {
  from: string
  to: string
}

/** Every view carries this: true when the database is older than migration 0086. */
interface Versioned {
  needsUpdate: boolean
}

// ------------------------------------------------------------------ access

export interface AnalyticsDepartment {
  id: string
  name: string
  /** The desks the department offers (department.services). */
  desks: string[]
}
export interface AnalyticsAccess {
  manager: boolean
  /** The manager: every active department (to pick one). A head: the ones they lead. */
  departments: AnalyticsDepartment[]
  /** The views the server grants the manager and the heads (0086); [] for everyone else. */
  views: AnalyticsView[]
  /** The dashboard this person has (0102; null = none). */
  dashboard: AnalyticsDashboard | null
  /** That dashboard's views, in the dashboard's order (0102): the page's structure. */
  dashboardViews: AnalyticsView[]
  /** Before 0086: computed from the role, not by the server. */
  fallback: boolean
}

// ------------------------------------------------------------------ revenue

export interface RevenueTotals {
  collected: number
  refunded: number
  /** collected − refunded */
  net: number
  /** Number of refunds. */
  refunds: number
  /** Cancelled payments: amount and count. */
  voided: number
  voidedCount: number
  payments: number
  paidVisits: number
  /** Bills collected per paid visit; null without paid visits. */
  avgPerVisit: number | null
  /** Collected on visit bills / on counter sales. */
  bills: number
  counterSales: number
  /** Bill lines entered in the period. */
  charged: number
  discounts: number
  creditNotes: number
}
export interface RevenueDay {
  day: string
  cash: number
  momo: number
  airtel: number
  other: number
  payments: number
  refunds: number
  voided: number
  /** cash + momo + airtel + other − refunds */
  net: number
  visits: number
  counterSales: number
}
export interface RevenueMethod {
  method: string
  amount: number
  count: number
  /** Percent of the period's collections (1 decimal). */
  share: number
}
export interface RevenueCategory {
  id: string | null
  group: string
  name: string | null
  nameKin: string | null
  nameFr: string | null
  charged: number
  /** Each bill's payments spread over its lines (an estimate). */
  collectedEst: number
  lines: number
}
export interface RevenueDepartment {
  id: string | null
  key: 'department' | 'pharmacy' | 'none'
  name: string | null
  charged: number
  collectedEst: number
  lines: number
}
export interface RevenuePayer {
  payerId: string | null
  name: string | null
  /** 'cash' when the bill has no payer. */
  type: string
  bills: number
  patientShare: number
  insurerShare: number
  paid: number
  owed: number
}
export interface RevenueCashier {
  id: string
  name: string
  payments: number
  amount: number
  refunds: number
  /** Number of payments cancelled. */
  voided: number
  /** Cash-count difference (day_close) over the period; null without a count. */
  variance: number | null
}
export interface RevenueRefund {
  id: string
  at: string
  amount: number
  method: string
  reason: string | null
  by: string | null
  invoiceId: string | null
  encounterId: string | null
  patient: string | null
  fileNumber: string | null
}
export interface RevenueCreditNote {
  id: string
  at: string
  number: string | null
  amount: number
  patientAmount: number
  insurerAmount: number
  reason: string | null
  by: string | null
  invoiceId: string | null
  encounterId: string | null
  patient: string | null
  fileNumber: string | null
}
export interface RevenueVoided {
  id: string
  at: string
  paidAt: string
  amount: number
  method: string
  reason: string | null
  /** Who cancelled it / who had taken it. */
  by: string | null
  cashier: string | null
  receiptNo: string | null
  encounterId: string | null
  patient: string | null
  fileNumber: string | null
}
export interface RevenueDebt {
  invoiceId: string
  number: string | null
  encounterId: string | null
  patient: string | null
  fileNumber: string | null
  due: number
  /** The visit is still open. */
  open: boolean
  arrivedAt: string | null
}
export interface RevenueAnalysis extends Versioned {
  from: string
  to: string
  /** The period before, of the same length. */
  prevFrom: string
  prevTo: string
  totals: RevenueTotals
  prev: RevenueTotals
  /** Every day of the period (up to 400 days; longer: the days with activity). */
  days: RevenueDay[]
  byMethod: RevenueMethod[]
  bySource: {
    bills: { amount: number; count: number }
    counterSales: { amount: number; count: number }
  }
  byCategory: RevenueCategory[]
  byDepartment: RevenueDepartment[]
  byPayer: RevenuePayer[]
  byCashier: RevenueCashier[]
  discounts: {
    lines: number
    amount: number
    byReason: { reason: string | null; lines: number; amount: number }[]
  }
  /** At most 200 each, newest first. */
  refunds: RevenueRefund[]
  creditNotes: RevenueCreditNote[]
  voided: RevenueVoided[]
  /** Owed now (not a period figure); top = the 20 largest. */
  debts: {
    openCount: number
    openDue: number
    closedCount: number
    closedDue: number
    top: RevenueDebt[]
  }
}

// ------------------------------------------------------------------ who did what

export interface ActivityPerson {
  id: string
  name: string
  role: string
  staffId: string | null
  departments: { id: string; name: string }[]
  /** False: the person has left (shown because they worked in the period). */
  active: boolean
  lastSignIn: string | null
  /** One entry for every kind of `kinds`. */
  counts: Record<string, number>
  /** All records written (every kind but patients seen and money). */
  records: number
  /** Money collected (the manager); null for heads. */
  amount: number | null
}
export interface ActivityDay {
  day: string
  userId: string
  kind: ActivityKind
  n: number
  amount: number | null
}
export interface StaffActivity extends Versioned {
  from: string
  to: string
  manager: boolean
  department: string | null
  /** The kinds in display order (money kinds only for the manager). */
  kinds: ActivityKind[]
  /** Sorted by records, most first. */
  people: ActivityPerson[]
  days: ActivityDay[]
  totals: Record<string, number>
  summary: {
    peopleActive: number
    /** Distinct visits. */
    patientsSeen: number
    records: number
    /** null for heads. */
    collected: number | null
  }
}

export interface ActivityRecord {
  at: string
  kind: ActivityKind
  encounterId: string | null
  /** null for an HIV test seen by a head. */
  patientId: string | null
  patientName: string | null
  fileNumber: string | null
  /** The visit reference, the item and dose, the test, the method… */
  what: string | null
  /** The manager only. */
  amount: number | null
}
export interface ActivityMoney {
  byMethod: { method: string; count: number; amount: number }[]
  refunds: {
    at: string
    amount: number
    method: string
    reason: string | null
    patient: string | null
    fileNumber: string | null
    encounterId: string | null
  }[]
  voided: {
    at: string
    paidAt: string
    amount: number
    method: string
    reason: string | null
    by: string | null
    patient: string | null
  }[]
  /** Cash counts: expected, counted and the difference. */
  closes: { day: string; expected: number; counted: number; variance: number }[]
}
export interface StaffActivityDetail extends Versioned {
  from: string
  to: string
  person: {
    id: string
    name: string
    role: string
    staffId: string | null
    active: boolean
    lastSignIn: string | null
    departments: { id: string; name: string }[]
  }
  counts: Record<string, number>
  days: { day: string; kind: ActivityKind; n: number }[]
  /** The records matching the kind asked, before the limit. */
  total: number
  /** Newest first, at most the limit (500). */
  records: ActivityRecord[]
  /** Sign-ins in the period, failed ones with their reason (at most 200). */
  signIns: { at: string; ok: boolean; reason: string | null }[]
  /** null for heads. */
  money: ActivityMoney | null
}

// ------------------------------------------------------------------ visits and treatments

export interface VisitsTotals {
  registered: number
  visits: number
  newPatients: number
  returning: number
  booked: number
  kept: number
  missed: number
  pending: number
}
export interface VisitsDay {
  day: string
  visits: number
  newPatients: number
  returning: number
  registered: number
  /** Visits by encounter type: opd, dental, procedure, direct_service… */
  byType: Record<string, number>
}
export interface VisitsGroup {
  group: string
  categoryId: string | null
  name: string | null
  nameKin: string | null
  nameFr: string | null
  /** Distinct visits. */
  count: number
}
export interface Treatment {
  description: string
  categoryId: string | null
  category: string | null
  categoryKin: string | null
  categoryFr: string | null
  count: number
  /** null for heads. */
  amount: number | null
}
export interface VisitsAnalysis extends Versioned {
  from: string
  to: string
  manager: boolean
  department: string | null
  totals: VisitsTotals
  prev: VisitsTotals
  prevFrom: string
  prevTo: string
  days: VisitsDay[]
  byGroup: VisitsGroup[]
  byType: { type: string; count: number }[]
  /** Arrivals per hour of the day, 24 entries (Kigali). */
  byHour: number[]
  treatmentTotals: { lines: number; distinct: number; charged: number | null }
  /** At most 300, most given first. */
  treatments: Treatment[]
}

// ------------------------------------------------------------------ waiting times

export interface WaitStat {
  /** Waits counted. */
  n: number
  /** Minutes (1 decimal); null without data. Show only when n >= rules.minN. */
  median: number | null
  p90: number | null
}
export interface WaitDesk extends WaitStat {
  station: WaitStation | string
  /** For Excel only, never on a card. */
  mean: number | null
  /** Left out as data errors (over 12 hours, across midnight). */
  excluded: number
  /** Live: joined today and not taken yet; the longest of those in minutes. */
  waitingNow: number
  longestNow: number | null
  /** Live: still open from an earlier day (please close). */
  forgotten: number
}
export interface WaitTimeStats extends Versioned {
  from: string
  to: string
  department: string | null
  rules: WaitRules
  /** Every measured desk in scope, even with n = 0. */
  desks: WaitDesk[]
  /** All waits pooled. */
  overall: WaitStat & { excluded: number }
  /** Arrival to the first desk where the patient is seen (triage, consultation, dental). */
  arrival: WaitStat & { excluded: number }
  days: { day: string; n: number; median: number | null }[]
  /** Order to verified result (not waiting). */
  turnaround: {
    station: 'laboratory' | 'ultrasound' | string
    n: number
    median: number | null
    p90: number | null
  }[]
}

// ------------------------------------------------------------------ mapping

type Raw = Record<string, unknown>
const n0 = (v: unknown): number => {
  const x = Number(v ?? 0)
  return Number.isFinite(x) ? x : 0
}
const nn = (v: unknown): number | null => (v == null ? null : n0(v))
const s0 = (v: unknown): string => (v == null ? '' : String(v))
const sn = (v: unknown): string | null => (v == null ? null : String(v))
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : [])
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {})
const counts = (v: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries(obj(v)).map(([k, x]) => [k, n0(x)]))
const deps = (v: unknown) => arr(v).map((d) => ({ id: s0(d.id), name: s0(d.name) }))

function toTotals(v: unknown): RevenueTotals {
  const t = obj(v)
  return {
    collected: n0(t.collected),
    refunded: n0(t.refunded),
    net: n0(t.net),
    refunds: n0(t.refunds),
    voided: n0(t.voided),
    voidedCount: n0(t.voidedCount),
    payments: n0(t.payments),
    paidVisits: n0(t.paidVisits),
    avgPerVisit: nn(t.avgPerVisit),
    bills: n0(t.bills),
    counterSales: n0(t.counterSales),
    charged: n0(t.charged),
    discounts: n0(t.discounts),
    creditNotes: n0(t.creditNotes),
  }
}

export function toRevenueAnalysis(data: unknown): RevenueAnalysis {
  const d = obj(data)
  const src = obj(d.bySource)
  const disc = obj(d.discounts)
  const debts = obj(d.debts)
  return {
    needsUpdate: false,
    from: s0(d.from),
    to: s0(d.to),
    prevFrom: s0(d.prevFrom),
    prevTo: s0(d.prevTo),
    totals: toTotals(d.totals),
    prev: toTotals(d.prev),
    days: arr(d.days).map((x) => ({
      day: s0(x.day),
      cash: n0(x.cash),
      momo: n0(x.momo),
      airtel: n0(x.airtel),
      other: n0(x.other),
      payments: n0(x.payments),
      refunds: n0(x.refunds),
      voided: n0(x.voided),
      net: n0(x.net),
      visits: n0(x.visits),
      counterSales: n0(x.counterSales),
    })),
    byMethod: arr(d.byMethod).map((x) => ({
      method: s0(x.method),
      amount: n0(x.amount),
      count: n0(x.count),
      share: n0(x.share),
    })),
    bySource: {
      bills: { amount: n0(obj(src.bills).amount), count: n0(obj(src.bills).count) },
      counterSales: {
        amount: n0(obj(src.counterSales).amount),
        count: n0(obj(src.counterSales).count),
      },
    },
    byCategory: arr(d.byCategory).map((x) => ({
      id: sn(x.id),
      group: s0(x.group),
      name: sn(x.name),
      nameKin: sn(x.nameKin),
      nameFr: sn(x.nameFr),
      charged: n0(x.charged),
      collectedEst: n0(x.collectedEst),
      lines: n0(x.lines),
    })),
    byDepartment: arr(d.byDepartment).map((x) => ({
      id: sn(x.id),
      key: (x.key === 'pharmacy' || x.key === 'none'
        ? x.key
        : 'department') as RevenueDepartment['key'],
      name: sn(x.name),
      charged: n0(x.charged),
      collectedEst: n0(x.collectedEst),
      lines: n0(x.lines),
    })),
    byPayer: arr(d.byPayer).map((x) => ({
      payerId: sn(x.payerId),
      name: sn(x.name),
      type: s0(x.type ?? 'cash') || 'cash',
      bills: n0(x.bills),
      patientShare: n0(x.patientShare),
      insurerShare: n0(x.insurerShare),
      paid: n0(x.paid),
      owed: n0(x.owed),
    })),
    byCashier: arr(d.byCashier).map((x) => ({
      id: s0(x.id),
      name: s0(x.name),
      payments: n0(x.payments),
      amount: n0(x.amount),
      refunds: n0(x.refunds),
      voided: n0(x.voided),
      variance: nn(x.variance),
    })),
    discounts: {
      lines: n0(disc.lines),
      amount: n0(disc.amount),
      byReason: arr(disc.byReason).map((x) => ({
        reason: sn(x.reason),
        lines: n0(x.lines),
        amount: n0(x.amount),
      })),
    },
    refunds: arr(d.refunds).map((x) => ({
      id: s0(x.id),
      at: s0(x.at),
      amount: n0(x.amount),
      method: s0(x.method),
      reason: sn(x.reason),
      by: sn(x.by),
      invoiceId: sn(x.invoiceId),
      encounterId: sn(x.encounterId),
      patient: sn(x.patient),
      fileNumber: sn(x.fileNumber),
    })),
    creditNotes: arr(d.creditNotes).map((x) => ({
      id: s0(x.id),
      at: s0(x.at),
      number: sn(x.number),
      amount: n0(x.amount),
      patientAmount: n0(x.patientAmount),
      insurerAmount: n0(x.insurerAmount),
      reason: sn(x.reason),
      by: sn(x.by),
      invoiceId: sn(x.invoiceId),
      encounterId: sn(x.encounterId),
      patient: sn(x.patient),
      fileNumber: sn(x.fileNumber),
    })),
    voided: arr(d.voided).map((x) => ({
      id: s0(x.id),
      at: s0(x.at),
      paidAt: s0(x.paidAt),
      amount: n0(x.amount),
      method: s0(x.method),
      reason: sn(x.reason),
      by: sn(x.by),
      cashier: sn(x.cashier),
      receiptNo: sn(x.receiptNo),
      encounterId: sn(x.encounterId),
      patient: sn(x.patient),
      fileNumber: sn(x.fileNumber),
    })),
    debts: {
      openCount: n0(debts.openCount),
      openDue: n0(debts.openDue),
      closedCount: n0(debts.closedCount),
      closedDue: n0(debts.closedDue),
      top: arr(debts.top).map((x) => ({
        invoiceId: s0(x.invoiceId),
        number: sn(x.number),
        encounterId: sn(x.encounterId),
        patient: sn(x.patient),
        fileNumber: sn(x.fileNumber),
        due: n0(x.due),
        open: !!x.open,
        arrivedAt: sn(x.arrivedAt),
      })),
    },
  }
}

const kindsOf = (v: unknown): ActivityKind[] =>
  Array.isArray(v) ? (v as unknown[]).filter(isActivityKind) : []

export function toStaffActivity(data: unknown): StaffActivity {
  const d = obj(data)
  const sum = obj(d.summary)
  return {
    needsUpdate: false,
    from: s0(d.from),
    to: s0(d.to),
    manager: !!d.manager,
    department: sn(d.department),
    kinds: kindsOf(d.kinds),
    people: arr(d.people).map((p) => ({
      id: s0(p.id),
      name: s0(p.name),
      role: s0(p.role),
      staffId: sn(p.staffId),
      departments: deps(p.departments),
      active: p.active !== false,
      lastSignIn: sn(p.lastSignIn),
      counts: counts(p.counts),
      records: n0(p.records),
      amount: nn(p.amount),
    })),
    days: arr(d.days)
      .filter((x) => isActivityKind(x.kind))
      .map((x) => ({
        day: s0(x.day),
        userId: s0(x.userId),
        kind: x.kind as ActivityKind,
        n: n0(x.n),
        amount: nn(x.amount),
      })),
    totals: counts(d.totals),
    summary: {
      peopleActive: n0(sum.peopleActive),
      patientsSeen: n0(sum.patientsSeen),
      records: n0(sum.records),
      collected: nn(sum.collected),
    },
  }
}

export function toStaffActivityDetail(data: unknown): StaffActivityDetail {
  const d = obj(data)
  const p = obj(d.person)
  const m = d.money == null ? null : obj(d.money)
  return {
    needsUpdate: false,
    from: s0(d.from),
    to: s0(d.to),
    person: {
      id: s0(p.id),
      name: s0(p.name),
      role: s0(p.role),
      staffId: sn(p.staffId),
      active: p.active !== false,
      lastSignIn: sn(p.lastSignIn),
      departments: deps(p.departments),
    },
    counts: counts(d.counts),
    days: arr(d.days)
      .filter((x) => isActivityKind(x.kind))
      .map((x) => ({ day: s0(x.day), kind: x.kind as ActivityKind, n: n0(x.n) })),
    total: n0(d.total),
    records: arr(d.records)
      .filter((x) => isActivityKind(x.kind))
      .map((x) => ({
        at: s0(x.at),
        kind: x.kind as ActivityKind,
        encounterId: sn(x.encounterId),
        patientId: sn(x.patientId),
        patientName: sn(x.patientName),
        fileNumber: sn(x.fileNumber),
        what: sn(x.what),
        amount: nn(x.amount),
      })),
    signIns: arr(d.signIns).map((x) => ({
      at: s0(x.at),
      ok: x.ok !== false,
      reason: sn(x.reason),
    })),
    money: m && {
      byMethod: arr(m.byMethod).map((x) => ({
        method: s0(x.method),
        count: n0(x.count),
        amount: n0(x.amount),
      })),
      refunds: arr(m.refunds).map((x) => ({
        at: s0(x.at),
        amount: n0(x.amount),
        method: s0(x.method),
        reason: sn(x.reason),
        patient: sn(x.patient),
        fileNumber: sn(x.fileNumber),
        encounterId: sn(x.encounterId),
      })),
      voided: arr(m.voided).map((x) => ({
        at: s0(x.at),
        paidAt: s0(x.paidAt),
        amount: n0(x.amount),
        method: s0(x.method),
        reason: sn(x.reason),
        by: sn(x.by),
        patient: sn(x.patient),
      })),
      closes: arr(m.closes).map((x) => ({
        day: s0(x.day),
        expected: n0(x.expected),
        counted: n0(x.counted),
        variance: n0(x.variance),
      })),
    },
  }
}

function toVisitsTotals(v: unknown): VisitsTotals {
  const t = obj(v)
  return {
    registered: n0(t.registered),
    visits: n0(t.visits),
    newPatients: n0(t.newPatients),
    returning: n0(t.returning),
    booked: n0(t.booked),
    kept: n0(t.kept),
    missed: n0(t.missed),
    pending: n0(t.pending),
  }
}

export function toVisitsAnalysis(data: unknown): VisitsAnalysis {
  const d = obj(data)
  const tt = obj(d.treatmentTotals)
  const hours = Array.isArray(d.byHour) ? (d.byHour as unknown[]).map(n0) : []
  return {
    needsUpdate: false,
    from: s0(d.from),
    to: s0(d.to),
    manager: !!d.manager,
    department: sn(d.department),
    totals: toVisitsTotals(d.totals),
    prev: toVisitsTotals(d.prev),
    prevFrom: s0(d.prevFrom),
    prevTo: s0(d.prevTo),
    days: arr(d.days).map((x) => ({
      day: s0(x.day),
      visits: n0(x.visits),
      newPatients: n0(x.newPatients),
      returning: n0(x.returning),
      registered: n0(x.registered),
      byType: counts(x.byType),
    })),
    byGroup: arr(d.byGroup).map((x) => ({
      group: s0(x.group),
      categoryId: sn(x.categoryId),
      name: sn(x.name),
      nameKin: sn(x.nameKin),
      nameFr: sn(x.nameFr),
      count: n0(x.count),
    })),
    byType: arr(d.byType).map((x) => ({ type: s0(x.type), count: n0(x.count) })),
    byHour: Array.from({ length: 24 }, (_, i) => hours[i] ?? 0),
    treatmentTotals: { lines: n0(tt.lines), distinct: n0(tt.distinct), charged: nn(tt.charged) },
    treatments: arr(d.treatments).map((x) => ({
      description: s0(x.description),
      categoryId: sn(x.categoryId),
      category: sn(x.category),
      categoryKin: sn(x.categoryKin),
      categoryFr: sn(x.categoryFr),
      count: n0(x.count),
      amount: nn(x.amount),
    })),
  }
}

const toWaitStat = (v: unknown) => {
  const x = obj(v)
  return { n: n0(x.n), median: nn(x.median), p90: nn(x.p90), excluded: n0(x.excluded) }
}

export function toWaitTimeStats(data: unknown): WaitTimeStats {
  const d = obj(data)
  const rules = obj(d.rules)
  return {
    needsUpdate: false,
    from: s0(d.from),
    to: s0(d.to),
    department: sn(d.department),
    rules: {
      minN: rules.minN == null ? WAIT_RULES.minN : n0(rules.minN),
      maxHours: rules.maxHours == null ? WAIT_RULES.maxHours : n0(rules.maxHours),
    },
    desks: arr(d.desks).map((x) => ({
      station: s0(x.station),
      n: n0(x.n),
      median: nn(x.median),
      p90: nn(x.p90),
      mean: nn(x.mean),
      excluded: n0(x.excluded),
      waitingNow: n0(x.waitingNow),
      longestNow: nn(x.longestNow),
      forgotten: n0(x.forgotten),
    })),
    overall: toWaitStat(d.overall),
    arrival: toWaitStat(d.arrival),
    days: arr(d.days).map((x) => ({ day: s0(x.day), n: n0(x.n), median: nn(x.median) })),
    turnaround: arr(d.turnaround).map((x) => ({
      station: s0(x.station),
      n: n0(x.n),
      median: nn(x.median),
      p90: nn(x.p90),
    })),
  }
}

// ------------------------------------------------------------------ empty views (before 0086)

/** The period before, of the same length (as the server computes it). */
export function previousPeriod(p: AnalyticsPeriod): AnalyticsPeriod {
  const day = 86_400_000
  const a = Date.parse(`${p.from}T00:00:00Z`)
  const b = Date.parse(`${p.to}T00:00:00Z`)
  const len = Math.round((b - a) / day) + 1
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
  return { from: iso(a - len * day), to: iso(a - day) }
}

const zeroTotals = (): RevenueTotals => toTotals({})
const zeroVisits = (): VisitsTotals => toVisitsTotals({})

export function emptyRevenue(p: AnalyticsPeriod, needsUpdate = true): RevenueAnalysis {
  const prev = previousPeriod(p)
  return {
    ...toRevenueAnalysis({}),
    needsUpdate,
    from: p.from,
    to: p.to,
    prevFrom: prev.from,
    prevTo: prev.to,
    totals: zeroTotals(),
    prev: zeroTotals(),
  }
}
export function emptyStaffActivity(
  p: AnalyticsPeriod,
  manager: boolean,
  needsUpdate = true,
): StaffActivity {
  const kinds: ActivityKind[] = manager ? [...ACTIVITY_KINDS] : [...WORK_KINDS]
  return {
    ...toStaffActivity({}),
    needsUpdate,
    from: p.from,
    to: p.to,
    manager,
    kinds,
    totals: Object.fromEntries(kinds.map((k) => [k, 0])),
    summary: { peopleActive: 0, patientsSeen: 0, records: 0, collected: manager ? 0 : null },
  }
}
export function emptyStaffActivityDetail(
  userId: string,
  p: AnalyticsPeriod,
  needsUpdate = true,
): StaffActivityDetail {
  return {
    ...toStaffActivityDetail({ person: { id: userId } }),
    needsUpdate,
    from: p.from,
    to: p.to,
  }
}
export function emptyVisits(
  p: AnalyticsPeriod,
  manager: boolean,
  needsUpdate = true,
): VisitsAnalysis {
  const prev = previousPeriod(p)
  return {
    ...toVisitsAnalysis({}),
    needsUpdate,
    from: p.from,
    to: p.to,
    manager,
    totals: zeroVisits(),
    prev: zeroVisits(),
    prevFrom: prev.from,
    prevTo: prev.to,
    treatmentTotals: { lines: 0, distinct: 0, charged: manager ? 0 : null },
  }
}
export function emptyWaitTimes(p: AnalyticsPeriod, needsUpdate = true): WaitTimeStats {
  return { ...toWaitTimeStats({}), needsUpdate, from: p.from, to: p.to }
}

// ------------------------------------------------------------------ hooks

const STALE = 60_000
/** The query keys, for invalidation (everything under ['analytics']). */
export const analyticsKeys = {
  all: ['analytics'] as const,
  access: (userId: string | null) => ['analytics', 'access', userId] as const,
  revenue: (p: AnalyticsPeriod) => ['analytics', 'revenue', p.from, p.to] as const,
  staff: (p: AnalyticsPeriod, dept: string | null) =>
    ['analytics', 'staff', p.from, p.to, dept] as const,
  person: (userId: string | null, p: AnalyticsPeriod, kind: string | null, limit: number) =>
    ['analytics', 'person', userId, p.from, p.to, kind, limit] as const,
  visits: (p: AnalyticsPeriod, dept: string | null) =>
    ['analytics', 'visits', p.from, p.to, dept] as const,
  waiting: (p: AnalyticsPeriod, dept: string | null) =>
    ['analytics', 'waiting', p.from, p.to, dept] as const,
}

/** Is the signed-in person the manager (sample mode and the fallback before 0086)? */
const userIsManager = () => {
  const u = useSession.getState().user
  return !!u && (u.role === 'manager' || u.dashboard === 'manager')
}

/** A dashboard's views when the server does not list them (before 0102): the fixed lists, a
 *  head's from the desks of their departments. */
function fallbackDashboardViews(
  dashboard: AnalyticsDashboard | null,
  desks: string[],
): AnalyticsView[] {
  if (!dashboard) return []
  if (dashboard === 'head') return headDashboardViews(desks)
  return [...DASHBOARD_VIEWS[dashboard]]
}

/** Calls a 0086 function: its data, or null when the database is older (PGRST202). */
async function call(fn: string, args: Record<string, unknown>): Promise<unknown | null> {
  const { data, error } = await supabase!.rpc(fn, args)
  if (error) {
    if (isMissingFunction(error)) return null
    throw apiError(error)
  }
  return data
}

/**
 * What the signed-in person may open on the Analytics page. The page and the dashboard links use
 * `views` (a card links to a view only when it is listed). Before 0086: the manager gets every
 * view, a head the people/visits/treatments/waiting ones (their data then says needsUpdate).
 */
export function useAnalyticsAccess(enabled = true) {
  const userId = useSession((s) => s.user?.id ?? null)
  return useQuery({
    queryKey: analyticsKeys.access(userId),
    enabled: enabled && !!userId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<AnalyticsAccess> => {
      const user = useSession.getState().user
      if (!supabase) return sampleAccess(user)
      const data = await call('analytics_access', {})
      const dashboard = dashboardOf(user)
      if (data == null) {
        const manager = userIsManager()
        const head = !manager && user?.dashboard === 'head'
        return {
          manager,
          departments: [],
          views: manager
            ? ANALYTICS_VIEWS.slice(0, 9)
            : head
              ? ['staff', 'visits', 'treatments', 'waiting']
              : [],
          dashboard,
          dashboardViews: fallbackDashboardViews(dashboard, []),
          fallback: true,
        }
      }
      const d = obj(data)
      const departments = arr(d.departments).map((x) => ({
        id: s0(x.id),
        name: s0(x.name),
        desks: Array.isArray(x.desks) ? (x.desks as unknown[]).map(String) : [],
      }))
      // a database between 0086 and 0102 names no dashboard: the role says which
      const served = isDashboard(d.dashboard) ? d.dashboard : dashboard
      const servedViews = Array.isArray(d.dashboardViews)
        ? (d.dashboardViews as unknown[]).filter(isAnalyticsView)
        : null
      return {
        manager: !!d.manager,
        departments,
        views: Array.isArray(d.views) ? (d.views as unknown[]).filter(isAnalyticsView) : [],
        dashboard: served,
        dashboardViews:
          servedViews ??
          fallbackDashboardViews(
            served,
            departments.flatMap((x) => x.desks),
          ),
        fallback: false,
      }
    },
  })
}

/** Revenue for the period (the manager only): totals against the period before, per day and
 *  method, and every breakdown. The day drawer uses useCashierSummary(day) from ./finance. */
export function useRevenueAnalysis(period: AnalyticsPeriod, enabled = true) {
  return useQuery({
    queryKey: analyticsKeys.revenue(period),
    enabled,
    staleTime: STALE,
    queryFn: async (): Promise<RevenueAnalysis> => {
      if (!supabase) return sampleRevenueAnalysis(period)
      const data = await call('revenue_analysis', { p_from: period.from, p_to: period.to })
      return data == null ? emptyRevenue(period) : toRevenueAnalysis(data)
    },
  })
}

/** Who did what in the period: per person, per day and kind. A head always gets their own
 *  department; the manager the whole clinic, or `departmentId`. */
export function useStaffActivity(
  period: AnalyticsPeriod,
  departmentId: string | null = null,
  enabled = true,
) {
  return useQuery({
    queryKey: analyticsKeys.staff(period, departmentId),
    enabled,
    staleTime: STALE,
    queryFn: async (): Promise<StaffActivity> => {
      if (!supabase) return sampleStaffActivity(period, departmentId)
      const data = await call('staff_activity', {
        p_from: period.from,
        p_to: period.to,
        p_department: departmentId,
      })
      return data == null ? emptyStaffActivity(period, userIsManager()) : toStaffActivity(data)
    },
  })
}

/** One person's work (the drawer): records newest first (at most `limit`, 500), sign-ins and,
 *  for the manager, money. `kind` limits the records (and `total`) to one kind of work. */
export function useStaffActivityDetail(
  userId: string | null,
  period: AnalyticsPeriod,
  kind: ActivityKind | null = null,
  limit = 500,
) {
  const lim = Math.min(Math.max(Math.round(limit), 1), 500)
  return useQuery({
    queryKey: analyticsKeys.person(userId, period, kind, lim),
    enabled: !!userId,
    staleTime: STALE,
    queryFn: async (): Promise<StaffActivityDetail> => {
      if (!supabase) return sampleStaffActivityDetail(userId!, period, kind, lim)
      const data = await call('staff_activity_detail', {
        p_user: userId,
        p_from: period.from,
        p_to: period.to,
        p_kind: kind,
        p_limit: lim,
      })
      return data == null ? emptyStaffActivityDetail(userId!, period) : toStaffActivityDetail(data)
    },
  })
}

/** Patients and visits in the period, and the treatments given (Visits and Treatments views). */
export function useVisitsAnalysis(
  period: AnalyticsPeriod,
  departmentId: string | null = null,
  enabled = true,
) {
  return useQuery({
    queryKey: analyticsKeys.visits(period, departmentId),
    enabled,
    staleTime: STALE,
    queryFn: async (): Promise<VisitsAnalysis> => {
      if (!supabase) return sampleVisitsAnalysis(period, departmentId)
      const data = await call('visits_analysis', {
        p_from: period.from,
        p_to: period.to,
        p_department: departmentId,
      })
      return data == null ? emptyVisits(period, userIsManager()) : toVisitsAnalysis(data)
    },
  })
}

/** Waiting times (the only place they are shown): per desk median and 90th percentile, arrival to
 *  the first desk, the daily median, test turnaround, and the live queue. Refreshes every minute. */
export function useWaitTimeStats(
  period: AnalyticsPeriod,
  departmentId: string | null = null,
  enabled = true,
) {
  return useQuery({
    queryKey: analyticsKeys.waiting(period, departmentId),
    enabled,
    staleTime: STALE,
    refetchInterval: 60_000,
    queryFn: async (): Promise<WaitTimeStats> => {
      if (!supabase) return sampleWaitTimeStats(period, departmentId)
      const data = await call('wait_time_stats', {
        p_from: period.from,
        p_to: period.to,
        p_department: departmentId,
      })
      return data == null ? emptyWaitTimes(period) : toWaitTimeStats(data)
    },
  })
}

// ------------------------------------------------------------------ the desk dashboards (0102)

/** One record of the signed-in person's own work (desk_analytics). */
export interface DeskRecord {
  at: string
  kind: WorkKind
  encounterId: string | null
  patientName: string | null
  fileNumber: string | null
  what: string | null
}
/**
 * The figures of a desk dashboard's analytics: the signed-in person's own work (their records,
 * no money), and the desk's registrations, visits and arrivals by hour, bookings and tasks.
 */
export interface DeskAnalytics extends Versioned {
  from: string
  to: string
  counts: Record<string, number>
  days: { day: string; kind: WorkKind; n: number }[]
  /** Newest first, at most 500. */
  records: DeskRecord[]
  registrations: { day: string; n: number }[]
  visits: { day: string; n: number }[]
  /** Arrivals per hour of the day (Kigali), 24 entries. */
  arrivals: number[]
  bookings: {
    booked: number
    kept: number
    missed: number
    pending: number
    cancelled: number
    byDay: { day: string; booked: number; kept: number; missed: number }[]
  }
  tasks: { open: number; overdue: number; done: number; doneByMe: number }
}

const isWorkKind = (v: unknown): v is WorkKind =>
  typeof v === 'string' && (WORK_KINDS as readonly string[]).includes(v)

export function toDeskAnalytics(data: unknown): DeskAnalytics {
  const d = obj(data)
  const b = obj(d.bookings)
  const k = obj(d.tasks)
  const hours = arr(d.arrivals)
  const byHour = Array.from({ length: 24 }, () => 0)
  for (const h of hours) {
    const i = n0(h.hour)
    if (i >= 0 && i < 24) byHour[i] = n0(h.count)
  }
  const days = (v: unknown) => arr(v).map((x) => ({ day: s0(x.day), n: n0(x.n) }))
  return {
    needsUpdate: false,
    from: s0(d.from),
    to: s0(d.to),
    counts: counts(d.counts),
    days: arr(d.days)
      .filter((x) => isWorkKind(x.kind))
      .map((x) => ({ day: s0(x.day), kind: x.kind as WorkKind, n: n0(x.n) })),
    records: arr(d.records)
      .filter((x) => isWorkKind(x.kind))
      .map((x) => ({
        at: s0(x.at),
        kind: x.kind as WorkKind,
        encounterId: sn(x.encounterId),
        patientName: sn(x.patientName),
        fileNumber: sn(x.fileNumber),
        what: sn(x.what),
      })),
    registrations: days(d.registrations),
    visits: days(d.visits),
    arrivals: byHour,
    bookings: {
      booked: n0(b.booked),
      kept: n0(b.kept),
      missed: n0(b.missed),
      pending: n0(b.pending),
      cancelled: n0(b.cancelled),
      byDay: arr(b.byDay).map((x) => ({
        day: s0(x.day),
        booked: n0(x.booked),
        kept: n0(x.kept),
        missed: n0(x.missed),
      })),
    },
    tasks: { open: n0(k.open), overdue: n0(k.overdue), done: n0(k.done), doneByMe: n0(k.doneByMe) },
  }
}

export const emptyDeskAnalytics = (p: AnalyticsPeriod, needsUpdate = true): DeskAnalytics => ({
  ...toDeskAnalytics({}),
  needsUpdate,
  from: p.from,
  to: p.to,
})

/** Sample mode: a small desk, the same figures from one render to the next. */
function sampleDeskAnalytics(p: AnalyticsPeriod, user: StaffUser | null): DeskAnalytics {
  const day = 86_400_000
  const a = Date.parse(`${p.from}T00:00:00Z`)
  const b = Date.parse(`${p.to}T00:00:00Z`)
  const n = Math.max(1, Math.min(92, Math.round((b - a) / day) + 1))
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
  const dayAt = (i: number) => iso(a + i * day)
  const seed = (i: number, k: number) => ((i * 7 + k * 13 + 5) % 9) + 1
  const role = user?.role ?? 'doctor'
  const kinds: WorkKind[] =
    role === 'nurse'
      ? ['vitals', 'patientsSeen', 'tasksDone']
      : role === 'receptionist'
        ? ['registered']
        : ['patientsSeen', 'diagnoses', 'prescriptions', 'orders', 'tasksDone']
  const days = Array.from({ length: n }, (_, i) =>
    kinds.map((kind, k) => ({ day: dayAt(i), kind, n: seed(i, k) })),
  ).flat()
  const counts: Record<string, number> = {}
  for (const x of days) counts[x.kind] = (counts[x.kind] ?? 0) + x.n
  const names = ['Mukamana Alice', 'Rukundo Kevin', 'Uwase Claudine', 'Hakizimana Emmanuel']
  const what: Record<string, string[]> = {
    diagnoses: ['B54 Malaria', 'J06.9 Upper respiratory infection', 'A09 Gastroenteritis'],
    prescriptions: ['Amoxicillin 500 mg · 1 cap', 'Paracetamol 500 mg · 2 tab'],
    orders: ['Malaria RDT', 'Full blood count'],
    patientsSeen: ['V-2026-000124', 'V-2026-000131'],
    registered: ['MMC-000131', 'MMC-000132'],
    vitals: ['Temp 38.2 °C', 'BP 128/84'],
    tasksDone: ['Injection', 'Dressing'],
  }
  const records: DeskRecord[] = []
  for (let i = n - 1; i >= 0 && records.length < 60; i--)
    kinds.forEach((kind, k) => {
      const at = new Date(a + i * day + (9 + k) * 3_600_000 + seed(i, k) * 60_000)
      if (at.getTime() > Date.now()) return
      records.push({
        at: at.toISOString(),
        kind,
        encounterId: `e-${(i + k) % 4}`,
        patientName: names[(i + k) % names.length]!,
        fileNumber: `MMC-00012${(i + k) % 9}`,
        what: what[kind]?.[(i + k) % (what[kind]?.length ?? 1)] ?? null,
      })
    })
  records.sort((x, y) => y.at.localeCompare(x.at))
  const reg = Array.from({ length: n }, (_, i) => ({ day: dayAt(i), n: seed(i, 3) + 4 }))
  const vis = Array.from({ length: n }, (_, i) => ({ day: dayAt(i), n: seed(i, 4) * 4 + 20 }))
  const curve = [0, 0, 0, 0, 0, 0, 1, 4, 9, 12, 11, 8, 5, 6, 8, 6, 4, 2, 1, 0, 0, 0, 0, 0]
  const byDay = Array.from({ length: n }, (_, i) => {
    const booked = seed(i, 5) + 2
    const missed = i % 3 === 0 ? 1 : 0
    return { day: dayAt(i), booked, kept: booked - missed, missed }
  })
  const sum = (k: 'booked' | 'kept' | 'missed') => byDay.reduce((s, x) => s + x[k], 0)
  return {
    needsUpdate: false,
    from: p.from,
    to: p.to,
    counts,
    days,
    records,
    registrations: reg,
    visits: vis,
    arrivals: curve.map((c) => c * n),
    bookings: {
      booked: sum('booked'),
      kept: sum('kept'),
      missed: sum('missed'),
      pending: 3,
      cancelled: 1,
      byDay,
    },
    tasks: { open: 4, overdue: 1, done: 6 * n, doneByMe: 2 * n },
  }
}

/**
 * The desk dashboards' analytics (0102): the signed-in person's own work in the period, the
 * desk's registrations, visits, arrivals, bookings and tasks. Any employee, for their own
 * dashboard. Before 0102: empty with `needsUpdate`.
 */
export function useDeskAnalytics(period: AnalyticsPeriod, enabled = true) {
  const userId = useSession((s) => s.user?.id ?? null)
  return useQuery({
    queryKey: ['analytics', 'desk', userId, period.from, period.to] as const,
    enabled: enabled && !!userId,
    staleTime: STALE,
    queryFn: async (): Promise<DeskAnalytics> => {
      if (!supabase) return sampleDeskAnalytics(period, useSession.getState().user)
      const data = await call('desk_analytics', { p_from: period.from, p_to: period.to })
      return data == null ? emptyDeskAnalytics(period) : toDeskAnalytics(data)
    },
  })
}

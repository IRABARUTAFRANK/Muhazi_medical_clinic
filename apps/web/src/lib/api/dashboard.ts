import { useQuery } from '@tanstack/react-query'
import { CLAIMS_DUE, EXPIRING_BATCHES, RECEIVABLES, REORDER, CHANNELS, addDays } from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import {
  sampleDashboardStaff,
  sampleLogins,
  sampleQueueNow,
  sampleRevenueAnalysis,
  sampleRevenueDays,
  sampleRevenueTotals,
  sampleTopTreatments,
  sampleVisitTotals,
  sampleVisitsByGroup,
} from './analytics-sample'
import { apiError } from './errors'

/**
 * Manager dashboard numbers, computed by `dashboard_summary(from, to)` in the database.
 * Money fields are null for heads of station. Sample mode uses the same generated clinic as the
 * Analytics page (./analytics-sample), so a card and its detailed view agree.
 *
 * Migration 0086: no average waiting time on any card (tiles.avgWaitMin and waitByStation.minutes
 * are gone; the waiting times live on the Analytics page). waitingNow counts the patients who
 * joined a queue today; older entries still open come apart as forgottenNow / forgotten. Staff
 * rows carry the person's id, reorder rows the item's id and full name, revenue per day refunds
 * and net, and revenuePeriod follows the chosen period. Older databases (before 0086) still answer
 * the old shape: the mapping below fills the new fields so the screens need no second branch.
 */
export type DashboardRange = 'today' | 'week' | 'month' | 'all' | 'custom'
/** A chosen period (custom range): ISO dates, both included. */
export interface CustomRange {
  from: string
  to: string
}
/** "All time" starts here (before the clinic's first record). */
export const ALL_TIME_FROM = '2020-01-01'

export interface DashboardData {
  from: string
  to: string
  manager: boolean
  tiles: {
    registered: number
    registeredPrev: number
    visits: number
    visitsPrev: number
    /** Patients who joined a queue today and are not taken yet. */
    waitingNow: number
    /** Still open in a queue from an earlier day: to close (0086; 0 before). */
    forgottenNow: number
    revenue: number | null
    revenuePrev: number | null
    /** Money given back in the period (the manager, 0086; null before). */
    refunded: number | null
    openBills: number | null
    openBillsDue: number | null
    /** Money still owed on finished visits (the manager, 0065). */
    debts?: number | null
    debtsDue?: number | null
    bedsOccupied: number
    bedsTotal: number
  }
  /** The 30 days ending today: collected, refunded and net (net = amount − refunds). */
  revenue30d: RevenuePoint[]
  /** The chosen period, day by day (the manager; periods up to 92 days; otherwise null). */
  revenuePeriod: RevenuePoint[] | null
  collections: { method: string; amount: number }[]
  receivables: { payer: string; count: number; amount: number }[]
  /** By category: group = its former group (icon), name* = the clinic's category names. */
  visitsByGroup: {
    group: string
    /** The service category (0086), for the link to its treatments; null for medicines. */
    categoryId?: string | null
    name?: string | null
    nameKin?: string | null
    nameFr?: string | null
    count: number
  }[]
  waitByStation: QueueNow[]
  topTreatments: { name: string; count: number; amount: number | null }[]
  staff: {
    /** The person (0086): the link to their detailed view; null on an older database. */
    id: string | null
    name: string
    role: string
    staffId: string | null
    /** False: has left, shown for the work done in the period. */
    active: boolean
    registrations: number
    vitals: number
    charges: number
    /** Patients seen (taken from a queue, or written on the visit), results written, medicines
     *  given (handed over at the pharmacy or from a room store) (0063, rules of 0086). */
    patients?: number
    results?: number
    dispensed?: number
    payments: number | null
    collected: number | null
    lastSignIn: string | null
  }[]
  /** Below the reorder level: id (the name on an older database) and the full item label. */
  reorder: { id: string; name: string; onHand: number; min: number }[]
  /** Medicines (not batches) expiring; `expired` already past their date (0065). */
  expiring: { d30: number; d60: number; d90: number; expired?: number }
  bookings: { booked: number; missed: number; pending: number }
  messages: { channel: string; sent: number; failed: number }[]
  claims: { payer: string; count: number; amount: number | null }[]
  logins: { id: string | null; name: string; role: string; at: string; reason: string | null }[]
  services: { active: number; total: number }
}

/** One day of revenue. */
export interface RevenuePoint {
  day: string
  amount: number
  refunds: number
  net: number
}
/** A desk's queue right now: waiting (joined today), being seen, the first in line (minutes) and
 *  the entries forgotten from earlier days. */
export interface QueueNow {
  station: string
  waiting: number
  busy: number
  longest: number | null
  forgotten: number
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const parseDay = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y!, (m ?? 1) - 1, d ?? 1)
}

export function rangeDates(
  range: DashboardRange,
  now = new Date(),
  custom?: CustomRange | null,
): { from: Date; to: Date } {
  if (range === 'today') return { from: now, to: now }
  if (range === 'all') return { from: parseDay(ALL_TIME_FROM), to: now }
  if (range === 'custom' && custom) return { from: parseDay(custom.from), to: parseDay(custom.to) }
  // this week / this month run up to today, so the previous period compared has as many days
  if (range === 'week') {
    const monday = addDays(now, -((now.getDay() + 6) % 7))
    return { from: monday, to: now }
  }
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1),
    to: now,
  }
}

const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  momo: 'MTN MoMo',
  airtel: 'Airtel Money',
  card: 'Card',
  bank: 'Bank',
}
export const methodLabel = (m: string) => METHOD_LABEL[m] ?? m

function sample(
  range: DashboardRange,
  manager: boolean,
  now: Date,
  custom?: CustomRange | null,
): DashboardData {
  const { from, to } = rangeDates(range, now, custom)
  const period = { from: iso(from), to: iso(to) }
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1
  const prev = { from: iso(addDays(from, -days)), to: iso(addDays(from, -1)) }
  const visits = sampleVisitTotals(period)
  const visitsPrev = sampleVisitTotals(prev)
  const money = sampleRevenueTotals(period)
  const queue = sampleQueueNow()
  return {
    from: period.from,
    to: period.to,
    manager,
    tiles: {
      registered: visits.registered,
      registeredPrev: visitsPrev.registered,
      visits: visits.visits,
      visitsPrev: visitsPrev.visits,
      waitingNow: queue.reduce((s, q) => s + q.waiting, 0),
      forgottenNow: queue.reduce((s, q) => s + q.forgotten, 0),
      revenue: manager ? money.collected : null,
      revenuePrev: manager ? sampleRevenueTotals(prev).collected : null,
      refunded: manager ? money.refunded : null,
      openBills: manager ? 9 : null,
      openBillsDue: manager ? 268900 : null,
      debts: manager ? 4 : null,
      debtsDue: manager ? 62500 : null,
      bedsOccupied: 5,
      bedsTotal: 8,
    },
    revenue30d: manager ? sampleRevenueDays({ from: iso(addDays(now, -29)), to: iso(now) }) : [],
    revenuePeriod: manager && days <= 92 ? sampleRevenueDays(period) : null,
    // method keys (cash, momo, airtel…), as the database sends them
    collections: manager
      ? sampleRevenueAnalysis(period).byMethod.map((m) => ({ method: m.method, amount: m.amount }))
      : [],
    receivables: manager
      ? RECEIVABLES.map((r) => ({ payer: r.label, count: 10, amount: r.value }))
      : [],
    visitsByGroup: sampleVisitsByGroup(period),
    waitByStation: queue,
    topTreatments: sampleTopTreatments(period, manager),
    staff: sampleDashboardStaff(period, manager),
    reorder: REORDER.map((r, i) => ({ id: `item-${i}`, name: r.label, onHand: r.qty, min: r.min })),
    expiring: { ...EXPIRING_BATCHES },
    bookings: { booked: visits.booked, missed: visits.missed, pending: visits.pending },
    messages: CHANNELS.map((c) => ({ channel: c.label, sent: c.sent, failed: c.failed })),
    claims: CLAIMS_DUE.map((c) => ({
      payer: c.label,
      count: c.count,
      amount: manager ? c.amount : null,
    })),
    logins: sampleLogins(),
    services: { active: 24, total: 24 },
  }
}

/** Revenue per day as the database sends it (refunds and net from 0086; before: none). */
const toRevenuePoints = (rows: unknown): RevenuePoint[] =>
  (Array.isArray(rows) ? (rows as Partial<Record<keyof RevenuePoint, unknown>>[]) : []).map((r) => {
    const amount = Number(r.amount ?? 0)
    const refunds = Number(r.refunds ?? 0)
    return {
      day: String(r.day),
      amount,
      refunds,
      net: r.net == null ? amount - refunds : Number(r.net),
    }
  })

export function useDashboard(range: DashboardRange, manager: boolean, custom?: CustomRange | null) {
  return useQuery({
    queryKey: ['dashboard', range, range === 'custom' ? custom : null],
    refetchInterval: 60_000,
    queryFn: async (): Promise<DashboardData> => {
      const now = new Date()
      if (!supabase) return sample(range, manager, now, custom)
      const { from, to } = rangeDates(range, now, custom)
      const p = { from: iso(from), to: iso(to) }
      const { data, error } = await supabase.rpc('dashboard_summary', {
        p_from: p.from,
        p_to: p.to,
      })
      if (error) throw apiError(error)
      // the shape of 0086, with the fields older databases do not send yet made optional
      type Raw = Omit<
        DashboardData,
        'tiles' | 'revenue30d' | 'revenuePeriod' | 'waitByStation' | 'staff' | 'reorder' | 'logins'
      > & {
        tiles: Record<string, unknown>
        revenue30d?: unknown
        revenuePeriod?: unknown
        waitByStation?: Partial<Record<keyof QueueNow, unknown>>[]
        staff?: (Partial<DashboardData['staff'][number]> & { name: string })[]
        reorder?: { id?: string | null; name: string; onHand: unknown; min: unknown }[]
        logins?: (Omit<DashboardData['logins'][number], 'id'> & { id?: string | null })[]
      }
      const d = data as Raw
      const num = (v: unknown) => (v == null ? null : Number(v))
      const revenue30d = toRevenuePoints(d.revenue30d)
      // before 0086 there is no revenuePeriod: the 30 days cover a period inside them
      const revenuePeriod =
        'revenuePeriod' in d
          ? d.revenuePeriod == null
            ? null
            : toRevenuePoints(d.revenuePeriod)
          : revenue30d.length && revenue30d[0]!.day <= p.from
            ? revenue30d.filter((r) => r.day >= p.from && r.day <= p.to)
            : null
      return {
        ...d,
        tiles: {
          registered: Number(d.tiles.registered),
          registeredPrev: Number(d.tiles.registeredPrev),
          visits: Number(d.tiles.visits),
          visitsPrev: Number(d.tiles.visitsPrev),
          waitingNow: Number(d.tiles.waitingNow ?? 0),
          forgottenNow: Number(d.tiles.forgottenNow ?? 0),
          revenue: num(d.tiles.revenue),
          revenuePrev: num(d.tiles.revenuePrev),
          refunded: num(d.tiles.refunded),
          openBills: num(d.tiles.openBills),
          openBillsDue: num(d.tiles.openBillsDue),
          debts: num(d.tiles.debts),
          debtsDue: num(d.tiles.debtsDue),
          bedsOccupied: Number(d.tiles.bedsOccupied),
          bedsTotal: Number(d.tiles.bedsTotal),
        },
        revenue30d,
        revenuePeriod,
        collections: (d.collections ?? []).map((c) => ({
          method: c.method,
          amount: Number(c.amount),
        })),
        receivables: (d.receivables ?? []).map((r) => ({
          ...r,
          amount: Number(r.amount),
          count: Number(r.count),
        })),
        visitsByGroup: (d.visitsByGroup ?? []).map((v) => ({
          ...v,
          categoryId: v.categoryId ?? null,
          count: Number(v.count),
        })),
        waitByStation: (d.waitByStation ?? []).map((w) => ({
          station: String(w.station),
          waiting: Number(w.waiting ?? 0),
          busy: Number(w.busy ?? 0),
          longest: num(w.longest),
          forgotten: Number(w.forgotten ?? 0),
        })),
        topTreatments: (d.topTreatments ?? []).map((x) => ({
          ...x,
          count: Number(x.count),
          amount: num(x.amount),
        })),
        staff: (d.staff ?? []).map((s) => ({
          id: s.id ?? null,
          name: s.name,
          role: s.role ?? '',
          staffId: s.staffId ?? null,
          active: s.active !== false,
          registrations: Number(s.registrations ?? 0),
          vitals: Number(s.vitals ?? 0),
          charges: Number(s.charges ?? 0),
          patients: Number(s.patients ?? 0),
          results: Number(s.results ?? 0),
          dispensed: Number(s.dispensed ?? 0),
          payments: num(s.payments),
          collected: num(s.collected),
          lastSignIn: s.lastSignIn ?? null,
        })),
        reorder: (d.reorder ?? []).map((r) => ({
          id: r.id ?? r.name,
          name: r.name,
          onHand: Number(r.onHand),
          min: Number(r.min),
        })),
        expiring: {
          d30: Number(d.expiring.d30),
          d60: Number(d.expiring.d60),
          d90: Number(d.expiring.d90),
          expired: Number(d.expiring.expired ?? 0),
        },
        bookings: {
          booked: Number(d.bookings.booked),
          missed: Number(d.bookings.missed),
          pending: Number(d.bookings.pending),
        },
        messages: d.messages.map((m) => ({ ...m, sent: Number(m.sent), failed: Number(m.failed) })),
        claims: d.claims.map((c) => ({ ...c, count: Number(c.count), amount: num(c.amount) })),
        logins: (d.logins ?? []).map((l) => ({ ...l, id: l.id ?? null })),
        services: { active: Number(d.services.active), total: Number(d.services.total) },
      }
    },
  })
}

/** One department as its head sees it (department_summary, 0063): no money. */
export interface DepartmentSummary {
  department: { id: string; name: string; roles: string[] }
  stations: string[]
  tiles: {
    patients: number
    patientsPrev: number
    /** Joined a queue today, not taken yet (0086: today only). */
    waitingNow: number
    /** Still open from an earlier day (0086; 0 before). */
    forgottenNow: number
    ordersOpen: number
    ordersNotDone: number
    tasksOpen: number
    members: number
    signedInToday: number
  }
  members: {
    id: string
    name: string
    role: string
    position: 'head' | 'assistant' | 'member'
    station: string | null
    lastSignIn: string | null
    active: boolean
    patients: number
    registrations: number
    vitals: number
    results: number
    dispensed: number
    payments: number
    tasksDone: number
    busyNow: number
  }[]
  /** The department's queues now (0086: no average wait; forgotten from earlier days). */
  queue: QueueNow[]
  services: { name: string; count: number }[]
}

export function useDepartmentSummary(
  departmentId: string | null,
  range: DashboardRange,
  custom?: CustomRange | null,
) {
  return useQuery({
    queryKey: ['department-summary', departmentId, range, range === 'custom' ? custom : null],
    enabled: !!departmentId && !!supabase,
    refetchInterval: 60_000,
    queryFn: async (): Promise<DepartmentSummary> => {
      const { from, to } = rangeDates(range, new Date(), custom)
      const { data, error } = await supabase!.rpc('department_summary', {
        p_department_id: departmentId,
        p_from: iso(from),
        p_to: iso(to),
      })
      if (error) throw apiError(error)
      const d = data as Omit<DepartmentSummary, 'queue' | 'tiles'> & {
        tiles: Omit<DepartmentSummary['tiles'], 'forgottenNow'> & { forgottenNow?: unknown }
        queue?: Partial<Record<keyof QueueNow, unknown>>[]
      }
      return {
        ...d,
        tiles: { ...d.tiles, forgottenNow: Number(d.tiles.forgottenNow ?? 0) },
        queue: (d.queue ?? []).map((w) => ({
          station: String(w.station),
          waiting: Number(w.waiting ?? 0),
          busy: Number(w.busy ?? 0),
          longest: w.longest == null ? null : Number(w.longest),
          forgotten: Number(w.forgotten ?? 0),
        })),
      }
    },
  })
}

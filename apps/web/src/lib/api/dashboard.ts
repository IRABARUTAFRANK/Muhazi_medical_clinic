import { useQuery } from '@tanstack/react-query'
import {
  CLAIMS_DUE,
  COLLECTIONS_TODAY,
  EXPIRING_BATCHES,
  RECEIVABLES,
  REORDER,
  REVENUE_30D,
  TOP_DIAGNOSES,
  VISITS_BY_SERVICE,
  WAIT_BY_STATION,
  CHANNELS,
  NO_SHOW,
  addDays,
} from '@mmc/shared'
import { supabase } from '@/lib/supabase'

/**
 * Manager dashboard numbers, computed by `dashboard_summary(from, to)` in the database.
 * Money fields are null for heads of station. Sample mode uses the design's figures.
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
    waitingNow: number
    avgWaitMin: number
    revenue: number | null
    revenuePrev: number | null
    openBills: number | null
    openBillsDue: number | null
    bedsOccupied: number
    bedsTotal: number
  }
  revenue30d: { day: string; amount: number }[]
  collections: { method: string; amount: number }[]
  receivables: { payer: string; count: number; amount: number }[]
  visitsByGroup: { group: string; count: number }[]
  /** minutes: average wait today of those already taken (null: nobody yet); longest: the
   *  first patient still in line (null: nobody waiting). */
  waitByStation: {
    station: string
    minutes: number | null
    waiting: number
    longest: number | null
  }[]
  topTreatments: { name: string; count: number; amount: number | null }[]
  staff: {
    name: string
    role: string
    staffId: string | null
    registrations: number
    vitals: number
    charges: number
    payments: number | null
    collected: number | null
    lastSignIn: string | null
  }[]
  reorder: { name: string; onHand: number; min: number }[]
  expiring: { d30: number; d60: number; d90: number }
  bookings: { booked: number; missed: number; pending: number }
  messages: { channel: string; sent: number; failed: number }[]
  claims: { payer: string; count: number; amount: number | null }[]
  logins: { name: string; role: string; at: string; reason: string | null }[]
  services: { active: number; total: number }
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
  if (range === 'week') {
    const monday = addDays(now, -((now.getDay() + 6) % 7))
    return { from: monday, to: addDays(monday, 6) }
  }
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1),
    to: new Date(now.getFullYear(), now.getMonth() + 1, 0),
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
  return {
    from: iso(from),
    to: iso(to),
    manager,
    tiles: {
      registered: 38,
      registeredPrev: 34,
      visits: 52,
      visitsPrev: 47,
      waitingNow: 11,
      avgWaitMin: 18,
      revenue: manager ? 742500 : null,
      revenuePrev: manager ? 700000 : null,
      openBills: manager ? 9 : null,
      openBillsDue: manager ? 268900 : null,
      bedsOccupied: 5,
      bedsTotal: 8,
    },
    revenue30d: REVENUE_30D.map((amount, i) => ({ day: iso(addDays(now, -(29 - i))), amount })),
    collections: COLLECTIONS_TODAY.filter((c) => c.label !== 'Insurer (billed)').map((c) => ({
      method: c.label,
      amount: c.value,
    })),
    receivables: RECEIVABLES.map((r) => ({ payer: r.label, count: 10, amount: r.value })),
    visitsByGroup: VISITS_BY_SERVICE.map((v) => ({ group: v.label, count: v.value })),
    waitByStation: WAIT_BY_STATION.map((w) => ({
      station: w.label.toLowerCase(),
      minutes: w.value,
      waiting: 2,
      longest: w.value + 6,
    })),
    topTreatments: TOP_DIAGNOSES.map((d) => ({ name: d.label, count: d.value, amount: null })),
    staff: [],
    reorder: REORDER.map((r) => ({ name: r.label, onHand: r.qty, min: r.min })),
    expiring: { ...EXPIRING_BATCHES },
    bookings: { booked: NO_SHOW.booked, missed: NO_SHOW.missed, pending: 2 },
    messages: CHANNELS.map((c) => ({ channel: c.label, sent: c.sent, failed: c.failed })),
    claims: CLAIMS_DUE.map((c) => ({ payer: c.label, count: c.count, amount: c.amount })),
    logins: [],
    services: { active: 24, total: 24 },
  }
}

export function useDashboard(range: DashboardRange, manager: boolean, custom?: CustomRange | null) {
  return useQuery({
    queryKey: ['dashboard', range, range === 'custom' ? custom : null],
    refetchInterval: 60_000,
    queryFn: async (): Promise<DashboardData> => {
      const now = new Date()
      if (!supabase) return sample(range, manager, now, custom)
      const { from, to } = rangeDates(range, now, custom)
      const { data, error } = await supabase.rpc('dashboard_summary', {
        p_from: iso(from),
        p_to: iso(to),
      })
      if (error) throw new Error(error.message)
      const d = data as DashboardData
      const num = (v: unknown) => (v == null ? null : Number(v))
      return {
        ...d,
        tiles: {
          registered: Number(d.tiles.registered),
          registeredPrev: Number(d.tiles.registeredPrev),
          visits: Number(d.tiles.visits),
          visitsPrev: Number(d.tiles.visitsPrev),
          waitingNow: Number(d.tiles.waitingNow),
          avgWaitMin: Number(d.tiles.avgWaitMin),
          revenue: num(d.tiles.revenue),
          revenuePrev: num(d.tiles.revenuePrev),
          openBills: num(d.tiles.openBills),
          openBillsDue: num(d.tiles.openBillsDue),
          bedsOccupied: Number(d.tiles.bedsOccupied),
          bedsTotal: Number(d.tiles.bedsTotal),
        },
        revenue30d: d.revenue30d.map((r) => ({ day: r.day, amount: Number(r.amount) })),
        collections: d.collections.map((c) => ({
          method: c.method,
          amount: Number(c.amount),
        })),
        receivables: d.receivables.map((r) => ({
          ...r,
          amount: Number(r.amount),
          count: Number(r.count),
        })),
        visitsByGroup: d.visitsByGroup.map((v) => ({ ...v, count: Number(v.count) })),
        waitByStation: d.waitByStation.map((w) => ({
          ...w,
          minutes: w.minutes == null ? null : Number(w.minutes),
          waiting: Number(w.waiting),
          longest: w.longest == null ? null : Number(w.longest),
        })),
        topTreatments: d.topTreatments.map((x) => ({
          ...x,
          count: Number(x.count),
          amount: num(x.amount),
        })),
        staff: d.staff.map((s) => ({
          ...s,
          registrations: Number(s.registrations),
          vitals: Number(s.vitals),
          charges: Number(s.charges),
          payments: num(s.payments),
          collected: num(s.collected),
        })),
        reorder: d.reorder.map((r) => ({ ...r, onHand: Number(r.onHand), min: Number(r.min) })),
        expiring: {
          d30: Number(d.expiring.d30),
          d60: Number(d.expiring.d60),
          d90: Number(d.expiring.d90),
        },
        bookings: {
          booked: Number(d.bookings.booked),
          missed: Number(d.bookings.missed),
          pending: Number(d.bookings.pending),
        },
        messages: d.messages.map((m) => ({ ...m, sent: Number(m.sent), failed: Number(m.failed) })),
        claims: d.claims.map((c) => ({ ...c, count: Number(c.count), amount: num(c.amount) })),
        services: { active: Number(d.services.active), total: Number(d.services.total) },
      }
    },
  })
}

import { useQuery } from '@tanstack/react-query'
import { ROLE_HOME, type HomeRole, type StaffUser } from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { apiError, isMissingFunction } from './errors'
import { isKigaliToday } from './notifications'
import type { DayRange } from './lab'
import { stationFor, toItem, type BoardRow, type QueueItem, type Station } from './visits'

/**
 * The signed-in person's own dashboard figures (migration 0120, my_summary): the patients that
 * are theirs right now (sent to them by name first, then their desks' queue), what they did in
 * the period by kind (as "Who did what" counts it) and, for whoever takes payments, their own
 * money. Nobody else's figures ever come through here: the clinic's belong to the manager
 * dashboard. The rows are queue_board rows, so Take / Call work as on any queue.
 */

/** A row of my queue: a queue_board row, flagged when the patient was sent to me by name. */
export interface MyQueueItem extends QueueItem {
  /** Sent to me by name (assigned to me, or a handover waiting for my answer). */
  byName: boolean
  /** Joined the queue on an earlier day and still open (0122): shown apart, not counted. */
  earlier: boolean
}

export interface MyMoney {
  payments: { count: number; amount: number; prevAmount: number; prevCount: number }
  byMethod: { method: string; amount: number; count: number }[]
  refunds: { count: number; amount: number }
  /** The walk-in sales I handed over (the pharmacy). */
  sales: { count: number; total: number }
}

export interface MySummary {
  from: string
  to: string
  role: string
  /** My own desk (the profile's station, else the role's usual desk; the manager: only when
   *  the profile names one). */
  station: Station | null
  desks: string[]
  waiting: MyQueueItem[]
  /** Today's (0122); `earlier`: the patients still here from an earlier day, shown apart. */
  counts: { sentToMe: number; atMyDesks: number; inProgress: number; earlier: number }
  /** My work in the period, by kind (analytics.kinds.*; plus visitsStarted). */
  work: Record<string, number>
  /** The same for the period just before (the arrows). */
  workPrev: Record<string, number>
  /** Only for whoever takes payments (and the manager). */
  money: MyMoney | null
  /** The database is older than 0120: the lists and counts above are empty. */
  needsUpdate?: boolean
}

export const MY_KEY = ['queue', 'mine'] as const

const n0 = (v: unknown) => (v == null ? 0 : Number(v))
const counts = (v: unknown): Record<string, number> =>
  Object.fromEntries(
    Object.entries((v ?? {}) as Record<string, unknown>).map(([k, x]) => [k, n0(x)]),
  )

function toSummary(d: Record<string, unknown>): MySummary {
  const money = d.money as Record<string, unknown> | null
  const obj = (v: unknown) => (v ?? {}) as Record<string, unknown>
  return {
    from: String(d.from ?? ''),
    to: String(d.to ?? ''),
    role: String(d.role ?? ''),
    station: (d.station as Station | null) ?? null,
    desks: (d.desks as string[]) ?? [],
    waiting: ((d.waiting as (BoardRow & { by_name?: boolean; earlier?: boolean })[]) ?? []).map(
      (r) => ({
        ...toItem(r),
        byName: !!r.by_name,
        // a database before 0122: from the time the patient joined the queue
        earlier:
          typeof r.earlier === 'boolean'
            ? r.earlier
            : !!r.queued_at && !isKigaliToday(String(r.queued_at)),
      }),
    ),
    counts: {
      sentToMe: n0(obj(d.counts).sentToMe),
      atMyDesks: n0(obj(d.counts).atMyDesks),
      inProgress: n0(obj(d.counts).inProgress),
      earlier: n0(obj(d.counts).earlier),
    },
    work: counts(d.work),
    workPrev: counts(d.workPrev),
    money: money
      ? {
          payments: {
            count: n0(obj(money.payments).count),
            amount: n0(obj(money.payments).amount),
            prevAmount: n0(obj(money.payments).prevAmount),
            prevCount: n0(obj(money.payments).prevCount),
          },
          byMethod: ((money.byMethod as Record<string, unknown>[]) ?? []).map((m) => ({
            method: String(m.method),
            amount: n0(m.amount),
            count: n0(m.count),
          })),
          refunds: { count: n0(obj(money.refunds).count), amount: n0(obj(money.refunds).amount) },
          sales: { count: n0(obj(money.sales).count), total: n0(obj(money.sales).total) },
        }
      : null,
  }
}

/* ---------------------------------------------------------------- sample mode */

/** The sample's work of each role (today), roughly what a morning gives. */
const SAMPLE_WORK: Record<string, Record<string, number>> = {
  receptionist: { registered: 6, visitsStarted: 9, charges: 3, bookings: 2 },
  nurse: { vitals: 12, patientsSeen: 3, tasksDone: 4, admissions: 1, registered: 2, charges: 1 },
  doctor: { patientsSeen: 17, diagnoses: 15, prescriptions: 14, orders: 9, procedures: 2 },
  lab_tech: { results: 14, charges: 4, patientsSeen: 11 },
  pharmacist: { medicinesGiven: 18, handovers: 5, charges: 2 },
  cashier: { payments: 23, refunds: 1, charges: 0 },
  manager: { patientsSeen: 2, vitals: 1 },
}
const SAMPLE_PREV: Record<string, Record<string, number>> = {
  receptionist: { registered: 5, visitsStarted: 11, charges: 2 },
  nurse: { vitals: 14, patientsSeen: 2, tasksDone: 5, admissions: 0, registered: 1 },
  doctor: { patientsSeen: 15, diagnoses: 15, prescriptions: 12, orders: 7, procedures: 3 },
  lab_tech: { results: 16, charges: 3, patientsSeen: 12 },
  pharmacist: { medicinesGiven: 21, handovers: 3, charges: 1 },
  cashier: { payments: 20, refunds: 0 },
  manager: { patientsSeen: 1 },
}

/** The sample's queue of a role: the design's rows, the first one sent to me by name (the
 *  clinicians), at my own desk. The manager's sample: one patient sent to him at triage. */
function sampleSummary(user: StaffUser): MySummary {
  const role: HomeRole = user.role === 'manager' ? 'nurse' : user.role
  const station = user.role === 'manager' ? ('triage' as Station) : stationFor(user)
  const named = user.role === 'doctor' || user.role === 'nurse' || user.role === 'manager'
  const rows = user.role === 'manager' ? ROLE_HOME.nurse.queue.slice(0, 1) : ROLE_HOME[role].queue
  const waiting: MyQueueItem[] = rows.map((q, i) => ({
    ...q,
    insurer: `MMC-00013${i}`,
    queueId: `q-mine-${i}`,
    encounterId: `e-${station}-${i}`,
    patientId: `p-${station}-${i}`,
    fileNumber: `MMC-00013${i}`,
    station,
    priority: q.triage === 'red' ? 1 : q.triage === 'yellow' ? 2 : 3,
    queuedAt: new Date(Date.now() - q.waitMin * 60_000).toISOString(),
    startedAt: null,
    finishedAt: null,
    calledAt: null,
    poolId: null,
    takenBy: null,
    vitalsAt: user.role === 'nurse' && i > 1 ? new Date().toISOString() : null,
    forMe: true,
    canWork: true,
    byName: named && i === 0,
    earlier: false,
    handover: null,
  }))
  // the clinicians' sample: one patient left in the queue since yesterday (shown apart)
  if (named && waiting.length > 0) {
    const first = waiting[0]!
    waiting.push({
      ...first,
      queueId: 'q-mine-old',
      encounterId: `e-${station}-old`,
      patientId: `p-${station}-old`,
      fileNumber: 'MMC-000098',
      insurer: 'MMC-000098',
      ticket: 'C-041',
      name: 'Nshimiyimana Jean',
      ageSex: '52 · M',
      triage: 'green',
      priority: 3,
      waitMin: 19 * 60,
      queuedAt: new Date(Date.now() - 26 * 60 * 60_000).toISOString(),
      byName: false,
      earlier: true,
      vitalsAt: new Date(Date.now() - 26 * 60 * 60_000).toISOString(),
    })
  }
  const dbRole = user.dbRole ?? user.role
  const money = user.role === 'cashier' || user.role === 'manager'
  return {
    from: '',
    to: '',
    role: dbRole,
    station,
    desks: [],
    waiting,
    counts: {
      sentToMe: waiting.filter((r) => r.byName && !r.earlier).length,
      atMyDesks: waiting.filter((r) => !r.byName && !r.earlier).length,
      inProgress: user.role === 'cashier' ? 1 : 0,
      earlier: waiting.filter((r) => r.earlier).length,
    },
    work: SAMPLE_WORK[user.role] ?? {},
    workPrev: SAMPLE_PREV[user.role] ?? {},
    money: money
      ? {
          payments: { count: 23, amount: 486500, prevAmount: 412000, prevCount: 20 },
          byMethod: [
            { method: 'cash', amount: 312500, count: 15 },
            { method: 'momo', amount: 146000, count: 7 },
            { method: 'airtel', amount: 28000, count: 1 },
          ],
          refunds: { count: 1, amount: 5000 },
          sales: { count: 4, total: 36000 },
        }
      : null,
  }
}

const empty = (): MySummary => ({
  from: '',
  to: '',
  role: '',
  station: null,
  desks: [],
  waiting: [],
  counts: { sentToMe: 0, atMyDesks: 0, inProgress: 0, earlier: 0 },
  work: {},
  workPrev: {},
  money: null,
  needsUpdate: true,
})

/**
 * My own figures for the period (today by default). The key starts with 'queue' so that taking
 * or calling a patient (which refreshes every queue) refreshes this list too.
 */
export function useMySummary(period?: DayRange | null, opts: { enabled?: boolean } = {}) {
  const user = useSession((s) => s.user)
  return useQuery({
    queryKey: [...MY_KEY, user?.id, period?.from, period?.to],
    enabled: (opts.enabled ?? true) && !!user,
    refetchInterval: 15_000,
    queryFn: async (): Promise<MySummary> => {
      if (!supabase) return sampleSummary(user!)
      const { data, error } = await supabase.rpc(
        'my_summary',
        period ? { p_from: period.from, p_to: period.to } : undefined,
      )
      if (error) {
        // before 0120: the home keeps its other panels, the personal ones say so
        if (isMissingFunction(error)) return empty()
        throw apiError(error)
      }
      return toSummary((data ?? {}) as Record<string, unknown>)
    },
  })
}

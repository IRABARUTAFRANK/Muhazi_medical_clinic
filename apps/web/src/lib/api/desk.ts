import { useQuery } from '@tanstack/react-query'
import type { DayRange } from './lab'
import { supabase } from '@/lib/supabase'

/**
 * Today's figures for the front-desk and nursing dashboards, from `desk_summary()`: no money,
 * readable by every signed-in staff member. Refreshes every 30 seconds.
 */
export interface DeskSummary {
  tiles: {
    registeredToday: number
    registeredYesterday: number
    visitsToday: number
    visitsYesterday: number
    inClinic: number
    /** Joined a queue today and not taken yet (0086: an older entry is not "waiting"). */
    waitingNow: number
    /** Still open in a queue from an earlier day: forgotten, please close (0086). */
    forgottenNow?: number
    triageWaiting: number
    triageRed: number
    triageYellow: number
    /** Open visits by colour (0063); older databases send only red and yellow. */
    triageGreen?: number
    triageNone?: number
    /** Open visits still without any measurement. */
    needVitals?: number
    vitalsToday: number
    vitalsYesterday: number
    apptsToday: number
    inquiriesPending: number
    bedsOccupied: number
    bedsTotal: number
  }
  /** waiting: joined today, not taken yet; longest: the first of them still in line, in minutes
   *  (null: nobody waiting); forgotten: still open from an earlier day (0086). No average wait:
   *  waiting times are shown on the Analytics page only. */
  stations: {
    station: string
    waiting: number
    busy: number
    longest: number | null
    forgotten: number
  }[]
  arrivals: { hour: number; count: number }[]
  mine: { registrations: number; visitsStarted: number; vitals: number; charges: number }
}

const sample = (): DeskSummary => {
  const hour = new Date().getHours()
  const curve = [1, 3, 6, 8, 7, 5, 4, 5, 6, 4, 3, 2, 2, 1, 1, 0]
  return {
    tiles: {
      registeredToday: 14,
      registeredYesterday: 11,
      visitsToday: 38,
      visitsYesterday: 41,
      inClinic: 12,
      waitingNow: 7,
      forgottenNow: 1,
      triageWaiting: 5,
      triageRed: 1,
      triageYellow: 2,
      triageGreen: 6,
      triageNone: 3,
      needVitals: 4,
      vitalsToday: 29,
      vitalsYesterday: 33,
      apptsToday: 9,
      inquiriesPending: 3,
      bedsOccupied: 4,
      bedsTotal: 8,
    },
    stations: [
      { station: 'triage', waiting: 5, busy: 1, longest: 14, forgotten: 0 },
      { station: 'consultation', waiting: 4, busy: 2, longest: 41, forgotten: 1 },
      { station: 'laboratory', waiting: 2, busy: 1, longest: 18, forgotten: 0 },
      { station: 'pharmacy', waiting: 1, busy: 0, longest: 4, forgotten: 0 },
      { station: 'cashier', waiting: 2, busy: 1, longest: 7, forgotten: 0 },
    ],
    arrivals: curve.map((c, i) => ({ hour: 6 + i, count: 6 + i <= hour ? c : 0 })),
    mine: { registrations: 6, visitsStarted: 9, vitals: 12, charges: 3 },
  }
}

export function useDeskSummary(period?: DayRange | null) {
  return useQuery({
    queryKey: ['desk', period?.from, period?.to],
    refetchInterval: 30_000,
    queryFn: async (): Promise<DeskSummary> => {
      if (!supabase) return sample()
      const { data, error } = await supabase.rpc(
        'desk_summary',
        period ? { p_from: period.from, p_to: period.to } : undefined,
      )
      if (error) throw new Error(error.message)
      const d = data as DeskSummary
      const n = (v: unknown) => Number(v ?? 0)
      return {
        // before 0086 the tiles also carried an average wait: dropped (it was not a waiting time)
        tiles: Object.fromEntries(
          Object.entries(d.tiles)
            .filter(([k]) => k !== 'avgWaitMin' && k !== 'triageAvgWaitMin')
            .map(([k, v]) => [k, n(v)]),
        ) as DeskSummary['tiles'],
        stations: d.stations.map((s) => ({
          station: s.station,
          waiting: n(s.waiting),
          busy: n(s.busy),
          longest: s.longest == null ? null : Number(s.longest),
          forgotten: n(s.forgotten),
        })),
        arrivals: d.arrivals.map((a) => ({ hour: n(a.hour), count: n(a.count) })),
        mine: {
          registrations: n(d.mine.registrations),
          visitsStarted: n(d.mine.visitsStarted),
          vitals: n(d.mine.vitals),
          charges: n(d.mine.charges),
        },
      }
    },
  })
}

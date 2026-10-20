import { useQuery } from '@tanstack/react-query'
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
    waitingNow: number
    avgWaitMin: number
    triageWaiting: number
    triageRed: number
    triageYellow: number
    triageAvgWaitMin: number
    vitalsToday: number
    vitalsYesterday: number
    apptsToday: number
    inquiriesPending: number
    bedsOccupied: number
    bedsTotal: number
  }
  /** minutes: average wait today of those already taken (null: nobody yet); longest: the
   *  first patient still in line (null: nobody waiting). */
  stations: {
    station: string
    waiting: number
    busy: number
    minutes: number | null
    longest: number | null
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
      avgWaitMin: 18,
      triageWaiting: 5,
      triageRed: 1,
      triageYellow: 2,
      triageAvgWaitMin: 9,
      vitalsToday: 29,
      vitalsYesterday: 33,
      apptsToday: 9,
      inquiriesPending: 3,
      bedsOccupied: 4,
      bedsTotal: 8,
    },
    stations: [
      { station: 'triage', waiting: 5, busy: 1, minutes: 9, longest: 14 },
      { station: 'consultation', waiting: 4, busy: 2, minutes: 22, longest: 41 },
      { station: 'laboratory', waiting: 2, busy: 1, minutes: 14, longest: 18 },
      { station: 'pharmacy', waiting: 1, busy: 0, minutes: 6, longest: 4 },
      { station: 'cashier', waiting: 2, busy: 1, minutes: 5, longest: 7 },
    ],
    arrivals: curve.map((c, i) => ({ hour: 6 + i, count: 6 + i <= hour ? c : 0 })),
    mine: { registrations: 6, visitsStarted: 9, vitals: 12, charges: 3 },
  }
}

export function useDeskSummary() {
  return useQuery({
    queryKey: ['desk'],
    refetchInterval: 30_000,
    queryFn: async (): Promise<DeskSummary> => {
      if (!supabase) return sample()
      const { data, error } = await supabase.rpc('desk_summary')
      if (error) throw new Error(error.message)
      const d = data as DeskSummary
      const n = (v: unknown) => Number(v ?? 0)
      return {
        tiles: Object.fromEntries(
          Object.entries(d.tiles).map(([k, v]) => [k, n(v)]),
        ) as DeskSummary['tiles'],
        stations: d.stations.map((s) => ({
          station: s.station,
          waiting: n(s.waiting),
          busy: n(s.busy),
          minutes: s.minutes == null ? null : Number(s.minutes),
          longest: s.longest == null ? null : Number(s.longest),
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

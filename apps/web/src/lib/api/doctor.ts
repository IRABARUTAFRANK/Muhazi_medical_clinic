import { useQuery } from '@tanstack/react-query'
import { isoDate } from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import type { Station } from '@/lib/api/visits'
import type { TestStatus } from '@/lib/api/lab'

/**
 * The doctor's own lists (migration 0057): the tests they ordered with their results, and the
 * prescriptions they wrote with what the pharmacy did (handed over, not given and why).
 */
export interface MyOrder {
  id: string
  encounterId: string
  patientId: string
  patient: string
  fileNumber: string
  test: string
  station: Station
  status: TestStatus
  priority: number
  reason: string | null
  orderedAt: string
  findings: string | null
  impression: string | null
  verified: boolean
  resultAt: string | null
  resultBy: string | null
  visitOpen: boolean
}

export type RxState = 'waiting' | 'given' | 'not_given' | 'room'
/** With 0082 a line can also be cancelled by its prescriber (stateFull). */
export type RxStateFull = RxState | 'cancelled'
export interface MyPrescription {
  id: string
  encounterId: string
  patientId: string
  patient: string
  fileNumber: string
  item: string
  quantity: number
  dose: string | null
  frequency: string | null
  days: number | null
  instructions: string | null
  supply: 'pharmacy' | 'room'
  at: string
  /**
   * Where it stands. A cancelled line (0082) shows here as 'not_given' with the cancel reason,
   * so lists made for the four states keep working; `stateFull` and `cancelled` tell it apart.
   */
  state: RxState
  stateFull: RxStateFull
  cancelled: boolean
  givenAt: string | null
  notGivenReason: string | null
  cancelledAt: string | null
  cancelReason: string | null
  visitOpen: boolean
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const sampleOrders: MyOrder[] = [
  ['Malaria RDT', 'Mukamana Alice', 'verified', 'Negative', 'No malaria', 95],
  ['Full blood count', 'Habimana Eric', 'in_process', null, null, 40],
  ['Urinalysis', 'Ingabire Diane', 'ordered', null, null, 12],
  [
    'Abdominal ultrasound',
    'Umutoni Grace',
    'resulted',
    'Normal liver and gallbladder',
    'Normal',
    70,
  ],
].map(([test, patient, status, findings, impression, min], i) => ({
  id: `mo-${i}`,
  encounterId: `e-${i}`,
  patientId: `p-${i}`,
  patient: patient as string,
  fileNumber: `MMC-00012${i}`,
  test: test as string,
  station: ((test as string).includes('ultrasound') ? 'ultrasound' : 'laboratory') as Station,
  status: status as TestStatus,
  priority: 3,
  reason: null,
  orderedAt: ago(min as number),
  findings: findings as string | null,
  impression: impression as string | null,
  verified: status === 'verified',
  resultAt: findings ? ago((min as number) - 20) : null,
  resultBy: findings ? 'Uwera Diane' : null,
  visitOpen: true,
}))
const sampleRx: MyPrescription[] = [
  ['Artemether-lumefantrine 20/120 mg', 'Mukamana Alice', 24, 'waiting', null, 30],
  ['Amoxicillin 500 mg', 'Habimana Eric', 21, 'given', null, 65],
  ['Ciprofloxacin 500 mg', 'Ingabire Diane', 10, 'not_given', 'Out of stock', 80],
].map(([item, patient, quantity, state, reason, min], i) => ({
  id: `mp-${i}`,
  encounterId: `e-${i}`,
  patientId: `p-${i}`,
  patient: patient as string,
  fileNumber: `MMC-00012${i}`,
  item: item as string,
  quantity: quantity as number,
  dose: '1 tab',
  frequency: 'BD',
  days: 3,
  instructions: null,
  supply: 'pharmacy' as const,
  at: ago(min as number),
  state: state as RxState,
  stateFull: state as RxState,
  cancelled: false,
  givenAt: state === 'given' ? ago((min as number) - 15) : null,
  notGivenReason: reason as string | null,
  cancelledAt: null,
  cancelReason: null,
  visitOpen: true,
}))

/** The days the lists cover, ISO, both included (the shared period filter). */
export interface DayRange {
  from: string
  to: string
}

/** A list of the period. `cut`: the database is not updated yet and could only give the last 90 days. */
export interface PeriodRows<T> {
  rows: T[]
  cut: boolean
}

/** What an older database (before 0078) can reach back: the last 90 days. */
const OLD_MAX_DAYS = 90

/**
 * Ask for the days `from`..`to` (migration 0078). An older database only knows "the last N
 * days" (at most 90): ask for enough days back to reach `from`, then keep only the days
 * `from`..`to`.
 */
async function rowsOfPeriod<T>(
  fn: 'my_orders' | 'my_prescriptions',
  period: DayRange,
  dayOf: (row: T) => string,
): Promise<PeriodRows<T>> {
  if (!supabase) return { rows: [], cut: false }
  const { data, error } = await supabase.rpc(fn, { p_from: period.from, p_to: period.to })
  if (!error) return { rows: (data as T[]) ?? [], cut: false }
  if (!/function|schema cache/i.test(error.message)) throw new Error(error.message)
  const [y, m, d] = period.from.split('-').map(Number)
  const start = new Date(y!, m! - 1, d!).getTime()
  const needed = Math.max(1, Math.floor((Date.now() - start) / 86_400_000) + 1)
  const old = await supabase.rpc(fn, { p_days: Math.min(OLD_MAX_DAYS, needed) })
  if (old.error) throw new Error(old.error.message)
  const rows = ((old.data as T[]) ?? []).filter((r) => {
    const day = isoDate(new Date(dayOf(r)))
    return day >= period.from && day <= period.to
  })
  return { rows, cut: needed > OLD_MAX_DAYS }
}

export function useMyOrders(period: DayRange) {
  return useQuery({
    queryKey: ['my-orders', period.from, period.to],
    refetchInterval: 20_000,
    queryFn: async (): Promise<PeriodRows<MyOrder>> => {
      if (!supabase) return { rows: sampleOrders, cut: false }
      return rowsOfPeriod<MyOrder>('my_orders', period, (o) => o.orderedAt)
    },
  })
}

export function useMyPrescriptions(period: DayRange) {
  return useQuery({
    queryKey: ['my-prescriptions', period.from, period.to],
    refetchInterval: 30_000,
    queryFn: async (): Promise<PeriodRows<MyPrescription>> => {
      if (!supabase) return { rows: sampleRx, cut: false }
      const got = await rowsOfPeriod<Omit<MyPrescription, 'state'> & { state: RxStateFull }>(
        'my_prescriptions',
        period,
        (r) => r.at,
      )
      return {
        ...got,
        rows: got.rows.map((r) => {
          const cancelled = r.state === 'cancelled'
          return {
            ...r,
            quantity: Number(r.quantity),
            state: (cancelled ? 'not_given' : r.state) as RxState,
            stateFull: r.state,
            cancelled,
            notGivenReason: cancelled ? (r.cancelReason ?? null) : r.notGivenReason,
            cancelledAt: r.cancelledAt ?? null,
            cancelReason: r.cancelReason ?? null,
          }
        }),
      }
    },
  })
}

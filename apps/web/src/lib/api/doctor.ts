import { useQuery } from '@tanstack/react-query'
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
  state: RxState
  givenAt: string | null
  notGivenReason: string | null
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
  givenAt: state === 'given' ? ago((min as number) - 15) : null,
  notGivenReason: reason as string | null,
  visitOpen: true,
}))

export function useMyOrders(days: number) {
  return useQuery({
    queryKey: ['my-orders', days],
    refetchInterval: 20_000,
    queryFn: async (): Promise<MyOrder[]> => {
      if (!supabase) return sampleOrders
      const { data, error } = await supabase.rpc('my_orders', { p_days: days })
      if (error) throw new Error(error.message)
      return (data as MyOrder[]) ?? []
    },
  })
}

export function useMyPrescriptions(days: number) {
  return useQuery({
    queryKey: ['my-prescriptions', days],
    refetchInterval: 30_000,
    queryFn: async (): Promise<MyPrescription[]> => {
      if (!supabase) return sampleRx
      const { data, error } = await supabase.rpc('my_prescriptions', { p_days: days })
      if (error) throw new Error(error.message)
      return ((data as MyPrescription[]) ?? []).map((r) => ({ ...r, quantity: Number(r.quantity) }))
    },
  })
}

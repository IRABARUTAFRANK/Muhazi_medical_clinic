import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Triage } from '@mmc/shared'
import type { Sex } from '@/lib/api/visits'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import type { DocPerson } from '@/lib/api/patients'
import { apiError } from './errors'

/**
 * Laboratory (migration 0036): the worklist of tests ordered for this person's bench (lab for lab
 * technicians, imaging for sonographers), sample taken, results, the day's figures.
 */
export type TestStatus =
  'ordered' | 'collected' | 'in_process' | 'resulted' | 'verified' | 'cancelled'

export interface LabOrder {
  id: string
  encounterId: string
  patientId: string
  patient: string
  fileNumber: string
  sex: Sex
  birthDate: string | null
  ticket: string | null
  triage: Triage | null
  test: string
  category: 'lab' | 'imaging'
  status: TestStatus
  priority: number
  reason: string | null
  orderedAt: string
  orderedBy: string | null
  findings: string | null
  impression: string | null
  verified: boolean
  resultAt: string | null
  resultBy: string | null
  // ---- what the result report prints (0084; absent on an older database)
  phone?: string | null
  /** Insurer of the visit (null = cash). */
  insurer?: string | null
  memberNo?: string | null
  coveragePct?: number | null
  /** The weight measured at this visit (else within the 90 days before). */
  weightKg?: number | null
  weightAt?: string | null
  allergies?: string | null
  /** "No known allergies" was recorded. */
  allergiesNone?: boolean
  bloodGroup?: string | null
  /** V-YYYY-NNNNNN. */
  visitReference?: string | null
  visitAt?: string | null
  /** Who validated (else entered) the result, with title and registration. */
  resultByPerson?: DocPerson | null
}

export interface LabSummary {
  waiting: number
  inProcess: number
  toVerify: number
  doneToday: number
  urgent: number
  orderedToday: number
  turnaroundMin: number
  byTest: { test: string; count: number }[]
  /** Tests the bench could not do today, with the reason (0064). */
  notDone?: {
    id: string
    test: string
    at: string
    encounterId: string
    patient: string
    reason: string | null
  }[]
  /** Patients the lab / ultrasound desk finished with today. */
  served?: number
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
let sampleOrders: LabOrder[] = [
  ['Malaria RDT', 'Mukamana Alice', 'F', 'yellow', 'ordered', 2, 'fever 3 days', 12],
  ['Full blood count', 'Habimana Eric', 'M', 'yellow', 'collected', 3, 'pallor', 25],
  ['Urinalysis', 'Ingabire Diane', 'F', 'green', 'ordered', 3, null, 31],
  [
    'Blood glucose (fasting)',
    'Nshimiyimana Patrick',
    'M',
    'green',
    'in_process',
    3,
    'diabetic follow-up',
    44,
  ],
  ['Stool examination', 'Umutoni Grace', 'F', 'green', 'resulted', 3, null, 58],
  ['Widal test', 'Niyonzima Jean Bosco', 'M', 'red', 'ordered', 1, 'high fever', 6],
].map(([test, patient, sex, triage, status, priority, reason, min], i) => ({
  id: `lo-${i}`,
  encounterId: `e-${i}`,
  patientId: `p-${i}`,
  patient: patient as string,
  fileNumber: `MMC-00012${i}`,
  sex: (sex === 'F' ? 'female' : 'male') as Sex,
  birthDate: '1990-01-01',
  ticket: `A-0${10 + i}`,
  triage: triage as Triage,
  test: test as string,
  category: 'lab' as const,
  status: status as TestStatus,
  priority: priority as number,
  reason: reason as string | null,
  orderedAt: ago(min as number),
  orderedBy: 'Dr. Habimana Eric',
  findings: status === 'resulted' ? 'No ova or parasites seen' : null,
  impression: status === 'resulted' ? 'Normal' : null,
  verified: false,
  resultAt: status === 'resulted' ? ago(5) : null,
  resultBy: status === 'resulted' ? 'Uwera Diane' : null,
  phone: `07881234${String(10 + i)}`,
  insurer: i % 2 ? 'Mutuelle de santé (CBHI)' : null,
  memberNo: i % 2 ? `01-0412-0773${i}` : null,
  coveragePct: i % 2 ? 90 : null,
  weightKg: [62, 21.5, 58, 81, 55, 70][i] ?? null,
  weightAt: ago((min as number) + 20),
  allergies: i === 0 ? 'Penicillin (rash)' : null,
  allergiesNone: i === 1 || i === 3,
  bloodGroup: null,
  visitReference: `V-2026-${String(130 + i).padStart(6, '0')}`,
  visitAt: ago((min as number) + 30),
  resultByPerson:
    status === 'resulted'
      ? {
          id: 'u-lab',
          name: 'Uwera Diane',
          role: 'lab_tech',
          specialty: 'Biomedical laboratory scientist',
          registrationNo: '2018/0790',
          registrationBody: 'RAHPC',
        }
      : null,
}))
// The ultrasound asked for Habimana Eric today (its image is in the sample files, lib/api/files.ts).
sampleOrders = [
  ...sampleOrders,
  {
    ...sampleOrders[1]!,
    id: 'sr-us-1',
    encounterId: 'e-1',
    patientId: 'p-2',
    patient: 'Habimana Eric',
    fileNumber: 'MMC-000131',
    ticket: 'A-017',
    test: 'Abdominal ultrasound',
    category: 'imaging',
    status: 'in_process',
    priority: 3,
    reason: 'abdominal pain, right upper side',
    orderedAt: ago(70),
    visitReference: 'V-2026-000101',
  },
]
/** The sample tests at the signed-in person's bench: imaging for a sonographer, the laboratory's
 *  for a laboratory technician, every test for the others (the manager). */
const sampleBench = (list: LabOrder[]): LabOrder[] => {
  const u = useSession.getState().user
  if (u?.role !== 'lab_tech') return list
  const imaging = u.dbRole === 'sonographer'
  return list.filter((o) => (o.category === 'imaging') === imaging)
}
/** The open sample tests (sample mode of the supporting files: whose desk a visit's test is at). */
export const sampleLabTests = (): Pick<
  LabOrder,
  'id' | 'encounterId' | 'patientId' | 'test' | 'category'
>[] => sampleOrders
let sampleDone: LabOrder[] = [
  {
    ...sampleOrders[0]!,
    id: 'ld-1',
    test: 'Haemoglobin',
    patient: 'Kayitesi Rose',
    status: 'verified',
    findings: 'Hb 12.4 g/dL',
    impression: 'Normal',
    verified: true,
    resultAt: ago(40),
    resultBy: 'Uwera Diane',
    resultByPerson: {
      id: 'u-lab',
      name: 'Uwera Diane',
      role: 'lab_tech',
      specialty: 'Biomedical laboratory scientist',
      registrationNo: '2018/0790',
      registrationBody: 'RAHPC',
    },
  },
]

export function useLabWorklist(scope: 'open' | 'done') {
  return useQuery({
    queryKey: ['lab', 'worklist', scope],
    refetchInterval: 20_000,
    queryFn: async (): Promise<LabOrder[]> => {
      if (!supabase) return sampleBench(scope === 'open' ? sampleOrders : sampleDone)
      const { data, error } = await supabase.rpc('lab_worklist', { p_scope: scope })
      if (error) throw apiError(error)
      return (data as LabOrder[]) ?? []
    },
  })
}

/** Orders waiting at a desk other than the lab (Nursing, Dental…), for that desk (migration 0059). */
export function useDeskOrders(station: string) {
  return useQuery({
    queryKey: ['lab', 'desk', station],
    refetchInterval: 20_000,
    queryFn: async (): Promise<LabOrder[]> => {
      if (!supabase) return []
      const { data, error } = await supabase.rpc('desk_orders', { p_station: station })
      if (error) throw apiError(error)
      return (data as LabOrder[]) ?? []
    },
  })
}

/** The days counted (both included); nothing = today (migration 0075). */
export interface DayRange {
  from: string
  to: string
}
export function useLabSummary(period?: DayRange | null) {
  return useQuery({
    queryKey: ['lab', 'summary', period?.from, period?.to],
    refetchInterval: 30_000,
    queryFn: async (): Promise<LabSummary> => {
      if (!supabase) {
        return {
          waiting: sampleOrders.filter((o) => o.status === 'ordered').length,
          inProcess: sampleOrders.filter(
            (o) => o.status === 'collected' || o.status === 'in_process',
          ).length,
          toVerify: sampleOrders.filter((o) => o.status === 'resulted').length,
          doneToday: sampleDone.length + 13,
          urgent: sampleOrders.filter((o) => o.priority <= 2).length,
          orderedToday: 21,
          turnaroundMin: 38,
          byTest: [
            { test: 'Malaria RDT', count: 7 },
            { test: 'Full blood count', count: 5 },
            { test: 'Urinalysis', count: 4 },
            { test: 'Blood glucose', count: 3 },
            { test: 'Widal test', count: 2 },
          ],
        }
      }
      const { data, error } = await supabase.rpc(
        'lab_summary',
        period ? { p_from: period.from, p_to: period.to } : undefined,
      )
      if (error) throw apiError(error)
      return data as LabSummary
    },
  })
}

export function useLabActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['lab'] })
    void qc.invalidateQueries({ queryKey: ['visit'] })
    void qc.invalidateQueries({ queryKey: ['access'] })
    void qc.invalidateQueries({ queryKey: ['routing'] })
  }
  const setStatus = useMutation({
    mutationFn: async (i: {
      id: string
      status: 'collected' | 'in_process' | 'cancelled'
      reason?: string
    }) => {
      if (!supabase) {
        sampleOrders = sampleOrders.map((o) => (o.id === i.id ? { ...o, status: i.status } : o))
        if (i.status === 'cancelled') sampleOrders = sampleOrders.filter((o) => o.id !== i.id)
        return
      }
      const { error } = await supabase.rpc('set_request_status', {
        p_id: i.id,
        p_status: i.status,
        p_reason: i.reason ?? null,
      })
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })
  const result = useMutation({
    mutationFn: async (i: {
      id: string
      findings: string
      impression: string
      verify: boolean
    }) => {
      if (!supabase) {
        const o = sampleOrders.find((x) => x.id === i.id)
        if (o) {
          const done = {
            ...o,
            findings: i.findings,
            impression: i.impression,
            verified: i.verify,
            resultAt: new Date().toISOString(),
            resultBy: 'You',
            status: (i.verify ? 'verified' : 'resulted') as TestStatus,
          }
          sampleOrders = i.verify
            ? sampleOrders.filter((x) => x.id !== i.id)
            : sampleOrders.map((x) => (x.id === i.id ? done : x))
          if (i.verify) sampleDone = [done, ...sampleDone]
        }
        return
      }
      const { error } = await supabase.rpc('record_result', {
        p_request_id: i.id,
        p_findings: i.findings || null,
        p_impression: i.impression || null,
        p_verify: i.verify,
      })
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })
  return { setStatus, result }
}

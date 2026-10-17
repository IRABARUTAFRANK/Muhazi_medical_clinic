import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  APPOINTMENTS,
  BEDS,
  DOCTOR_INQUIRY,
  INQUIRIES,
  LAB_RESULTS,
  NURSE_TASKS,
  OPEN_BILLS,
  type ApptStatus,
} from '@mmc/shared'
import { supabase } from '@/lib/supabase'

/**
 * What each role must do next, computed by `home_summary()` in the database: today's
 * appointments, public inquiries, bookings to accept, open bills, beds, tasks, results.
 * Sample mode shows the design's figures.
 */
export interface HomeAppointment {
  id: string
  time: string
  name: string
  doctor: string
  station: string
  status: ApptStatus
  mine: boolean
}
export interface HomeInquiry {
  id: string
  name: string
  phone: string | null
  reference: string | null
  category: string | null
  doctor: string | null
  channel: string | null
  when: string | null
  note: string | null
}
export interface HomeToAccept {
  id: string
  name: string
  when: string
  note: string | null
}
export interface HomeBill {
  encounterId: string
  name: string
  file: string
  ticket: string | null
  station: string | null
  amount: number
  balance: number
  status: string
}
export interface HomeBed {
  n: number
  name: string
  state: 'free' | 'occupied' | 'cleaning' | 'out_of_service'
  who: string | null
}
export interface HomeTask {
  id: string
  time: string | null
  title: string
  detail: string
  overdue: boolean
  patient: string | null
}
export interface HomeResult {
  id: string
  encounterId: string
  test: string
  name: string
  impression: string
  verified: boolean
  at: string
}
export interface HomeSummary {
  appointments: HomeAppointment[]
  inquiries: HomeInquiry[]
  toAccept: HomeToAccept[]
  openBills: HomeBill[]
  paidToday: { count: number; amount: number }
  beds: HomeBed[]
  tasks: HomeTask[]
  results: HomeResult[]
}

const sampleSummary = (): HomeSummary => ({
  appointments: APPOINTMENTS.map((a, i) => ({
    id: `a-${i}`,
    time: a.time,
    name: a.name,
    doctor: a.doctor,
    station: '',
    status: a.status,
    mine: true,
  })),
  inquiries: INQUIRIES.map((q, i) => ({
    id: `q-${i}`,
    name: q.name,
    phone: '0788000000',
    reference: `MMC-2026-000${i + 1}`,
    category: null,
    doctor: null,
    channel: 'whatsapp',
    when: null,
    note: q.detail,
  })),
  toAccept: [
    { id: 'ta-1', name: DOCTOR_INQUIRY.name, when: '16/10 10:30', note: DOCTOR_INQUIRY.detail },
  ],
  openBills: OPEN_BILLS.map((b, i) => ({
    encounterId: `e-sample-${i}`,
    name: b.name,
    file: `MMC-00013${i}`,
    ticket: `A-01${i}`,
    station: b.station.toLowerCase(),
    amount: b.amount,
    balance: b.amount,
    status: 'draft',
  })),
  paidToday: { count: 36, amount: 742500 },
  beds: BEDS.map((b) => ({ n: b.n, name: `Bed ${b.n}`, state: b.state, who: b.who ?? null })),
  tasks: NURSE_TASKS.map((x, i) => ({
    id: `t-${i}`,
    time: x.time,
    title: x.task,
    detail: '',
    overdue: !!x.overdue,
    patient: x.patient,
  })),
  results: LAB_RESULTS.map((r, i) => ({
    id: `r-${i}`,
    encounterId: `e-${i}`,
    test: r.test,
    name: r.name,
    impression: r.detail,
    verified: r.flag !== 'critical',
    at: '12:20',
  })),
})

const KEY = ['home', 'summary'] as const

export function useHomeSummary() {
  return useQuery({
    queryKey: KEY,
    refetchInterval: 20_000,
    queryFn: async (): Promise<HomeSummary> => {
      if (!supabase) return sampleSummary()
      const { data, error } = await supabase.rpc('home_summary')
      if (error) throw new Error(error.message)
      const d = data as HomeSummary
      return {
        ...d,
        openBills: d.openBills.map((b) => ({
          ...b,
          amount: Number(b.amount),
          balance: Number(b.balance),
        })),
        paidToday: { count: Number(d.paidToday.count), amount: Number(d.paidToday.amount) },
      }
    },
  })
}

export function useHomeActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEY })
    void qc.invalidateQueries({ queryKey: ['public'] })
  }
  const call = async (fn: string, args: Record<string, unknown>) => {
    if (!supabase) return
    const { error } = await supabase.rpc(fn, args)
    if (error) throw new Error(error.message)
  }
  const approveInquiry = useMutation({
    mutationFn: ({ id, patientId }: { id: string; patientId?: string }) =>
      call('approve_inquiry_auto', { p_appointment_id: id, p_patient_id: patientId ?? null }),
    onSuccess: refresh,
  })
  const rejectInquiry = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      call('reject_inquiry', { p_appointment_id: id, p_reason: reason }),
    onSuccess: refresh,
  })
  const acceptAppointment = useMutation({
    mutationFn: ({ id }: { id: string }) => call('accept_appointment', { p_appointment_id: id }),
    onSuccess: refresh,
  })
  const declineAppointment = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      call('decline_appointment', { p_appointment_id: id, p_reason: reason }),
    onSuccess: refresh,
  })
  const completeTask = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      if (!supabase) return
      const { error } = await supabase
        .from('internal_task')
        .update({
          done_at: new Date().toISOString(),
          done_by: (await supabase.auth.getUser()).data.user?.id,
        })
        .eq('id', id)
      if (error) throw new Error(error.message)
    },
    onSuccess: refresh,
  })
  return { approveInquiry, rejectInquiry, acceptAppointment, declineAppointment, completeTask }
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DayRange } from './lab'
import {
  APPOINTMENTS,
  BEDS,
  DOCTOR_INQUIRY,
  INQUIRIES,
  LAB_RESULTS,
  NURSE_TASKS,
  OPEN_BILLS,
  STAFF,
  type ApptStatus,
} from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import { throwIf, apiError } from './errors'

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
  /** The visit opened by the arrival (0065). */
  encounterId?: string | null
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
  /** The service asked for (0065). */
  category?: string | null
  /** The booked time (0068), for the doctor to move it. */
  startsAt?: string | null
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
  /** The doctor has seen it (0065); corrected after verification. */
  reviewed?: boolean
  corrected?: boolean
}
export interface HomeSummary {
  /** The patients this person took and finished today (0065). */
  seenToday?: number
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

export function useHomeSummary(period?: DayRange | null) {
  return useQuery({
    queryKey: [...KEY, period?.from, period?.to],
    refetchInterval: 20_000,
    queryFn: async (): Promise<HomeSummary> => {
      if (!supabase) return sampleSummary()
      const { data, error } = await supabase.rpc(
        'home_summary',
        period ? { p_from: period.from, p_to: period.to } : undefined,
      )
      if (error) throw apiError(error)
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

/** A booking request waiting for reception, with the patient file its phone matches. */
export interface OpenInquiry {
  id: string
  name: string
  phone: string | null
  reference: string | null
  category: string | null
  channel: string | null
  note: string | null
  doctor: string | null
  doctorUserId: string | null
  startsAt: string | null
  preferredAt: string | null
  createdAt: string
  insurer: string | null
  patientId: string | null
  patientFile: string | null
  patientName: string | null
  matches: number
}
const SAMPLE_OPEN: OpenInquiry[] = INQUIRIES.map((q, i) => ({
  id: `inq-${i}`,
  name: q.name,
  phone: '0788000000',
  reference: `MMC-2026-00${10 + i}`,
  category: null,
  channel: 'whatsapp',
  note: q.detail,
  doctor: null,
  doctorUserId: null,
  startsAt: null,
  preferredAt: new Date(Date.now() + (i + 1) * 86_400_000).toISOString(),
  createdAt: new Date().toISOString(),
  insurer: null,
  patientId: i === 0 ? 'p-1' : null,
  patientFile: i === 0 ? 'MMC-000124' : null,
  patientName: i === 0 ? 'Mukamana Alice' : null,
  matches: i === 0 ? 1 : 0,
}))

export function useOpenInquiries() {
  return useQuery({
    queryKey: [...KEY, 'inquiries'],
    refetchInterval: 30_000,
    queryFn: async (): Promise<OpenInquiry[]> => {
      if (!supabase) return SAMPLE_OPEN
      const { data, error } = await supabase.rpc('inquiries_open')
      if (error) throw apiError(error)
      return ((data ?? []) as Omit<OpenInquiry, 'matches'>[] & { matches?: number }[]).map((r) => ({
        ...r,
        matches: Number((r as { matches?: number }).matches ?? 0),
      })) as OpenInquiry[]
    },
  })
}

/** Everyone reception can book: doctors, sonographers, nurses, managers (their calendar is
 *  created when first booked). */
export interface BookableDoctor {
  userId: string
  name: string
  role: string
  staffId: string | null
  hasHours: boolean
  slotMinutes: number
  title: string | null
}
export function useBookableDoctors() {
  return useQuery({
    queryKey: [...KEY, 'doctors'],
    staleTime: 60_000,
    queryFn: async (): Promise<BookableDoctor[]> => {
      if (!supabase)
        return STAFF.filter((s) => s.role === 'doctor').map((s) => ({
          userId: s.id,
          name: s.name,
          role: s.role,
          staffId: s.staffId ?? null,
          hasHours: true,
          slotMinutes: 30,
          title: null,
        }))
      const { data, error } = await supabase.rpc('bookable_doctors')
      if (error) throw apiError(error)
      return (data ?? []) as BookableDoctor[]
    },
  })
}

export function useHomeActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEY })
    void qc.invalidateQueries({ queryKey: ['public'] })
    // a booking made or answered: the day's list and the desk counters follow
    void qc.invalidateQueries({ queryKey: ['appointments'] })
    void qc.invalidateQueries({ queryKey: ['desk'] })
    void qc.invalidateQueries({ queryKey: ['inquiries'] })
  }
  const call = async (fn: string, args: Record<string, unknown>) => {
    if (!supabase) return
    const { error } = await supabase.rpc(fn, args)
    if (error) throw apiError(error)
  }
  const approveInquiry = useMutation({
    mutationFn: ({
      id,
      patientId,
      doctorUserId,
      startsAt,
    }: {
      id: string
      patientId?: string
      /** Reception books the request with this doctor at this time (website requests). */
      doctorUserId?: string
      startsAt?: string
    }) =>
      call('approve_inquiry_auto', {
        p_appointment_id: id,
        p_patient_id: patientId ?? null,
        p_practitioner_user: doctorUserId ?? null,
        p_starts_at: startsAt ?? null,
      }),
    onSuccess: refresh,
  })
  // Reception books a phone caller or a patient at the desk (migration 0059).
  const bookAppointment = useMutation({
    mutationFn: (i: {
      patientId: string
      doctorUserId: string
      startsAt: string
      reason?: string
      source: 'reception' | 'phone'
    }) =>
      call('book_appointment', {
        p_patient_id: i.patientId,
        p_practitioner_user: i.doctorUserId,
        p_starts_at: i.startsAt,
        p_reason: i.reason?.trim() || null,
        p_source: i.source,
      }),
    onSuccess: refresh,
  })
  const rejectInquiry = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      call('reject_inquiry', { p_appointment_id: id, p_reason: reason }),
    onSuccess: refresh,
  })
  /** The doctor has seen this result: it leaves "Results to review". */
  const markReviewed = useMutation({
    mutationFn: (id: string) => call('mark_result_reviewed', { p_report_id: id }),
    onSuccess: refresh,
  })
  const acceptAppointment = useMutation({
    // the doctor may move the time to arrange the day (startsAt), or keep reception's
    mutationFn: ({ id, startsAt }: { id: string; startsAt?: string | null }) =>
      call('accept_appointment', { p_appointment_id: id, p_starts_at: startsAt ?? null }),
    onSuccess: refresh,
  })
  const declineAppointment = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      call('decline_appointment', { p_appointment_id: id, p_reason: reason }),
    onSuccess: refresh,
  })
  // complete_task checks who may (the nursing desk, the person named, the giver) and tells the
  // giver; the task table is not written directly (0085)
  const completeTask = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      if (!supabase) return
      const { error } = await supabase.rpc('complete_task', { p_task_id: id })
      throwIf(error)
    },
    onSuccess: refresh,
  })
  return {
    markReviewed,
    approveInquiry,
    bookAppointment,
    rejectInquiry,
    acceptAppointment,
    declineAppointment,
    completeTask,
  }
}

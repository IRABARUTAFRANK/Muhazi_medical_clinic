import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isoDate } from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import { apiError } from './errors'
import { withLeftUnseen } from './booking-status'

/**
 * Operations that link reception, triage and the doctor: the day's appointments (arrival opens
 * a visit at triage), tasks the doctor leaves the nurse, and the short-stay bed board.
 * Sample mode keeps small in-memory lists so every button can be tried without a database.
 */

export interface DayAppointment {
  id: string
  time: string
  startsAt: string
  status:
    | 'approved'
    | 'confirmed'
    | 'arrived'
    | 'in_progress'
    | 'completed'
    | 'no_show'
    | 'cancelled'
    | 'declined'
    | 'left_unseen'
  /** Why it was cancelled (0101: "left_unseen…" becomes the status left_unseen). */
  cancelReason?: string | null
  patientId: string | null
  fileNumber: string | null
  name: string
  phone: string | null
  doctor: string | null
  reason: string | null
  reference?: string | null
  source?: string | null
  channel?: string | null
  late: boolean
  doctorUserId?: string | null
  /** The doctor's reason when they declined the booking. */
  declineReason?: string | null
  /** A declined booking already booked again. */
  rebooked?: boolean
  /** The visit opened by the arrival (0065). */
  encounterId?: string | null
  /**
   * 0108: what the booked patient's file still needs (files.missing keys, extra:<key> for the
   * clinic's own fields); null or absent when there is no file yet.
   */
  missing?: string[] | null
}

/** One booking in full (appointment_detail). */
export interface AppointmentDetail {
  id: string
  status: string
  source: string | null
  reference: string | null
  startsAt: string | null
  endsAt: string | null
  preferredAt: string | null
  createdAt: string
  reason: string | null
  cancelReason: string | null
  category: string | null
  insurer: string | null
  channel: string | null
  contactName: string | null
  contactPhone: string | null
  patientId: string | null
  patientFile: string | null
  patientName: string | null
  patientPhone: string | null
  doctor: string | null
  doctorUserId: string | null
  approvedBy: string | null
  approvedAt: string | null
  acceptedBy: string | null
  acceptedAt: string | null
  encounterId: string | null
  late: boolean
}
export function useAppointmentDetail(id: string | null) {
  return useQuery({
    queryKey: ['appointments', 'detail', id],
    enabled: !!id,
    queryFn: async (): Promise<AppointmentDetail | null> => {
      if (!supabase) {
        const a = sampleAppts.find((x) => x.id === id)
        if (!a) return null
        return {
          id: a.id,
          status: a.status,
          source: 'online',
          reference: 'MMC-2026-0007',
          startsAt: a.startsAt,
          endsAt: null,
          preferredAt: null,
          createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          reason: a.reason,
          cancelReason: null,
          category: null,
          insurer: null,
          channel: 'whatsapp',
          contactName: a.name,
          contactPhone: a.phone,
          patientId: a.patientId,
          patientFile: a.fileNumber,
          patientName: a.name,
          patientPhone: a.phone,
          doctor: a.doctor,
          doctorUserId: null,
          approvedBy: 'Uwimana Josiane',
          approvedAt: new Date(Date.now() - 86_400_000).toISOString(),
          acceptedBy: a.status === 'approved' ? null : a.doctor,
          acceptedAt:
            a.status === 'approved' ? null : new Date(Date.now() - 80_000_000).toISOString(),
          encounterId: a.status === 'arrived' || a.status === 'in_progress' ? 'e-1' : null,
          late: a.late,
        }
      }
      const { data, error } = await supabase.rpc('appointment_detail', { p_id: id })
      if (error) throw apiError(error)
      const d = (data ?? null) as AppointmentDetail | null
      return d ? withLeftUnseen(d) : null
    },
  })
}
export interface BoardBed {
  id: string
  name: string
  state: 'free' | 'occupied' | 'cleaning' | 'out_of_service'
  /** Price of one night in this bed (RWF), set by the manager. */
  nightlyPrice: number
  encounterId: string | null
  patient: string | null
  since: string | null
  /** Nights planned (and billed) for the current stay, and when they end. */
  nights: number | null
  until: string | null
}
export interface OpenTask {
  id: string
  title: string
  detail: string | null
  dueAt: string | null
  overdue: boolean
  encounterId: string | null
  patient: string | null
  by: string | null
  /** I gave this task (visit_tasks, 0063). */
  mine?: boolean
}

// the local calendar day (toISOString is UTC: between midnight and 02:00 it gave yesterday)
const iso = (d: Date) => isoDate(d)
const at = (h: number, m = 0) => {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}
const sampleAppts: DayAppointment[] = [
  {
    id: 'ap-1',
    time: '08:30',
    startsAt: at(8, 30),
    status: 'arrived',
    patientId: 'p-1',
    fileNumber: 'MMC-000124',
    name: 'Mukamana Alice',
    phone: '0788123456',
    doctor: 'Dr. Mukamana Béatrice',
    reason: 'Follow-up',
    late: false,
  },
  {
    id: 'ap-2',
    time: '10:00',
    startsAt: at(10),
    status: 'confirmed',
    patientId: 'p-2',
    fileNumber: 'MMC-000131',
    name: 'Habimana Eric',
    phone: '0722987654',
    doctor: 'Dr. Ndayisaba Félix',
    reason: 'Tooth pain',
    late: true,
    missing: ['national_id', 'extra:church'],
  },
  {
    // a website request booked with the name and phone only: the file is made on arrival
    id: 'ap-4',
    time: '11:30',
    startsAt: at(11, 30),
    status: 'confirmed',
    patientId: null,
    fileNumber: null,
    name: 'Ingabire Diane',
    phone: '0788555444',
    doctor: 'Dr. Mukamana Béatrice',
    reason: 'Fever and headache',
    source: 'online',
    late: false,
    missing: null,
  },
  {
    id: 'ap-3',
    time: '14:30',
    startsAt: at(14, 30),
    status: 'approved',
    patientId: 'p-3',
    fileNumber: 'MMC-000140',
    name: 'Niyonzima Jean Bosco',
    phone: '0733111222',
    doctor: 'Dr. Mukamana Béatrice',
    reason: null,
    late: false,
  },
]
const sampleBeds: BoardBed[] = Array.from({ length: 6 }, (_, i) => ({
  id: `b-${i + 1}`,
  name: `Bed ${i + 1}`,
  state: i === 0 || i === 3 ? 'occupied' : i === 4 ? 'cleaning' : 'free',
  encounterId: i === 0 || i === 3 ? `e-${i}` : null,
  patient: i === 0 ? 'Uwase Claudine' : i === 3 ? 'Mugisha Kevin' : null,
  since: i === 0 || i === 3 ? at(9, 15) : null,
  nightlyPrice: 15000,
  nights: i === 0 ? 1 : i === 3 ? 2 : null,
  until:
    i === 0 || i === 3 ? new Date(Date.now() + (i === 0 ? 1 : 2) * 86_400_000).toISOString() : null,
}))
const sampleTasks: OpenTask[] = [
  {
    id: 't-1',
    title: 'Injection: ceftriaxone 1 g IM',
    detail: null,
    dueAt: at(new Date().getHours() - 1, 0),
    overdue: true,
    encounterId: 'e-1',
    patient: 'Uwase Claudine',
    by: 'Dr. Mukamana Béatrice',
  },
  {
    id: 't-2',
    title: 'Repeat vitals',
    detail: 'Temperature and pulse',
    dueAt: at(new Date().getHours() + 1, 0),
    overdue: false,
    encounterId: 'e-3',
    patient: 'Mugisha Kevin',
    by: 'Dr. Mukamana Béatrice',
  },
]

export function useAppointmentsDay(day: Date) {
  return useQuery({
    queryKey: ['appointments', iso(day)],
    refetchInterval: 30_000,
    queryFn: async (): Promise<DayAppointment[]> => {
      if (!supabase) return iso(day) === iso(new Date()) ? sampleAppts : []
      const { data, error } = await supabase.rpc('appointments_day', { p_day: iso(day) })
      if (error) throw apiError(error)
      return ((data as DayAppointment[]) ?? []).map(withLeftUnseen)
    },
  })
}

export function useBedBoard() {
  return useQuery({
    queryKey: ['beds'],
    refetchInterval: 30_000,
    queryFn: async (): Promise<BoardBed[]> => {
      if (!supabase) return sampleBeds
      const { data, error } = await supabase.rpc('bed_board')
      if (error) throw apiError(error)
      return (data as BoardBed[]) ?? []
    },
  })
}

export function useOpenTasks() {
  return useQuery({
    queryKey: ['tasks'],
    refetchInterval: 30_000,
    queryFn: async (): Promise<OpenTask[]> => {
      if (!supabase) return sampleTasks
      const { data, error } = await supabase.rpc('open_tasks')
      if (error) throw apiError(error)
      return (data as OpenTask[]) ?? []
    },
  })
}

/** The open tasks of one visit, whoever they are for (the doctor's card; migration 0060). */
export function useVisitTasks(encounterId: string) {
  return useQuery({
    queryKey: ['tasks', 'visit', encounterId],
    refetchInterval: 30_000,
    queryFn: async (): Promise<OpenTask[]> => {
      if (!supabase) return sampleTasks.filter((x) => x.encounterId === encounterId)
      const { data, error } = await supabase.rpc('visit_tasks', { p_encounter_id: encounterId })
      if (!error) return (data as OpenTask[]) ?? []
      // a database without migration 0060: the tasks of my role only
      const r = await supabase.rpc('open_tasks')
      if (r.error) throw apiError(error)
      return ((r.data as OpenTask[]) ?? []).filter((x) => x.encounterId === encounterId)
    },
  })
}

export type MissingKey = 'phone' | 'national_id' | 'address' | 'age'
export interface FileToComplete {
  patientId: string
  fileNumber: string
  name: string
  missing: MissingKey[]
  registeredBy: string | null
  registeredAt: string
  encounterId: string | null
  ticket: string | null
  station: string | null
}
const sampleFiles: FileToComplete[] = [
  {
    patientId: 'p-1',
    fileNumber: 'MMC-000141',
    name: 'Uwase Claudine',
    missing: ['phone', 'national_id', 'address'],
    registeredBy: 'Nyirahabimana Chantal',
    registeredAt: at(9, 5),
    encounterId: 'e-1',
    ticket: 'A-019',
    station: 'reception',
  },
  {
    patientId: 'p-2',
    fileNumber: 'MMC-000142',
    name: 'Mugisha Kevin',
    missing: ['national_id'],
    registeredBy: 'Nyirahabimana Chantal',
    registeredAt: at(9, 40),
    encounterId: 'e-3',
    ticket: 'A-020',
    station: 'triage',
  },
]

/** Files the nurse started (name, sex, age) that reception must complete. */
export function useFilesToComplete() {
  return useQuery({
    queryKey: ['files-to-complete'],
    refetchInterval: 30_000,
    queryFn: async (): Promise<FileToComplete[]> => {
      if (!supabase) return sampleFiles
      const { data, error } = await supabase.rpc('files_to_complete')
      if (error) throw apiError(error)
      return (data as FileToComplete[]) ?? []
    },
  })
}

export function useDeskOps() {
  const qc = useQueryClient()
  const refresh = () => {
    for (const k of [
      'appointments',
      'beds',
      'tasks',
      'queue',
      'desk',
      'home',
      'visit',
      'patients',
      'files-to-complete',
    ])
      void qc.invalidateQueries({ queryKey: [k] })
  }
  const call = async <T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await supabase!.rpc(fn, args)
    if (error) throw apiError(error)
    return data as T
  }

  /**
   * The booked patient is here: a visit opens. A booking without a file (0108) names the file
   * found for it (patientId) or brings the registration form (registration, by column name): the
   * file is made with the arrival, or not at all.
   */
  const arrived = useMutation({
    mutationFn: async (i: {
      id: string
      patientId?: string
      registration?: Record<string, unknown>
    }): Promise<{
      encounterId: string
      existing: boolean
      fileNumber: string | null
      newFile: boolean
    }> => {
      if (!supabase) {
        const a = sampleAppts.find((x) => x.id === i.id)
        if (a) {
          a.status = 'arrived'
          if (!a.patientId) {
            a.patientId = i.patientId ?? 'p-1'
            a.fileNumber = i.patientId ? a.fileNumber : 'MMC-000143'
            a.missing = []
          }
        }
        return {
          encounterId: 'e-1',
          existing: false,
          fileNumber: a?.fileNumber ?? null,
          newFile: !!i.registration,
        }
      }
      const v = await call<{
        encounter_id: string
        existing?: boolean
        file_number?: string | null
        new_file?: boolean
      }>(
        'appointment_arrived',
        // only what is needed: a linked booking arrives the same way on a database before 0108
        i.patientId || i.registration
          ? {
              p_appointment_id: i.id,
              p_patient_id: i.patientId ?? null,
              p_registration: i.registration ?? null,
            }
          : { p_appointment_id: i.id },
      )
      return {
        encounterId: v.encounter_id,
        existing: !!v.existing,
        fileNumber: v.file_number ?? null,
        newFile: !!v.new_file,
      }
    },
    onSuccess: refresh,
  })
  /**
   * A website request booked with the name and phone the person gave (0108): no file yet, it is
   * made when the patient arrives.
   */
  const bookWithoutFile = useMutation({
    mutationFn: async (i: { id: string; doctorUserId: string; startsAt: string }) => {
      if (!supabase) return
      await call('approve_inquiry_auto', {
        p_appointment_id: i.id,
        p_patient_id: null,
        p_practitioner_user: i.doctorUserId,
        p_starts_at: i.startsAt,
        p_without_file: true,
      })
    },
    onSuccess: () => {
      refresh()
      void qc.invalidateQueries({ queryKey: ['inquiries'] })
      void qc.invalidateQueries({ queryKey: ['public'] })
    },
  })
  const outcome = useMutation({
    mutationFn: async (i: { id: string; status: 'no_show' | 'cancelled'; reason?: string }) => {
      if (!supabase) {
        const a = sampleAppts.find((x) => x.id === i.id)
        if (a) a.status = i.status
        return
      }
      await call('set_appointment_outcome', {
        p_appointment_id: i.id,
        p_status: i.status,
        p_reason: i.reason ?? null,
      })
    },
    onSuccess: refresh,
  })
  const createTask = useMutation({
    mutationFn: async (i: {
      encounterId: string
      title: string
      dueAt?: string | null
      detail?: string
    }) => {
      if (!supabase) {
        sampleTasks.push({
          id: `t-${Date.now()}`,
          title: i.title,
          detail: i.detail ?? null,
          dueAt: i.dueAt ?? null,
          overdue: false,
          encounterId: i.encounterId,
          patient: null,
          by: null,
        })
        return
      }
      await call('create_task', {
        p_encounter_id: i.encounterId,
        p_title: i.title,
        p_due_at: i.dueAt ?? null,
        p_detail: i.detail?.trim() || null,
      })
    },
    onSuccess: refresh,
  })
  const completeTask = useMutation({
    mutationFn: async (id: string) => {
      if (!supabase) {
        const i = sampleTasks.findIndex((x) => x.id === id)
        if (i >= 0) sampleTasks.splice(i, 1)
        return
      }
      await call('complete_task', { p_task_id: id })
    },
    onSuccess: refresh,
  })
  /** The giver withdraws a task, or the nurse says it could not be done (with the reason). */
  const cancelTask = useMutation({
    mutationFn: async (i: { id: string; reason: string }) => {
      if (!supabase) {
        const k = sampleTasks.findIndex((x) => x.id === i.id)
        if (k >= 0) sampleTasks.splice(k, 1)
        return
      }
      await call('cancel_task', { p_task_id: i.id, p_reason: i.reason })
    },
    onSuccess: refresh,
  })
  const admit = useMutation({
    mutationFn: async (i: {
      bedId: string
      encounterId: string
      patient: string
      nights: number
      /** Price agreed for the whole period; null = nights × the bed's price. */
      periodPrice: number | null
    }) => {
      if (!supabase) {
        const b = sampleBeds.find((x) => x.id === i.bedId)
        if (b)
          Object.assign(b, {
            state: 'occupied',
            encounterId: i.encounterId,
            patient: i.patient,
            since: new Date().toISOString(),
            nights: i.nights,
            until: new Date(Date.now() + i.nights * 86_400_000).toISOString(),
          })
        return
      }
      await call('admit_to_bed', {
        p_encounter_id: i.encounterId,
        p_bed_id: i.bedId,
        p_nights: i.nights,
        p_period_price: i.periodPrice,
      })
    },
    onSuccess: refresh,
  })
  const extend = useMutation({
    mutationFn: async (i: { bedId: string; nights: number; periodPrice: number | null }) => {
      if (!supabase) {
        const b = sampleBeds.find((x) => x.id === i.bedId)
        if (b) {
          b.nights = (b.nights ?? 0) + i.nights
          b.until = new Date(
            new Date(b.until ?? Date.now()).getTime() + i.nights * 86_400_000,
          ).toISOString()
        }
        return
      }
      await call('extend_bed_stay', {
        p_bed_id: i.bedId,
        p_nights: i.nights,
        p_period_price: i.periodPrice,
      })
    },
    onSuccess: refresh,
  })
  const discharge = useMutation({
    mutationFn: async (bedId: string) => {
      if (!supabase) {
        const b = sampleBeds.find((x) => x.id === bedId)
        if (b)
          Object.assign(b, {
            state: 'cleaning',
            encounterId: null,
            patient: null,
            since: null,
            nights: null,
            until: null,
          })
        return
      }
      await call('discharge_bed', { p_bed_id: bedId })
    },
    onSuccess: refresh,
  })
  const ready = useMutation({
    mutationFn: async (bedId: string) => {
      if (!supabase) {
        const b = sampleBeds.find((x) => x.id === bedId)
        if (b) b.state = 'free'
        return
      }
      await call('bed_ready', { p_bed_id: bedId })
    },
    onSuccess: refresh,
  })
  /** Reception is done with the patient (file completed): send them on, usually to the doctor. */
  const sendOn = useMutation({
    mutationFn: async (i: { encounterId: string; from: string; to: string }) => {
      if (!supabase) {
        const f = sampleFiles.find((x) => x.encounterId === i.encounterId)
        if (f) f.station = i.to
        return
      }
      await call('finish_station', {
        p_encounter_id: i.encounterId,
        p_station: i.from,
        p_next: i.to,
      })
    },
    onSuccess: refresh,
  })
  return {
    arrived,
    bookWithoutFile,
    outcome,
    createTask,
    completeTask,
    cancelTask,
    admit,
    extend,
    discharge,
    ready,
    sendOn,
  }
}

/**
 * Manager: how many beds the clinic has and what a night costs (migration 0028). Sample mode
 * changes the in-memory board.
 */
export function useBedAdmin() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['beds'] })
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { error } = await supabase!.rpc(fn, args)
    if (error) throw apiError(error)
  }
  const setCount = useMutation({
    mutationFn: async (i: { count: number; nightlyPrice: number | null }) => {
      if (!supabase) {
        while (sampleBeds.length > i.count) sampleBeds.pop()
        while (sampleBeds.length < i.count) {
          const n = sampleBeds.length + 1
          sampleBeds.push({
            id: `b-${n}-${Date.now()}`,
            name: `Bed ${n}`,
            state: 'free',
            nightlyPrice: i.nightlyPrice ?? 0,
            encounterId: null,
            patient: null,
            since: null,
            nights: null,
            until: null,
          })
        }
        if (i.nightlyPrice != null) sampleBeds.forEach((b) => (b.nightlyPrice = i.nightlyPrice!))
        return
      }
      await rpc('set_bed_count', { p_count: i.count, p_nightly_price: i.nightlyPrice })
    },
    onSuccess: refresh,
  })
  const save = useMutation({
    mutationFn: async (i: { id: string; name: string; nightlyPrice: number }) => {
      if (!supabase) {
        const b = sampleBeds.find((x) => x.id === i.id)
        if (b) Object.assign(b, { name: i.name, nightlyPrice: i.nightlyPrice })
        return
      }
      await rpc('save_bed', { p_id: i.id, p_name: i.name, p_nightly_price: i.nightlyPrice })
    },
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: async (id: string) => {
      if (!supabase) {
        const k = sampleBeds.findIndex((x) => x.id === id)
        if (k >= 0) sampleBeds.splice(k, 1)
        return
      }
      await rpc('remove_bed', { p_id: id })
    },
    onSuccess: refresh,
  })
  return { setCount, save, remove }
}

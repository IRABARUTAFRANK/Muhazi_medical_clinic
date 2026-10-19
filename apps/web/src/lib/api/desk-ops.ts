import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

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
    'approved' | 'confirmed' | 'arrived' | 'in_progress' | 'completed' | 'no_show' | 'cancelled'
  patientId: string | null
  fileNumber: string | null
  name: string
  phone: string | null
  doctor: string | null
  reason: string | null
  late: boolean
}
export interface BoardBed {
  id: string
  name: string
  state: 'free' | 'occupied' | 'cleaning' | 'out_of_service'
  encounterId: string | null
  patient: string | null
  since: string | null
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
}

const iso = (d: Date) => d.toISOString().slice(0, 10)
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
      if (error) throw new Error(error.message)
      return (data as DayAppointment[]) ?? []
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
      if (error) throw new Error(error.message)
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
      if (error) throw new Error(error.message)
      return (data as OpenTask[]) ?? []
    },
  })
}

export function useDeskOps() {
  const qc = useQueryClient()
  const refresh = () => {
    for (const k of ['appointments', 'beds', 'tasks', 'queue', 'desk', 'home', 'visit', 'patients'])
      void qc.invalidateQueries({ queryKey: [k] })
  }
  const call = async <T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await supabase!.rpc(fn, args)
    if (error) throw new Error(error.message)
    return data as T
  }

  const arrived = useMutation({
    mutationFn: async (id: string): Promise<{ encounterId: string; existing: boolean }> => {
      if (!supabase) {
        const a = sampleAppts.find((x) => x.id === id)
        if (a) a.status = 'arrived'
        return { encounterId: 'e-1', existing: false }
      }
      const v = await call<{ encounter_id: string; existing?: boolean }>('appointment_arrived', {
        p_appointment_id: id,
      })
      return { encounterId: v.encounter_id, existing: !!v.existing }
    },
    onSuccess: refresh,
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
  const admit = useMutation({
    mutationFn: async (i: { bedId: string; encounterId: string; patient: string }) => {
      if (!supabase) {
        const b = sampleBeds.find((x) => x.id === i.bedId)
        if (b)
          Object.assign(b, {
            state: 'occupied',
            encounterId: i.encounterId,
            patient: i.patient,
            since: new Date().toISOString(),
          })
        return
      }
      await call('admit_to_bed', { p_encounter_id: i.encounterId, p_bed_id: i.bedId })
    },
    onSuccess: refresh,
  })
  const discharge = useMutation({
    mutationFn: async (bedId: string) => {
      if (!supabase) {
        const b = sampleBeds.find((x) => x.id === bedId)
        if (b)
          Object.assign(b, { state: 'cleaning', encounterId: null, patient: null, since: null })
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
  return { arrived, outcome, createTask, completeTask, admit, discharge, ready }
}

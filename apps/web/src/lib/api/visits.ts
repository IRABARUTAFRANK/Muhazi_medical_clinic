import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ROLE_HOME, type QueueRow, type Role, type StaffUser, type Triage } from '@mmc/shared'
import { supabase } from '@/lib/supabase'

/**
 * Patient journey (MoH workflow): registration at any station → triage (vitals + colour) →
 * the treating station. Emergencies are registered straight at the treating station.
 * Live: database functions `find_patients`, `register_patient`, `start_visit`, `record_vitals`
 * and the `queue_board` view. Sample: in-memory stand-ins so the screens work without a backend.
 */

/** `station` enum of the database. */
export const STATIONS = [
  'reception',
  'triage',
  'consultation',
  'dental',
  'laboratory',
  'ultrasound',
  'theatre',
  'nursing',
  'pharmacy',
  'cashier',
  'beds',
] as const
export type Station = (typeof STATIONS)[number]
/** Stations a patient can be sent to from triage, or registered at in an emergency. */
export const TREATING_STATIONS: readonly Station[] = [
  'consultation',
  'dental',
  'laboratory',
  'ultrasound',
  'nursing',
  'theatre',
  'pharmacy',
]

/**
 * Where the nurse can send a patient after the first measurements: reception first when the
 * file still lacks details only reception can take (phone, national ID, address).
 */
export const SEND_FROM_TRIAGE: readonly Station[] = ['reception', ...TREATING_STATIONS]

export type Sex = 'female' | 'male' | 'other' | 'unknown'

/** Where this staff member works, for the emergency path and for "my queue". */
export function stationFor(user: StaffUser): Station {
  const s = (user.station ?? '').toLowerCase()
  if (s.includes('dent')) return 'dental'
  if (s.includes('lab')) return 'laboratory'
  if (s.includes('ultra') || s.includes('echo')) return 'ultrasound'
  if (s.includes('pharm')) return 'pharmacy'
  if (s.includes('theat') || s.includes('surg')) return 'theatre'
  if (s.includes('triage')) return 'triage'
  if (s.includes('nurs')) return 'nursing'
  switch (user.role) {
    case 'nurse':
      return 'triage'
    case 'doctor':
      return 'consultation'
    case 'cashier':
      return 'cashier'
    case 'pharmacist':
      return 'pharmacy'
    case 'lab_tech':
      return 'laboratory'
    default:
      return 'consultation'
  }
}

// ---------------------------------------------------------------- patient search
export interface PatientHit {
  id: string
  fileNumber: string
  surname: string
  givenNames: string
  sex: Sex
  birthDate: string | null
  phone: string | null
  hasOpenVisit: boolean
}

interface FindRow {
  id: string
  file_number: string
  surname: string
  given_names: string
  sex: Sex
  birth_date: string | null
  phone_1: string | null
  has_open_visit: boolean
}

const samplePatients: PatientHit[] = [
  {
    id: 'p-1',
    fileNumber: 'MMC-000124',
    surname: 'Mukamana',
    givenNames: 'Alice',
    sex: 'female',
    birthDate: '1995-03-12',
    phone: '0788123456',
    hasOpenVisit: false,
  },
  {
    id: 'p-2',
    fileNumber: 'MMC-000131',
    surname: 'Habimana',
    givenNames: 'Eric',
    sex: 'male',
    birthDate: '2018-07-01',
    phone: '0722987654',
    hasOpenVisit: true,
  },
]

export function useFindPatients(query: string) {
  const q = query.trim()
  return useQuery({
    queryKey: ['patients', 'find', q],
    enabled: q.length >= 2,
    queryFn: async (): Promise<PatientHit[]> => {
      if (!supabase) {
        const needle = q.toLowerCase()
        return samplePatients.filter((p) =>
          `${p.surname} ${p.givenNames} ${p.fileNumber} ${p.phone ?? ''}`
            .toLowerCase()
            .includes(needle),
        )
      }
      const { data, error } = await supabase.rpc('find_patients', { p_query: q, p_limit: 10 })
      if (error) throw new Error(error.message)
      return (data as FindRow[]).map((r) => ({
        id: r.id,
        fileNumber: r.file_number,
        surname: r.surname,
        givenNames: r.given_names,
        sex: r.sex,
        birthDate: r.birth_date,
        phone: r.phone_1,
        hasOpenVisit: r.has_open_visit,
      }))
    },
  })
}

// ---------------------------------------------------------------- registration
export interface NewPatient {
  surname: string
  givenNames: string
  sex: Sex
  birthDate?: string
  ageYears?: number
  phone?: string
  nationalId?: string
  sector?: string
}
export interface VisitOptions {
  emergency: boolean
  /** Station of the registering staff member; used only when `emergency` is true. */
  station: Station
}
export interface VisitResult {
  patientId: string
  fileNumber: string
  encounterId: string
  ticketNo: string
  station: Station
}

interface VisitJson {
  patient_id?: string
  file_number?: string
  encounter_id: string
  ticket_no: string
  station: Station
}

let sampleTicket = 19
const sampleVisit = (patientId: string, fileNumber: string, o: VisitOptions): VisitResult => {
  sampleTicket += 1
  return {
    patientId,
    fileNumber,
    encounterId: `e-${sampleTicket}`,
    ticketNo: `A-${String(sampleTicket).padStart(3, '0')}`,
    station: o.emergency ? o.station : 'triage',
  }
}

export function useVisitActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['queue'] })
    void qc.invalidateQueries({ queryKey: ['patients'] })
    void qc.invalidateQueries({ queryKey: ['visit'] })
    void qc.invalidateQueries({ queryKey: ['desk'] })
  }

  const register = useMutation({
    mutationFn: async ({ patient, visit }: { patient: NewPatient; visit: VisitOptions }) => {
      if (!supabase) {
        const id = `p-${Math.random().toString(36).slice(2, 8)}`
        const file = `MMC-${String(140 + samplePatients.length).padStart(6, '0')}`
        samplePatients.push({
          id,
          fileNumber: file,
          surname: patient.surname,
          givenNames: patient.givenNames,
          sex: patient.sex,
          birthDate: patient.birthDate ?? null,
          phone: patient.phone ?? null,
          hasOpenVisit: true,
        })
        return sampleVisit(id, file, visit)
      }
      const { data, error } = await supabase.rpc('register_patient', {
        p_surname: patient.surname.trim(),
        p_given_names: patient.givenNames.trim(),
        p_sex: patient.sex,
        p_birth_date: patient.birthDate || null,
        p_age_years: patient.ageYears ?? null,
        p_phone: patient.phone?.trim() || null,
        p_national_id: patient.nationalId?.trim() || null,
        p_sector: patient.sector?.trim() || null,
        p_emergency: visit.emergency,
        p_station: visit.station,
      })
      if (error) throw new Error(error.message)
      const v = data as VisitJson
      return {
        patientId: v.patient_id!,
        fileNumber: v.file_number!,
        encounterId: v.encounter_id,
        ticketNo: v.ticket_no,
        station: v.station,
      } satisfies VisitResult
    },
    onSuccess: refresh,
  })

  const startVisit = useMutation({
    mutationFn: async ({ patient, visit }: { patient: PatientHit; visit: VisitOptions }) => {
      if (!supabase) {
        patient.hasOpenVisit = true
        return sampleVisit(patient.id, patient.fileNumber, visit)
      }
      const { data, error } = await supabase.rpc('start_visit', {
        p_patient_id: patient.id,
        p_emergency: visit.emergency,
        p_station: visit.station,
      })
      if (error) throw new Error(error.message)
      const v = data as VisitJson
      return {
        patientId: patient.id,
        fileNumber: patient.fileNumber,
        encounterId: v.encounter_id,
        ticketNo: v.ticket_no,
        station: v.station,
      } satisfies VisitResult
    },
    onSuccess: refresh,
  })

  const recordVitals = useMutation({
    mutationFn: async ({
      encounterId,
      vitals,
      triage,
      nextStation,
      reason,
      measuredBy,
      measuredAt,
    }: {
      encounterId: string
      vitals: Record<string, string>
      /** Omitted when vitals are added later (the patient stays where they are). */
      triage?: Triage | null
      nextStation?: Station | null
      reason?: string
      /** Who measured (the nurse); omitted = the person typing. */
      measuredBy?: string | null
      /** When it was measured (from the paper sheet); omitted = now. */
      measuredAt?: string | null
    }): Promise<string> => {
      if (!supabase) {
        const row = sampleQueue.find((r) => r.encounterId === encounterId)
        if (row && nextStation) row.station = nextStation
        return row?.ticket ?? 'A-000'
      }
      const clean: Record<string, number> = {}
      for (const [k, v] of Object.entries(vitals)) {
        const n = Number(v)
        if (v.trim() !== '' && Number.isFinite(n)) clean[k] = n
      }
      const { data, error } = await supabase.rpc('record_vitals', {
        p_encounter_id: encounterId,
        p_vitals: clean,
        p_triage: triage ?? null,
        p_next_station: nextStation ?? null,
        p_reason: reason?.trim() || null,
        p_measured_by: measuredBy ?? null,
        p_measured_at: measuredAt ?? null,
      })
      if (error) throw new Error(error.message)
      return String(data)
    },
    onSuccess: refresh,
  })

  /** Triage when the vitals were already taken: colour and next station, nothing measured again. */
  const sendFromTriage = useMutation({
    mutationFn: async ({
      encounterId,
      triage,
      nextStation,
      reason,
    }: {
      encounterId: string
      triage: Triage
      nextStation: Station
      reason?: string
    }): Promise<string> => {
      if (!supabase) {
        const row = sampleQueue.find((r) => r.encounterId === encounterId)
        if (row) row.station = nextStation
        return row?.ticket ?? 'A-000'
      }
      const { data, error } = await supabase.rpc('send_from_triage', {
        p_encounter_id: encounterId,
        p_triage: triage,
        p_next_station: nextStation,
        p_reason: reason?.trim() || null,
      })
      if (error) throw new Error(error.message)
      return String(data)
    },
    onSuccess: refresh,
  })

  /** The patient has left: closes the visit and every queue entry (end_visit). With money
   *  still due only the manager may do it, with a reason. */
  const endVisit = useMutation({
    mutationFn: async ({ encounterId, reason }: { encounterId: string; reason?: string }) => {
      if (!supabase) return
      const { error } = await supabase.rpc('end_visit', {
        p_encounter_id: encounterId,
        p_reason: reason || null,
      })
      if (error) throw new Error(error.message)
    },
    onSuccess: refresh,
  })

  /** A patient file only, no visit (a booking for a later day; the visit starts on arrival). */
  const registerFile = useMutation({
    mutationFn: async (patient: NewPatient): Promise<{ patientId: string; fileNumber: string }> => {
      if (!supabase) {
        const id = `p-${Math.random().toString(36).slice(2, 8)}`
        const fileNumber = `MMC-${String(140 + samplePatients.length).padStart(6, '0')}`
        samplePatients.push({
          id,
          fileNumber,
          surname: patient.surname,
          givenNames: patient.givenNames,
          sex: patient.sex,
          birthDate: patient.birthDate ?? null,
          phone: patient.phone ?? null,
          hasOpenVisit: false,
        })
        return { patientId: id, fileNumber }
      }
      const { data, error } = await supabase.rpc('register_patient_file', {
        p_surname: patient.surname.trim(),
        p_given_names: patient.givenNames.trim(),
        p_sex: patient.sex,
        p_birth_date: patient.birthDate || null,
        p_age_years: patient.ageYears ?? null,
        p_phone: patient.phone?.trim() || null,
        p_national_id: patient.nationalId?.trim() || null,
        p_sector: patient.sector?.trim() || null,
      })
      if (error) throw new Error(error.message)
      const r = data as { patient_id: string; file_number: string }
      return { patientId: r.patient_id, fileNumber: r.file_number }
    },
    onSuccess: refresh,
  })

  return { register, registerFile, startVisit, recordVitals, sendFromTriage, endVisit }
}

// ---------------------------------------------------------------- who measures
export interface VitalsTaker {
  id: string
  name: string
  staffId: string | null
  role: string
}

/** Nurses first, then doctors and managers: the "Measured by" list on every vitals form. */
export function useVitalsTakers() {
  return useQuery({
    queryKey: ['staff', 'vitals-takers'],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<VitalsTaker[]> => {
      if (!supabase)
        return [
          { id: 'u-nur', name: 'Nyirahabimana Chantal', staffId: 'MMC-S-0002', role: 'nurse' },
          { id: 'u-doc', name: 'Dr. Mukamana Béatrice', staffId: 'MMC-S-0003', role: 'doctor' },
          { id: 'u-mgr', name: 'Mugabo Théogène', staffId: 'MMC-S-0007', role: 'manager' },
        ]
      const { data, error } = await supabase.rpc('vitals_takers')
      if (error) throw new Error(error.message)
      return (data as VitalsTaker[]) ?? []
    },
  })
}

// ---------------------------------------------------------------- queue board
export interface QueueItem extends QueueRow {
  queueId: string
  encounterId: string
  patientId: string
  fileNumber: string
  station: Station
  priority: number
  queuedAt: string
  startedAt: string | null
  finishedAt: string | null
  /** Set when the patient waits at several desks at once; the first doctor who takes them wins. */
  poolId: string | null
  /** Who took (started) the patient here, if anyone. */
  takenBy: string | null
  /** Referral: sent to this colleague by someone, with a reason (migration 0034). */
  assignedTo?: string | null
  assignedName?: string | null
  referredBy?: string | null
  referralNote?: string | null
  /** Vitals already measured for this visit: when and by whom (migration 0039). */
  vitalsAt?: string | null
  vitalsBy?: string | null
  /** Sent to a department: only its members work on the patient (migration 0055). */
  departmentName?: string | null
  /** False when the patient was sent to someone else: seen in the clinic, read only. */
  canWork?: boolean
}

interface BoardRow {
  queue_id: string
  encounter_id: string
  station: Station
  ticket_no: string
  priority: number
  queued_at: string
  called_at: string | null
  started_at: string | null
  finished_at: string | null
  patient_id: string
  triage_level: Triage | null
  file_number: string
  surname: string
  given_names: string
  sex: Sex
  birth_date: string | null
  pool_id?: string | null
  taken_by_name?: string | null
  assigned_to?: string | null
  assigned_name?: string | null
  referred_by_name?: string | null
  referral_note?: string | null
  vitals_at?: string | null
  vitals_by?: string | null
  department_name?: string | null
  can_work?: boolean | null
}

const sexLetter: Record<Sex, string> = { female: 'F', male: 'M', other: '', unknown: '' }
const ageOf = (birth: string | null): string => {
  if (!birth) return '—'
  const b = new Date(birth)
  const now = new Date()
  let years = now.getFullYear() - b.getFullYear()
  if (now < new Date(now.getFullYear(), b.getMonth(), b.getDate())) years -= 1
  if (years >= 2) return String(years)
  const months = (now.getFullYear() - b.getFullYear()) * 12 + now.getMonth() - b.getMonth()
  return `${Math.max(0, months)}m`
}
const minutesSince = (iso: string): number =>
  Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))

const toItem = (r: BoardRow): QueueItem => ({
  queueId: r.queue_id,
  encounterId: r.encounter_id,
  patientId: r.patient_id,
  fileNumber: r.file_number,
  station: r.station,
  priority: r.priority,
  queuedAt: r.queued_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  poolId: r.pool_id ?? null,
  takenBy: r.taken_by_name ?? null,
  assignedTo: r.assigned_to ?? null,
  assignedName: r.assigned_name ?? null,
  referredBy: r.referred_by_name ?? null,
  referralNote: r.referral_note ?? null,
  vitalsAt: r.vitals_at ?? null,
  vitalsBy: r.vitals_by ?? null,
  departmentName: r.department_name ?? null,
  canWork: r.can_work ?? true,
  ticket: r.ticket_no,
  name: `${r.surname} ${r.given_names}`,
  ageSex: `${ageOf(r.birth_date)} ${sexLetter[r.sex]}`.trim(),
  triage: r.triage_level ?? 'green',
  waitMin: minutesSince(r.queued_at),
  insurer: r.file_number,
})

/** Sample queue (shared by the home page and the triage screen when there is no backend). */
const sampleQueue: QueueItem[] = ROLE_HOME.nurse.queue.map((q, i) => ({
  ...q,
  insurer: `MMC-00012${i}`,
  queueId: `q-${i}`,
  encounterId: `e-${i}`,
  patientId: `p-${i}`,
  fileNumber: `MMC-00012${i}`,
  station: 'triage' as Station,
  priority: q.triage === 'red' ? 1 : q.triage === 'yellow' ? 2 : 3,
  queuedAt: new Date(Date.now() - q.waitMin * 60_000).toISOString(),
  startedAt: null,
  finishedAt: null,
  poolId: i === 1 ? 'pool-sample' : null,
  takenBy: null,
}))

/** Today's queue at one station (or everywhere for reception), refreshed every 15 s. */
export function useQueueBoard(station: Station | 'all', role: Role) {
  return useQuery({
    queryKey: ['queue', station],
    refetchInterval: 15_000,
    queryFn: async (): Promise<QueueItem[]> => {
      if (!supabase) {
        const roleKey = role === 'manager' ? 'receptionist' : role
        if (station === 'triage') return sampleQueue.filter((r) => r.station === 'triage')
        return ROLE_HOME[roleKey].queue.map((q, i) => ({
          ...q,
          insurer: `MMC-00013${i}`,
          queueId: `q-${station}-${i}`,
          encounterId: `e-${station}-${i}`,
          patientId: `p-${station}-${i}`,
          fileNumber: `MMC-00013${i}`,
          station: station === 'all' ? ('consultation' as Station) : station,
          poolId: i === 1 ? 'pool-sample' : null,
          takenBy: null,
          priority: 3,
          queuedAt: new Date(Date.now() - q.waitMin * 60_000).toISOString(),
          startedAt: null,
          finishedAt: null,
        }))
      }
      // Everyone still waiting or being seen, whatever day they arrived (a visit left open
      // overnight must not vanish at midnight), plus today's finished rows for the counts.
      const since = new Date()
      since.setHours(0, 0, 0, 0)
      let query = supabase
        .from('queue_board')
        .select('*')
        .or(`finished_at.is.null,queued_at.gte.${since.toISOString()}`)
        .order('priority')
        .order('queued_at')
      if (station !== 'all') query = query.eq('station', station)
      const { data, error } = await query
      if (error) throw new Error(error.message)
      return (data as BoardRow[]).map(toItem)
    },
  })
}

export const queueCounts = (items: readonly QueueItem[]) => ({
  waiting: items.filter((i) => !i.startedAt && !i.finishedAt).length,
  inProgress: items.filter((i) => i.startedAt && !i.finishedAt).length,
  done: items.filter((i) => i.finishedAt).length,
})

/** Rows still waiting or in progress, for the queue card. */
export const openItems = (items: readonly QueueItem[]) => items.filter((i) => !i.finishedAt)

const TRIAGE_RANK: Record<string, number> = { red: 0, yellow: 1, green: 2 }
/** Queue order chosen by the user: urgent first, longest waiting, latest arrival, or by name. */
export const sortQueue = (
  items: readonly QueueItem[],
  sort: 'urgent' | 'longest' | 'latest' | 'oldest' | 'name',
) =>
  [...items].sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name)
    if (sort === 'latest') return b.queuedAt.localeCompare(a.queuedAt)
    if (sort === 'longest' || sort === 'oldest') return a.queuedAt.localeCompare(b.queuedAt)
    return (
      a.priority - b.priority ||
      (TRIAGE_RANK[a.triage] ?? 3) - (TRIAGE_RANK[b.triage] ?? 3) ||
      a.queuedAt.localeCompare(b.queuedAt)
    )
  })

/** One row per shared patient (sent to several desks at once); other rows unchanged. */
export const onePerPool = (items: readonly QueueItem[]) => {
  const seen = new Set<string>()
  return items.filter((i) => {
    if (!i.poolId) return true
    if (seen.has(i.poolId)) return false
    seen.add(i.poolId)
    return true
  })
}

/**
 * "I take this patient": starts the patient at this desk; a patient shared between several desks
 * leaves the other queues. Refused when another doctor was faster.
 */
export function useTakePatient() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (queueId: string) => {
      if (!supabase) return
      const { error } = await supabase.rpc('take_patient', { p_queue_id: queueId })
      if (error) throw new Error(error.message)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queue'] }),
  })
}

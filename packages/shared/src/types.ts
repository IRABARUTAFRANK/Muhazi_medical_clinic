/** Interface languages. i18next and Intl use BCP-47 codes; the database enum (doc §10.2) uses kin/en/fr. */
export type Lang = 'rw' | 'en' | 'fr'
export const LANGS: ReadonlyArray<{ code: Lang; label: string }> = [
  { code: 'rw', label: 'KIN' },
  { code: 'en', label: 'EN' },
  { code: 'fr', label: 'FR' },
]
export const LANG_DB_CODE: Record<Lang, 'kin' | 'en' | 'fr'> = { rw: 'kin', en: 'en', fr: 'fr' }

export type Theme = 'light' | 'dim'

/** Roles from doc §1.4 that have a home page in the current design. */
export type Role = 'receptionist' | 'nurse' | 'doctor' | 'cashier' | 'lab_tech' | 'manager'
export type HomeRole = Exclude<Role, 'manager'>
export type DashboardRole = 'manager' | 'head'

export type Triage = 'red' | 'yellow' | 'green'
export type ResultFlag = 'critical' | 'abnormal' | 'normal'
/** Semantic tones. Never used alone: every tone ships with a dot, icon or word. */
export type Tone = 'green' | 'yellow' | 'red' | 'blue' | 'orange' | 'grey'

export type SyncState =
  | { status: 'synced' }
  | { status: 'syncing'; pending: number }
  | { status: 'offline'; since: Date; pending: number }

/** Dev/demo variants of the staff home (design props). */
export type HomeMode = 'normal' | 'offline' | 'empty'

export type CategoryId =
  | 'consultation'
  | 'dental'
  | 'laboratory'
  | 'ultrasound'
  | 'nursing'
  | 'surgery'
  | 'fp'
  | 'hiv'
  | 'circ'
export type CategoryFilter = CategoryId | 'all'

/** "HH:MM" to "HH:MM" in clinic local time (Africa/Kigali). */
export type TimeSpan = [string, string]
export type DayKey = '0' | '1' | '2' | '3' | '4' | '5' | '6'
/** JS weekday (0 = Sunday) → working spans. Same shape as `practitioner.working_hours` in the database. */
export type WeeklyHours = Partial<Record<DayKey, TimeSpan[]>>

/** `setting` row `clinic.hours`. */
export interface ClinicHours {
  timezone?: string
  days: Partial<Record<DayKey, TimeSpan>>
  lab?: TimeSpan
}

/** `setting` row `clinic.profile`. */
export interface ClinicProfile {
  name: string
  tagline: string
  sector: string
  district: string
  province: string
  country: string
  phone: string
  whatsapp: string
  email: string
}

export interface StaffUser {
  id: string
  username: string
  name: string
  role: Role
  /** Public staff identifier typed on the landing page before signing in (MMC-S-0001). */
  staffId?: string
  /** Where the one-time sign-in code is sent. */
  email?: string
  /** Station shown after the role, e.g. "Consultation 1". */
  station?: string
  /** Which dashboard variant the user may open; undefined = none. */
  dashboard?: DashboardRole
  /** For heads of station: the station they lead. */
  headOf?: string
  /** True until the employee replaced the PIN the manager handed over. */
  mustChangePin?: boolean
}

export interface Practitioner {
  /** Database id (uuid) in live data; equals `code` in sample data. */
  id: string
  /** Short public code used in URLs and the booking RPC (`mb`, `nf`, …). */
  code: string
  name: string
  title: string
  cats: CategoryId[]
  langs: string
  hours: WeeklyHours
  slotMinutes: number
  /** Seed for deterministic sample bookings (sample data only). */
  seed: number
}

export interface QueueRow {
  ticket: string
  name: string
  ageSex: string
  triage: Triage
  waitMin: number
  insurer: string
  /** Live rows: the visit the row belongs to (opens the visit screen). */
  encounterId?: string
}
export interface QueueCounts {
  waiting: number
  inProgress: number
  done: number
}

export interface NavItem {
  id: string
  labelKey: string
  to: string
  icon: string
}
export interface QuickAction {
  id: string
  labelKey: string
  icon: string
  primary?: boolean
  to: string
}

export type ApptStatus = 'arrived' | 'due' | 'late'
export interface Appointment {
  time: string
  name: string
  doctor: string
  status: ApptStatus
}
export interface Inquiry {
  name: string
  detail: string
}
export interface NurseTask {
  time: string
  task: string
  patient: string
  overdue?: boolean
}
export type BedState = 'occupied' | 'free' | 'cleaning'
export interface Bed {
  n: number
  who?: string
  state: BedState
}
export interface LabResult {
  flag: ResultFlag
  test: string
  name: string
  detail: string
}
export interface CalendarItem {
  time: string
  what: string
}
export interface OpenBill {
  name: string
  station: string
  amount: number
}
export interface ProvisionalReceipt {
  no: string
  name: string
  amount: number
}

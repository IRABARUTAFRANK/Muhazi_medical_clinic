import { addDays, isoDate } from '@mmc/shared'
import type { ReportContext, ReportPeriod } from '@/lib/reports/defs/types'
import { reportCall } from './reports-options'

/**
 * The report centre's clinical reports (migration 0112): patients seen, diagnoses, prescriptions,
 * tests and exams, vital signs, bookings. Each database function checks the rights again (0088
 * privacy): the manager everything, a head their departments' visits, a clinician their own
 * work, the laboratory / ultrasound desk their desk's tests, the pharmacy desk the prescriptions,
 * reception the bookings. Sample mode: rows from the sample clinic (the same people as the rest of
 * the sample app), within the same rights.
 */

export type Sex = 'female' | 'male' | 'other' | 'unknown'
export type Outcome = 'finished' | 'referred' | 'left' | 'open'
export const OUTCOMES: readonly Outcome[] = ['finished', 'referred', 'left', 'open']

export interface PatientSeenRow {
  encounterId: string
  visitAt: string
  seenAt: string | null
  reference: string | null
  patientId: string
  patient: string
  fileNo: string | null
  sex: Sex
  age: number | null
  clinicianId: string
  clinician: string
  clinicianRole: string | null
  /** consultation, dental, theatre, nursing, beds, ultrasound (null: wrote a diagnosis only). */
  desk: string | null
  department: string | null
  /** "B54 Malaria; J06.9 …" (clinical). */
  diagnosis: string | null
  prescriptions: number
  tests: number
  outcome: Outcome
}

export interface DiagnosisRow {
  code: string | null
  diagnosis: string
  cases: number
  patients: number
  newCases: number
  followUp: number
  primary: number
  female: number
  male: number
  otherSex: number
  age0to4: number
  age5to14: number
  age15to24: number
  age25to49: number
  age50plus: number
  ageUnknown: number
}

export type Supply = 'pharmacy' | 'room' | 'outside'
export type RxStatus = 'given' | 'part' | 'waiting' | 'not_given' | 'outside' | 'cancelled'
export const RX_STATUSES: readonly RxStatus[] = [
  'given',
  'part',
  'waiting',
  'not_given',
  'outside',
  'cancelled',
]
export interface PrescriptionRow {
  id: string
  at: string
  encounterId: string
  reference: string | null
  patientId: string
  patient: string
  fileNo: string | null
  itemId: string | null
  medicine: string
  code: string | null
  unit: string | null
  packSize: number | null
  packUnit: string | null
  quantity: number
  given: number | null
  supply: Supply
  status: RxStatus
  prescriberId: string | null
  prescriber: string | null
  dose: string | null
  instructions: string | null
  reason: string | null
}

export type TestStatus =
  'ordered' | 'collected' | 'in_process' | 'resulted' | 'verified' | 'cancelled'
export const TEST_STATUSES: readonly TestStatus[] = [
  'ordered',
  'collected',
  'in_process',
  'resulted',
  'verified',
  'cancelled',
]
export interface TestRow {
  id: string
  at: string
  encounterId: string
  reference: string | null
  test: string
  testFr: string | null
  testRw: string | null
  category: 'lab' | 'imaging'
  /** laboratory, ultrasound, or the desk the test is done at. */
  desk: string
  urgent: boolean
  sampleId: string | null
  patientId: string
  patient: string
  fileNo: string | null
  requesterId: string | null
  requester: string | null
  status: TestStatus
  sampleAt: string | null
  resultAt: string | null
  verifiedAt: string | null
  resultBy: string | null
  /** Minutes from the request to the result validated (else written). */
  turnaround: number | null
  corrected: boolean
  /** The conclusion (else the findings): clinical, null when the reader may not see it. */
  result: string | null
}

export type VitalFlag =
  | 'temp_high'
  | 'temp_low'
  | 'spo2_low'
  | 'bp_high'
  | 'bp_low'
  | 'pulse_high'
  | 'pulse_low'
  | 'resp_high'
  | 'resp_low'
export interface VitalsRow {
  encounterId: string
  at: string
  reference: string | null
  patientId: string
  patient: string
  fileNo: string | null
  sex: Sex
  age: number | null
  measuredById: string | null
  measuredBy: string | null
  enteredById: string | null
  enteredBy: string | null
  /** Typed by someone else than the person who measured (the nurse's paper sheet). */
  onBehalf: boolean
  count: number
  /** code → value (bp_sys, bp_dia, pulse, temp, resp, spo2, weight, height, muac, custom_…). */
  values: Record<string, number>
  flags: VitalFlag[]
}

export type BookingStatus =
  | 'requested'
  | 'approved'
  | 'confirmed'
  | 'arrived'
  | 'with_clinician'
  | 'seen'
  | 'left_unseen'
  | 'no_show'
  | 'cancelled'
  | 'declined'
export const BOOKING_STATUSES: readonly BookingStatus[] = [
  'requested',
  'approved',
  'confirmed',
  'arrived',
  'with_clinician',
  'seen',
  'left_unseen',
  'no_show',
  'cancelled',
  'declined',
]
export type BookingSource = 'online' | 'reception' | 'phone'
export interface BookingRow {
  id: string
  at: string | null
  createdAt: string
  reference: string | null
  patientId: string | null
  patient: string | null
  fileNo: string | null
  phone: string | null
  practitionerId: string | null
  bookedWith: string | null
  /** The booking category (consultation, dental…). */
  service: string | null
  status: BookingStatus
  source: BookingSource
  arrivedAt: string | null
  encounterId: string | null
  reason: string | null
  cancelReason: string | null
}

export interface ClinicalOptions {
  scope: 'all' | 'departments' | 'own'
  me: string | null
  clinicians: { id: string; name: string; role: string | null }[]
  departments: { id: string; name: string }[]
  practitioners: { id: string; name: string; userId: string | null }[]
}

// ---------------------------------------------------------------- calling the database

const arrayOf = <T>(d: unknown): T[] => (Array.isArray(d) ? (d as T[]) : [])
const rpcRows = async <T>(fn: string, args: Record<string, unknown>): Promise<T[]> =>
  arrayOf<T>(await reportCall(fn, args))

const optionsCache = new Map<string, { at: number; value: Promise<ClinicalOptions> }>()

/** The clinicians, departments and practitioners this person may filter by (once a minute). */
export function clinicalOptions(ctx: ReportContext): Promise<ClinicalOptions> {
  if (ctx.sample) return Promise.resolve(sampleOptions(ctx))
  const hit = optionsCache.get(ctx.user.id)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  const value = (async (): Promise<ClinicalOptions> => {
    const d = ((await reportCall('report_clinical_options', {})) ?? {}) as Partial<ClinicalOptions>
    return {
      scope: d.scope ?? 'own',
      me: d.me ?? null,
      clinicians: arrayOf<ClinicalOptions['clinicians'][number]>(d.clinicians),
      departments: arrayOf<ClinicalOptions['departments'][number]>(d.departments),
      practitioners: arrayOf<ClinicalOptions['practitioners'][number]>(d.practitioners),
    }
  })()
  optionsCache.set(ctx.user.id, { at: Date.now(), value })
  value.catch(() => optionsCache.delete(ctx.user.id))
  return value
}

export interface SeenArgs {
  period: ReportPeriod
  clinician: string | null
  department: string | null
}
export const loadPatientsSeen = (a: SeenArgs, ctx: ReportContext) =>
  ctx.sample
    ? Promise.resolve(samplePatientsSeen(a, ctx))
    : rpcRows<PatientSeenRow>('report_patients_seen', {
        p_from: a.period.from,
        p_to: a.period.to,
        p_clinician: a.clinician,
        p_department: a.department,
      })

export interface DiagnosesArgs {
  period: ReportPeriod
  department: string | null
  doctor: string | null
}
export const loadDiagnoses = (a: DiagnosesArgs, ctx: ReportContext) =>
  ctx.sample
    ? Promise.resolve(sampleDiagnoses(a, ctx))
    : rpcRows<DiagnosisRow>('report_diagnoses', {
        p_from: a.period.from,
        p_to: a.period.to,
        p_department: a.department,
        p_doctor: a.doctor,
      })

export interface PrescriptionsArgs {
  period: ReportPeriod
  supply: Supply | null
  prescriber: string | null
}
export const loadPrescriptions = (a: PrescriptionsArgs, ctx: ReportContext) =>
  ctx.sample
    ? Promise.resolve(samplePrescriptions(a, ctx))
    : rpcRows<PrescriptionRow>('report_prescriptions', {
        p_from: a.period.from,
        p_to: a.period.to,
        p_supply: a.supply,
        p_prescriber: a.prescriber,
      })

export interface TestsArgs {
  period: ReportPeriod
  desk: string | null
  status: TestStatus | null
  requester: string | null
}
export const loadTests = (a: TestsArgs, ctx: ReportContext) =>
  ctx.sample
    ? Promise.resolve(sampleTests(a, ctx))
    : rpcRows<TestRow>('report_tests', {
        p_from: a.period.from,
        p_to: a.period.to,
        p_desk: a.desk,
        p_status: a.status,
        p_requester: a.requester,
      })

export interface VitalsArgs {
  period: ReportPeriod
  taker: string | null
}
export const loadVitals = (a: VitalsArgs, ctx: ReportContext) =>
  ctx.sample
    ? Promise.resolve(sampleVitals(a, ctx))
    : rpcRows<VitalsRow>('report_vitals', {
        p_from: a.period.from,
        p_to: a.period.to,
        p_taker: a.taker,
      })

export interface BookingsArgs {
  period: ReportPeriod
  status: BookingStatus | null
  practitioner: string | null
  source: BookingSource | null
}
export const loadBookings = (a: BookingsArgs, ctx: ReportContext) =>
  ctx.sample
    ? Promise.resolve(sampleBookings(a, ctx))
    : rpcRows<BookingRow>('report_bookings', {
        p_from: a.period.from,
        p_to: a.period.to,
        p_status: a.status,
        p_practitioner: a.practitioner,
        p_source: a.source,
      })

// ---------------------------------------------------------------- sample mode

/** mulberry32, seeded by a string: the same sample from one render to the next. */
function rng(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T>(list: readonly T[], r: () => number): T =>
  list[Math.min(list.length - 1, Math.floor(r() * list.length))]!

interface SamplePerson {
  id: string
  name: string
  role: string
  desk: string
  department: string
}
const PEOPLE: SamplePerson[] = [
  {
    id: 'u-doc',
    name: 'Dr. Mukamana Béatrice',
    role: 'doctor',
    desk: 'consultation',
    department: 'dep-opd',
  },
  {
    id: 'p-doc2',
    name: 'Dr. Niyonsenga Patrick',
    role: 'doctor',
    desk: 'consultation',
    department: 'dep-opd',
  },
  {
    id: 'u-head',
    name: 'Dr. Ndayisaba Félix',
    role: 'doctor',
    desk: 'dental',
    department: 'dep-dental',
  },
  {
    id: 'u-nur',
    name: 'Nyirahabimana Chantal',
    role: 'nurse',
    desk: 'nursing',
    department: 'dep-opd',
  },
  {
    id: 'u-sono',
    name: 'Uwase Claudine',
    role: 'sonographer',
    desk: 'ultrasound',
    department: 'dep-lab',
  },
]
const DEPARTMENTS = [
  { id: 'dep-opd', name: 'General consultation' },
  { id: 'dep-dental', name: 'Dental' },
  { id: 'dep-lab', name: 'Laboratory & ultrasound' },
]
const LAB = { id: 'u-lab', name: 'Uwera Diane' }
const RECEPTION = { id: 'u-rec', name: 'Uwimana Josiane' }
const PATIENTS: { id: string; name: string; file: string; sex: Sex; age: number; phone: string }[] =
  [
    {
      id: 'p-1',
      name: 'Mukamana Alice',
      file: 'MMC-000124',
      sex: 'female',
      age: 35,
      phone: '0788 412 905',
    },
    {
      id: 'p-2',
      name: 'Habimana Eric',
      file: 'MMC-000131',
      sex: 'male',
      age: 7,
      phone: '0722 118 640',
    },
    {
      id: 'p-3',
      name: 'Uwimana Claudine',
      file: 'MMC-000087',
      sex: 'female',
      age: 52,
      phone: '0783 300 217',
    },
    {
      id: 'p-4',
      name: 'Nshimiyimana Jean',
      file: 'MMC-000142',
      sex: 'male',
      age: 41,
      phone: '0788 655 011',
    },
    {
      id: 'p-5',
      name: 'Ingabire Grace',
      file: 'MMC-000150',
      sex: 'female',
      age: 24,
      phone: '0791 204 388',
    },
    {
      id: 'p-6',
      name: 'Mugisha Olivier',
      file: 'MMC-000063',
      sex: 'male',
      age: 3,
      phone: '0785 777 120',
    },
    {
      id: 'p-7',
      name: 'Uwase Diane',
      file: 'MMC-000158',
      sex: 'female',
      age: 29,
      phone: '0738 090 455',
    },
    {
      id: 'p-8',
      name: 'Niyonzima Emmanuel',
      file: 'MMC-000112',
      sex: 'male',
      age: 67,
      phone: '0788 121 908',
    },
    {
      id: 'p-9',
      name: 'Mukeshimana Esther',
      file: 'MMC-000099',
      sex: 'female',
      age: 16,
      phone: '0723 456 870',
    },
    {
      id: 'p-10',
      name: 'Hakizimana Patrick',
      file: 'MMC-000161',
      sex: 'male',
      age: 33,
      phone: '0786 902 314',
    },
    {
      id: 'p-11',
      name: 'Umutoni Sandrine',
      file: 'MMC-000075',
      sex: 'female',
      age: 9,
      phone: '0789 645 230',
    },
    {
      id: 'p-12',
      name: 'Bizimana Claude',
      file: 'MMC-000166',
      sex: 'male',
      age: 58,
      phone: '0784 512 667',
    },
  ]
const DIAGNOSES: [string, string][] = [
  ['B54', 'Malaria'],
  ['J06.9', 'Upper respiratory tract infection'],
  ['I10', 'Essential hypertension'],
  ['K29.7', 'Gastritis'],
  ['N39.0', 'Urinary tract infection'],
  ['E11.9', 'Type 2 diabetes mellitus'],
  ['A09', 'Gastroenteritis'],
  ['J18.9', 'Pneumonia'],
]
const DENTAL: [string, string][] = [
  ['K02.9', 'Dental caries'],
  ['K05.1', 'Chronic gingivitis'],
  ['K04.7', 'Periapical abscess'],
]
const MEDICINES: [string, string, number, number | null][] = [
  ['it-3', 'Artemether-lumefantrine 20/120 mg', 24, 24],
  ['it-1', 'Amoxicillin 500 mg', 21, 100],
  ['it-2', 'Paracetamol 500 mg', 18, 20],
  ['it-r1', 'Metformin 500 mg', 56, 28],
  ['it-r2', 'Oral rehydration salts', 6, 50],
  ['it-6', 'Cough syrup 100 ml', 1, null],
]
const TESTS: [string, 'lab' | 'imaging', string][] = [
  ['Malaria rapid test', 'lab', 'Test rapide du paludisme'],
  ['Full blood count', 'lab', 'Numération formule sanguine'],
  ['Urinalysis', 'lab', 'Analyse d’urine'],
  ['Blood glucose', 'lab', 'Glycémie'],
  ['Abdominal ultrasound', 'imaging', 'Échographie abdominale'],
  ['Obstetric ultrasound', 'imaging', 'Échographie obstétricale'],
]

const minutes = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString()

interface SampleVisit {
  encounterId: string
  at: string
  reference: string
  patient: (typeof PATIENTS)[number]
  clinician: SamplePerson
  dx: [string, string]
  followUp: boolean
  rx: (typeof MEDICINES)[number][]
  tests: (typeof TESTS)[number][]
  outcome: Outcome
  day: number
}

/** The sample visits of the period: 2 to 5 a day over its last 45 days. */
function sampleVisits(p: ReportPeriod): SampleVisit[] {
  const out: SampleVisit[] = []
  const end = new Date(`${p.to}T12:00:00`)
  const today = isoDate(new Date())
  let seq = 0
  for (let back = 0; back < 45; back++) {
    const day = isoDate(addDays(end, -back))
    if (day < p.from) break
    if (day > today) continue
    const r = rng(`visits-${day}`)
    const n = 2 + Math.floor(r() * 4)
    for (let i = 0; i < n; i++) {
      seq++
      const clinician = pick(
        PEOPLE.filter((x) => x.role !== 'sonographer'),
        r,
      )
      const patient = pick(PATIENTS, r)
      const dental = clinician.desk === 'dental'
      const at = `${day}T${String(8 + Math.floor(r() * 8)).padStart(2, '0')}:${String(Math.floor(r() * 60)).padStart(2, '0')}:00+02:00`
      const tests = clinician.role === 'doctor' && !dental && r() < 0.6 ? [pick(TESTS, r)] : []
      const rx =
        clinician.role === 'nurse' ? (r() < 0.3 ? [MEDICINES[4]!] : []) : [pick(MEDICINES, r)]
      if (clinician.role === 'doctor' && r() < 0.35) rx.push(pick(MEDICINES, r))
      const o = r()
      out.push({
        encounterId: `e-s${seq}`,
        at,
        reference: `V-2026-${String(4000 - seq).padStart(6, '0')}`,
        patient,
        clinician,
        dx: dental ? pick(DENTAL, r) : pick(DIAGNOSES, r),
        followUp: r() < 0.3,
        rx,
        tests,
        outcome:
          day === today && o < 0.3
            ? 'open'
            : o < 0.08
              ? 'left'
              : o < 0.18
                ? 'referred'
                : 'finished',
        day: back,
      })
    }
  }
  return out
}

/** The visits this sample person may report on: all, their department's (a head), or their own. */
function visible(ctx: ReportContext, v: SampleVisit): boolean {
  if (ctx.isManager) return true
  if (v.clinician.id === ctx.user.id) return true
  const me = PEOPLE.find((x) => x.id === ctx.user.id)
  return ctx.isHead && !!me && me.department === v.clinician.department
}

function sampleOptions(ctx: ReportContext): ClinicalOptions {
  const me = PEOPLE.find((x) => x.id === ctx.user.id)
  return {
    scope: ctx.isManager ? 'all' : ctx.isHead ? 'departments' : 'own',
    me: ctx.user.id,
    clinicians: [...PEOPLE, { ...LAB, role: 'lab_tech' }].map((x) => ({
      id: x.id,
      name: x.name,
      role: x.role,
    })),
    departments: ctx.isManager
      ? DEPARTMENTS
      : DEPARTMENTS.filter((d) => ctx.isHead && d.id === me?.department),
    practitioners: PEOPLE.filter((x) => x.role !== 'nurse')
      .filter((x) => ctx.isManager || ctx.canDesk('reception') || x.id === ctx.user.id)
      .map((x) => ({ id: `pr-${x.id}`, name: x.name, userId: x.id })),
  }
}

function samplePatientsSeen(a: SeenArgs, ctx: ReportContext): PatientSeenRow[] {
  return sampleVisits(a.period)
    .filter((v) => visible(ctx, v))
    .filter((v) => !a.clinician || v.clinician.id === a.clinician)
    .filter((v) => !a.department || v.clinician.department === a.department)
    .map((v) => ({
      encounterId: v.encounterId,
      visitAt: v.at,
      seenAt: minutes(v.at, 25),
      reference: v.reference,
      patientId: v.patient.id,
      patient: v.patient.name,
      fileNo: v.patient.file,
      sex: v.patient.sex,
      age: v.patient.age,
      clinicianId: v.clinician.id,
      clinician: v.clinician.name,
      clinicianRole: v.clinician.role,
      desk: v.clinician.desk,
      department: DEPARTMENTS.find((d) => d.id === v.clinician.department)?.name ?? null,
      diagnosis: v.clinician.role === 'nurse' ? null : `${v.dx[0]} ${v.dx[1]}`,
      prescriptions: v.rx.length,
      tests: v.tests.length,
      outcome: v.outcome,
    }))
}

function sampleDiagnoses(a: DiagnosesArgs, ctx: ReportContext): DiagnosisRow[] {
  const rows = new Map<string, DiagnosisRow>()
  for (const v of sampleVisits(a.period)) {
    if (v.clinician.role === 'nurse' || !visible(ctx, v)) continue
    if (a.doctor && v.clinician.id !== a.doctor) continue
    if (a.department && v.clinician.department !== a.department) continue
    const [code, text] = v.dx
    const r =
      rows.get(code) ??
      ({
        code,
        diagnosis: text,
        cases: 0,
        patients: 0,
        newCases: 0,
        followUp: 0,
        primary: 0,
        female: 0,
        male: 0,
        otherSex: 0,
        age0to4: 0,
        age5to14: 0,
        age15to24: 0,
        age25to49: 0,
        age50plus: 0,
        ageUnknown: 0,
      } satisfies DiagnosisRow)
    r.cases++
    r.primary++
    if (v.followUp) r.followUp++
    else r.newCases++
    if (v.patient.sex === 'female') r.female++
    else if (v.patient.sex === 'male') r.male++
    else r.otherSex++
    const age = v.patient.age
    if (age < 5) r.age0to4++
    else if (age < 15) r.age5to14++
    else if (age < 25) r.age15to24++
    else if (age < 50) r.age25to49++
    else r.age50plus++
    rows.set(code, r)
  }
  // a patient counted once per diagnosis
  for (const r of rows.values()) r.patients = Math.max(1, Math.round(r.cases * 0.85))
  return [...rows.values()].sort((x, y) => y.cases - x.cases)
}

function samplePrescriptions(a: PrescriptionsArgs, ctx: ReportContext): PrescriptionRow[] {
  const all = ctx.isManager || ctx.canDesk('pharmacy')
  const out: PrescriptionRow[] = []
  for (const v of sampleVisits(a.period)) {
    if (!all && !visible(ctx, v)) continue
    if (a.prescriber && v.clinician.id !== a.prescriber) continue
    v.rx.forEach(([itemId, medicine, quantity, packSize], i) => {
      const r = rng(`${v.encounterId}-${i}`)
      const supply: Supply =
        v.clinician.role === 'nurse'
          ? 'room'
          : r() < 0.12
            ? 'outside'
            : r() < 0.15
              ? 'room'
              : 'pharmacy'
      if (a.supply && supply !== a.supply) return
      const status: RxStatus =
        supply === 'outside'
          ? 'outside'
          : supply === 'room'
            ? 'given'
            : v.outcome === 'open'
              ? 'waiting'
              : r() < 0.06
                ? 'not_given'
                : r() < 0.08
                  ? 'part'
                  : 'given'
      out.push({
        id: `rx-${v.encounterId}-${i}`,
        at: minutes(v.at, 30 + i),
        encounterId: v.encounterId,
        reference: v.reference,
        patientId: v.patient.id,
        patient: v.patient.name,
        fileNo: v.patient.file,
        itemId,
        medicine,
        code: null,
        unit: null,
        packSize,
        packUnit: packSize ? 'box' : null,
        quantity,
        given: status === 'given' ? quantity : status === 'part' ? Math.floor(quantity / 2) : 0,
        supply,
        status,
        prescriberId: v.clinician.id,
        prescriber: v.clinician.name,
        dose: '1 × 3 a day · 7 d',
        instructions: null,
        reason: status === 'not_given' ? 'None in the pharmacy' : null,
      })
    })
  }
  return out.sort((x, y) => y.at.localeCompare(x.at))
}

function sampleTests(a: TestsArgs, ctx: ReportContext): TestRow[] {
  const lab = ctx.canDesk('laboratory')
  const us = ctx.canDesk('ultrasound')
  const out: TestRow[] = []
  for (const v of sampleVisits(a.period)) {
    v.tests.forEach(([test, category, testFr], i) => {
      const desk = category === 'imaging' ? 'ultrasound' : 'laboratory'
      const mine =
        visible(ctx, v) || (desk === 'laboratory' && lab) || (desk === 'ultrasound' && us)
      if (!mine) return
      if (a.desk && desk !== a.desk) return
      if (a.requester && v.clinician.id !== a.requester) return
      const r = rng(`${v.encounterId}-t${i}`)
      const status: TestStatus =
        v.outcome === 'open'
          ? r() < 0.5
            ? 'collected'
            : 'ordered'
          : r() < 0.05
            ? 'cancelled'
            : 'verified'
      if (a.status && status !== a.status) return
      const at = minutes(v.at, 20)
      const tat = 25 + Math.round(r() * 70)
      const done = status === 'verified'
      out.push({
        id: `t-${v.encounterId}-${i}`,
        at,
        encounterId: v.encounterId,
        reference: v.reference,
        test,
        testFr,
        testRw: null,
        category,
        desk,
        urgent: r() < 0.15,
        sampleId: category === 'lab' ? `L-${v.encounterId.slice(3)}` : null,
        patientId: v.patient.id,
        patient: v.patient.name,
        fileNo: v.patient.file,
        requesterId: v.clinician.id,
        requester: v.clinician.name,
        status,
        sampleAt: status === 'ordered' || status === 'cancelled' ? null : minutes(at, 8),
        resultAt: done ? minutes(at, tat - 5) : null,
        verifiedAt: done ? minutes(at, tat) : null,
        resultBy: done ? (desk === 'ultrasound' ? 'Uwase Claudine' : LAB.name) : null,
        turnaround: done ? tat : null,
        corrected: false,
        result: done
          ? category === 'imaging'
            ? 'No abnormality seen'
            : test.startsWith('Malaria')
              ? r() < 0.4
                ? 'Positive (P. falciparum)'
                : 'Negative'
              : 'Within normal limits'
          : null,
      })
    })
  }
  return out.sort((x, y) => y.at.localeCompare(x.at))
}

function sampleVitals(a: VitalsArgs, ctx: ReportContext): VitalsRow[] {
  const nurse = PEOPLE.find((x) => x.id === 'u-nur')!
  const out: VitalsRow[] = []
  for (const v of sampleVisits(a.period)) {
    const r = rng(`${v.encounterId}-v`)
    // the nurse measures at triage; reception sometimes types her paper sheet
    const typedByReception = r() < 0.25
    const enteredBy = typedByReception ? RECEPTION : nurse
    const own = nurse.id === ctx.user.id || enteredBy.id === ctx.user.id
    if (!(ctx.isManager || own || (ctx.isHead && visible(ctx, v)))) continue
    if (a.taker && a.taker !== nurse.id) continue
    const temp = Math.round((36.2 + r() * 2.6) * 10) / 10
    const sys = 100 + Math.round(r() * 60)
    const values: Record<string, number> = {
      temp,
      pulse: 64 + Math.round(r() * 50),
      spo2: 92 + Math.round(r() * 7),
      bp_sys: sys,
      bp_dia: Math.round(sys * 0.62),
      weight: Math.round((v.patient.age < 12 ? 12 + v.patient.age * 2.5 : 55 + r() * 30) * 10) / 10,
    }
    const flags: VitalFlag[] = []
    if (temp >= 37.5) flags.push('temp_high')
    if (values.spo2! < 94) flags.push('spo2_low')
    if (sys >= 140 || values.bp_dia! >= 90) flags.push('bp_high')
    if (v.patient.age >= 12 && values.pulse! > 100) flags.push('pulse_high')
    out.push({
      encounterId: v.encounterId,
      at: minutes(v.at, 10),
      reference: v.reference,
      patientId: v.patient.id,
      patient: v.patient.name,
      fileNo: v.patient.file,
      sex: v.patient.sex,
      age: v.patient.age,
      measuredById: nurse.id,
      measuredBy: nurse.name,
      enteredById: enteredBy.id,
      enteredBy: enteredBy.name,
      onBehalf: typedByReception,
      count: Object.keys(values).length,
      values,
      flags,
    })
  }
  return out.sort((x, y) => y.at.localeCompare(x.at))
}

function sampleBookings(a: BookingsArgs, ctx: ReportContext): BookingRow[] {
  const all = ctx.isManager || ctx.canDesk('reception')
  const out: BookingRow[] = []
  const today = isoDate(new Date())
  const end = new Date(`${a.period.to}T12:00:00`)
  let seq = 0
  for (let back = -3; back < 30; back++) {
    const day = isoDate(addDays(end, -back))
    if (day < a.period.from || day > a.period.to) continue
    const r = rng(`bookings-${day}`)
    const n = 1 + Math.floor(r() * 4)
    for (let i = 0; i < n; i++) {
      seq++
      const doc = pick(
        PEOPLE.filter((x) => x.role !== 'nurse'),
        r,
      )
      if (!all && doc.id !== ctx.user.id) continue
      const prId = `pr-${doc.id}`
      if (a.practitioner && prId !== a.practitioner) continue
      const known = r() < 0.7
      const patient = pick(PATIENTS, r)
      const source: BookingSource = pick(['online', 'reception', 'phone'] as const, r)
      if (a.source && source !== a.source) continue
      const at = `${day}T${String(8 + Math.floor(r() * 9)).padStart(2, '0')}:${r() < 0.5 ? '00' : '30'}:00+02:00`
      const o = r()
      const status: BookingStatus =
        day > today
          ? o < 0.15
            ? 'requested'
            : 'confirmed'
          : day === today
            ? pick(['confirmed', 'arrived', 'with_clinician', 'seen'] as const, r)
            : o < 0.7
              ? 'seen'
              : o < 0.82
                ? 'no_show'
                : o < 0.9
                  ? 'cancelled'
                  : 'left_unseen'
      if (a.status && status !== a.status) continue
      const arrived = ['arrived', 'with_clinician', 'seen', 'left_unseen'].includes(status)
      out.push({
        id: `bk-${seq}`,
        at,
        createdAt: minutes(at, -60 * 24 * (1 + Math.floor(r() * 5))),
        reference: `BK-${day.replace(/-/g, '').slice(2)}-${String(i + 1).padStart(3, '0')}`,
        patientId: known ? patient.id : null,
        patient: known ? patient.name : pick(['Mutesi Ange', 'Kamanzi Joseph', 'Uwera Aline'], r),
        fileNo: known ? patient.file : null,
        phone: patient.phone,
        practitionerId: prId,
        bookedWith: doc.name,
        service:
          doc.desk === 'dental'
            ? 'dental'
            : doc.desk === 'ultrasound'
              ? 'ultrasound'
              : 'consultation',
        status,
        source,
        arrivedAt: arrived ? minutes(at, -10) : null,
        encounterId: arrived ? `e-b${seq}` : null,
        reason: r() < 0.5 ? 'Follow-up' : null,
        cancelReason: status === 'cancelled' ? 'Travelling' : null,
      })
    }
  }
  return out.sort((x, y) => (x.at ?? '').localeCompare(y.at ?? ''))
}

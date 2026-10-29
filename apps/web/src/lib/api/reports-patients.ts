import { supabase } from '@/lib/supabase'
import { apiError } from './errors'
import type { PatientFieldDef } from './patients'

/**
 * The patients reports of the report centre (migration 0110): patients who visited in a period
 * (report_patients_visited), the visits (report_visits), the files created (report_new_
 * registrations) and the filters' choices (report_patients_options). The database checks the
 * rights again: the manager the whole clinic, a head their department, reception the
 * registrations only; a diagnosis only where the reader may see the visit, and logged.
 * Sample mode: rows made up from a dozen sample patients, filtered the same way.
 */

export interface VisitedPatientRow {
  patientId: string
  fileNumber: string
  surname: string
  givenNames: string
  sex: string
  age: number | null
  ageBand: string | null
  birthDate: string | null
  phone: string | null
  phone2: string | null
  /** Whole for the manager, masked for everyone else. */
  nationalId: string | null
  province: string | null
  district: string | null
  sector: string | null
  cell: string | null
  village: string | null
  insurer: string | null
  firstVisit: string
  lastVisit: string
  visits: number
  isNew: boolean
  departments: string[]
  /** Station keys (consultation, laboratory…). */
  desks: string[]
  doctors: string[]
  /** Only when asked (null otherwise): the visits' diagnoses the reader may see. */
  diagnoses: string[] | null
  extra: Record<string, unknown>
}

export interface VisitReportRow {
  id: string
  reference: string | null
  at: string
  closedAt: string | null
  status: 'open' | 'finished' | 'left_unseen' | string
  type: string | null
  service: string | null
  triage: string | null
  patientId: string
  patient: string
  fileNumber: string
  sex: string
  age: number | null
  ageBand: string | null
  district: string | null
  /** The desks in the order the patient went. */
  route: string[]
  department: string | null
  doctor: string | null
  insurer: string | null
  isNew: boolean
  diagnosis: string | null
  /** Money: the manager (and whoever reads the bills) only; null for everyone else. */
  billed: number | null
  insurerShare: number | null
  patientShare: number | null
  paid: number | null
  balance: number | null
}

export interface RegistrationRow {
  patientId: string
  fileNumber: string
  surname: string
  givenNames: string
  sex: string
  age: number | null
  birthDate: string | null
  phone: string | null
  district: string | null
  sector: string | null
  cell: string | null
  village: string | null
  hasId: boolean
  idType: string | null
  registeredById: string | null
  registeredBy: string | null
  registeredAt: string
  /** files.missing.* keys and extra:<key>. */
  missing: string[]
}

export interface PatientReportOptions {
  departments: { id: string; name: string }[]
  doctors: { id: string; name: string }[]
  services: string[]
  insurers: { id: string; name: string }[]
  districts: string[]
  registrars: { id: string; name: string }[]
}

/** The filters the functions take (empty = all). */
export interface PatientReportFilters {
  department?: string
  desk?: string
  doctor?: string
  service?: string
  insurer?: string
  sex?: string
  ageBand?: string
  kind?: 'new' | 'returning' | ''
  district?: string
  search?: string
  status?: string
  registeredBy?: string
  missingOnly?: boolean
}

type Raw = Record<string, unknown>
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : [])
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : [])
const s0 = (v: unknown) => (v == null ? '' : String(v))
const sn = (v: unknown) => (v == null || v === '' ? null : String(v))
const nn = (v: unknown) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v))
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {})

/** Only the filters that are set (the functions read empty keys as "all"). */
const clean = (f: PatientReportFilters) =>
  Object.fromEntries(
    Object.entries(f).filter(([, v]) => v !== undefined && v !== '' && v !== false),
  )

const toVisited = (x: Raw): VisitedPatientRow => ({
  patientId: s0(x.patientId),
  fileNumber: s0(x.fileNumber),
  surname: s0(x.surname),
  givenNames: s0(x.givenNames),
  sex: s0(x.sex),
  age: nn(x.age),
  ageBand: sn(x.ageBand),
  birthDate: sn(x.birthDate),
  phone: sn(x.phone),
  phone2: sn(x.phone2),
  nationalId: sn(x.nationalId),
  province: sn(x.province),
  district: sn(x.district),
  sector: sn(x.sector),
  cell: sn(x.cell),
  village: sn(x.village),
  insurer: sn(x.insurer),
  firstVisit: s0(x.firstVisit),
  lastVisit: s0(x.lastVisit),
  visits: nn(x.visits) ?? 0,
  isNew: !!x.isNew,
  departments: strs(x.departments),
  desks: strs(x.desks),
  doctors: strs(x.doctors),
  diagnoses: Array.isArray(x.diagnoses) ? strs(x.diagnoses) : null,
  extra: obj(x.extra),
})

const toVisit = (x: Raw): VisitReportRow => ({
  id: s0(x.id),
  reference: sn(x.reference),
  at: s0(x.at),
  closedAt: sn(x.closedAt),
  status: s0(x.status) || 'open',
  type: sn(x.type),
  service: sn(x.service),
  triage: sn(x.triage),
  patientId: s0(x.patientId),
  patient: s0(x.patient),
  fileNumber: s0(x.fileNumber),
  sex: s0(x.sex),
  age: nn(x.age),
  ageBand: sn(x.ageBand),
  district: sn(x.district),
  route: strs(x.route),
  department: sn(x.department),
  doctor: sn(x.doctor),
  insurer: sn(x.insurer),
  isNew: !!x.isNew,
  diagnosis: sn(x.diagnosis),
  billed: nn(x.billed),
  insurerShare: nn(x.insurerShare),
  patientShare: nn(x.patientShare),
  paid: nn(x.paid),
  balance: nn(x.balance),
})

const toRegistration = (x: Raw): RegistrationRow => ({
  patientId: s0(x.patientId),
  fileNumber: s0(x.fileNumber),
  surname: s0(x.surname),
  givenNames: s0(x.givenNames),
  sex: s0(x.sex),
  age: nn(x.age),
  birthDate: sn(x.birthDate),
  phone: sn(x.phone),
  district: sn(x.district),
  sector: sn(x.sector),
  cell: sn(x.cell),
  village: sn(x.village),
  hasId: !!x.hasId,
  idType: sn(x.idType),
  registeredById: sn(x.registeredById),
  registeredBy: sn(x.registeredBy),
  registeredAt: s0(x.registeredAt),
  missing: strs(x.missing),
})

// ---------------------------------------------------------------- live

export async function fetchPatientsVisited(
  from: string,
  to: string,
  f: PatientReportFilters,
  clinical: boolean,
  manager: boolean,
): Promise<VisitedPatientRow[]> {
  if (!supabase) return sampleVisited(from, to, f, clinical, manager)
  const { data, error } = await supabase.rpc('report_patients_visited', {
    p_from: from,
    p_to: to,
    p_filters: clean(f),
    p_clinical: clinical,
  })
  if (error) throw apiError(error)
  return arr(obj(data).rows).map(toVisited)
}

export async function fetchVisitsReport(
  from: string,
  to: string,
  f: PatientReportFilters,
  clinical: boolean,
  manager: boolean,
): Promise<VisitReportRow[]> {
  if (!supabase) return sampleVisitRows(from, to, f, clinical, manager)
  const { data, error } = await supabase.rpc('report_visits', {
    p_from: from,
    p_to: to,
    p_filters: clean(f),
    p_clinical: clinical,
  })
  if (error) throw apiError(error)
  return arr(obj(data).rows).map(toVisit)
}

export async function fetchRegistrations(
  from: string,
  to: string,
  f: PatientReportFilters,
): Promise<RegistrationRow[]> {
  if (!supabase) return sampleRegistrations(from, to, f)
  const { data, error } = await supabase.rpc('report_new_registrations', {
    p_from: from,
    p_to: to,
    p_filters: clean(f),
  })
  if (error) throw apiError(error)
  return arr(obj(data).rows).map(toRegistration)
}

let optionsCache: Promise<PatientReportOptions> | null = null
/** The filters' choices, read once for every filter of the page (each filter asks for its list). */
export function fetchPatientReportOptions(): Promise<PatientReportOptions> {
  if (!supabase) return Promise.resolve(SAMPLE_OPTIONS)
  if (!optionsCache) {
    const client = supabase
    optionsCache = (async () => {
      const { data, error } = await client.rpc('report_patients_options')
      if (error) throw apiError(error)
      const d = obj(data)
      const idName = (v: unknown) => arr(v).map((x) => ({ id: s0(x.id), name: s0(x.name) }))
      return {
        departments: idName(d.departments),
        doctors: idName(d.doctors),
        services: strs(d.services),
        insurers: idName(d.insurers),
        districts: strs(d.districts),
        registrars: idName(d.registrars),
      }
    })()
    // a failure is not kept: the next filter asks again
    optionsCache.catch(() => {
      optionsCache = null
    })
    setTimeout(() => {
      optionsCache = null
    }, 60_000)
  }
  return optionsCache
}

/** The clinic's own fields of the patient file (Settings › Patient file). */
export async function fetchPatientFieldDefs(): Promise<PatientFieldDef[]> {
  if (!supabase) return SAMPLE_FIELDS
  const { data, error } = await supabase.rpc('patient_fields')
  if (error) throw apiError(error)
  return Array.isArray(data) ? (data as PatientFieldDef[]) : []
}

// ---------------------------------------------------------------- shared filters (sample mode)

const AGE_BANDS: [number, string][] = [
  [5, 'u5'],
  [15, '5-14'],
  [25, '15-24'],
  [50, '25-49'],
  [65, '50-64'],
]
export const ageBandOf = (age: number | null): string | null =>
  age == null ? null : (AGE_BANDS.find(([max]) => age < max)?.[1] ?? '65+')

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const has = (q: string, ...fields: (string | null | undefined)[]) =>
  fields.some((x) => x && norm(x).includes(norm(q)))

// ---------------------------------------------------------------- sample data

interface SamplePatient {
  id: string
  fileNumber: string
  surname: string
  givenNames: string
  sex: 'female' | 'male'
  birthDate: string
  phone: string
  phone2: string | null
  nationalId: string | null
  district: string
  sector: string
  cell: string
  village: string
  insurer: string | null
  extra: Record<string, string>
  /** Days before today the file was created. */
  registeredDaysAgo: number
  registeredBy: [string, string]
  missing: string[]
}

const RECEPTION: [string, string] = ['u-rec', 'Uwimana Josiane']
const NURSE: [string, string] = ['u-nurse', 'Nyirahabimana Chantal']
const SP = (
  n: number,
  surname: string,
  givenNames: string,
  sex: 'female' | 'male',
  birthDate: string,
  district: string,
  sector: string,
  insurer: string | null,
  extra: Record<string, string>,
  registeredDaysAgo: number,
  missing: string[] = [],
): SamplePatient => ({
  id: `p-${n}`,
  fileNumber: `MMC-${String(120 + n).padStart(6, '0')}`,
  surname,
  givenNames,
  sex,
  birthDate,
  phone: `078${String(8000000 + n * 137_911).slice(0, 7)}`,
  phone2: n % 3 === 0 ? `072${String(5000000 + n * 91_317).slice(0, 7)}` : null,
  nationalId:
    missing.includes('national_id') || Number(birthDate.slice(0, 4)) > 2008
      ? null
      : `1${birthDate.slice(0, 4)}${sex === 'female' ? 7 : 8}00${String(12345 + n * 1111).slice(0, 5)}0${String(10 + n).slice(-2)}`,
  district,
  sector,
  cell: ['Gakenke', 'Rubona', 'Nyagahanga', 'Kabeza'][n % 4]!,
  village: ['Rugarama', 'Kabuga', 'Nyarutovu', 'Akabuye', 'Gasharu'][n % 5]!,
  insurer,
  extra,
  registeredDaysAgo,
  registeredBy: n % 3 === 1 ? NURSE : RECEPTION,
  missing,
})

const SAMPLE_PATIENTS: SamplePatient[] = [
  SP(
    1,
    'Mukamana',
    'Alice',
    'female',
    '1994-03-12',
    'Gatsibo',
    'Kiramuruzi',
    'RSSB (CBHI)',
    { next_of_kin: 'Habimana Eric', church: 'ADEPR Kiramuruzi', chronic: 'None' },
    410,
  ),
  SP(
    2,
    'Rukundo',
    'Kevin',
    'male',
    '2019-07-02',
    'Gatsibo',
    'Kabarore',
    'RSSB (CBHI)',
    { next_of_kin: 'Uwase Claudine', church: 'Catholic', chronic: 'Asthma' },
    2,
  ),
  SP(
    3,
    'Uwase',
    'Claudine',
    'female',
    '1988-11-20',
    'Kayonza',
    'Mukarange',
    'RAMA',
    { next_of_kin: 'Rukundo Paul', church: 'Catholic', chronic: 'None' },
    380,
  ),
  SP(
    4,
    'Hakizimana',
    'Emmanuel',
    'male',
    '1961-01-05',
    'Gatsibo',
    'Kiramuruzi',
    'MMI',
    { church: 'Anglican', chronic: 'Hypertension' },
    650,
  ),
  SP(
    5,
    'Kayitesi',
    'Rose',
    'female',
    '2008-05-17',
    'Nyagatare',
    'Rukomo',
    null,
    { next_of_kin: 'Kayitesi Marie', chronic: 'None' },
    5,
    ['extra:church'],
  ),
  SP(
    6,
    'Niyonzima',
    'Jean Bosco',
    'male',
    '1979-09-30',
    'Rwamagana',
    'Muhazi',
    'RSSB (CBHI)',
    { church: 'Adventist', chronic: 'Diabetes' },
    21,
  ),
  SP(
    7,
    'Ingabire',
    'Diane',
    'female',
    '2000-02-14',
    'Gatsibo',
    'Ngarama',
    null,
    { church: 'ADEPR', chronic: 'None' },
    0,
    ['national_id'],
  ),
  SP(
    8,
    'Habimana',
    'Eric',
    'male',
    '1955-12-01',
    'Kayonza',
    'Kabarondo',
    'RAMA',
    { church: 'Catholic', chronic: 'Hypertension' },
    900,
  ),
  SP(
    9,
    'Mutoni',
    'Grace',
    'female',
    '2022-08-09',
    'Gatsibo',
    'Kiramuruzi',
    'RSSB (CBHI)',
    { next_of_kin: 'Mukamana Alice', church: 'Catholic', chronic: 'None' },
    1,
  ),
  SP(
    10,
    'Nshimiyimana',
    'Olivier',
    'male',
    '1997-04-23',
    'Nyagatare',
    'Karangazi',
    null,
    { chronic: 'None' },
    12,
    ['address', 'extra:church'],
  ),
  SP(
    11,
    'Uwimana',
    'Solange',
    'female',
    '1970-06-11',
    'Rwamagana',
    'Fumbwe',
    'MMI',
    { church: 'Anglican', chronic: 'HIV' },
    33,
  ),
  SP(
    12,
    'Bizimana',
    'Patrick',
    'male',
    '1946-10-03',
    'Gatsibo',
    'Kabarore',
    'RSSB (CBHI)',
    { church: 'Catholic', chronic: 'None' },
    1200,
  ),
]

const SAMPLE_DOCTORS = [
  { id: 'u-doc', name: 'Dr. Mukamana Béatrice' },
  { id: 'u-doc2', name: 'Dr. Habimana Jean' },
]
const SAMPLE_DEPTS = [
  { id: 'dep-consult', name: 'Consultation' },
  { id: 'dep-dental', name: 'Dental' },
  { id: 'dep-mch', name: 'Mother and child' },
]
const SAMPLE_DX = [
  'Malaria (B54)',
  'Upper respiratory tract infection (J06.9)',
  'Gastroenteritis (A09)',
  'Dental caries (K02.9)',
  'Hypertension (I10)',
  'Urinary tract infection (N39.0)',
]
const SAMPLE_FIELDS: PatientFieldDef[] = [
  { key: 'next_of_kin', label: 'Next of kin', type: 'text' },
  { key: 'church', label: 'Church / community', type: 'text', required: true },
  {
    key: 'chronic',
    label: 'Chronic condition',
    type: 'choice',
    options: ['None', 'Diabetes', 'Hypertension', 'HIV', 'Asthma', 'Epilepsy'],
    private: true,
  },
]
const SAMPLE_OPTIONS: PatientReportOptions = {
  departments: SAMPLE_DEPTS,
  doctors: SAMPLE_DOCTORS,
  services: ['consultation', 'dental', 'laboratory', 'ultrasound'],
  insurers: [
    { id: 'ins-cbhi', name: 'RSSB (CBHI)' },
    { id: 'ins-rama', name: 'RAMA' },
    { id: 'ins-mmi', name: 'MMI' },
  ],
  districts: ['Gatsibo', 'Kayonza', 'Nyagatare', 'Rwamagana'],
  registrars: [NURSE, RECEPTION].map(([id, name]) => ({ id, name })),
}

const DAY = 86_400_000
const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const ageAt = (birth: string, day: string) => {
  const [by, bm, bd] = birth.split('-').map(Number)
  const [y, m, d] = day.split('-').map(Number)
  return y! - by! - (m! < bm! || (m === bm && d! < bd!) ? 1 : 0)
}
const mask = (id: string | null) =>
  !id || id.length < 6 ? id : `${id.slice(0, 2)}${'•'.repeat(id.length - 5)}${id.slice(-3)}`

interface SampleVisit {
  row: VisitReportRow
  departmentId: string
  doctorId: string
  insurerId: string | null
}

/** The sample visits of a period: 3 to 6 a day, at most the last 120 days of it. */
function sampleVisits(from: string, to: string): SampleVisit[] {
  const end = Math.min(Date.parse(`${to}T00:00:00`), Date.now())
  const start = Math.max(Date.parse(`${from}T00:00:00`), end - 119 * DAY)
  const out: SampleVisit[] = []
  let seq = 400
  for (let t0 = start; t0 <= end; t0 += DAY) {
    const d = new Date(t0)
    const dayNo = Math.floor(t0 / DAY)
    const n = 3 + (dayNo % 4)
    for (let k = 0; k < n; k++) {
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 8 + k, (k * 17 + dayNo) % 60)
      if (at.getTime() > Date.now()) continue
      const p = SAMPLE_PATIENTS[(dayNo * 5 + k * 7) % SAMPLE_PATIENTS.length]!
      const doc = SAMPLE_DOCTORS[(k + dayNo) % 2]!
      const dental = (k + dayNo) % 5 === 0
      const mch = !dental && ageAt(p.birthDate, isoDay(d)) < 5
      const dept = dental ? SAMPLE_DEPTS[1]! : mch ? SAMPLE_DEPTS[2]! : SAMPLE_DEPTS[0]!
      const today = isoDay(d) === isoDay(new Date())
      const status =
        today && k >= n - 2 ? 'open' : (k + dayNo) % 11 === 0 ? 'left_unseen' : 'finished'
      const lab = (k + dayNo) % 3 === 0
      const route =
        status === 'left_unseen'
          ? ['reception', 'triage']
          : [
              'reception',
              'triage',
              dental ? 'dental' : 'consultation',
              ...(lab ? ['laboratory'] : []),
              'cashier',
              'pharmacy',
            ]
      const billed = status === 'left_unseen' ? 0 : 4000 + ((k * 3 + dayNo) % 6) * 2500
      const insurerShare = p.insurer ? Math.round(billed * 0.85) : 0
      const patientShare = billed - insurerShare
      const paid =
        status === 'open' ? 0 : (k + dayNo) % 7 === 0 ? Math.floor(patientShare / 2) : patientShare
      seq += 1
      out.push({
        departmentId: dept.id,
        doctorId: doc.id,
        insurerId: SAMPLE_OPTIONS.insurers.find((i) => i.name === p.insurer)?.id ?? null,
        row: {
          id: `e-${seq}`,
          reference: `V-${d.getFullYear()}-${String(seq).padStart(6, '0')}`,
          at: at.toISOString(),
          closedAt: status === 'open' ? null : new Date(at.getTime() + 95 * 60_000).toISOString(),
          status,
          type: dental ? 'dental' : 'opd',
          service: dental ? 'dental' : 'consultation',
          triage: (['green', 'green', 'yellow', 'green', 'red'] as const)[(k + dayNo) % 5]!,
          patientId: p.id,
          patient: `${p.surname} ${p.givenNames}`,
          fileNumber: p.fileNumber,
          sex: p.sex,
          age: ageAt(p.birthDate, isoDay(d)),
          ageBand: ageBandOf(ageAt(p.birthDate, isoDay(d))),
          district: p.district,
          route,
          department: dept.name,
          doctor: status === 'left_unseen' ? null : doc.name,
          insurer: p.insurer,
          isNew: false,
          diagnosis: status === 'finished' ? SAMPLE_DX[(k + dayNo) % SAMPLE_DX.length]! : null,
          billed,
          insurerShare,
          patientShare,
          paid,
          balance: patientShare - paid,
        },
      })
    }
  }
  // the first visit ever of each sample patient (in the sample's 120 days) is "new"
  const seen = new Set<string>()
  for (const v of out) {
    if (
      !seen.has(v.row.patientId) &&
      SAMPLE_PATIENTS.find((p) => p.id === v.row.patientId)!.registeredDaysAgo < 120
    )
      v.row.isNew = true
    seen.add(v.row.patientId)
  }
  return out
}

/** The visit filters (department, desk, doctor, service, insurer, status). */
const visitMatches = (v: SampleVisit, f: PatientReportFilters) =>
  (!f.department || v.departmentId === f.department) &&
  (!f.desk || v.row.route.includes(f.desk)) &&
  (!f.doctor || v.doctorId === f.doctor) &&
  (!f.service || v.row.service === f.service) &&
  (!f.insurer || v.insurerId === f.insurer) &&
  (!f.status || v.row.status === f.status)

function sampleVisitRows(
  from: string,
  to: string,
  f: PatientReportFilters,
  clinical: boolean,
  manager: boolean,
): VisitReportRow[] {
  return sampleVisits(from, to)
    .filter((v) => visitMatches(v, f))
    .map((v) => v.row)
    .filter(
      (v) =>
        (!f.sex || v.sex === f.sex) &&
        (!f.ageBand || v.ageBand === f.ageBand) &&
        (!f.kind || (f.kind === 'new') === v.isNew) &&
        (!f.district || v.district?.toLowerCase() === f.district.toLowerCase()) &&
        (!f.search || has(f.search, v.patient, v.fileNumber, v.reference)),
    )
    .map((v) => ({
      ...v,
      diagnosis: clinical ? v.diagnosis : null,
      ...(manager
        ? {}
        : { billed: null, insurerShare: null, patientShare: null, paid: null, balance: null }),
    }))
}

function sampleVisited(
  from: string,
  to: string,
  f: PatientReportFilters,
  clinical: boolean,
  manager: boolean,
): VisitedPatientRow[] {
  const visits = sampleVisits(from, to).filter((v) => visitMatches(v, f))
  const byPatient = new Map<string, SampleVisit[]>()
  for (const v of visits)
    byPatient.set(v.row.patientId, [...(byPatient.get(v.row.patientId) ?? []), v])
  const rows: VisitedPatientRow[] = []
  for (const [id, list] of byPatient) {
    const p = SAMPLE_PATIENTS.find((x) => x.id === id)!
    const age = ageAt(p.birthDate, to)
    const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort()
    rows.push({
      patientId: p.id,
      fileNumber: p.fileNumber,
      surname: p.surname,
      givenNames: p.givenNames,
      sex: p.sex,
      age,
      ageBand: ageBandOf(age),
      birthDate: p.birthDate,
      phone: p.phone,
      phone2: p.phone2,
      nationalId: manager ? p.nationalId : mask(p.nationalId),
      province: 'eastern',
      district: p.district,
      sector: p.sector,
      cell: p.cell,
      village: p.village,
      insurer: p.insurer,
      firstVisit: list[0]!.row.at,
      lastVisit: list[list.length - 1]!.row.at,
      visits: list.length,
      isNew: list.some((v) => v.row.isNew),
      departments: uniq(list.map((v) => v.row.department)),
      desks: uniq(list.flatMap((v) => v.row.route)),
      doctors: uniq(list.map((v) => v.row.doctor)),
      diagnoses: clinical ? uniq(list.map((v) => v.row.diagnosis)) : null,
      extra: manager || clinical ? p.extra : { ...p.extra, chronic: undefined },
    })
  }
  return rows
    .filter(
      (r) =>
        (!f.sex || r.sex === f.sex) &&
        (!f.ageBand || r.ageBand === f.ageBand) &&
        (!f.kind || (f.kind === 'new') === r.isNew) &&
        (!f.district || r.district?.toLowerCase() === f.district.toLowerCase()) &&
        (!f.search || has(f.search, `${r.surname} ${r.givenNames}`, r.fileNumber, r.phone)),
    )
    .sort((a, b) => `${a.surname} ${a.givenNames}`.localeCompare(`${b.surname} ${b.givenNames}`))
}

function sampleRegistrations(from: string, to: string, f: PatientReportFilters): RegistrationRow[] {
  const now = Date.now()
  return SAMPLE_PATIENTS.map((p, i) => {
    const at = new Date(now - p.registeredDaysAgo * DAY)
    at.setHours(8 + (i % 8), (i * 13) % 60, 0, 0)
    return { p, at }
  })
    .filter(({ at }) => isoDay(at) >= from && isoDay(at) <= to && at.getTime() <= now)
    .map(({ p, at }) => ({
      patientId: p.id,
      fileNumber: p.fileNumber,
      surname: p.surname,
      givenNames: p.givenNames,
      sex: p.sex,
      age: ageAt(p.birthDate, to),
      birthDate: p.birthDate,
      phone: p.phone,
      district: p.district,
      sector: p.missing.includes('address') ? null : p.sector,
      cell: p.cell,
      village: p.village,
      hasId: !!p.nationalId || ageAt(p.birthDate, to) < 16,
      idType: p.nationalId ? 'national_id' : null,
      registeredById: p.registeredBy[0],
      registeredBy: p.registeredBy[1],
      registeredAt: at.toISOString(),
      missing: p.missing,
    }))
    .filter(
      (r) =>
        (!f.registeredBy || r.registeredById === f.registeredBy) &&
        (!f.missingOnly || r.missing.length > 0) &&
        (!f.sex || r.sex === f.sex) &&
        (!f.search || has(f.search, `${r.surname} ${r.givenNames}`, r.fileNumber, r.phone)),
    )
    .sort((a, b) => a.registeredAt.localeCompare(b.registeredAt))
}

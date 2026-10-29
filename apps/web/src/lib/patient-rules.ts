/**
 * The patient file's fields (0108): which built-in fields the clinic shows, hides or requires
 * (setting `patient.builtins`), the identity rules by ID type and what a file still needs. The
 * same rules as the database (patient_identity, patient_required_keys, patient_missing_with in
 * 20261218090000_reception_and_fields): the forms say it first, the database refuses the same.
 */

/** The built-in fields the manager may show, hide or require, in the order of the forms. */
export const BUILTIN_FIELDS = [
  'national_id',
  'phone_1',
  'phone_2',
  'email',
  'province',
  'district',
  'sector',
  'cell',
  'village',
  'occupation',
  'marital_status',
  'ubudehe_category',
  'emergency',
] as const
export type BuiltinField = (typeof BUILTIN_FIELDS)[number]
export type FieldState = 'shown' | 'hidden' | 'required'
export type BuiltinStates = Record<BuiltinField, FieldState>

/** As the file was before 0108; the fields new in 0108 start hidden. */
export const BUILTIN_DEFAULTS: BuiltinStates = {
  national_id: 'shown',
  phone_1: 'shown',
  phone_2: 'shown',
  email: 'hidden',
  province: 'hidden',
  district: 'shown',
  sector: 'shown',
  cell: 'shown',
  village: 'shown',
  occupation: 'shown',
  marital_status: 'hidden',
  ubudehe_category: 'shown',
  emergency: 'shown',
}

/** The saved settings over the defaults; anything unknown is left out. */
export function withDefaults(raw: unknown): BuiltinStates {
  const out = { ...BUILTIN_DEFAULTS }
  if (raw && typeof raw === 'object')
    for (const k of BUILTIN_FIELDS) {
      const v = (raw as Record<string, unknown>)[k]
      if (v === 'shown' || v === 'hidden' || v === 'required') out[k] = v
    }
  return out
}

/** The registration form shows these at once; the other optional ones under "More details". */
export const MAIN_FIELDS: readonly BuiltinField[] = ['national_id', 'phone_1', 'sector']

export const MARITAL_STATUSES = ['single', 'married', 'widowed', 'divorced', 'separated'] as const
/** Rwanda's provinces, stored by these codes. */
export const PROVINCES = ['kigali', 'northern', 'southern', 'eastern', 'western'] as const

// ---------------------------------------------------------------- identity
/** The ID document: a number of some type, or why there is none. */
export const ID_KINDS = [
  'national_id',
  'passport',
  'other',
  'child',
  'not_issued',
  'foreigner',
] as const
export type IdKind = (typeof ID_KINDS)[number]
export const NO_ID_KINDS: readonly IdKind[] = ['child', 'not_issued', 'foreigner']

export const NATIONAL_ID_LENGTH = 16
/** A typed or pasted national ID: digits only ("1 1990 8 0012345 0 12" → 16 digits). */
export const nationalIdDigits = (s: string) => s.replace(/\D/g, '')
/** Shown grouped as on the card: 1 1990 8 0012345 0 12. */
export function groupNationalId(digits: string | null | undefined): string {
  const d = (digits ?? '').trim()
  if (!/^\d{16}$/.test(d)) return d
  return `${d.slice(0, 1)} ${d.slice(1, 5)} ${d.slice(5, 6)} ${d.slice(6, 13)} ${d.slice(13, 14)} ${d.slice(14)}`
}
/** A passport or other ID number: letters and digits, upper case, at most 20. */
export const cleanIdNumber = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 20)
export const ID_NUMBER_MIN = 6
export const ID_NUMBER_MAX = 20
export const isIdNumber = (s: string) => /^[A-Z0-9]{6,20}$/.test(s)
export const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim())

// ---------------------------------------------------------------- the form
/** One manager field: its key, its label, whether it is required (the order is the list's). */
export interface ExtraDef {
  key: string
  label: string
  required?: boolean
}

/** What the registration and edit forms hold, by the database's column names. */
export interface PatientDraft {
  surname: string
  given_names: string
  sex: string
  birth_date: string
  age_years: string
  id_kind: IdKind
  national_id: string
  id_number: string
  phone_1: string
  phone_2: string
  email: string
  province: string
  district: string
  sector: string
  cell: string
  village: string
  occupation: string
  marital_status: string
  ubudehe_category: string
  emergency_name: string
  emergency_phone: string
  extra: Record<string, string>
}

/** A file as the database sends it (the fields the rules read). */
export interface PatientLike {
  birth_date?: string | null
  national_id?: string | null
  id_type?: string | null
  id_number?: string | null
  no_national_id?: string | null
  phone_1?: string | null
  phone_2?: string | null
  email?: string | null
  province?: string | null
  district?: string | null
  sector?: string | null
  cell?: string | null
  village?: string | null
  occupation?: string | null
  marital_status?: string | null
  ubudehe_category?: number | string | null
  emergency_name?: string | null
  emergency_phone?: string | null
  extra?: Record<string, string> | null
}

export const emptyDraft = (): PatientDraft => ({
  surname: '',
  given_names: '',
  sex: '',
  birth_date: '',
  age_years: '',
  id_kind: 'national_id',
  national_id: '',
  id_number: '',
  phone_1: '',
  phone_2: '',
  email: '',
  province: '',
  district: '',
  sector: '',
  cell: '',
  village: '',
  occupation: '',
  marital_status: '',
  ubudehe_category: '',
  emergency_name: '',
  emergency_phone: '',
  extra: {},
})

/** The ID kind of a file: its "no ID" reason, else its document type (national ID before 0108). */
export function idKindOf(p: PatientLike): IdKind {
  if (p.no_national_id && (NO_ID_KINDS as string[]).includes(p.no_national_id))
    return p.no_national_id as IdKind
  if (p.id_type === 'passport' || p.id_type === 'other') return p.id_type
  return 'national_id'
}

const s = (v: string | number | null | undefined) => (v == null ? '' : String(v))

/** The draft of an existing file (Edit details); the manager's fields by key (or label, as before). */
export function draftOf(
  p: PatientLike & { surname: string; given_names: string; sex: string },
  defs: ExtraDef[],
): PatientDraft {
  const extra: Record<string, string> = { ...(p.extra ?? {}) }
  for (const d of defs)
    if (extra[d.key] === undefined && extra[d.label] !== undefined) {
      extra[d.key] = extra[d.label]!
      if (d.key !== d.label) delete extra[d.label]
    }
  return {
    surname: p.surname,
    given_names: p.given_names,
    sex: p.sex,
    birth_date: s(p.birth_date),
    age_years: '',
    id_kind: idKindOf(p),
    national_id: s(p.national_id).trim(),
    id_number: s(p.id_number),
    phone_1: s(p.phone_1),
    phone_2: s(p.phone_2),
    email: s(p.email),
    province: s(p.province),
    district: s(p.district),
    sector: s(p.sector),
    cell: s(p.cell),
    village: s(p.village),
    occupation: s(p.occupation),
    marital_status: s(p.marital_status),
    ubudehe_category: s(p.ubudehe_category),
    emergency_name: s(p.emergency_name),
    emergency_phone: s(p.emergency_phone),
    extra,
  }
}

/** Under 16 (the date of birth, or the age typed): no ID is expected. */
function isChild(birth: string | null | undefined, ageYears?: string): boolean {
  if (birth) {
    const b = new Date(birth)
    if (Number.isNaN(b.getTime())) return false
    const sixteen = new Date()
    sixteen.setFullYear(sixteen.getFullYear() - 16)
    return b > sixteen
  }
  return ageYears != null && ageYears !== '' && Number(ageYears) < 16
}

const blank = (v: string | number | null | undefined) => s(v).trim() === ''

/** The draft as a file, for the same rules as a saved file. */
export function asFile(d: PatientDraft): PatientLike {
  const noId = (NO_ID_KINDS as string[]).includes(d.id_kind)
  return {
    birth_date: d.birth_date || null,
    national_id: d.id_kind === 'national_id' ? d.national_id || null : null,
    id_type: noId ? 'national_id' : d.id_kind,
    id_number: d.id_kind === 'passport' || d.id_kind === 'other' ? d.id_number || null : null,
    no_national_id: noId ? d.id_kind : null,
    phone_1: d.phone_1,
    phone_2: d.phone_2,
    email: d.email,
    province: d.province,
    district: d.district,
    sector: d.sector,
    cell: d.cell,
    village: d.village,
    occupation: d.occupation,
    marital_status: d.marital_status,
    ubudehe_category: d.ubudehe_category,
    emergency_name: d.emergency_name,
    emergency_phone: d.emergency_phone,
    extra: d.extra,
  }
}

function hasId(p: PatientLike, ageYears?: string): boolean {
  return (
    !blank(p.national_id) ||
    !blank(p.id_number) ||
    !blank(p.no_national_id) ||
    isChild(p.birth_date, ageYears)
  )
}

/**
 * The required fields a file lacks, as the keys of `files.missing.*` (extra:<key> for the
 * manager's fields, in their order). Mirrors patient_required_keys().
 */
export function requiredMissing(
  p: PatientLike,
  states: BuiltinStates,
  defs: ExtraDef[],
  ageYears?: string,
): string[] {
  const req = (k: BuiltinField) => states[k] === 'required'
  const out: string[] = []
  if (req('national_id') && !hasId(p, ageYears)) out.push('national_id')
  if (req('phone_1') && blank(p.phone_1)) out.push('phone')
  if (req('phone_2') && blank(p.phone_2)) out.push('phone_2')
  if (req('email') && blank(p.email)) out.push('email')
  if (req('province') && blank(p.province)) out.push('province')
  if (req('district') && blank(p.district)) out.push('district')
  if (req('sector') && blank(p.sector)) out.push('address')
  if (req('cell') && blank(p.cell)) out.push('cell')
  if (req('village') && blank(p.village)) out.push('village')
  if (req('occupation') && blank(p.occupation)) out.push('occupation')
  if (req('marital_status') && blank(p.marital_status)) out.push('marital_status')
  if (req('ubudehe_category') && blank(p.ubudehe_category)) out.push('ubudehe_category')
  if (req('emergency') && (blank(p.emergency_name) || blank(p.emergency_phone)))
    out.push('emergency')
  for (const d of defs)
    if (d.required && blank(p.extra?.[d.key] ?? p.extra?.[d.label])) out.push(`extra:${d.key}`)
  return out
}

/**
 * What the file still needs: phone, ID and address (unless hidden), the age, then whatever the
 * clinic made required. Mirrors patient_missing_with().
 */
export function fileMissing(p: PatientLike, states: BuiltinStates, defs: ExtraDef[]): string[] {
  const out: string[] = []
  if (states.phone_1 !== 'hidden' && blank(p.phone_1)) out.push('phone')
  if (states.national_id !== 'hidden' && !hasId(p)) out.push('national_id')
  if (states.sector !== 'hidden' && blank(p.sector)) out.push('address')
  if (!p.birth_date) out.push('age')
  for (const k of requiredMissing(p, states, defs)) if (!out.includes(k)) out.push(k)
  return out
}

/**
 * The first thing wrong with a draft, as an i18n key (with its values), before the database says
 * it: the names, the date of birth or age, the ID by its type, the e-mail. Null when fine.
 */
export function draftProblem(
  d: PatientDraft,
  states: BuiltinStates,
): { key: string; values?: Record<string, string | number> } | null {
  if (d.surname.trim().length < 2 || d.given_names.trim().length < 2)
    return { key: 'patientFields.errors.names' }
  if (!d.sex) return { key: 'patientFields.errors.sex' }
  if (!d.birth_date && d.age_years === '') return { key: 'patientFields.errors.age' }
  if (d.birth_date && new Date(d.birth_date) > new Date())
    return { key: 'patientFields.errors.future' }
  if (!d.birth_date && Number(d.age_years) > 130) return { key: 'patientFields.errors.ageRange' }
  if (states.national_id !== 'hidden') {
    if (d.id_kind === 'national_id' && d.national_id && d.national_id.length !== 16)
      return {
        key: 'patientFields.errors.nationalId',
        values: { count: d.national_id.length },
      }
    if (
      (d.id_kind === 'passport' || d.id_kind === 'other') &&
      d.id_number &&
      !isIdNumber(d.id_number)
    )
      return { key: 'patientFields.errors.idNumber' }
  }
  if (states.email !== 'hidden' && d.email.trim() && !isEmail(d.email))
    return { key: 'patientFields.errors.email' }
  return null
}

/**
 * The draft for the database: the built-in fields shown (a hidden one is left as it is), the
 * identity by its kind, the manager's fields that hold a value.
 */
export function draftPayload(d: PatientDraft, states: BuiltinStates): Record<string, unknown> {
  const out: Record<string, unknown> = {
    surname: d.surname.trim(),
    given_names: d.given_names.trim(),
    sex: d.sex || 'unknown',
  }
  if (d.birth_date) out.birth_date = d.birth_date
  else if (d.age_years !== '') out.age_years = Number(d.age_years)
  if (states.national_id !== 'hidden') {
    const noId = (NO_ID_KINDS as string[]).includes(d.id_kind)
    out.id_type = noId ? 'national_id' : d.id_kind
    out.national_id = d.id_kind === 'national_id' ? d.national_id : ''
    out.id_number = d.id_kind === 'passport' || d.id_kind === 'other' ? d.id_number : ''
    out.no_national_id = noId ? d.id_kind : ''
  }
  const text: [BuiltinField, (keyof PatientDraft)[]][] = [
    ['phone_1', ['phone_1']],
    ['phone_2', ['phone_2']],
    ['email', ['email']],
    ['province', ['province']],
    ['district', ['district']],
    ['sector', ['sector']],
    ['cell', ['cell']],
    ['village', ['village']],
    ['occupation', ['occupation']],
    ['marital_status', ['marital_status']],
    ['ubudehe_category', ['ubudehe_category']],
    ['emergency', ['emergency_name', 'emergency_phone']],
  ]
  for (const [field, keys] of text)
    if (states[field] !== 'hidden') for (const k of keys) out[k] = String(d[k]).trim()
  out.extra = Object.fromEntries(
    Object.entries(d.extra)
      .map(([k, v]) => [k, v.trim()] as const)
      .filter(([, v]) => v !== ''),
  )
  return out
}

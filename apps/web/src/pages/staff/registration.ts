import {
  REGISTRATION_BODIES,
  type DbRole,
  type Employee,
  type EmployeeInput,
} from '@/lib/api/staff'

/** The roles that hold a professional council registration (printed on what they sign). */
export const CLINICAL_ROLES: readonly DbRole[] = [
  'doctor',
  'nurse',
  'sonographer',
  'lab_tech',
  'pharmacist',
]

/** The council a role usually registers with (the form starts on it). */
const ROLE_BODY: Partial<Record<DbRole, (typeof REGISTRATION_BODIES)[number]>> = {
  doctor: 'RMDC',
  nurse: 'NCNM',
  pharmacist: 'NPC',
  lab_tech: 'RAHPC',
  sonographer: 'RAHPC',
}

/** The limits manage-staff checks (0084). */
export const REGISTRATION_NO_MAX = 40
export const REGISTRATION_BODY_MAX = 60

export const OTHER = 'other'
const isKnownBody = (b: string): boolean =>
  (REGISTRATION_BODIES as readonly string[]).includes(b.toUpperCase())

/** What the form holds: the number, the council chosen ('' none, 'other' written below). */
export interface RegistrationValue {
  no: string
  body: string
  otherBody: string
}

/** The form's starting value: the employee's registration, or the role's usual council. */
export const registrationStart = (employee: Employee | null, role: DbRole): RegistrationValue => {
  const no = employee?.registrationNo ?? ''
  const body = employee?.registrationBody?.trim() ?? ''
  if (!body) return { no, body: no ? '' : (ROLE_BODY[role] ?? ''), otherBody: '' }
  return isKnownBody(body)
    ? { no, body: body.toUpperCase(), otherBody: '' }
    : { no, body: OTHER, otherBody: body }
}

/** When the role changes and no number is typed yet, the council follows the new role. */
export const registrationForRole = (v: RegistrationValue, role: DbRole): RegistrationValue =>
  v.no.trim() ? v : { ...v, body: ROLE_BODY[role] ?? '', otherBody: '' }

/** The council as it will be saved ('' when no number). */
export const resolvedBody = (v: RegistrationValue): string =>
  !v.no.trim() ? '' : v.body === OTHER ? v.otherBody.trim() : v.body

/** Whether the field is shown: clinical roles, or anyone who already has a number (to clear it). */
export const showsRegistration = (role: DbRole, v: RegistrationValue): boolean =>
  CLINICAL_ROLES.includes(role) || !!v.no.trim()

/** The translation key of what is wrong, or null. */
export const registrationError = (v: RegistrationValue): string | null => {
  const no = v.no.trim()
  if (!no) return null
  if (no.length > REGISTRATION_NO_MAX) return 'staff.errors.registrationNo'
  if (v.body === OTHER && !v.otherBody.trim()) return 'staff.errors.registrationBody'
  if (resolvedBody(v).length > REGISTRATION_BODY_MAX) return 'staff.errors.registrationBody'
  return null
}

/**
 * The registration fields for EmployeeInput: only when they changed (undefined = leave
 * unchanged, so saving someone else's details never rewrites the registration).
 */
export const registrationInput = (
  v: RegistrationValue,
  employee: Employee | null,
): Pick<EmployeeInput, 'registrationNo' | 'registrationBody'> => {
  const no = v.no.trim()
  const body = resolvedBody(v)
  const out: Pick<EmployeeInput, 'registrationNo' | 'registrationBody'> = {}
  if (no !== (employee?.registrationNo?.trim() ?? '')) out.registrationNo = no
  if (body !== (employee?.registrationBody?.trim() ?? '')) out.registrationBody = body
  return out
}

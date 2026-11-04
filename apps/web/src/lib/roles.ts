import type { TFunction } from 'i18next'
import type { StaffUser } from '@mmc/shared'

/**
 * 0126: patient records (notes, diagnoses, prescriptions history, results, attachments, medical
 * documents, past visits) are for doctors: the profession 'doctor' (0128), or an employee the
 * manager marked a doctor before 0128. The database decides; the screens follow.
 */
export const isDoctorUser = (
  user: Pick<StaffUser, 'role' | 'dbRole' | 'isDoctor'> | null | undefined,
) => !!user && (user.isDoctor ?? (user.dbRole ?? user.role) === 'doctor')

/** Emergency registration queues the patient for treatment on the spot: treating professions
 *  only (0128: the clinic manager by profession too; an administrator does not treat). */
export const canRegisterEmergency = (user: StaffUser) =>
  !['receptionist', 'cashier', 'administrator'].includes(user.dbRole ?? user.role)

type TLike = (key: string, opts?: Record<string, unknown>) => string

/** The specialties offered per profession (0128); anything else is "Other", typed. The value saved
 *  is the English name (the website calendar shows it); the screens translate the known ones. */
export const SPECIALTIES: Readonly<Partial<Record<string, readonly string[]>>> = {
  doctor: [
    'General practitioner',
    'Dentist',
    'Surgeon',
    'Gynaecologist / obstetrician',
    'Paediatrician',
    'Radiologist',
    'Ophthalmologist',
    'Internist',
  ],
  nurse: ['General nurse', 'Anaesthetic nurse', 'Paediatric nurse'],
  midwife: ['Midwife'],
}
const SPECIALTY_KEY: Readonly<Record<string, string>> = {
  'general practitioner': 'generalPractitioner',
  dentist: 'dentist',
  surgeon: 'surgeon',
  'gynaecologist / obstetrician': 'gynaecologist',
  paediatrician: 'paediatrician',
  radiologist: 'radiologist',
  ophthalmologist: 'ophthalmologist',
  internist: 'internist',
  'general nurse': 'generalNurse',
  'anaesthetic nurse': 'anaestheticNurse',
  'paediatric nurse': 'paediatricNurse',
  midwife: 'midwife',
}

/** A specialty in the reader's language when it is one of the lists, else as typed. */
export const specialtyLabel = (s: string | null | undefined, t: TFunction | TLike): string => {
  const v = s?.trim() ?? ''
  const k = SPECIALTY_KEY[v.toLowerCase()]
  return k ? (t as TLike)(`specialties.${k}`) : v
}

/**
 * "Doctor · Dentist · Clinic manager" (0128): the profession, what the person is expert in, and
 * "Clinic manager" when they are also the clinic manager. Wherever a colleague is named with what
 * they are: the Employees list, the profile, History, the pickers.
 */
export function professionLabel(
  p: { role: string; specialty?: string | null; isManager?: boolean | null },
  t: TFunction | TLike,
): string {
  const tt = t as TLike
  // an account the database has not moved yet (the role 'manager' before 0128)
  if (p.role === 'manager') return tt('roles.clinicManager')
  const base = tt(`staff.roles.${p.role}`, { defaultValue: p.role })
  const spec = specialtyLabel(p.specialty, t)
  const parts = [base]
  // "Midwife · Midwife" says it once
  if (spec && spec.toLowerCase() !== base.toLowerCase()) parts.push(spec)
  if (p.isManager) parts.push(tt('roles.clinicManager'))
  return parts.join(' · ')
}

/**
 * "Doctor · Dentist", "Nurse · Paediatric nurse", "Doctor · Consultation 1", "Head of Dental",
 * "Doctor · General practitioner · Clinic manager", "Sonographer".
 * The specialty or title (what the person is expert in) goes with the profession; a doctor without
 * one shows the desk instead. Heads are named by the department they lead. The clinic manager is
 * named by profession, then "Clinic manager" (0128).
 */
export function roleLabel(
  user: StaffUser & { specialty?: string | null },
  t: TFunction,
  specialty: string | null = user.specialty ?? null,
): string {
  if (user.isManager || user.role === 'manager') {
    const profession = user.dbRole && user.dbRole !== 'manager' ? user.dbRole : null
    if (!profession) return t('roles.clinicManager')
    return professionLabel({ role: profession, specialty, isManager: true }, t)
  }
  if (user.dashboard === 'head' && user.headOf) return t('roles.headOf', { station: user.headOf })
  // a sonographer has the laboratory's pages but is named for what they are (a midwife and an
  // administrator likewise)
  const base =
    user.dbRole && user.dbRole !== user.role
      ? t(`staff.roles.${user.dbRole}`)
      : t(`roles.${user.role}`)
  const extra = specialtyLabel(specialty, t) || (user.role === 'doctor' ? user.station : undefined)
  // "Sonographer · Sonographer" says it once
  return extra && extra.toLowerCase() !== base.toLowerCase()
    ? t('roles.withStation', { role: base, station: extra })
    : base
}

/** Staff routes a user lands on when switched to. */
export const homeRouteFor = (user: StaffUser): '/app' | '/app/dashboard' =>
  user.role === 'manager' ? '/app/dashboard' : '/app'

const camel = (kebab: string): string =>
  kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/** `/app/direct-sales` → `nav.directSales`. */
export const navKeyForSection = (section: string): string => `nav.${camel(section)}`

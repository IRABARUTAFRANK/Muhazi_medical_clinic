import type { TFunction } from 'i18next'
import type { StaffUser } from '@mmc/shared'

/** Emergency registration queues the patient for treatment on the spot: treating staff only. */
export const canRegisterEmergency = (user: StaffUser) =>
  user.role !== 'receptionist' && user.role !== 'cashier'

/**
 * "Doctor · Dentist", "Nurse · Midwife", "Doctor · Consultation 1", "Head of Dental", "Nurse",
 * "Sonographer".
 * The specialty or title (what the person is expert in) goes with the role; a doctor without
 * one shows the desk instead. Heads are named by the department they lead.
 */
export function roleLabel(
  user: StaffUser & { specialty?: string | null },
  t: TFunction,
  specialty: string | null = user.specialty ?? null,
): string {
  if (user.dashboard === 'head' && user.headOf) return t('roles.headOf', { station: user.headOf })
  // a sonographer has the laboratory's pages but is named for what they are
  const base =
    user.dbRole === 'sonographer' ? t('staff.roles.sonographer') : t(`roles.${user.role}`)
  const extra = specialty?.trim() || (user.role === 'doctor' ? user.station : undefined)
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

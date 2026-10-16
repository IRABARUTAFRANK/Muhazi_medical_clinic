import type { TFunction } from 'i18next'
import type { StaffUser } from '@mmc/shared'

/** "Doctor · Consultation 1", "Head of Dental", "Manager / Owner", "Nurse". */
export function roleLabel(user: StaffUser, t: TFunction): string {
  if (user.dashboard === 'head' && user.headOf) return t('roles.headOf', { station: user.headOf })
  const base = t(`roles.${user.role}`)
  if (user.role === 'doctor' && user.station) {
    return t('roles.withStation', { role: base, station: user.station })
  }
  return base
}

/** Staff routes a user lands on when switched to. */
export const homeRouteFor = (user: StaffUser): '/app' | '/app/dashboard' =>
  user.role === 'manager' ? '/app/dashboard' : '/app'

const camel = (kebab: string): string =>
  kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/** `/app/direct-sales` → `nav.directSales`. */
export const navKeyForSection = (section: string): string => `nav.${camel(section)}`

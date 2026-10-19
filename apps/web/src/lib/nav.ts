import { ROLE_HOME, type NavItem, type StaffUser } from '@mmc/shared'

/** Every role's rail ends with the notifications page (inbox, filters; manager: sent). */
const NOTICES: NavItem = {
  id: 'notifications',
  labelKey: 'nav.notifications',
  icon: 'bell',
  to: '/app/notifications',
}

/**
 * Manager rail (the dashboard is the manager's home page, doc §12.3). The manager runs the
 * whole clinic and can work at any station, so every operation has its own entry, in the
 * order a patient moves: register → triage → in the clinic (open visits) → patient files,
 * then the clinic's own management (prices, employees, settings).
 */
export const MANAGER_NAV: NavItem[] = [
  { id: 'dashboard', labelKey: 'nav.dashboard', icon: 'layout-dashboard', to: '/app/dashboard' },
  { id: 'register', labelKey: 'nav.register', icon: 'user-plus', to: '/app/register' },
  { id: 'vitals', labelKey: 'nav.triage', icon: 'activity', to: '/app/vitals' },
  { id: 'visits', labelKey: 'nav.inClinic', icon: 'stethoscope', to: '/app/visits' },
  { id: 'appointments', labelKey: 'nav.bookings', icon: 'calendar', to: '/app/appointments' },
  { id: 'patients', labelKey: 'nav.patients', icon: 'users', to: '/app/patients' },
  { id: 'prices', labelKey: 'nav.prices', icon: 'receipt', to: '/app/prices' },
  { id: 'staff', labelKey: 'nav.staff', icon: 'id-card', to: '/app/staff' },
  NOTICES,
  { id: 'settings', labelKey: 'nav.settings', icon: 'settings', to: '/app/settings' },
]

/** Front desk: the dashboard, then the patient's path from the door. */
export const RECEPTION_NAV: NavItem[] = [
  { id: 'home', labelKey: 'nav.home', icon: 'layout-dashboard', to: '/app' },
  { id: 'register', labelKey: 'nav.register', icon: 'user-plus', to: '/app/register' },
  // Typing in the vitals a nurse wrote on paper when she had no device.
  { id: 'vitals', labelKey: 'nav.triage', icon: 'activity', to: '/app/vitals' },
  { id: 'visits', labelKey: 'nav.inClinic', icon: 'stethoscope', to: '/app/visits' },
  { id: 'appointments', labelKey: 'nav.bookings', icon: 'calendar', to: '/app/appointments' },
  { id: 'patients', labelKey: 'nav.patients', icon: 'users', to: '/app/patients' },
  NOTICES,
]

/** Nursing: the dashboard, triage first, then everyone in the clinic and the files. */
export const NURSE_NAV: NavItem[] = [
  { id: 'home', labelKey: 'nav.home', icon: 'layout-dashboard', to: '/app' },
  { id: 'vitals', labelKey: 'nav.triage', icon: 'activity', to: '/app/vitals' },
  { id: 'register', labelKey: 'nav.register', icon: 'user-plus', to: '/app/register' },
  { id: 'visits', labelKey: 'nav.inClinic', icon: 'stethoscope', to: '/app/visits' },
  { id: 'patients', labelKey: 'nav.patients', icon: 'users', to: '/app/patients' },
  NOTICES,
]

/** Navigation items for the user's role. */
export const navForUser = (user: StaffUser): NavItem[] =>
  user.dashboard === 'manager' || user.role === 'manager'
    ? MANAGER_NAV
    : user.role === 'receptionist'
      ? RECEPTION_NAV
      : user.role === 'nurse'
        ? NURSE_NAV
        : [...ROLE_HOME[user.role].nav, NOTICES]

import { ROLE_HOME, type NavItem, type StaffUser } from '@mmc/shared'

/**
 * Manager rail (the dashboard is the manager's home page, doc §12.3). The manager runs the
 * whole clinic, so registration and the clinic settings sit next to the dashboard and staff.
 */
export const MANAGER_NAV: NavItem[] = [
  { id: 'home', labelKey: 'nav.home', icon: 'home', to: '/app' },
  { id: 'dashboard', labelKey: 'nav.dashboard', icon: 'layout-dashboard', to: '/app/dashboard' },
  { id: 'patients', labelKey: 'nav.patients', icon: 'user-plus', to: '/app/register' },
  { id: 'staff', labelKey: 'nav.staff', icon: 'users', to: '/app/staff' },
  { id: 'settings', labelKey: 'nav.settings', icon: 'settings', to: '/app/settings' },
]

/** ≤ 5 navigation items for the user's role. */
export const navForUser = (user: StaffUser): NavItem[] =>
  user.dashboard === 'manager' || user.role === 'manager' ? MANAGER_NAV : ROLE_HOME[user.role].nav

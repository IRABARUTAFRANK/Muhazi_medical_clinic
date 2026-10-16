import { ROLE_HOME, type NavItem, type StaffUser } from '@mmc/shared'

/** Manager rail (the dashboard is the manager's home page, doc §12.3). */
export const MANAGER_NAV: NavItem[] = [
  { id: 'home', labelKey: 'nav.home', icon: 'home', to: '/app' },
  { id: 'dashboard', labelKey: 'nav.dashboard', icon: 'layout-dashboard', to: '/app/dashboard' },
  { id: 'staff', labelKey: 'nav.staff', icon: 'users', to: '/app/staff' },
  { id: 'stock', labelKey: 'nav.stock', icon: 'package', to: '/app/stock' },
  { id: 'settings', labelKey: 'nav.settings', icon: 'settings', to: '/app/settings' },
]

/** ≤ 5 navigation items for the user's role. */
export const navForUser = (user: StaffUser): NavItem[] =>
  user.dashboard === 'manager' || user.role === 'manager' ? MANAGER_NAV : ROLE_HOME[user.role].nav

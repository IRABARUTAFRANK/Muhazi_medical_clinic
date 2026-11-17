import { createFileRoute, redirect } from '@tanstack/react-router'
import { AccountsPage } from '@/pages/finance/accounts-page'
import { ACCOUNTS_TABS, type AccountsTab } from '@/pages/finance/accounts-tabs'
import { useSession } from '@/store/session'

/** The clinic's accounts (0179): the cashier (the accountant) and the manager. */
export const Route = createFileRoute('/app/finance')({
  beforeLoad: () => {
    const user = useSession.getState().user
    if (!user) throw redirect({ to: '/app' })
    if (!['cashier', 'manager'].includes(user.role)) throw redirect({ to: '/app' })
  },
  validateSearch: (search: Record<string, unknown>): { tab?: AccountsTab; year?: number } => ({
    tab: ACCOUNTS_TABS.includes(search.tab as AccountsTab)
      ? (search.tab as AccountsTab)
      : undefined,
    year: /^\d{4}$/.test(String(search.year ?? '')) ? Number(search.year) : undefined,
  }),
  component: Page,
})

function Page() {
  const user = useSession((s) => s.user)
  const { tab, year } = Route.useSearch()
  if (!user) return null
  return <AccountsPage user={user} initialTab={tab} initialYear={year} />
}

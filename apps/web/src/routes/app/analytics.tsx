import { createFileRoute, redirect } from '@tanstack/react-router'
import { AnalyticsPage } from '@/pages/analytics/analytics-page'
import { validateAnalyticsSearch, type UpdateSearch } from '@/pages/analytics/search'
import { useSession } from '@/store/session'

/**
 * Analytics: the detailed views behind the dashboard cards. The same people as the dashboard
 * (the manager, and heads or assistants of a department); the server then decides what each may
 * see (analytics_access). Everything else is in the address, e.g.
 *   /app/analytics?view=revenue&range=custom&from=2026-09-26&to=2026-10-25&day=2026-10-21
 */
export const Route = createFileRoute('/app/analytics')({
  validateSearch: validateAnalyticsSearch,
  beforeLoad: () => {
    const user = useSession.getState().user
    if (
      user &&
      user.role !== 'manager' &&
      user.dashboard !== 'manager' &&
      user.dashboard !== 'head'
    )
      throw redirect({ to: '/app' })
  },
  component: AnalyticsRoute,
})

function AnalyticsRoute() {
  const user = useSession((s) => s.user)
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  // filters replace the address; a new view or a detail is a new entry (Back returns)
  const update: UpdateSearch = (patch, opts) =>
    void navigate({
      search: (prev) => ({ ...prev, ...patch }),
      replace: opts?.replace ?? false,
    })
  if (!user) return null
  return <AnalyticsPage key={user.id} user={user} search={search} update={update} />
}

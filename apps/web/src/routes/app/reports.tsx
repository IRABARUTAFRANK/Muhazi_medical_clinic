import { createFileRoute, redirect } from '@tanstack/react-router'
import { ReportsPage } from '@/pages/reports/reports-page'
import { menuAllows } from '@/lib/nav'
import { useSession } from '@/store/session'

/**
 * The report centre: every report the person may print, as a table they filter, whose columns
 * they choose, grouped and totalled as they like, then printed (PDF) or exported (Excel).
 * `?r=patients.visited` opens one report. The menu offers it to whoever has at least one report;
 * each report's database function checks the rights again.
 */
export const Route = createFileRoute('/app/reports')({
  validateSearch: (s: Record<string, unknown>): { r?: string } => ({
    r: typeof s.r === 'string' && s.r ? s.r : undefined,
  }),
  beforeLoad: async () => {
    const user = useSession.getState().user
    if (user && !(await menuAllows(user, '/app/reports'))) throw redirect({ to: '/app' })
  },
  component: ReportsRoute,
})

function ReportsRoute() {
  const user = useSession((s) => s.user)
  const { r } = Route.useSearch()
  const navigate = Route.useNavigate()
  if (!user) return null
  return (
    <ReportsPage
      key={user.id}
      user={user}
      reportId={r ?? null}
      onPick={(id) => void navigate({ search: { r: id ?? undefined }, replace: false })}
    />
  )
}

import { createFileRoute } from '@tanstack/react-router'
import type { DashboardRole } from '@mmc/shared'
import { DashboardPage } from '@/pages/dashboard/dashboard-page'
import { useSession } from '@/store/session'

export const Route = createFileRoute('/app/dashboard')({
  /** `?view=head` previews the head-of-station variant (no money rows). */
  validateSearch: (search: Record<string, unknown>): { view?: DashboardRole } => ({
    view: search.view === 'manager' || search.view === 'head' ? search.view : undefined,
  }),
  component: DashboardRoute,
})

function DashboardRoute() {
  const user = useSession((s) => s.user)
  const { view } = Route.useSearch()
  if (!user) return null
  return <DashboardPage key={`${user.id}-${view ?? ''}`} user={user} view={view} />
}

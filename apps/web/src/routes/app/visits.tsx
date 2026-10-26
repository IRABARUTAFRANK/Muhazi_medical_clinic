import { createFileRoute, redirect } from '@tanstack/react-router'
import { VisitsPage } from '@/pages/visits/visits-page'
import { menuAllows } from '@/lib/nav'
import { useSession } from '@/store/session'

/** Everyone in the clinic right now, by station, with a link to each open visit. */
export const Route = createFileRoute('/app/visits')({
  // only for people whose menu offers it (role, desks, switches); otherwise back home
  beforeLoad: async () => {
    const user = useSession.getState().user
    if (!user || !(await menuAllows(user, '/app/visits'))) throw redirect({ to: '/app' })
  },
  component: VisitsRoute,
})

function VisitsRoute() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <VisitsPage user={user} />
}

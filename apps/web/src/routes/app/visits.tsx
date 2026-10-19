import { createFileRoute } from '@tanstack/react-router'
import { VisitsPage } from '@/pages/visits/visits-page'
import { useSession } from '@/store/session'

/** Everyone in the clinic right now, by station, with a link to each open visit. */
export const Route = createFileRoute('/app/visits')({
  component: VisitsRoute,
})

function VisitsRoute() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <VisitsPage user={user} />
}

import { createFileRoute } from '@tanstack/react-router'
import { PlaceholderPage } from '@/pages/placeholder-page'
import { useSession } from '@/store/session'

/** Every nav target that is not designed yet (patients, queue, bills, …). */
export const Route = createFileRoute('/app/$section')({
  component: SectionRoute,
})

function SectionRoute() {
  const { section } = Route.useParams()
  const user = useSession((s) => s.user)
  if (!user) return null
  return <PlaceholderPage user={user} section={section} />
}

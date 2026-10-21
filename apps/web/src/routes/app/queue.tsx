import { createFileRoute, redirect } from '@tanstack/react-router'
import { QueuePage } from '@/pages/doctor/doctor-pages'
import { useSession } from '@/store/session'

/** The doctor's desk queue on its own page. Doctors, nurses and the manager. */
export const Route = createFileRoute('/app/queue')({
  beforeLoad: () => {
    const role = useSession.getState().user?.role
    if (!role || !['doctor', 'nurse', 'manager'].includes(role)) throw redirect({ to: '/app' })
  },
  component: Page,
})

function Page() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <QueuePage user={user} />
}

import { createFileRoute, redirect } from '@tanstack/react-router'
import { ResultsPage } from '@/pages/doctor/doctor-pages'
import { useSession } from '@/store/session'

/** The tests I ordered and their results. Doctors, nurses and the manager. */
export const Route = createFileRoute('/app/results')({
  beforeLoad: () => {
    const role = useSession.getState().user?.role
    if (!role || !['doctor', 'nurse', 'manager'].includes(role)) throw redirect({ to: '/app' })
  },
  component: Page,
})

function Page() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <ResultsPage user={user} />
}

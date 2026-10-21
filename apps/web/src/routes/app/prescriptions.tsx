import { createFileRoute, redirect } from '@tanstack/react-router'
import { PrescriptionsPage } from '@/pages/doctor/doctor-pages'
import { useSession } from '@/store/session'

/** The prescriptions I wrote and what the pharmacy did. Doctors, nurses and the manager. */
export const Route = createFileRoute('/app/prescriptions')({
  beforeLoad: () => {
    const role = useSession.getState().user?.role
    if (!role || !['doctor', 'nurse', 'manager'].includes(role)) throw redirect({ to: '/app' })
  },
  component: Page,
})

function Page() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <PrescriptionsPage user={user} />
}

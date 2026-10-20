import { createFileRoute, redirect } from '@tanstack/react-router'
import { LabPage } from '@/pages/lab/lab-page'
import { useSession } from '@/store/session'

/** Laboratory worklist: lab technicians, sonographers (imaging) and the manager. */
export const Route = createFileRoute('/app/lab')({
  beforeLoad: () => {
    const role = useSession.getState().user?.role
    if (!role || !['lab_tech', 'manager'].includes(role)) throw redirect({ to: '/app' })
  },
  component: Page,
})

function Page() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <LabPage user={user} />
}

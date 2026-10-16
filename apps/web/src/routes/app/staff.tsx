import { createFileRoute, redirect } from '@tanstack/react-router'
import { StaffPage } from '@/pages/staff/staff-page'
import { useSession } from '@/store/session'

/** Employee accounts: managers only. */
export const Route = createFileRoute('/app/staff')({
  beforeLoad: () => {
    if (useSession.getState().user?.role !== 'manager') throw redirect({ to: '/app' })
  },
  component: StaffRoute,
})

function StaffRoute() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <StaffPage user={user} />
}

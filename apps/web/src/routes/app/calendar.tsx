import { createFileRoute, redirect } from '@tanstack/react-router'
import { CalendarPage } from '@/pages/calendar/calendar-page'
import { useSession } from '@/store/session'

/** A doctor's own calendar; the manager keeps any doctor's. */
export const Route = createFileRoute('/app/calendar')({
  beforeLoad: () => {
    const role = useSession.getState().user?.role
    if (!role || !['doctor', 'manager'].includes(role)) throw redirect({ to: '/app' })
  },
  component: Page,
})

function Page() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <CalendarPage user={user} />
}

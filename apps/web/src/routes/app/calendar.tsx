import { createFileRoute, redirect } from '@tanstack/react-router'
import { CalendarPage } from '@/pages/calendar/calendar-page'
import { useSession } from '@/store/session'

/** A doctor's own calendar; the manager keeps any doctor's. */
export const Route = createFileRoute('/app/calendar')({
  beforeLoad: () => {
    const user = useSession.getState().user
    // doctors, sonographers (their own calendar) and the manager (everyone's)
    const ok = user && (['doctor', 'manager'].includes(user.role) || user.dbRole === 'sonographer')
    if (!ok) throw redirect({ to: '/app' })
  },
  component: Page,
})

function Page() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <CalendarPage user={user} />
}

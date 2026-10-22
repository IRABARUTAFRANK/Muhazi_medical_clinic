import { createFileRoute, redirect } from '@tanstack/react-router'
import { CalendarPage } from '@/pages/calendar/calendar-page'
import { useSession } from '@/store/session'

/** A doctor's own calendar; the manager keeps any doctor's. */
export const Route = createFileRoute('/app/calendar')({
  // ?user= opens that doctor's calendar (the manager, from the calendars board)
  validateSearch: (search: Record<string, unknown>): { user?: string } => ({
    user: typeof search.user === 'string' ? search.user : undefined,
  }),
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
  const { user: whose } = Route.useSearch()
  if (!user) return null
  return <CalendarPage key={whose ?? 'me'} user={user} initialUser={whose} />
}

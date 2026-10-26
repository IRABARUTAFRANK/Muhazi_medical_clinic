import { createFileRoute, redirect } from '@tanstack/react-router'
import { AppointmentsPage } from '@/pages/appointments/appointments-page'
import { menuAllows } from '@/lib/nav'
import { useSession } from '@/store/session'

/** The day's appointments and the booking requests to answer. */
export const Route = createFileRoute('/app/appointments')({
  // only for people whose menu offers it (role, desks, switches); otherwise back home
  beforeLoad: async () => {
    const user = useSession.getState().user
    if (!user || !(await menuAllows(user, '/app/appointments'))) throw redirect({ to: '/app' })
  },
  // ?day=yyyy-mm-dd opens that day (a declined-booking notice opens the booking's day)
  validateSearch: (search: Record<string, unknown>): { day?: string } => ({
    day:
      typeof search.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(search.day)
        ? search.day
        : undefined,
  }),
  component: AppointmentsRoute,
})

function AppointmentsRoute() {
  const user = useSession((s) => s.user)
  const { day } = Route.useSearch()
  if (!user) return null
  return <AppointmentsPage key={day ?? 'today'} user={user} initialDay={day} />
}

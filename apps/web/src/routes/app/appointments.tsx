import { createFileRoute } from '@tanstack/react-router'
import { AppointmentsPage } from '@/pages/appointments/appointments-page'
import { useSession } from '@/store/session'

/** The day's appointments and the booking requests to answer. */
export const Route = createFileRoute('/app/appointments')({
  component: AppointmentsRoute,
})

function AppointmentsRoute() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <AppointmentsPage user={user} />
}

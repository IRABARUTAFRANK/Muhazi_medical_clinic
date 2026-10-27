import { createFileRoute, redirect } from '@tanstack/react-router'
import { MyBookingsPage } from '@/pages/appointments/my-bookings-page'
import { menuAllows } from '@/lib/nav'
import { useSession } from '@/store/session'

/** The bookings made with the signed-in person (doctor, sonographer, nurse, manager). */
export const Route = createFileRoute('/app/my-bookings')({
  // only for people whose menu offers it (those who keep a calendar); otherwise back home
  beforeLoad: async () => {
    const user = useSession.getState().user
    if (!user || !(await menuAllows(user, '/app/my-bookings'))) throw redirect({ to: '/app' })
  },
  // ?focus=<appointment id> opens that booking beside the list (a notice, Home)
  validateSearch: (search: Record<string, unknown>): { focus?: string } => ({
    focus: typeof search.focus === 'string' && search.focus ? search.focus : undefined,
  }),
  component: MyBookingsRoute,
})

function MyBookingsRoute() {
  const user = useSession((s) => s.user)
  const { focus } = Route.useSearch()
  if (!user) return null
  return <MyBookingsPage user={user} focus={focus} />
}

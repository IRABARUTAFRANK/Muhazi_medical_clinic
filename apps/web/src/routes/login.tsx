import { createFileRoute, redirect } from '@tanstack/react-router'
import { normalizeStaffId, STAFF_ID_RE } from '@mmc/shared'
import { LoginPage } from '@/pages/login/login-page'
import { homeRouteFor } from '@/lib/roles'
import { sessionOver, useSession } from '@/store/session'

/** Steps 2 and 3 of the staff sign-in: username + PIN, then the code sent by e-mail. */
export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { staff: string } => ({
    staff: typeof search.staff === 'string' ? normalizeStaffId(search.staff) : '',
  }),
  beforeLoad: async ({ search }) => {
    // A tab left unused for the set hours never leads back into the staff area: sign in again,
    // with a new e-mailed code.
    const s = useSession.getState()
    if (sessionOver(s)) await s.signOut(s.lastActiveAt == null ? 'ended' : 'idle')
    const user = useSession.getState().user
    // Someone else is still signed in on this tab: sign them out first, so the next person never
    // lands on their dashboard (and nothing is recorded under their name).
    if (user && user.staffId && search.staff && user.staffId !== search.staff) {
      await useSession.getState().signOut('switched')
    } else if (user) {
      throw redirect({ to: user.mustChangePin ? '/app/change-pin' : homeRouteFor(user) })
    }
    // Without a valid staff ID the employee has to start on the landing page.
    if (!STAFF_ID_RE.test(search.staff)) throw redirect({ to: '/', hash: 'signin' })
  },
  component: LoginRoute,
})

function LoginRoute() {
  const { staff } = Route.useSearch()
  return <LoginPage staffId={staff} />
}

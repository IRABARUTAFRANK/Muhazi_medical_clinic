import { createFileRoute, redirect } from '@tanstack/react-router'
import { normalizeStaffId, STAFF_ID_RE } from '@mmc/shared'
import { LoginPage } from '@/pages/login/login-page'
import { homeRouteFor } from '@/lib/roles'
import { useSession } from '@/store/session'

/** Steps 2 and 3 of the staff sign-in: username + PIN, then the code sent by e-mail. */
export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { staff: string } => ({
    staff: typeof search.staff === 'string' ? normalizeStaffId(search.staff) : '',
  }),
  beforeLoad: ({ search }) => {
    const user = useSession.getState().user
    if (user) throw redirect({ to: user.mustChangePin ? '/app/change-pin' : homeRouteFor(user) })
    // Without a valid staff ID the employee has to start on the landing page.
    if (!STAFF_ID_RE.test(search.staff)) throw redirect({ to: '/', hash: 'signin' })
  },
  component: LoginRoute,
})

function LoginRoute() {
  const { staff } = Route.useSearch()
  return <LoginPage staffId={staff} />
}

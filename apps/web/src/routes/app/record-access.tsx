import { createFileRoute, redirect } from '@tanstack/react-router'
import { isDoctorUser } from '@/lib/roles'
import { RecordAccessPage } from '@/pages/record-access/record-access-page'
import { useSession } from '@/store/session'

/**
 * Record access (0088): the requests to see patients' past records and their answers, the
 * emergency accesses and (manager) the log of who opened past records. For the manager and
 * whoever the manager allowed to answer (Settings → Who may do what, 0095); a notice opens it on
 * one request: /app/record-access?request=<id>. 0126: patient records are for doctors: a doctor
 * opens it (the requests they made, those they may answer); the database refuses the others.
 */
export const Route = createFileRoute('/app/record-access')({
  validateSearch: (search: Record<string, unknown>): { request?: string } => ({
    request: typeof search.request === 'string' ? search.request : undefined,
  }),
  beforeLoad: () => {
    const user = useSession.getState().user
    if (user && !isDoctorUser(user)) throw redirect({ to: '/app' })
  },
  component: RecordAccessRoute,
})

function RecordAccessRoute() {
  const user = useSession((s) => s.user)
  const { request } = Route.useSearch()
  if (!user) return null
  return <RecordAccessPage key={user.id} user={user} focus={request} />
}

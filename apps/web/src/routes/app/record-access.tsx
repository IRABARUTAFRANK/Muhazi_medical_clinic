import { createFileRoute, redirect } from '@tanstack/react-router'
import { isApprover } from '@/components/privacy/approvers'
import { RecordAccessPage } from '@/pages/record-access/record-access-page'
import { useSession } from '@/store/session'

/**
 * Record access (0088): the requests to see patients' past records and their answers, the
 * emergency accesses and (manager) the log of who opened past records. For the manager and the
 * heads of department; a notice opens it on one request: /app/record-access?request=<id>.
 */
export const Route = createFileRoute('/app/record-access')({
  validateSearch: (search: Record<string, unknown>): { request?: string } => ({
    request: typeof search.request === 'string' ? search.request : undefined,
  }),
  beforeLoad: () => {
    const user = useSession.getState().user
    if (user && !isApprover(user)) throw redirect({ to: '/app' })
  },
  component: RecordAccessRoute,
})

function RecordAccessRoute() {
  const user = useSession((s) => s.user)
  const { request } = Route.useSearch()
  if (!user) return null
  return <RecordAccessPage key={user.id} user={user} focus={request} />
}

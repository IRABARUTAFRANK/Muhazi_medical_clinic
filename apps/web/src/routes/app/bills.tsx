import { createFileRoute, redirect } from '@tanstack/react-router'
import { BillsPage } from '@/pages/finance/finance-pages'
import { useSession } from '@/store/session'

/** Open bills: the cashier and the manager. */
export const Route = createFileRoute('/app/bills')({
  beforeLoad: () => {
    const role = useSession.getState().user?.role
    if (!role || !['cashier', 'manager'].includes(role)) throw redirect({ to: '/app' })
  },
  component: Page,
})

function Page() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <BillsPage user={user} />
}

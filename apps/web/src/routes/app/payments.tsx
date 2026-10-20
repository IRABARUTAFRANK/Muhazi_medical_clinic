import { createFileRoute, redirect } from '@tanstack/react-router'
import { PaymentsPage } from '@/pages/finance/finance-pages'
import { useSession } from '@/store/session'

/** Payments of a day and the day close: the cashier and the manager. */
export const Route = createFileRoute('/app/payments')({
  beforeLoad: () => {
    const role = useSession.getState().user?.role
    if (!role || !['cashier', 'manager'].includes(role)) throw redirect({ to: '/app' })
  },
  component: Page,
})

function Page() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <PaymentsPage user={user} />
}

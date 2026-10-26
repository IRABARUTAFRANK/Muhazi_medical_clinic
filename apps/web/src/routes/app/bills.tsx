import { createFileRoute, redirect } from '@tanstack/react-router'
import { BillsPage } from '@/pages/finance/finance-pages'
import { permsReady } from '@/lib/api/permissions'
import { useSession } from '@/store/session'

/** Open bills: the cashier and the manager, and anyone the manager allows to take payments
 *  (Settings → Who may do what). */
export const Route = createFileRoute('/app/bills')({
  beforeLoad: async () => {
    const user = useSession.getState().user
    if (!user) throw redirect({ to: '/app' })
    if (['cashier', 'manager'].includes(user.role)) return
    if (!(await permsReady(user)).has('payment.take')) throw redirect({ to: '/app' })
  },
  component: Page,
})

function Page() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <BillsPage user={user} />
}

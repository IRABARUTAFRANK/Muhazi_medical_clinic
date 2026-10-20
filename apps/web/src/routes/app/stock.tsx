import { createFileRoute, redirect } from '@tanstack/react-router'
import { StockPage } from '@/pages/stock/stock-page'
import { useSession } from '@/store/session'

/** Medicine stock: the pharmacist (doctor home with the pharmacy station), nurses, the lab, the manager. */
export const Route = createFileRoute('/app/stock')({
  beforeLoad: () => {
    const role = useSession.getState().user?.role
    if (!role || !['manager', 'doctor', 'nurse', 'lab_tech'].includes(role))
      throw redirect({ to: '/app' })
  },
  component: Page,
})

function Page() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <StockPage user={user} />
}

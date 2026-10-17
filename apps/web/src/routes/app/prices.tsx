import { createFileRoute, redirect } from '@tanstack/react-router'
import { PricesPage } from '@/pages/prices/prices-page'
import { useSession } from '@/store/session'

/** Treatments, prices, discounts, insurers and coverage: managers only. */
export const Route = createFileRoute('/app/prices')({
  beforeLoad: () => {
    if (useSession.getState().user?.role !== 'manager') throw redirect({ to: '/app' })
  },
  component: PricesRoute,
})

function PricesRoute() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <PricesPage user={user} />
}

import { createFileRoute, redirect } from '@tanstack/react-router'
import { PriceListsPage } from '@/pages/prices/price-lists-page'
import { useSession } from '@/store/session'

/** The published price lists (MoH, RSSB, insurers), the insurers and the official medicine list: managers only. */
export const Route = createFileRoute('/app/price-lists')({
  beforeLoad: () => {
    if (useSession.getState().user?.role !== 'manager') throw redirect({ to: '/app' })
  },
  component: PriceListsRoute,
})

function PriceListsRoute() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <PriceListsPage user={user} />
}

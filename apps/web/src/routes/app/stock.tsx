import { createFileRoute, redirect } from '@tanstack/react-router'
import { StockPage, type Tab } from '@/pages/stock/stock-page'
import { useSession } from '@/store/session'

const TABS: Tab[] = [
  'stock',
  'pharmacy',
  'receive',
  'send',
  'use',
  'medicines',
  'moves',
  'sales',
  'stores',
]

/** Medicine stock: the pharmacist, nurses, the lab, doctors with an office store, the manager. */
export const Route = createFileRoute('/app/stock')({
  beforeLoad: () => {
    const role = useSession.getState().user?.role
    if (!role || !['manager', 'doctor', 'nurse', 'lab_tech', 'pharmacist'].includes(role))
      throw redirect({ to: '/app' })
  },
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } => ({
    tab: TABS.includes(search.tab as Tab) ? (search.tab as Tab) : undefined,
  }),
  component: Page,
})

function Page() {
  const user = useSession((s) => s.user)
  const { tab } = Route.useSearch()
  if (!user) return null
  return <StockPage key={tab ?? ''} user={user} initialTab={tab} />
}

import { createFileRoute, redirect } from '@tanstack/react-router'
import { StockPage, type StockPreset, type Tab } from '@/pages/stock/stock-page'
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

/** An id passed in the address (a medicine or a store), or nothing. */
const id = (v: unknown) => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : undefined)

/** Medicine stock: the pharmacist, nurses, the lab, doctors with an office store, the manager. */
export const Route = createFileRoute('/app/stock')({
  beforeLoad: () => {
    const role = useSession.getState().user?.role
    if (!role || !['manager', 'doctor', 'nurse', 'lab_tech', 'pharmacist'].includes(role))
      throw redirect({ to: '/app' })
  },
  // tab: which tab opens; item, location (receive into) and to (send to) fill in the form,
  // e.g. the pharmacy's "Receive stock" / "Send from another store" on a short medicine
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } & StockPreset => ({
    tab: TABS.includes(search.tab as Tab) ? (search.tab as Tab) : undefined,
    item: id(search.item),
    location: id(search.location),
    to: id(search.to),
  }),
  component: Page,
})

function Page() {
  const user = useSession((s) => s.user)
  const { tab, item, location, to } = Route.useSearch()
  if (!user) return null
  // a new address (another tab, another medicine) opens the page afresh on it
  return (
    <StockPage
      key={[tab, item, location, to].join('|')}
      user={user}
      initialTab={tab}
      preset={{ item, location, to }}
    />
  )
}

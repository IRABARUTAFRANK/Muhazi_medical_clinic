import { createFileRoute, redirect } from '@tanstack/react-router'
import { StockPage, type StockFocus, type StockPreset } from '@/pages/stock/stock-page'
import { STOCK_TABS, type Tab } from '@/pages/stock/stock-util'
import { useSession } from '@/store/session'

/** An id passed in the address (a medicine, a store, a note…), or nothing. */
const id = (v: unknown) => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : undefined)

/**
 * Medicine stock. The pharmacist and the manager see every store; anyone else sees only the
 * room stores they hold ("My store", tab=mine) and is told so when they hold none.
 */
export const Route = createFileRoute('/app/stock')({
  beforeLoad: () => {
    if (!useSession.getState().user) throw redirect({ to: '/app' })
  },
  // tab: which tab opens; item, location (receive into) and to (send to) fill in the form;
  // store, note, request, delivery: what a notification points to
  // (e.g. ?tab=rooms&note=…, ?tab=mine&store=…, ?tab=reorder)
  validateSearch: (
    search: Record<string, unknown>,
  ): { tab?: Tab; sale?: string } & StockPreset & StockFocus => ({
    tab: STOCK_TABS.includes(search.tab as Tab) ? (search.tab as Tab) : undefined,
    item: id(search.item),
    location: id(search.location),
    to: id(search.to),
    store: id(search.store),
    note: id(search.note),
    request: id(search.request),
    delivery: id(search.delivery),
    sale: id(search.sale),
  }),
  component: Page,
})

function Page() {
  const user = useSession((s) => s.user)
  const { tab, item, location, to, store, note, request, delivery } = Route.useSearch()
  if (!user) return null
  // a new address (another tab, another medicine, another note) opens the page afresh on it
  return (
    <StockPage
      key={[tab, item, location, to, store, note, request, delivery].join('|')}
      user={user}
      initialTab={tab}
      preset={{ item, location, to }}
      focus={{ store, note, request, delivery }}
    />
  )
}

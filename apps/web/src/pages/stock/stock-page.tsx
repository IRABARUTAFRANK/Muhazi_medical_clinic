import { useState } from 'react'
import {
  ArrowRightLeft,
  BarChart3,
  Boxes,
  Coins,
  DoorOpen,
  ListOrdered,
  Package,
  PackageMinus,
  PackagePlus,
  Pill,
  Printer,
  ShoppingBag,
  ShoppingCart,
  Store,
  Tags,
  Truck,
  Warehouse,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf, type StaffUser } from '@mmc/shared'
import { ActionRow, ActionRowEnd, BannerChip, PageBanner } from '@/components/dash/page-banner'
import { Button } from '@/components/ui/button'
import { StaffShell } from '@/components/staff/staff-shell'
import { NotAllowedNotice } from '@/components/clinical/perm-gate'
import { NoDeskNotice } from '@/components/clinical/desk-gate'
import { useSessionCanDesk } from '@/components/clinical/session-desks'
import { usePharmacyQueue, useStockOverview } from '@/lib/api/stock'
import { useDailyStockAlertCheck, useStockTotals } from '@/lib/api/pharmacy'
import { useHoldsStore } from '@/lib/api/rooms'
import { useCanDesk } from '@/lib/api/desks'
import { useCan } from '@/lib/api/permissions'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'
import { PharmacyDesk } from './pharmacy-desk'
import { CounterSalesPanel } from './pharmacy/counter-sales'
import { AddStockForm } from './add-stock-form'
import { BetweenStoresForm } from './between-stores'
import { MyStoreTab } from './my-store'
import { RoomStoresTab } from './room-stores'
import { StockReports, Movements } from './stock-reports'
import { StockTab } from './stock-tab'
import { StoresTab } from './stores-tab'
import { errorBox, mainTab, pharmacySide, type MainTab, type Tab } from './stock-util'

export type { Tab }

const ICONS: Record<Tab, typeof Package> = {
  stock: Boxes,
  prescriptions: Pill,
  walkin: ShoppingBag,
  add: PackagePlus,
  rooms: DoorOpen,
  reports: BarChart3,
  mine: Package,
  // older names (only the holder's "Movements" is still shown as a tab)
  pharmacy: Pill,
  receive: PackagePlus,
  deliveries: Truck,
  reorder: ShoppingCart,
  send: ArrowRightLeft,
  use: PackageMinus,
  medicines: Tags,
  moves: ListOrdered,
  sales: Coins,
  stores: Store,
}
/** The pharmacy and the manager: six tabs, and "My store" when they hold a room store too. */
const ADMIN_TABS: MainTab[] = ['stock', 'prescriptions', 'walkin', 'add', 'rooms', 'reports']

/** What the form opens with: the medicine, the store to receive into, the store to send to. */
export interface StockPreset {
  item?: string
  location?: string
  to?: string
}
/** From the address (a notification): the store, the note, the request or the delivery to open. */
export interface StockFocus {
  store?: string
  note?: string
  request?: string
  delivery?: string
}
/** Opens "Add stock" or the move between pharmacy stores already filled in (the desk's short
 *  medicine). */
export type OpenStock = (tab: 'receive' | 'send', preset: StockPreset) => void

/**
 * The pharmacy: the clinic's main store and its only way in. It records stock (name, batch,
 * expiry, quantity, cost and selling price), hands prescribed medicines over, sells to walk-in
 * buyers, sends stock to the room stores and warns the manager. The pharmacy desk and the manager
 * get six tabs: Stock, Prescriptions, Walk-in sales, Add stock, Room stores, Reports. Holders of a
 * room store see only "My store".
 */
export function StockPage({
  user,
  initialTab,
  preset: initialPreset,
  focus = {},
}: {
  user: StaffUser
  /** From the address; an older tab name opens the tab that now holds it. */
  initialTab?: Tab
  /** From the address: the medicine and stores the Add stock / move form starts with. */
  preset?: StockPreset
  focus?: StockFocus
}) {
  const isManager = user.role === 'manager'
  // the pharmacy desk, not the role (0085): the database's stock_admin() asks the same
  const canDesk = useCanDesk(user)
  const admin = isManager || canDesk('pharmacy')
  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="stock">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        {admin ? (
          <AdminStock
            user={user}
            isManager={isManager}
            initialTab={initialTab}
            preset={initialPreset}
            focus={focus}
          />
        ) : (
          <HolderStock user={user} initialTab={initialTab} focus={focus} />
        )}
      </main>
    </StaffShell>
  )
}

/* ---------------------------------------------------------------- holders of a room store */
function HolderStock({
  user,
  initialTab,
  focus,
}: {
  user: StaffUser
  initialTab?: Tab
  focus: StockFocus
}) {
  const { t } = useTranslation()
  const { holds } = useHoldsStore()
  const [tab, setTab] = useState<'mine' | 'moves'>(
    initialTab === 'moves' || initialTab === 'reports' ? 'moves' : 'mine',
  )
  const { data } = useStockOverview()
  return (
    <>
      <PageBanner icon={Package} tint="amber" title={t('myStore.title')} lead={t('myStore.lead')} />
      {holds && (
        <TabBar
          tabs={['mine', 'moves']}
          tab={tab}
          onTab={(x) => setTab(x as 'mine' | 'moves')}
          badge={{}}
        />
      )}
      {tab === 'mine' && <MyStoreTab user={user} storeId={focus.store} noteId={focus.note} />}
      {tab === 'moves' && <Movements items={data?.items ?? []} locations={data?.locations ?? []} />}
    </>
  )
}

function TabBar({
  tabs,
  tab,
  onTab,
  badge,
}: {
  tabs: Tab[]
  tab: Tab
  onTab: (t: Tab) => void
  badge: Partial<Record<Tab, number>>
}) {
  const { t } = useTranslation()
  return (
    <div
      className="border-border bg-surface flex flex-wrap gap-0.5 self-start rounded-md border p-0.5"
      role="tablist"
    >
      {tabs.map((x) => {
        const Icon = ICONS[x]
        const n = badge[x] ?? 0
        return (
          <button
            key={x}
            type="button"
            role="tab"
            aria-selected={tab === x}
            onClick={() => onTab(x)}
            className={cn(
              'inline-flex min-h-9 items-center gap-2 rounded px-3 text-[14px] font-medium whitespace-nowrap transition-colors duration-120',
              tab === x
                ? 'bg-card text-primary border-border border'
                : 'text-ink-2 hover:bg-hover hover:text-ink border border-transparent',
            )}
          >
            <Icon size={16} aria-hidden="true" />
            {t(`stock.tabs.${x}`)}
            {n > 0 && (
              <span className="bg-amber-bg text-amber rounded px-1.5 text-[12px] font-medium">
                {n}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/* ---------------------------------------------------------------- the pharmacy and the manager */
function AdminStock({
  user,
  isManager,
  initialTab,
  preset: initialPreset,
  focus,
}: {
  user: StaffUser
  isManager: boolean
  initialTab?: Tab
  preset?: StockPreset
  focus: StockFocus
}) {
  const { t } = useTranslation()
  const { holds } = useHoldsStore()
  // adding, sending, counting and the stores themselves: the manager, or the pharmacy desk with
  // the switch "Manage stock" (the database's stock_manager()); handing over and selling stay
  const can = useCan(user)
  const manage = isManager || can('stock.write')
  const blocked = <NotAllowedNotice feature="stock.write" />
  const tabs: MainTab[] = holds ? [...ADMIN_TABS, 'mine'] : ADMIN_TABS
  // an older tab name opens the tab that now holds it, on the right part
  const opened0 = mainTab(initialTab)
  // the pharmacy desk starts at the prescriptions (only the manager starts at the stock)
  const [tab, setTab] = useState<MainTab>(
    opened0.tab && (opened0.tab !== 'mine' || holds)
      ? opened0.tab
      : !isManager
        ? 'prescriptions'
        : 'stock',
  )
  const [part, setPart] = useState<string | undefined>(opened0.part)
  const [preset, setPreset] = useState<StockPreset>(initialPreset ?? {})
  // each time the desk opens a form, it starts again with the new medicine and store
  const [opened, setOpened] = useState(0)
  const openStock: OpenStock = (to, p) => {
    setPreset(p)
    setTab(to === 'receive' ? 'add' : 'rooms')
    setPart(to === 'send' ? 'send' : undefined)
    setOpened((n) => n + 1)
  }
  const { data, error } = useStockOverview()
  const { data: queue = [] } = usePharmacyQueue()
  const { data: totals } = useStockTotals(null)
  // the stock notices (low, expiring, expired, the daily summary): once a day per person
  useDailyStockAlertCheck(true)
  const canDeskNow = useSessionCanDesk()
  const atDesk = canDeskNow('pharmacy')
  const items = data?.items ?? []
  const locations = data?.locations ?? []
  const costShown = items.some((i) => i.costShown !== false)
  const value = totals?.inventoryCost ?? items.reduce((s, i) => s + i.costValue, 0)
  const active = items.filter((i) => i.active)

  return (
    <>
      <PageBanner
        icon={Warehouse}
        tint="amber"
        title={t('stock.title')}
        lead={t('stock.lead')}
        meta={
          <>
            {costShown && (
              <BannerChip icon={Coins}>
                {t('stock.valueChip', { amount: formatRwf(Math.round(value)) })}
              </BannerChip>
            )}
            <BannerChip icon={Boxes}>{t('stock.itemCount', { count: active.length })}</BannerChip>
            {queue.length > 0 && (
              <BannerChip icon={Pill}>{t('stock.toHandOver', { count: queue.length })}</BannerChip>
            )}
          </>
        }
      />
      <ActionRow>
        <Button variant="tint-grey" onClick={() => window.print()}>
          <Printer size={16} aria-hidden="true" />
          {t('dashboard.print')}
        </Button>
        <ActionRowEnd />
        {manage && tab !== 'add' && (
          <Button variant="primary" onClick={() => openStock('receive', {})}>
            <PackagePlus size={16} aria-hidden="true" />
            {t('stock.tabs.add')}
          </Button>
        )}
      </ActionRow>
      {error && <p className={errorBox}>{error.message}</p>}

      <TabBar
        tabs={tabs}
        tab={tab}
        onTab={(x) => {
          // a tab chosen by hand opens empty
          setTab(x as MainTab)
          setPart(undefined)
          setPreset({})
        }}
        badge={{ prescriptions: queue.length }}
      />

      {tab === 'stock' && (
        <StockTab
          key={`stock-${part ?? ''}`}
          overview={data}
          totals={totals ?? null}
          manage={manage}
          initialPart={part}
          onAddStock={(item) => openStock('receive', item ? { item } : {})}
        />
      )}
      {tab === 'prescriptions' && <PharmacyDesk canDispense onOpenStock={openStock} />}
      {tab === 'walkin' && (atDesk ? <CounterSalesPanel /> : <NoDeskNotice desks={['pharmacy']} />)}
      {tab === 'add' && !manage && blocked}
      {tab === 'add' && manage && (
        <AddStockForm
          key={opened}
          items={items}
          locations={locations}
          mainId={data?.mainPharmacyId ?? null}
          isManager={isManager}
          preset={preset}
        />
      )}
      {tab === 'rooms' && !manage && blocked}
      {tab === 'rooms' && (
        <div className="flex flex-col gap-4">
          <RoomStoresTab
            overview={data}
            isManager={isManager}
            canAct={manage}
            focusNote={focus.note}
            focusRequest={focus.request}
            focusStore={focus.store}
          />
          {manage && pharmacySide(locations).length > 1 && (
            <BetweenStoresForm
              key={`send-${opened}`}
              overview={data}
              preset={preset}
              focused={part === 'send'}
            />
          )}
          <StoresTab
            locations={locations}
            items={items}
            mainId={data?.mainPharmacyId ?? null}
            isManager={isManager}
            focused={part === 'stores'}
          />
        </div>
      )}
      {tab === 'mine' && <MyStoreTab user={user} storeId={focus.store} noteId={focus.note} />}
      {tab === 'reports' && (
        <StockReports
          user={user}
          items={items}
          locations={locations}
          initialPart={part}
          focusDelivery={focus.delivery}
        />
      )}
    </>
  )
}

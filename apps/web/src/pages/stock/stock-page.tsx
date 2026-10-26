import { Fragment, useState, type FormEvent } from 'react'
import { PeriodFilter } from '@/components/dash/period-filter'
import { usePeriod } from '@/lib/period'
import {
  AlertTriangle,
  ArrowRightLeft,
  Boxes,
  Coins,
  DoorOpen,
  ListOrdered,
  Package,
  PackageMinus,
  PackagePlus,
  Pill,
  ShoppingCart,
  Store,
  Tags,
  Truck,
  Warehouse,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  CLINIC_PROFILE,
  formatDate,
  formatNumber,
  formatRwf,
  formatTime,
  isoDate,
  type StaffUser,
} from '@mmc/shared'
import { Empty, Kpi, Panel } from '@/components/dash/kit'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { ListBar, Pager } from '@/components/ui/list-tools'
import { Select } from '@/components/ui/select'
import { SearchSelect } from '@/components/ui/search-select'
import { Flash } from '@/components/ui/flash'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  usePharmacyQueue,
  isLowStock,
  useStockActions,
  useStockAlerts,
  useStockMovements,
  useStockOverview,
  useStockSales,
  type StockItem,
  type StockLocation,
  type StockOverview,
} from '@/lib/api/stock'
import { useHoldsStore } from '@/lib/api/rooms'
import { useCanDesk } from '@/lib/api/desks'
import { useCan } from '@/lib/api/permissions'
import { NotAllowedNotice } from '@/components/clinical/perm-gate'
import { useClinicInfo } from '@/lib/api/public'
import { ReportButtons } from '@/components/dash/report-buttons'
import { stockReport } from '@/lib/reports/build'
import { useNow } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { matches, usePaged } from '@/lib/paging'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/lib/confirm'
import { PharmacyDesk } from './pharmacy-desk'
import { MedicinesSection } from '../prices/medicines-section'
import { DeliveriesList, DeliveryForm } from './delivery-form'
import { MyStoreTab } from './my-store'
import { ReorderTab, LevelEditor } from './reorder-tab'
import { RoomStoresTab } from './room-stores'
import { PharmacyCountForm, StoresTab } from './stores-tab'
import { MsgFlash } from './stock-shared'
import {
  errText,
  errorBox,
  expiryState,
  itemName,
  mainPharmacy,
  pharmacySide,
  pharmacyStores,
  roomStores,
  usableIn,
  type Msg,
  type Tab,
} from './stock-util'

export type { Tab }

const ICONS: Record<Tab, typeof Package> = {
  stock: Boxes,
  pharmacy: Pill,
  receive: PackagePlus,
  deliveries: Truck,
  reorder: ShoppingCart,
  rooms: DoorOpen,
  mine: Package,
  send: ArrowRightLeft,
  use: PackageMinus,
  medicines: Tags,
  moves: ListOrdered,
  sales: Coins,
  stores: Store,
}
/** The pharmacy and the manager: every tab but "My store" (shown when they hold one too). */
const ADMIN_TABS: Tab[] = [
  'stock',
  'pharmacy',
  'receive',
  'deliveries',
  'reorder',
  'rooms',
  'send',
  'use',
  'medicines',
  'moves',
  'sales',
  'stores',
]
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
/** Opens Receive or Send already filled in (the pharmacy desk's short medicine). */
export type OpenStock = (tab: 'receive' | 'send', preset: StockPreset) => void

/**
 * Medicine stock. The pharmacy is the main store: deliveries are received into it, it hands
 * medicines over to patients and sends them to the room stores (a doctor's office, a ward) on
 * transfer notes. The pharmacy desk (the pharmacist, or anyone a department of theirs gives the
 * pharmacy, 0085) and the manager see every store, the value, what to order and what was sold; the
 * manager decides who holds each room store. Holders see only "My store".
 */
export function StockPage({
  user,
  initialTab,
  preset: initialPreset,
  focus = {},
}: {
  user: StaffUser
  initialTab?: Tab
  /** From the address: the medicine and stores the Receive / Send form starts with. */
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
  const [tab, setTab] = useState<'mine' | 'moves'>(initialTab === 'moves' ? 'moves' : 'mine')
  const { data } = useStockOverview()
  return (
    <>
      <PageBanner icon={Package} tint="mint" title={t('myStore.title')} lead={t('myStore.lead')} />
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
              'inline-flex min-h-8 items-center gap-2 rounded px-3 text-[14px] font-medium whitespace-nowrap transition-colors duration-120',
              tab === x
                ? 'bg-card text-primary border-border border'
                : 'text-ink-2 hover:bg-hover hover:text-ink border border-transparent',
            )}
          >
            <Icon size={16} aria-hidden="true" />
            {t(`stock.tabs.${x}`)}
            {n > 0 && (
              <span
                className={cn('rounded px-1.5 text-[12px] font-medium', 'bg-amber-bg text-amber')}
              >
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
  // receiving, sending, counting and the stores themselves: the manager, or the pharmacy desk with
  // the switch "Manage stock" (the database's stock_manager()); handing over and selling stay
  const can = useCan(user)
  const manage = isManager || can('stock.write')
  const blocked = <NotAllowedNotice feature="stock.write" />
  const tabs = holds
    ? [...ADMIN_TABS.slice(0, 6), 'mine' as const, ...ADMIN_TABS.slice(6)]
    : ADMIN_TABS
  // the pharmacy desk starts at the hand-over (only the manager starts at the stock)
  const [tab, setTab] = useState<Tab>(
    initialTab && (initialTab !== 'mine' || holds) ? initialTab : !isManager ? 'pharmacy' : 'stock',
  )
  const [preset, setPreset] = useState<StockPreset>(initialPreset ?? {})
  // each time the desk opens a form, it starts again with the new medicine and store
  const [opened, setOpened] = useState(0)
  const openStock: OpenStock = (to, p) => {
    setPreset(p)
    setTab(to)
    setOpened((n) => n + 1)
  }
  const { data, error } = useStockOverview()
  const { data: queue = [] } = usePharmacyQueue()
  const now = useNow(60_000)
  const items = data?.items ?? []
  const locations = data?.locations ?? []
  const { data: info } = useClinicInfo()
  // the report covers a chosen month (this month: up to today)
  const [reportMonth, setReportMonth] = useState(() => isoDate(new Date()).slice(0, 7))
  const [ry, rm] = reportMonth.split('-').map(Number)
  const reportFrom = isoDate(new Date(ry!, rm! - 1, 1))
  const monthEnd = isoDate(new Date(ry!, rm!, 0))
  const reportTo = monthEnd < isoDate(new Date(now)) ? monthEnd : isoDate(new Date(now))
  const { data: reportMoves = [] } = useStockMovements(reportFrom, reportTo, null)
  const { data: reportSales } = useStockSales(reportFrom, reportTo)
  const costShown = items.some((i) => i.costShown !== false)
  const value = items.reduce((s, i) => s + i.costValue, 0)
  const active = items.filter((i) => i.active)
  // tiles from unexpired stock: low, expiring (today to +90 days), expired (separately)
  const low = active.filter((i) => isLowStock(i)).length
  const expiring = active.filter((i) =>
    i.expiringUnits != null
      ? i.expiringUnits > 0
      : expiryState(i.nextExpiry ?? i.earliestExpiry) === 'soon',
  ).length
  const expired = active.filter((i) => i.expiredUnits > 0).length

  return (
    <>
      <PageBanner
        icon={Warehouse}
        tint="mint"
        title={t('stock.title')}
        lead={t('stock.lead')}
        meta={
          costShown ? (
            <BannerChip icon={Coins}>
              {t('stock.valueChip', { amount: formatRwf(value) })}
            </BannerChip>
          ) : undefined
        }
      >
        <label className="border-border bg-card flex h-10 items-center gap-2 rounded-md border px-3 text-[14px]">
          <span className="text-ink-3 text-[13px]">{t('stock.reportMonth')}</span>
          <input
            type="month"
            value={reportMonth}
            max={isoDate(new Date()).slice(0, 7)}
            onChange={(e) => e.target.value && setReportMonth(e.target.value)}
            className="bg-transparent outline-none"
          />
        </label>
        <ReportButtons
          build={() =>
            stockReport(
              items,
              reportMoves,
              reportSales,
              reportFrom,
              reportTo,
              info?.profile ?? CLINIC_PROFILE,
              user,
              t,
            )
          }
        />
      </PageBanner>
      {error && <p className={errorBox}>{error.message}</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(190px,1fr))] sm:gap-4">
        <Kpi
          i={0}
          icon={Boxes}
          tint="mint"
          label={t('stock.tiles.items')}
          value={active.length}
          unit={t('stock.units.items')}
        />
        {costShown && (
          <Kpi
            i={1}
            icon={Coins}
            tint="navy"
            label={t('stock.tiles.value')}
            value={Math.round(value)}
            unit="RWF"
          />
        )}
        <Kpi
          i={2}
          icon={AlertTriangle}
          tint="amber"
          label={t('stock.tiles.low')}
          value={low}
          unit={t('stock.units.toReorder')}
          delta={low > 0 ? { text: t('stock.reorderSoon'), good: false, up: null } : undefined}
        />
        <Kpi
          i={3}
          icon={AlertTriangle}
          tint="coral"
          label={t('stock.tiles.expiring')}
          value={expiring}
          unit={t('stock.units.in90')}
        />
        <Kpi
          i={4}
          icon={AlertTriangle}
          tint="coral"
          label={t('stockShared.tiles.expired')}
          value={expired}
          unit={t('stockShared.tiles.toWriteOff')}
        />
        <Kpi
          i={5}
          icon={Pill}
          tint="violet"
          label={t('stock.tiles.pharmacy')}
          value={queue.length}
          unit={t('stock.units.toHandOver')}
        />
        {data?.transit && (
          <Kpi
            i={6}
            icon={Truck}
            tint="teal"
            label={t('stockShared.tiles.onTheWay')}
            value={data.transit.units}
            unit={t('stockShared.tiles.notes', { count: data.transit.notes })}
          />
        )}
      </div>

      <TabBar
        tabs={tabs}
        tab={tab}
        onTab={(x) => {
          // a tab chosen by hand opens empty
          setTab(x)
          setPreset({})
        }}
        badge={{ pharmacy: queue.length }}
      />

      {tab === 'stock' && (
        <>
          <AlertsPanel onWriteOff={() => setTab('use')} />
          <StockTable items={items} locations={locations} canSetLevel={manage} />
        </>
      )}
      {tab === 'pharmacy' && <PharmacyDesk canDispense onOpenStock={openStock} />}
      {tab === 'receive' && !manage && blocked}
      {tab === 'receive' && manage && (
        <DeliveryForm
          key={opened}
          items={items}
          locations={locations}
          mainId={data?.mainPharmacyId ?? null}
          addsMedicines
          preset={preset}
        />
      )}
      {tab === 'deliveries' && <DeliveriesList focusId={focus.delivery} />}
      {tab === 'reorder' && (
        <ReorderTab
          items={items}
          onReceive={(item) => openStock('receive', { item })}
          canSetLevel={manage}
        />
      )}
      {tab === 'rooms' && !manage && blocked}
      {tab === 'rooms' && (
        <RoomStoresTab
          overview={data}
          isManager={isManager}
          canAct={manage}
          focusNote={focus.note}
          focusRequest={focus.request}
          focusStore={focus.store}
        />
      )}
      {tab === 'mine' && <MyStoreTab user={user} storeId={focus.store} noteId={focus.note} />}
      {tab === 'send' && !manage && blocked}
      {tab === 'send' && manage && (
        <SendForm key={opened} overview={data} preset={preset} onRooms={() => setTab('rooms')} />
      )}
      {tab === 'use' && (manage ? <UseForm items={items} locations={locations} /> : blocked)}
      {tab === 'medicines' && <MedicinesTab />}
      {tab === 'moves' && <Movements items={items} locations={locations} />}
      {tab === 'sales' && <Sales />}
      {tab === 'stores' && (
        <>
          {!manage && blocked}
          <StoresTab
            locations={locations}
            items={items}
            mainId={data?.mainPharmacyId ?? null}
            isManager={isManager}
          />
          {manage && <PharmacyCountForm items={items} locations={locations} />}
        </>
      )}
    </>
  )
}

/* ---------------------------------------------------------------- alerts */
/** Expired stock to write off, stock expiring within 90 days, room stores below their minimum. */
function AlertsPanel({ onWriteOff }: { onWriteOff: () => void }) {
  const { t } = useTranslation()
  const { data } = useStockAlerts()
  if (!data?.supported) return null
  const { expired, expiring, roomLow } = data
  if (expired.length + expiring.length + roomLow.length === 0) return null
  return (
    <Panel i={0} icon={AlertTriangle} tint="coral" title={t('stockShared.alertsTitle')}>
      {expired.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-red text-[14px] font-semibold">
            {t('stockShared.expiredList', { count: expired.length })}
          </span>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[14px]">
            {expired.slice(0, 8).map((x) => (
              <li key={`${x.storeId}-${x.itemId}-${x.batchNo}`}>
                <b>{x.item}</b> × {formatNumber(x.quantity)} · {x.store}
                {x.batchNo ? ` · ${x.batchNo}` : ''} · {formatDate(new Date(x.expiry))}
              </li>
            ))}
          </ul>
          <Button size="sm" className="self-start" onClick={onWriteOff}>
            <PackageMinus size={14} aria-hidden="true" />
            {t('stockShared.writeOffExpired')}
          </Button>
        </div>
      )}
      {expiring.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-amber text-[14px] font-semibold">
            {t('stockShared.expiringList', { count: expiring.length })}
          </span>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[14px]">
            {expiring.slice(0, 8).map((x) => (
              <li key={`${x.storeId}-${x.itemId}-${x.batchNo}`}>
                <b>{x.item}</b> × {formatNumber(x.quantity)} · {x.store}
                {x.batchNo ? ` · ${x.batchNo}` : ''} ·{' '}
                {t('stockShared.expiresIn', { count: x.days })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {roomLow.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[14px] font-semibold">
            {t('stockShared.roomLowList', { count: roomLow.length })}
          </span>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[14px]">
            {roomLow.slice(0, 8).map((x) => (
              <li key={`${x.storeId}-${x.itemId}`}>
                <b>{x.item}</b> · {x.store} ·{' '}
                {t('stockShared.roomLowLine', { count: x.onHand, min: x.min })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  )
}

/* ---------------------------------------------------------------- on hand */
function StockTable({
  items,
  locations,
  canSetLevel,
}: {
  items: StockItem[]
  locations: StockLocation[]
  /** The pharmacy and the manager set when a medicine shows as low. */
  canSetLevel: boolean
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [levelFor, setLevelFor] = useState<string | null>(null)
  const shown = items.filter((i) => i.active && matches(query, i.name, i.strength ?? '', i.code))
  const paged = usePaged(shown, 20, query)
  // open stores only, the pharmacy first, then the room stores
  const columns = [...pharmacySide(locations), ...roomStores(locations)]
  const showCost = items.some((i) => i.costShown !== false)
  const colCount = 4 + columns.length + (showCost ? 2 : 0)
  return (
    <Panel
      i={1}
      icon={Boxes}
      tint="mint"
      title={t('stock.onHand')}
      right={t('stock.itemCount', { count: shown.length })}
    >
      <ListBar query={query} onQuery={setQuery} placeholderKey="stock.search" />
      {paged.total === 0 ? (
        <Empty icon={Package}>{t('stock.empty')}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr className="text-ink-3 text-left text-[12px]">
                <th className="border-border border-b py-2 pr-2 font-medium">
                  {t('stock.cols.item')}
                </th>
                <th className="border-border border-b py-2 pr-2 text-right font-semibold">
                  {t('stockShared.cols.usable')}
                </th>
                {columns.map((l) => (
                  <th
                    key={l.id}
                    className="border-border hidden border-b py-2 pr-2 text-right font-semibold lg:table-cell"
                  >
                    {l.name}
                  </th>
                ))}
                {showCost && (
                  <th className="border-border hidden border-b py-2 pr-2 text-right font-semibold sm:table-cell">
                    {t('stock.cols.cost')}
                  </th>
                )}
                <th className="border-border border-b py-2 pr-2 text-right font-semibold">
                  {t('stock.cols.price')}
                </th>
                {showCost && (
                  <th className="border-border hidden border-b py-2 pr-2 text-right font-semibold md:table-cell">
                    {t('stock.cols.value')}
                  </th>
                )}
                <th className="border-border hidden border-b py-2 font-semibold md:table-cell">
                  {t('stockShared.cols.nextExpiry')}
                </th>
              </tr>
            </thead>
            <tbody>
              {paged.slice.map((i) => {
                const lowStock = isLowStock(i)
                const usable = i.usable ?? i.onHand - i.expiredUnits
                const next = i.nextExpiry ?? i.earliestExpiry
                const state = expiryState(next)
                return (
                  <Fragment key={i.id}>
                    <tr className="border-grid border-b last:border-b-0">
                      <td className="py-2 pr-2">
                        <span className="block font-semibold">{itemName(i)}</span>
                        <span className="text-ink-3 text-[12px]">
                          {i.code}
                          {i.unit ? ` · ${t('prices.meds.perUnit', { unit: i.unit })}` : ''}
                          {i.packSize && i.packSize > 1
                            ? ` · ${t('stockShared.packOf', { count: i.packSize })}`
                            : ''}
                          {' · '}
                          {canSetLevel ? (
                            <button
                              type="button"
                              className="text-primary underline-offset-2 hover:underline"
                              title={t('stock.reorderEdit')}
                              onClick={() => setLevelFor(levelFor === i.id ? null : i.id)}
                            >
                              {i.reorderLevel > 0
                                ? t('stock.reorderAt', { count: i.reorderLevel })
                                : t('stock.reorderNone')}
                            </button>
                          ) : i.reorderLevel > 0 ? (
                            t('stock.reorderAt', { count: i.reorderLevel })
                          ) : (
                            t('stock.reorderNone')
                          )}
                          {i.inTransit
                            ? ` · ${t('stockShared.inTransit', { count: i.inTransit })}`
                            : ''}
                        </span>
                      </td>
                      <td
                        className={cn(
                          'py-2 pr-2 text-right font-semibold tabular-nums',
                          lowStock ? 'text-red' : usable <= 0 ? 'text-ink-3' : 'text-green',
                        )}
                      >
                        {formatNumber(usable)}
                        {lowStock && (
                          <Badge tone="red" className="ml-1.5">
                            {t('stock.low')}
                          </Badge>
                        )}
                        {i.pharmacyUsable != null && (
                          <span className="text-ink-3 block text-[11px] font-normal">
                            {t('stockShared.inPharmacyShort', { count: i.pharmacyUsable })}
                          </span>
                        )}
                      </td>
                      {columns.map((l) => (
                        <td
                          key={l.id}
                          className="text-ink-2 hidden py-2 pr-2 text-right tabular-nums lg:table-cell"
                        >
                          {i.byLocation[l.id] ? formatNumber(i.byLocation[l.id]!) : '—'}
                        </td>
                      ))}
                      {showCost && (
                        <td className="hidden py-2 pr-2 text-right tabular-nums sm:table-cell">
                          {i.avgCost == null ? '—' : formatNumber(i.avgCost)}
                        </td>
                      )}
                      <td className="py-2 pr-2 text-right font-semibold tabular-nums">
                        {i.sellingPrice == null
                          ? t('prices.noPrice')
                          : formatNumber(i.sellingPrice)}
                      </td>
                      {showCost && (
                        <td className="hidden py-2 pr-2 text-right tabular-nums md:table-cell">
                          {formatNumber(Math.round(i.costValue))}
                        </td>
                      )}
                      <td
                        className={cn(
                          'hidden py-2 tabular-nums md:table-cell',
                          state === 'soon' && 'text-amber font-semibold',
                        )}
                      >
                        {next && state !== 'expired' ? formatDate(new Date(next)) : '—'}
                        {(i.expiringUnits ?? 0) > 0 && (
                          <span className="text-amber block text-[12px]">
                            {t('myStore.expiringUnits', { count: i.expiringUnits })}
                          </span>
                        )}
                        {i.expiredUnits > 0 && (
                          <span className="text-red block text-[12px] font-semibold">
                            {t('stock.expired', { count: i.expiredUnits })}
                          </span>
                        )}
                      </td>
                    </tr>
                    {levelFor === i.id && (
                      <tr className="border-grid border-b">
                        <td colSpan={colCount} className="bg-surface px-3 py-2">
                          <LevelEditor item={i} onDone={() => setLevelFor(null)} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager {...paged} onPage={paged.setPage} />
    </Panel>
  )
}

/* ---------------------------------------------------------------- between pharmacy stores */
/**
 * Stock moved between the pharmacy's own stores, or from the old main store to the pharmacy.
 * Room stores are supplied on transfer notes (Room stores tab), and return their stock the same
 * way.
 */
function SendForm({
  overview,
  preset,
  onRooms,
}: {
  overview: StockOverview | undefined
  /** The medicine and the store to send to (e.g. the pharmacy, short of it). */
  preset?: StockPreset
  onRooms: () => void
}) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const confirm = useConfirm()
  const items = overview?.items ?? []
  const locations = overview?.locations ?? []
  const sources = pharmacySide(locations)
  const targets = pharmacyStores(locations)
  const [itemId, setItemId] = useState(preset?.item ?? '')
  const item = items.find((i) => i.id === itemId)
  const [chosenTo, setTo] = useState('')
  const to =
    chosenTo ||
    (targets.find((l) => l.id === preset?.to)?.id ??
      mainPharmacy(locations, overview?.mainPharmacyId)?.id ??
      '')
  // from the other pharmacy-side store holding the most of it
  const fullest = item
    ? sources
        .filter((l) => l.id !== to && usableIn(item, l.id) > 0)
        .sort((a, b) => usableIn(item, b.id) - usableIn(item, a.id))[0]?.id
    : undefined
  const [chosenFrom, setFrom] = useState('')
  const from = chosenFrom || (fullest ?? sources.find((l) => l.id !== to)?.id ?? '')
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState<Msg | null>(null)
  const available = usableIn(item, from)
  // the medicine is only in room stores: they return it on a return note
  const inRooms = item ? roomStores(locations).filter((l) => (item.byLocation[l.id] ?? 0) > 0) : []
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    const q = Number(quantity)
    if (!itemId) return setMsg({ ok: false, text: t('stock.errors.item') })
    if (!from || !to || from === to) return setMsg({ ok: false, text: t('stock.errors.store') })
    if (!Number.isInteger(q) || q <= 0)
      return setMsg({ ok: false, text: t('stock.errors.quantity') })
    if (q > available)
      return setMsg({ ok: false, text: t('stock.errors.short', { count: available }) })
    const toName = locations.find((l) => l.id === to)?.name ?? ''
    if (
      !(await confirm({
        title: t('confirm.stock.sendTitle', {
          quantity: q,
          item: itemName(item),
          from: locations.find((l) => l.id === from)?.name ?? '',
          to: toName,
        }),
        confirmLabel: t('confirm.stock.sendYes'),
      }))
    )
      return
    try {
      await actions.transfer.mutateAsync({ itemId, from, to, quantity: q, reason })
      setMsg({ ok: true, text: t('stock.sent', { count: q, item: itemName(item), to: toName }) })
      setQuantity('')
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <Panel i={1} icon={ArrowRightLeft} tint="teal" title={t('stockShared.sendTitle')}>
      <p className="text-ink-2 m-0 text-[14px]">{t('stockShared.sendLead')}</p>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <SearchSelect
          label={t('stock.cols.item')}
          value={itemId}
          onChange={setItemId}
          required
          emptyLabel={t('visit.add.pickItem')}
          options={items
            .filter((i) => i.active && i.onHand > 0)
            .map((i) => ({
              value: i.id,
              label: `${itemName(i)} · ${t('stock.onHandShort', { count: i.onHand })}`,
            }))}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Select
            label={t('stock.fromStore')}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            required
          >
            {sources.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {item ? ` · ${usableIn(item, l.id)}` : ''}
              </option>
            ))}
          </Select>
          <Select
            label={t('stock.toStore')}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            required
          >
            <option value="">{t('stock.pickStore')}</option>
            {targets
              .filter((l) => l.id !== from)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.isMain ? ` · ${t('stockStores.main')}` : ''}
                </option>
              ))}
          </Select>
          <Field
            label={t('stock.quantity')}
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, ''))}
            required
          />
        </div>
        {item && (
          <p className="text-ink-3 m-0 text-[13px]">
            {t('stock.availableHere', { count: available })}
          </p>
        )}
        {item && available === 0 && inRooms.length > 0 && (
          <p className="bg-blue-bg text-blue m-0 rounded-md px-3 py-2 text-[14px]">
            {t('stockShared.onlyInRooms', { stores: inRooms.map((l) => l.name).join(', ') })}{' '}
            <button type="button" className="font-semibold underline" onClick={onRooms}>
              {t('stockShared.openRooms')}
            </button>
          </p>
        )}
        <Field
          label={t('stock.reason')}
          value={reason}
          placeholder={t('stockShared.sendReasonPh')}
          onChange={(e) => setReason(e.target.value)}
          wrapperClassName="sm:max-w-md"
        />
        <MsgFlash msg={msg} onClose={() => setMsg(null)} />
        <Button
          type="submit"
          variant="primary"
          className="self-start"
          loading={actions.transfer.isPending}
        >
          <ArrowRightLeft size={16} aria-hidden="true" />
          {t('stock.send')}
        </Button>
      </form>
    </Panel>
  )
}

/* ---------------------------------------------------------------- use / write off */
const USE_REASONS = ['expired', 'damaged', 'usedAtDesk', 'countCorrection'] as const
/**
 * Pharmacy stock that leaves without a sale: expired, damaged, used at a desk or a count
 * correction, with the reason. Room stores write off their own stock under "My store".
 */
function UseForm({ items, locations }: { items: StockItem[]; locations: StockLocation[] }) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const confirm = useConfirm()
  const stores = pharmacySide(locations)
  const [itemId, setItemId] = useState('')
  const [chosenFrom, setFrom] = useState('')
  const from =
    chosenFrom ||
    (stores.find((l) => l.isMain)?.id ??
      stores.find((l) => l.type === 'pharmacy')?.id ??
      stores[0]?.id ??
      '')
  const [quantity, setQuantity] = useState('')
  const [why, setWhy] = useState<(typeof USE_REASONS)[number]>('expired')
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<Msg | null>(null)
  const item = items.find((i) => i.id === itemId)
  const available = item ? (item.byLocation[from] ?? 0) : 0
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    const q = Number(quantity)
    if (!itemId) return setMsg({ ok: false, text: t('stock.errors.item') })
    if (!from) return setMsg({ ok: false, text: t('stock.errors.store') })
    if (!Number.isInteger(q) || q <= 0)
      return setMsg({ ok: false, text: t('stock.errors.quantity') })
    if (q > available)
      return setMsg({ ok: false, text: t('stock.errors.short', { count: available }) })
    const reason = [t(`stock.useReasons.${why}`), note.trim()].filter(Boolean).join(': ')
    if (
      !(await confirm({
        title: t('confirm.stock.useTitle', {
          quantity: q,
          item: itemName(item),
          store: locations.find((l) => l.id === from)?.name ?? '',
        }),
        body: t('confirm.stock.useBody', { reason }),
        confirmLabel: t('confirm.stock.useYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await actions.use.mutateAsync({ itemId, locationId: from, quantity: q, reason })
      setMsg({ ok: true, text: t('stock.used', { count: q, item: itemName(item) }) })
      setQuantity('')
      setNote('')
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <Panel i={1} icon={PackageMinus} tint="coral" title={t('stock.useTitle')}>
      <p className="text-ink-2 m-0 text-[14px]">{t('stockShared.useLead')}</p>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <SearchSelect
          label={t('stock.cols.item')}
          value={itemId}
          onChange={setItemId}
          required
          emptyLabel={t('visit.add.pickItem')}
          options={items
            .filter((i) => i.active && stores.some((l) => (i.byLocation[l.id] ?? 0) > 0))
            .map((i) => ({
              value: i.id,
              label: `${itemName(i)} · ${t('stock.onHandShort', { count: i.onHand })}${i.expiredUnits > 0 ? ` · ${t('stock.expired', { count: i.expiredUnits })}` : ''}`,
            }))}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Select
            label={t('stock.fromStore')}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            required
          >
            {stores.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {item ? ` · ${item.byLocation[l.id] ?? 0}` : ''}
              </option>
            ))}
          </Select>
          <Select
            label={t('stock.useWhy')}
            value={why}
            onChange={(e) => setWhy(e.target.value as typeof why)}
          >
            {USE_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`stock.useReasons.${r}`)}
              </option>
            ))}
          </Select>
          <Field
            label={t('stock.quantity')}
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, ''))}
            required
          />
        </div>
        {item && (
          <p className="text-ink-3 m-0 text-[13px]">
            {t('stock.availableHere', { count: available })}
            {item.expiredUnits > 0 && ` · ${t('stock.expired', { count: item.expiredUnits })}`}
          </p>
        )}
        <Field
          label={t('stock.reason')}
          value={note}
          placeholder={t('stock.useNotePh')}
          onChange={(e) => setNote(e.target.value)}
          wrapperClassName="sm:max-w-md"
        />
        <MsgFlash msg={msg} onClose={() => setMsg(null)} />
        <Button
          type="submit"
          variant="primary"
          className="self-start"
          loading={actions.use.isPending}
        >
          <PackageMinus size={16} aria-hidden="true" />
          {t('stock.useSave')}
        </Button>
      </form>
    </Panel>
  )
}

/* ---------------------------------------------------------------- medicines and prices */
/** The medicines list with prices: the pharmacist and the manager add medicines and set prices. */
function MedicinesTab() {
  const [notice, setNotice] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-3">
      {notice && (
        <Flash key={notice} onClose={() => setNotice(null)}>
          {notice}
        </Flash>
      )}
      <MedicinesSection onNotice={setNotice} />
    </div>
  )
}

/* ---------------------------------------------------------------- ledger */
function Movements({ items, locations }: { items: StockItem[]; locations: StockLocation[] }) {
  const { t } = useTranslation()
  const period = usePeriod('month')
  const { from, to } = period
  const [itemId, setItemId] = useState('')
  const [locationId, setLocationId] = useState('')
  const { data: moves = [] } = useStockMovements(from, to, itemId || null, locationId || null)
  const paged = usePaged(moves, 20, `${from}|${to}|${itemId}|${locationId}`)
  return (
    <Panel
      i={1}
      icon={ListOrdered}
      tint="navy"
      title={t('stock.movesTitle')}
      right={String(moves.length)}
    >
      <PeriodFilter period={period} />
      <div className="grid grid-cols-1 gap-3 sm:max-w-3xl sm:grid-cols-2">
        <SearchSelect
          label={t('stock.cols.item')}
          value={itemId}
          onChange={setItemId}
          emptyLabel={t('notices.filters.all')}
          options={items.map((i) => ({ value: i.id, label: itemName(i) }))}
        />
        {locations.length > 1 && (
          <Select
            label={t('stock.store')}
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          >
            <option value="">{t('notices.filters.all')}</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.active === false ? ` · ${t('stockStores.closed')}` : ''}
              </option>
            ))}
          </Select>
        )}
      </div>
      {paged.total === 0 ? (
        <Empty>{t('stock.noMoves')}</Empty>
      ) : (
        <div className="flex flex-col">
          {paged.slice.map((m) => (
            <div
              key={m.id}
              className="border-grid flex flex-wrap items-center gap-3 border-b py-2 text-[14px] last:border-b-0"
            >
              <span className="text-ink-3 w-24 tabular-nums">
                {formatDate(new Date(m.at))}
                <span className="block text-[12px]">{formatTime(new Date(m.at))}</span>
              </span>
              <Badge
                tone={
                  m.type === 'receipt'
                    ? 'green'
                    : m.type === 'transfer'
                      ? 'blue'
                      : m.type === 'dispense'
                        ? 'yellow'
                        : 'grey'
                }
              >
                {t(`stock.types.${m.type}`)}
              </Badge>
              <span className="min-w-[180px] flex-1">
                <span className="block font-semibold">
                  {m.item} × {formatNumber(m.quantity)}
                </span>
                <span className="text-ink-3 block text-[12px]">
                  {[
                    m.from && m.to ? `${m.from} → ${m.to}` : (m.to ?? m.from),
                    m.transfer ?? m.delivery ?? m.sale,
                    m.batch,
                    m.expiry ? t('stock.exp', { date: formatDate(new Date(m.expiry)) }) : null,
                    m.reason,
                    m.by,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              {m.unitCost != null && (
                <span className="tabular-nums">
                  {formatRwf(Math.round(m.value ?? m.quantity * m.unitCost))}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      <Pager {...paged} onPage={paged.setPage} />
    </Panel>
  )
}

/* ---------------------------------------------------------------- sales and value */
function Sales() {
  const { t } = useTranslation()
  const period = usePeriod('month')
  const { data } = useStockSales(period.from, period.to)
  const revenue = data?.items.reduce((s, x) => s + x.revenue, 0) ?? 0
  const cost = data?.items.reduce((s, x) => s + x.cost, 0) ?? 0
  return (
    <div className="flex flex-col gap-4">
      <PeriodFilter period={period} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(190px,1fr))] sm:gap-4">
        <Kpi
          i={0}
          icon={Coins}
          tint="mint"
          label={t('stock.sales.revenue')}
          value={revenue}
          unit="RWF"
        />
        <Kpi
          i={1}
          icon={Coins}
          tint="amber"
          label={t('stock.sales.cost')}
          value={Math.round(cost)}
          unit="RWF"
        />
        <Kpi
          i={2}
          icon={Coins}
          tint="violet"
          label={t('stock.sales.margin')}
          value={Math.round(revenue - cost)}
          unit="RWF"
        />
        <Kpi
          i={3}
          icon={Warehouse}
          tint="navy"
          label={t('stock.sales.value')}
          value={Math.round(data?.stockValue ?? 0)}
          unit="RWF"
        />
        {data?.counterRevenue != null && (
          <Kpi
            i={4}
            icon={Coins}
            tint="teal"
            label={t('stockShared.counterRevenue')}
            value={Math.round(data.counterRevenue)}
            unit="RWF"
          />
        )}
      </div>
      <Panel i={2} icon={Coins} tint="mint" title={t('stock.sales.byItem')}>
        {!data || data.items.length === 0 ? (
          <Empty>{t('stock.sales.none')}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[14px]">
              <thead>
                <tr className="text-ink-3 text-left text-[12px]">
                  <th className="border-border border-b py-2 pr-2 font-medium">
                    {t('stock.cols.item')}
                  </th>
                  <th className="border-border border-b py-2 pr-2 text-right font-semibold">
                    {t('stock.sales.units')}
                  </th>
                  <th className="border-border border-b py-2 pr-2 text-right font-semibold">
                    {t('stock.sales.revenue')}
                  </th>
                  <th className="border-border hidden border-b py-2 pr-2 text-right font-semibold sm:table-cell">
                    {t('stock.sales.cost')}
                  </th>
                  <th className="border-border border-b py-2 text-right font-semibold">
                    {t('stock.sales.margin')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((x) => (
                  <tr key={x.item} className="border-grid border-b last:border-b-0">
                    <td className="py-2 pr-2 font-semibold">{x.item}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatNumber(x.units)}</td>
                    <td className="py-2 pr-2 text-right font-semibold tabular-nums">
                      {formatNumber(x.revenue)}
                    </td>
                    <td className="hidden py-2 pr-2 text-right tabular-nums sm:table-cell">
                      {formatNumber(Math.round(x.cost))}
                    </td>
                    <td
                      className={cn(
                        'py-2 text-right font-semibold tabular-nums',
                        x.margin >= 0 ? 'text-green' : 'text-red',
                      )}
                    >
                      {formatNumber(Math.round(x.margin))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-ink-3 m-0 text-[13px]">
          {t('stock.sales.flows', {
            received: formatRwf(Math.round(data?.received ?? 0)),
            consumed: formatRwf(Math.round(data?.consumed ?? 0)),
          })}
        </p>
      </Panel>
    </div>
  )
}

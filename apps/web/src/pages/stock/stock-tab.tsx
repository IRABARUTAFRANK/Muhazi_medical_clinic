import { useState } from 'react'
import {
  AlertTriangle,
  Boxes,
  ChevronRight,
  Clock,
  Coins,
  Gauge,
  Package,
  Tags,
  Truck,
  Warehouse,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatNumber, formatRwf } from '@mmc/shared'
import { Empty, Kpi, Panel, Pill as KitPill, SectionTitle } from '@/components/dash/kit'
import {
  selectedRow,
  tableCell,
  tableFirstCell,
  tableHead,
  tableRow,
} from '@/components/dash/kit-style'
import { Flash } from '@/components/ui/flash'
import { ListBar, Pager } from '@/components/ui/list-tools'
import { Seg } from '@/components/ui/seg'
import { isLowStock, useStockAlerts, type StockItem, type StockOverview } from '@/lib/api/stock'
import { EXPIRY_WINDOW_DAYS, type StockTotals } from '@/lib/api/pharmacy'
import { matches, usePaged } from '@/lib/paging'
import { cn } from '@/lib/utils'
import { MedicinesSection } from '../prices/medicines-section'
import { ItemPanel } from './item-panel'
import { StatusTags } from './stock-shared'
import { ReorderTab } from './reorder-tab'
import { expiryState, itemName, itemStatuses, splitStock, type ItemStatus } from './stock-util'

type Part = 'list' | 'order' | 'prices'
type Filter = 'all' | ItemStatus

/**
 * The Stock tab: the totals of the stock now (stock_totals), what needs attention, then one row
 * per item (in the pharmacy, in the room stores, the total, the nearest expiry and a status tag:
 * OK, Low, Expiring within 30 days, Expired). A row opens the item in a side panel: its batches
 * store by store, and the actions (reorder point, write off with a reason, correct a count).
 * "To order" and "Medicines & prices" sit beside the list.
 */
export function StockTab({
  overview,
  totals,
  manage,
  initialPart,
  onAddStock,
}: {
  overview: StockOverview | undefined
  /** null: a database without stock_totals (the tiles count from the overview). */
  totals: StockTotals | null
  /** "Manage stock" (or the manager): reorder points, write-offs, counts. */
  manage: boolean
  /** From the address (an older tab): "order" or "prices". */
  initialPart?: string
  onAddStock: (itemId?: string) => void
}) {
  const { t } = useTranslation()
  const items = overview?.items ?? []
  const locations = overview?.locations ?? []
  const [part, setPart] = useState<Part>(
    initialPart === 'order' || initialPart === 'prices' ? initialPart : 'list',
  )
  const [openId, setOpenId] = useState<string | null>(null)
  const openItem = items.find((i) => i.id === openId) ?? null

  return (
    <div className="flex flex-col gap-4">
      <TotalsBand items={items} totals={totals} transit={overview?.transit ?? null} />
      <AlertsPanel onOpen={setOpenId} />
      <Seg
        label={t('stockPage.partsLabel')}
        value={part}
        onChange={setPart}
        options={[
          { value: 'list', label: t('stockPage.parts.list') },
          { value: 'order', label: t('stock.tabs.reorder') },
          { value: 'prices', label: t('stock.tabs.medicines') },
        ]}
        className="self-start"
      />
      {part === 'list' && (
        <StockList items={items} overview={overview} openId={openId} onOpen={setOpenId} />
      )}
      {part === 'order' && (
        <ReorderTab items={items} onReceive={(item) => onAddStock(item)} canSetLevel={manage} />
      )}
      {part === 'prices' && <MedicinesTab />}
      <ItemPanel
        item={openItem}
        locations={locations}
        manage={manage}
        onClose={() => setOpenId(null)}
        onAddStock={(id) => {
          setOpenId(null)
          onAddStock(id)
        }}
      />
    </div>
  )
}

/* ---------------------------------------------------------------- totals */
function TotalsBand({
  items,
  totals,
  transit,
}: {
  items: StockItem[]
  totals: StockTotals | null
  transit: StockOverview['transit']
}) {
  const { t } = useTranslation()
  const active = items.filter((i) => i.active)
  const costShown = items.some((i) => i.costShown !== false)
  // a database without stock_totals: the same figures from the overview
  const tl: StockTotals = totals ?? {
    inventoryCost: active.reduce((s, i) => s + i.costValue, 0),
    sellingValue: active.reduce(
      (s, i) => s + (i.usable ?? i.onHand - i.expiredUnits) * (i.sellingPrice ?? 0),
      0,
    ),
    items: active.length,
    low: active.filter((i) => isLowStock(i)).length,
    expiring30: active.filter((i) => expiryState(i.nextExpiry ?? i.earliestExpiry) === 'soon')
      .length,
    expiredUnits: active.reduce((s, i) => s + i.expiredUnits, 0),
    expiredCost: active.reduce((s, i) => s + i.expiredUnits * (i.avgCost ?? 0), 0),
  }
  return (
    <>
      <SectionTitle icon={Warehouse}>{t('stockPage.totalsTitle')}</SectionTitle>
      <div className="pc:grid-cols-[repeat(auto-fit,minmax(150px,1fr))] grid grid-cols-1 gap-3 sm:grid-cols-2">
        {costShown && (
          <Kpi
            i={0}
            icon={Coins}
            tint="teal"
            label={t('stockPage.tiles.cost')}
            value={Math.round(tl.inventoryCost)}
            unit="RWF"
          />
        )}
        {costShown && (
          <Kpi
            i={1}
            icon={Tags}
            tint="mint"
            label={t('stockPage.tiles.selling')}
            value={Math.round(tl.sellingValue)}
            unit="RWF"
          />
        )}
        <Kpi
          i={2}
          icon={Boxes}
          tint="navy"
          label={t('stockPage.tiles.items')}
          value={tl.items}
          unit={t('stock.units.items')}
        />
        <Kpi
          i={3}
          icon={Gauge}
          tint="amber"
          label={t('stock.tiles.low')}
          value={tl.low}
          unit={t('stock.units.toReorder')}
          delta={tl.low > 0 ? { text: t('stock.reorderSoon'), good: false, up: null } : undefined}
        />
        <Kpi
          i={4}
          icon={Clock}
          tint="amber"
          label={t('stock.tiles.expiring')}
          value={tl.expiring30}
          unit={t('stockPage.units.inDays', { count: EXPIRY_WINDOW_DAYS })}
        />
        <Kpi
          i={5}
          icon={AlertTriangle}
          tint="coral"
          label={t('stockPage.tiles.expired')}
          value={tl.expiredUnits}
          unit={
            costShown && tl.expiredCost > 0
              ? t('stockPage.units.expiredCost', { value: formatRwf(Math.round(tl.expiredCost)) })
              : t('stockShared.tiles.toWriteOff')
          }
        />
        {transit && transit.units > 0 && (
          <Kpi
            i={6}
            icon={Truck}
            tint="violet"
            label={t('stockShared.tiles.onTheWay')}
            value={transit.units}
            unit={t('stockShared.tiles.notes', { count: transit.notes })}
          />
        )}
      </div>
    </>
  )
}

/* ---------------------------------------------------------------- alerts */
const alertList = 'm-0 flex list-none flex-col p-0 text-[14px]'
const alertRow =
  'border-grid hover:bg-hover flex min-h-10 w-full flex-wrap items-center gap-2.5 border-b px-1 py-1.5 text-left last:border-b-0 transition-colors duration-120'

/**
 * Expired batches still on a shelf, batches expiring within 30 days, room stores below their
 * minimum. A batch opens its item (the write-off is there).
 */
function AlertsPanel({ onOpen }: { onOpen: (itemId: string) => void }) {
  const { t } = useTranslation()
  const { data } = useStockAlerts()
  if (!data?.supported) return null
  const { expired, roomLow } = data
  const expiring = data.expiring.filter((x) => x.days <= EXPIRY_WINDOW_DAYS)
  if (expired.length + expiring.length + roomLow.length === 0) return null
  return (
    <Panel i={0} icon={AlertTriangle} tint="coral" title={t('stockShared.alertsTitle')}>
      {expired.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-red flex items-center gap-1.5 text-[14px] font-semibold">
            <AlertTriangle size={16} aria-hidden="true" />
            {t('stockShared.expiredList', { count: expired.length })}
          </span>
          <ul className={alertList}>
            {expired.slice(0, 8).map((x) => (
              <li key={`${x.storeId}-${x.itemId}-${x.batchNo}`}>
                <button type="button" className={alertRow} onClick={() => onOpen(x.itemId)}>
                  <KitPill tint="coral" icon={AlertTriangle}>
                    {formatDate(new Date(x.expiry))}
                  </KitPill>
                  <span className="min-w-[min(12rem,100%)] flex-1 wrap-break-word">
                    <b>{x.item}</b> × {formatNumber(x.quantity)}
                    <span className="text-ink-3">
                      {' · '}
                      {x.store}
                      {x.batchNo ? ` · ${x.batchNo}` : ''}
                    </span>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" className="text-ink-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {expiring.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-amber flex items-center gap-1.5 text-[14px] font-semibold">
            <Clock size={16} aria-hidden="true" />
            {t('stockPage.expiringList', { count: expiring.length, days: EXPIRY_WINDOW_DAYS })}
          </span>
          <ul className={alertList}>
            {expiring.slice(0, 8).map((x) => (
              <li key={`${x.storeId}-${x.itemId}-${x.batchNo}`}>
                <button type="button" className={alertRow} onClick={() => onOpen(x.itemId)}>
                  <KitPill tint="amber" icon={Clock}>
                    {t('stockShared.expiresIn', { count: x.days })}
                  </KitPill>
                  <span className="min-w-[min(12rem,100%)] flex-1 wrap-break-word">
                    <b>{x.item}</b> × {formatNumber(x.quantity)}
                    <span className="text-ink-3">
                      {' · '}
                      {x.store}
                      {x.batchNo ? ` · ${x.batchNo}` : ''}
                    </span>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" className="text-ink-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {roomLow.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-ink flex items-center gap-1.5 text-[14px] font-semibold">
            <Gauge size={16} aria-hidden="true" className="text-amber" />
            {t('stockShared.roomLowList', { count: roomLow.length })}
          </span>
          <ul className={alertList}>
            {roomLow.slice(0, 8).map((x) => (
              <li key={`${x.storeId}-${x.itemId}`}>
                <button type="button" className={alertRow} onClick={() => onOpen(x.itemId)}>
                  <KitPill tint="amber" icon={Gauge}>
                    {t('stockShared.roomLowLine', { count: x.onHand, min: x.min })}
                  </KitPill>
                  <span className="min-w-[min(12rem,100%)] flex-1 wrap-break-word">
                    <b>{x.item}</b>
                    <span className="text-ink-3"> · {x.store}</span>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" className="text-ink-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  )
}

/* ---------------------------------------------------------------- one row per item */
function StockList({
  items,
  overview,
  openId,
  onOpen,
}: {
  items: StockItem[]
  overview: StockOverview | undefined
  openId: string | null
  onOpen: (id: string) => void
}) {
  const { t } = useTranslation()
  const locations = overview?.locations ?? []
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const rows = items
    .filter((i) => i.active && matches(query, i.name, i.strength ?? '', i.code))
    .map((i) => ({ i, statuses: itemStatuses(i), split: splitStock(i, locations) }))
  const count = (f: ItemStatus) => rows.filter((r) => r.statuses.includes(f)).length
  const shown = filter === 'all' ? rows : rows.filter((r) => r.statuses.includes(filter))
  const paged = usePaged(shown, 20, `${query}|${filter}`)
  return (
    <Panel
      i={1}
      icon={Boxes}
      tint="amber"
      title={t('stock.onHand')}
      right={t('stock.itemCount', { count: shown.length })}
    >
      <div className="flex flex-wrap items-end gap-3">
        <ListBar
          query={query}
          onQuery={setQuery}
          placeholderKey="stock.search"
          className="min-w-[min(220px,100%)] flex-1"
        />
        <Seg
          size="sm"
          label={t('stockPage.filterLabel')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('stockPage.filter.all') },
            { value: 'low', label: `${t('stockPage.status.low')} · ${count('low')}` },
            {
              value: 'expiring',
              label: `${t('stockPage.status.expiring', { count: EXPIRY_WINDOW_DAYS })} · ${count('expiring')}`,
            },
            { value: 'expired', label: `${t('stockPage.status.expired')} · ${count('expired')}` },
          ]}
        />
      </div>
      {paged.total === 0 ? (
        <Empty icon={Package}>{t('stock.empty')}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[14px]">
            <thead className="bg-surface">
              <tr className="border-border border-b">
                <th className={tableHead}>{t('stockPage.cols.item')}</th>
                <th className={cn(tableHead, 'text-right')}>{t('stockPage.cols.pharmacy')}</th>
                <th className={cn(tableHead, 'hidden text-right sm:table-cell')}>
                  {t('stockPage.cols.rooms')}
                </th>
                <th className={cn(tableHead, 'hidden text-right sm:table-cell')}>
                  {t('stockPage.cols.total')}
                </th>
                <th className={cn(tableHead, 'hidden md:table-cell')}>
                  {t('stockPage.cols.expiry')}
                </th>
                <th className={tableHead}>{t('stockPage.cols.status')}</th>
              </tr>
            </thead>
            <tbody>
              {paged.slice.map(({ i, statuses, split }) => {
                const next = i.nextExpiry ?? i.earliestExpiry
                const state = expiryState(next)
                return (
                  <tr
                    key={i.id}
                    className={cn(tableRow, 'cursor-pointer', openId === i.id && selectedRow)}
                    onClick={() => onOpen(i.id)}
                  >
                    <td className={tableFirstCell}>
                      <button
                        type="button"
                        className="text-ink hover:text-primary block text-left font-medium"
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpen(i.id)
                        }}
                      >
                        {itemName(i)}
                      </button>
                      <span className="text-ink-3 text-[12px]">
                        {[
                          i.code,
                          i.unit ? t('prices.meds.perUnit', { unit: i.unit }) : null,
                          i.kind === 'supply' ? t('stockPage.kind.supply') : null,
                          i.reorderLevel > 0
                            ? t('stock.reorderAt', { count: i.reorderLevel })
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </td>
                    <td
                      className={cn(
                        tableCell,
                        'text-right font-semibold tabular-nums',
                        statuses.includes('low')
                          ? 'text-red'
                          : split.pharmacy <= 0
                            ? 'text-ink-3'
                            : 'text-green',
                      )}
                    >
                      {formatNumber(split.pharmacy)}
                    </td>
                    <td
                      className={cn(
                        tableCell,
                        'text-ink-2 hidden text-right tabular-nums sm:table-cell',
                      )}
                    >
                      {split.rooms ? formatNumber(split.rooms) : '—'}
                    </td>
                    <td className={cn(tableCell, 'hidden text-right tabular-nums sm:table-cell')}>
                      {formatNumber(split.total)}
                      {i.expiredUnits > 0 && (
                        <span className="text-red block text-[12px] font-semibold">
                          {t('stock.expired', { count: i.expiredUnits })}
                        </span>
                      )}
                    </td>
                    <td
                      className={cn(
                        tableCell,
                        'hidden tabular-nums md:table-cell',
                        state === 'soon' && 'text-amber font-semibold',
                      )}
                    >
                      {next && state !== 'expired' ? formatDate(new Date(next)) : '—'}
                    </td>
                    <td className={tableCell}>
                      <StatusTags statuses={statuses} />
                    </td>
                  </tr>
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

/* ---------------------------------------------------------------- medicines and prices */
/** The medicines list with prices: the pharmacist and the manager add items and set prices. */
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

import { createElement, useState } from 'react'
import {
  ArrowRightLeft,
  Coins,
  ListOrdered,
  PackageMinus,
  PackagePlus,
  Pill,
  Store,
  TrendingUp,
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
import { Empty, Kpi, Panel, SectionTitle } from '@/components/dash/kit'
import { tableCell, tableFirstCell, tableHead, tableRow } from '@/components/dash/kit-style'
import { ActionRow } from '@/components/dash/page-banner'
import { PeriodFilter } from '@/components/dash/period-filter'
import { ReportButtons } from '@/components/dash/report-buttons'
import { Badge } from '@/components/ui/badge'
import { Pager } from '@/components/ui/list-tools'
import { Seg } from '@/components/ui/seg'
import { Select } from '@/components/ui/select'
import { SearchSelect } from '@/components/ui/search-select'
import {
  useBoughtOutside,
  useStockMovements,
  useStockSales,
  type StockItem,
  type StockLocation,
} from '@/lib/api/stock'
import { useClinicInfo } from '@/lib/api/public'
import { useNow } from '@/lib/hooks'
import { usePaged } from '@/lib/paging'
import { usePeriod } from '@/lib/period'
import { stockReport } from '@/lib/reports/build'
import { cn } from '@/lib/utils'
import { DeliveriesList } from './delivery-form'
import { itemName } from './stock-util'

type Part = 'sales' | 'moves' | 'deliveries' | 'outside'

/**
 * Reports: the month's report (PDF / Excel), sales and value (revenue, the cost of what was sold
 * and the margin, by item), the movements ledger, the stock received and the medicines patients
 * were sent to buy at an outside pharmacy (0100).
 */
export function StockReports({
  user,
  items,
  locations,
  initialPart,
  focusDelivery,
}: {
  user: StaffUser
  items: StockItem[]
  locations: StockLocation[]
  initialPart?: string
  /** A delivery a notice points to: opens "Stock received" on it. */
  focusDelivery?: string
}) {
  const { t } = useTranslation()
  const [part, setPart] = useState<Part>(
    focusDelivery
      ? 'deliveries'
      : initialPart === 'moves' || initialPart === 'deliveries' || initialPart === 'outside'
        ? initialPart
        : 'sales',
  )
  const now = useNow(60_000)
  const { data: info } = useClinicInfo()
  // the report covers a chosen month (this month: up to today)
  const [reportMonth, setReportMonth] = useState(() => isoDate(new Date()).slice(0, 7))
  const [ry, rm] = reportMonth.split('-').map(Number)
  const reportFrom = isoDate(new Date(ry!, rm! - 1, 1))
  const monthEnd = isoDate(new Date(ry!, rm!, 0))
  const reportTo = monthEnd < isoDate(new Date(now)) ? monthEnd : isoDate(new Date(now))
  const { data: reportMoves = [] } = useStockMovements(reportFrom, reportTo, null)
  const { data: reportSales } = useStockSales(reportFrom, reportTo)
  return (
    <div className="flex flex-col gap-4">
      <ActionRow>
        <label className="border-border bg-card flex h-9 items-center gap-2 rounded-md border px-3 text-[14px]">
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
      </ActionRow>
      <Seg
        label={t('stock.tabs.reports')}
        value={part}
        onChange={setPart}
        options={[
          { value: 'sales', label: t('stock.tabs.sales') },
          { value: 'moves', label: t('stock.tabs.moves') },
          { value: 'deliveries', label: t('stockPage.received') },
          { value: 'outside', label: t('stock.tabs.outside') },
        ]}
        className="self-start"
      />
      {part === 'sales' && <Sales />}
      {part === 'moves' && <Movements items={items} locations={locations} />}
      {part === 'deliveries' && <DeliveriesList focusId={focusDelivery} />}
      {part === 'outside' && <BoughtOutsideList />}
    </div>
  )
}

/* ---------------------------------------------------------------- ledger */
export function Movements({
  items,
  locations,
}: {
  items: StockItem[]
  locations: StockLocation[]
}) {
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
          label={t('stockPage.cols.item')}
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
                icon={createElement(
                  m.type === 'receipt'
                    ? PackagePlus
                    : m.type === 'transfer'
                      ? ArrowRightLeft
                      : m.type === 'dispense'
                        ? Pill
                        : PackageMinus,
                  { size: 12, 'aria-hidden': true },
                )}
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
  const revenue = data?.revenue ?? 0
  const cost = data?.cost ?? 0
  const margin = data?.margin ?? revenue - cost
  return (
    <div className="flex flex-col gap-4">
      <PeriodFilter period={period} />
      <SectionTitle icon={Coins}>{t('stock.tabs.sales')}</SectionTitle>
      <div className="pc:grid-cols-[repeat(auto-fit,minmax(150px,1fr))] grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Kpi
          i={0}
          icon={Coins}
          tint="teal"
          label={t('stock.sales.revenue')}
          value={Math.round(revenue)}
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
          icon={TrendingUp}
          tint="mint"
          label={t('stock.sales.margin')}
          value={Math.round(margin)}
          unit={
            revenue > 0
              ? t('stockPage.marginPct', { pct: Math.round((margin / revenue) * 100) })
              : 'RWF'
          }
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
      <Panel i={2} icon={Coins} tint="teal" title={t('stockPage.salesByItem')}>
        {!data || data.items.length === 0 ? (
          <Empty icon={Coins}>{t('stock.sales.none')}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[14px]">
              <thead className="bg-surface">
                <tr className="border-border border-b">
                  <th className={tableHead}>{t('stockPage.cols.item')}</th>
                  <th className={cn(tableHead, 'text-right')}>{t('stock.sales.units')}</th>
                  <th className={cn(tableHead, 'text-right')}>{t('stock.sales.revenue')}</th>
                  <th className={cn(tableHead, 'hidden text-right sm:table-cell')}>
                    {t('stock.sales.cost')}
                  </th>
                  <th className={cn(tableHead, 'text-right')}>{t('stock.sales.margin')}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((x) => (
                  <tr key={x.item} className={tableRow}>
                    <td className={tableFirstCell}>{x.item}</td>
                    <td className={cn(tableCell, 'text-right tabular-nums')}>
                      {formatNumber(x.units)}
                    </td>
                    <td className={cn(tableCell, 'text-right font-semibold tabular-nums')}>
                      {formatNumber(x.revenue)}
                    </td>
                    <td className={cn(tableCell, 'hidden text-right tabular-nums sm:table-cell')}>
                      {formatNumber(Math.round(x.cost))}
                    </td>
                    <td
                      className={cn(
                        tableCell,
                        'text-right font-semibold tabular-nums',
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

/* ---------------------------------------------------------------- bought outside (0100) */
/** "Prescribed but bought outside": what patients had to buy elsewhere, most asked first. */
function BoughtOutsideList() {
  const { t } = useTranslation()
  const period = usePeriod('month')
  const { data: rows = [], isLoading } = useBoughtOutside(period.from, period.to)
  return (
    <div className="flex flex-col gap-4">
      <PeriodFilter period={period} />
      <Panel
        i={1}
        icon={Store}
        tint="amber"
        title={t('stock.outside.title')}
        right={String(rows.length)}
      >
        <p className="text-ink-3 m-0 text-[13px]">{t('stock.outside.lead')}</p>
        {rows.length === 0 ? (
          <Empty icon={Store}>
            {isLoading ? t('doctorLists.loading') : t('stock.outside.none')}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[14px]">
              <thead className="bg-surface">
                <tr className="border-border border-b">
                  <th className={tableHead}>{t('stockPage.cols.item')}</th>
                  <th className={cn(tableHead, 'text-right')}>{t('stock.outside.times')}</th>
                  <th className={cn(tableHead, 'text-right')}>{t('stock.outside.quantity')}</th>
                  <th className={cn(tableHead, 'hidden text-right sm:table-cell')}>
                    {t('stock.outside.patients')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => (
                  <tr
                    key={`${x.itemId ?? ''}|${x.referenceCode ?? ''}|${x.name}`}
                    className={tableRow}
                  >
                    <td className={tableFirstCell}>
                      <span className="block">{x.name}</span>
                      <span className="mt-1 flex flex-wrap gap-1.5">
                        {!x.inClinic && (
                          <Badge tone="grey" dot={false}>
                            {t('clinical.stock.notSold')}
                          </Badge>
                        )}
                        {x.notGiven > 0 && (
                          <Badge tone="orange" dot={false}>
                            {t('stock.outside.afterNotGiven', { count: x.notGiven })}
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className={cn(tableCell, 'text-right font-semibold tabular-nums')}>
                      {formatNumber(x.times)}
                    </td>
                    <td className={cn(tableCell, 'text-right tabular-nums')}>
                      {formatNumber(x.quantity)}
                    </td>
                    <td className={cn(tableCell, 'hidden text-right tabular-nums sm:table-cell')}>
                      {formatNumber(x.patients)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}

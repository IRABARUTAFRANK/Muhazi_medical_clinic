import { Boxes, CalendarClock, Coins, PackageX, ShoppingCart, Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Hint, Kpi, Panel } from '@/components/dash/kit'
import { StaffLink } from '@/components/staff/staff-link'
import { buttonVariants } from '@/components/ui/button'
import {
  useReorderSuggestions,
  useStockAlerts,
  useStockSales,
  type ReorderSuggestion,
  type StockAlerts,
} from '@/lib/api/stock'
import { cn } from '@/lib/utils'
import { dayLong, num, type TFn } from '../format'
import { Choice, DataTable, Figures, LoadError, Quiet, useExport, ViewSkeleton } from '../kit'
import { analyticsReport } from '../reports'
import { pickBy, type ViewProps } from '../view-props'

const STOCK_BY = ['low', 'rooms', 'expiring'] as const
type StockBy = (typeof STOCK_BY)[number]

type Low = StockAlerts['low'][number]
type RoomLow = StockAlerts['roomLow'][number]
type Expiring = StockAlerts['expiring'][number]

/**
 * Stock now (a snapshot, not a period figure): medicines below their reorder level at the
 * pharmacy (the same rule as the stock screens), room stores below their minimum, batches expiring
 * within 90 days, with what to order. The period only drives the sales figure.
 */
export function StockView({ view, access, period, search, update, clinic }: ViewProps) {
  const { t } = useTranslation()
  const p = { from: period.from, to: period.to }
  const alertsQ = useStockAlerts()
  const reorder = useReorderSuggestions()
  const sales = useStockSales(p.from, p.to)
  const al = alertsQ.data
  // the pharmacy dashboard's Expiry view (0102) opens on the expiring batches
  const by = pickBy<StockBy>(search.by, STOCK_BY, view === 'expiry' ? 'expiring' : 'low')
  const suggestion = new Map((reorder.data ?? []).map((r) => [r.itemId, r]))
  const items = sales.data?.items ?? []
  const money = access.manager
  const expiringItems = new Set((al?.expiring ?? []).map((x) => x.itemId)).size

  useExport(() => (al ? stockReport(al, suggestion, p, t, clinic) : null))

  if (alertsQ.error) return <LoadError error={alertsQ.error} />
  if (!al) return <ViewSkeleton />

  return (
    <>
      <Figures>
        <Kpi
          i={0}
          icon={PackageX}
          tint="coral"
          label={t('analytics.stock.low')}
          value={al.low.length}
          unit=""
        />
        <Kpi
          i={1}
          icon={Store}
          tint="amber"
          label={t('analytics.stock.roomLow')}
          value={al.roomLow.length}
          unit=""
        />
        <Kpi
          i={2}
          icon={CalendarClock}
          tint="violet"
          label={t('analytics.stock.expiring')}
          value={expiringItems}
          unit=""
        />
        <Kpi
          i={3}
          icon={Coins}
          tint="mint"
          label={t(money ? 'analytics.stock.sales' : 'analytics.stock.unitsSold')}
          value={
            money
              ? items.reduce((n, x) => n + x.revenue, 0)
              : items.reduce((n, x) => n + x.units, 0)
          }
          unit={money ? 'RWF' : ''}
        />
      </Figures>
      <Hint>{t('analytics.stock.note')}</Hint>

      <Panel
        i={1}
        icon={Boxes}
        tint="amber"
        title={t(`analytics.stock.by.${by}`)}
        right={
          <Choice<StockBy>
            label={t('analytics.breakdown')}
            value={by}
            onChange={(v) => update({ by: v === 'low' ? undefined : v }, { replace: true })}
            options={STOCK_BY.map((v) => ({ value: v, label: t(`analytics.stock.by.${v}`) }))}
          />
        }
      >
        {by === 'rooms' ? (
          <RoomTable rows={al.roomLow} />
        ) : by === 'expiring' ? (
          <ExpiringTable rows={al.expiring} />
        ) : (
          <LowTable rows={al.low} suggestion={suggestion} />
        )}
        <div className="flex flex-wrap gap-2">
          <StaffLink
            to="/app/stock"
            search={{ tab: 'reorder' }}
            className={cn(buttonVariants({ variant: 'primary', size: 'md' }))}
          >
            <ShoppingCart size={16} aria-hidden="true" />
            {t('analytics.stock.openReorder')}
          </StaffLink>
          <StaffLink
            to="/app/stock"
            className={cn(buttonVariants({ variant: 'tint-teal', size: 'md' }))}
          >
            <Boxes size={16} aria-hidden="true" />
            {t('analytics.stock.openStock')}
          </StaffLink>
        </div>
      </Panel>
    </>
  )
}

function LowTable({
  rows,
  suggestion,
}: {
  rows: Low[]
  suggestion: Map<string, ReorderSuggestion>
}) {
  const { t } = useTranslation()
  return (
    <DataTable
      rows={rows}
      rowKey={(x) => x.itemId}
      cols={[
        {
          key: 'item',
          label: t('analytics.pharmacy.item'),
          cell: (x) => (
            <span className="flex min-w-0 flex-col">
              <b className="[overflow-wrap:anywhere]">{x.item}</b>
              {x.code && <span className="text-ink-3 text-[12px]">{x.code}</span>}
            </span>
          ),
          sort: (x) => x.item,
        },
        {
          key: 'onHand',
          label: t('analytics.stock.onHandLevel'),
          align: 'right',
          cell: (x) => `${num(x.onHand)} / ${num(x.level)}`,
          sort: (x) => (x.level > 0 ? x.onHand / x.level : x.onHand),
        },
        {
          key: 'suggested',
          label: t('analytics.stock.suggested'),
          align: 'right',
          cell: (x) => {
            const s = suggestion.get(x.itemId)
            if (!s) return '—'
            return s.suggestedBoxes != null
              ? t('analytics.stock.boxes', { units: num(s.suggested), count: s.suggestedBoxes })
              : num(s.suggested)
          },
          sort: (x) => suggestion.get(x.itemId)?.suggested ?? null,
        },
      ]}
      initialSort={{ key: 'onHand', desc: false }}
      empty={<Quiet>{t('analytics.stock.noneLow')}</Quiet>}
      caption={t('analytics.stock.by.low')}
    />
  )
}

function RoomTable({ rows }: { rows: RoomLow[] }) {
  const { t } = useTranslation()
  return (
    <DataTable
      rows={rows}
      rowKey={(x) => `${x.storeId}-${x.itemId}`}
      cols={[
        {
          key: 'item',
          label: t('analytics.pharmacy.item'),
          cell: (x) => <b className="[overflow-wrap:anywhere]">{x.item}</b>,
          sort: (x) => x.item,
        },
        {
          key: 'store',
          label: t('analytics.stock.store'),
          cell: (x) => x.store,
          sort: (x) => x.store,
        },
        {
          key: 'onHand',
          label: t('analytics.stock.onHandMin'),
          align: 'right',
          cell: (x) => `${num(x.onHand)} / ${num(x.min)}`,
          sort: (x) => x.onHand,
        },
      ]}
      initialSort={{ key: 'onHand', desc: false }}
      empty={<Quiet>{t('analytics.stock.noneRoomLow')}</Quiet>}
      caption={t('analytics.stock.by.rooms')}
    />
  )
}

function ExpiringTable({ rows }: { rows: Expiring[] }) {
  const { t } = useTranslation()
  return (
    <DataTable
      rows={rows}
      rowKey={(x) => `${x.storeId}-${x.itemId}-${x.batchNo ?? ''}-${x.expiry}`}
      cols={[
        {
          key: 'item',
          label: t('analytics.pharmacy.item'),
          cell: (x) => (
            <span className="flex min-w-0 flex-col">
              <b className="[overflow-wrap:anywhere]">{x.item}</b>
              {x.batchNo && <span className="text-ink-3 text-[12px]">{x.batchNo}</span>}
            </span>
          ),
          sort: (x) => x.item,
        },
        {
          key: 'store',
          label: t('analytics.stock.store'),
          wide: true,
          cell: (x) => x.store,
          sort: (x) => x.store,
        },
        {
          key: 'expiry',
          label: t('analytics.stock.expiry'),
          cell: (x) => (
            <span className="whitespace-nowrap">
              {dayLong(x.expiry.slice(0, 10))}
              <span className="text-ink-3 block text-[12px]">
                {t('analytics.stock.inDays', { count: x.days })}
              </span>
            </span>
          ),
          sort: (x) => x.days,
        },
        {
          key: 'qty',
          label: t('analytics.pharmacy.units'),
          align: 'right',
          cell: (x) => num(x.quantity),
          sort: (x) => x.quantity,
        },
      ]}
      initialSort={{ key: 'expiry', desc: false }}
      empty={<Quiet>{t('analytics.stock.noneExpiring')}</Quiet>}
      caption={t('analytics.stock.by.expiring')}
    />
  )
}

function stockReport(
  al: StockAlerts,
  suggestion: Map<string, ReorderSuggestion>,
  p: { from: string; to: string },
  t: TFn,
  clinic: ViewProps['clinic'],
) {
  return analyticsReport({
    t,
    clinic,
    title: t('analytics.stock.reportTitle'),
    code: 'STK',
    name: 'stock-alerts',
    from: p.to,
    to: p.to,
    figures: [
      { label: t('analytics.stock.low'), value: al.low.length },
      { label: t('analytics.stock.roomLow'), value: al.roomLow.length },
      {
        label: t('analytics.stock.expiring'),
        value: new Set(al.expiring.map((x) => x.itemId)).size,
      },
    ],
    summary: t('analytics.stock.note'),
    sections: [
      {
        name: t('analytics.stock.reportTitle'),
        tables: [
          {
            title: t('analytics.stock.by.low'),
            columns: [
              { label: t('analytics.pharmacy.item') },
              { label: t('analytics.stock.code') },
              { label: t('analytics.stock.onHand'), kind: 'number' },
              { label: t('analytics.stock.level'), kind: 'number' },
              { label: t('analytics.stock.suggested'), kind: 'number' },
            ],
            rows: al.low.map((x) => [
              x.item,
              x.code,
              x.onHand,
              x.level,
              suggestion.get(x.itemId)?.suggested ?? null,
            ]),
          },
          {
            title: t('analytics.stock.by.rooms'),
            columns: [
              { label: t('analytics.pharmacy.item') },
              { label: t('analytics.stock.store') },
              { label: t('analytics.stock.onHand'), kind: 'number' },
              { label: t('analytics.stock.min'), kind: 'number' },
            ],
            rows: al.roomLow.map((x) => [x.item, x.store, x.onHand, x.min]),
          },
          {
            title: t('analytics.stock.by.expiring'),
            columns: [
              { label: t('analytics.pharmacy.item') },
              { label: t('analytics.stock.batch') },
              { label: t('analytics.stock.store') },
              { label: t('analytics.stock.expiry'), kind: 'date' },
              { label: t('analytics.pharmacy.units'), kind: 'number' },
            ],
            rows: al.expiring.map((x) => [
              x.item,
              x.batchNo,
              x.store,
              x.expiry.slice(0, 10),
              x.quantity,
            ]),
          },
        ],
      },
    ],
  })
}

import { Fragment, useState } from 'react'
import {
  AlertTriangle,
  BarChart3,
  Boxes,
  ChevronDown,
  ChevronRight,
  Coins,
  Package,
  PackageMinus,
  Truck,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumber, formatRwf } from '@mmc/shared'
import { Empty, Kpi, Panel } from '@/components/dash/kit'
import {
  expandedSection,
  selectedRow,
  tableCell,
  tableFirstCell,
  tableHead,
  tableRow,
} from '@/components/dash/kit-style'
import { PeriodFilter } from '@/components/dash/period-filter'
import { Badge } from '@/components/ui/badge'
import { tableLink } from '@/components/ui/button'
import { controlClass } from '@/components/ui/field'
import { useRoomStoreActions, useRoomStoreSummary, useStoreStock } from '@/lib/api/rooms'
import { useConfirm } from '@/lib/confirm'
import { usePeriod } from '@/lib/period'
import { matches, usePaged } from '@/lib/paging'
import { ListBar, Pager } from '@/components/ui/list-tools'
import { cn } from '@/lib/utils'
import { ExpiryMark, MsgFlash } from './stock-shared'
import { errText, packPriceText, packsText, saleModeText, tx, type Msg } from './stock-util'

/**
 * One room store's stock, medicine by medicine (batches on demand): what is usable, expired and
 * expiring, the store's minimum (its holders and the manager set it) and, for the pharmacy and
 * the manager, the value at cost.
 */
export function RoomStoreStock({ locationId, i = 2 }: { locationId: string; i?: number }) {
  const { t } = useTranslation()
  const { data, error, isLoading } = useStoreStock(locationId)
  const actions = useRoomStoreActions()
  const confirm = useConfirm()
  const [query, setQuery] = useState('')
  const [openItem, setOpenItem] = useState<string | null>(null)
  const [msg, setMsg] = useState<Msg | null>(null)
  const [editMin, setEditMin] = useState<{ itemId: string; value: string } | null>(null)
  const items = (data?.items ?? []).filter((x) => matches(query, x.item, x.code))
  const paged = usePaged(items, 15, `${query}|${locationId}`)
  const showValue = data?.value != null
  // 0107: the stock at selling price (whole packs at the pack price), for everyone who sees it
  const showSell = data?.sellValue != null
  const cols = 4 + (showValue ? 1 : 0) + (showSell ? 1 : 0)

  const saveMin = async (itemId: string, item: string, raw: string) => {
    setMsg(null)
    const min = raw.trim() === '' ? null : Number(raw)
    if (min != null && (!Number.isInteger(min) || min < 0))
      return setMsg({ ok: false, text: t('stock.reorderBad') })
    if (
      !(await confirm({
        title: t('confirm.rooms.minTitle', { item, store: data?.store.name ?? '', min: min ?? 0 }),
        body: t('confirm.rooms.minBody'),
        confirmLabel: t('confirm.stock.saveYes'),
      }))
    )
      return
    try {
      await actions.setStoreMin.mutateAsync({ locationId, itemId, min })
      setEditMin(null)
      setMsg({ ok: true, text: t('myStore.minSaved', { item }) })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    }
  }

  return (
    <Panel
      i={i}
      icon={Boxes}
      tint="mint"
      title={t('myStore.stockTitle', { store: data?.store.name ?? '' })}
      right={
        [
          showValue
            ? t('myStore.valueRight', { value: formatRwf(Math.round(data!.value!)) })
            : null,
          showSell
            ? tx(t, 'packaging.atSellingPrice', 'value at selling price {{value}}', {
                value: formatRwf(Math.round(data!.sellValue!)),
              })
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || null
      }
    >
      {error && <p className="text-red m-0 text-[14px]">{error.message}</p>}
      <ListBar query={query} onQuery={setQuery} placeholderKey="stock.search" />
      {isLoading ? null : paged.total === 0 ? (
        <Empty icon={Package}>{t('myStore.empty')}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[14px]">
            <thead className="bg-surface">
              <tr className="border-border border-b">
                <th className={tableHead}>{t('stock.cols.item')}</th>
                <th className={cn(tableHead, 'text-right')}>{t('myStore.usable')}</th>
                <th className={cn(tableHead, 'hidden text-right sm:table-cell')}>
                  {t('myStore.min')}
                </th>
                <th className={tableHead}>{t('stock.cols.expiry')}</th>
                {showValue && (
                  <th className={cn(tableHead, 'hidden text-right md:table-cell')}>
                    {t('stock.cols.value')}
                  </th>
                )}
                {showSell && (
                  <th className={cn(tableHead, 'hidden text-right md:table-cell')}>
                    {tx(t, 'packaging.sellCol', 'At selling price')}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {paged.slice.map((x) => (
                <Fragment key={x.itemId}>
                  <tr className={cn(tableRow, openItem === x.itemId && selectedRow)}>
                    <td className={tableFirstCell}>
                      <button
                        type="button"
                        className="flex items-start gap-1 text-left"
                        aria-expanded={openItem === x.itemId}
                        onClick={() => setOpenItem(openItem === x.itemId ? null : x.itemId)}
                      >
                        {openItem === x.itemId ? (
                          <ChevronDown size={14} className="mt-0.5 flex-none" aria-hidden="true" />
                        ) : (
                          <ChevronRight size={14} className="mt-0.5 flex-none" aria-hidden="true" />
                        )}
                        <span>
                          <span className="block">{x.item}</span>
                          <span className="text-ink-3 block text-[12px] font-normal">
                            {[
                              x.code,
                              x.unit ? t('prices.meds.perUnit', { unit: x.unit }) : null,
                              x.price != null
                                ? t('myStore.priceEach', { price: formatRwf(x.price) })
                                : t('prices.noPrice'),
                              x.packSize && x.packSize > 1
                                ? saleModeText(t, { ...x, sellingPrice: x.price })
                                : null,
                              packPriceText(t, x, formatRwf),
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </span>
                      </button>
                    </td>
                    <td
                      className={cn(
                        tableCell,
                        'text-right font-semibold tabular-nums',
                        x.low ? 'text-red' : x.usable === 0 ? 'text-ink-3' : 'text-green',
                      )}
                    >
                      {formatNumber(x.usable)}
                      {packsText(t, x.usable, x.packSize, x.packUnit) && (
                        <span className="text-ink-3 block text-[12px] font-normal">
                          {packsText(t, x.usable, x.packSize, x.packUnit)}
                        </span>
                      )}
                      {x.low && (
                        <Badge
                          tone="red"
                          className="ml-1.5"
                          icon={<AlertTriangle size={12} aria-hidden="true" />}
                        >
                          {t('stock.low')}
                        </Badge>
                      )}
                      {x.expired > 0 && (
                        <span className="text-red block text-[12px] font-semibold">
                          {t('stock.expired', { count: x.expired })}
                        </span>
                      )}
                      {x.expiringSoon > 0 && (
                        <span className="text-amber block text-[12px] font-semibold">
                          {t('myStore.expiringUnits', { count: x.expiringSoon })}
                        </span>
                      )}
                    </td>
                    <td className={cn(tableCell, 'hidden text-right tabular-nums sm:table-cell')}>
                      {data?.canManage && editMin?.itemId === x.itemId ? (
                        <span className="inline-flex items-center gap-1">
                          <input
                            inputMode="numeric"
                            aria-label={t('myStore.min')}
                            value={editMin.value}
                            onChange={(e) =>
                              setEditMin({
                                itemId: x.itemId,
                                value: e.target.value.replace(/[^\d]/g, ''),
                              })
                            }
                            className={cn(controlClass, 'h-8 w-20 px-2 text-right')}
                          />
                          <button
                            type="button"
                            className={tableLink}
                            onClick={() => void saveMin(x.itemId, x.item, editMin.value)}
                          >
                            {t('prices.form.save')}
                          </button>
                        </span>
                      ) : data?.canManage ? (
                        <button
                          type="button"
                          className={tableLink}
                          title={t('myStore.minEdit')}
                          onClick={() =>
                            setEditMin({
                              itemId: x.itemId,
                              value: x.minLevel == null ? '' : String(x.minLevel),
                            })
                          }
                        >
                          {x.minLevel == null ? '—' : formatNumber(x.minLevel)}
                        </button>
                      ) : x.minLevel == null ? (
                        '—'
                      ) : (
                        formatNumber(x.minLevel)
                      )}
                    </td>
                    <td className={tableCell}>
                      <ExpiryMark date={x.earliestExpiry} />
                    </td>
                    {showValue && (
                      <td className={cn(tableCell, 'hidden text-right tabular-nums md:table-cell')}>
                        {x.value == null ? '—' : formatNumber(Math.round(x.value))}
                      </td>
                    )}
                    {showSell && (
                      <td className={cn(tableCell, 'hidden text-right tabular-nums md:table-cell')}>
                        {x.sellValue == null ? '—' : formatNumber(Math.round(x.sellValue))}
                      </td>
                    )}
                  </tr>
                  {openItem === x.itemId && (
                    <tr className="border-grid border-b">
                      <td colSpan={cols} className={cn(expandedSection, 'px-3 py-2')}>
                        {x.batches.length === 0 ? (
                          <span className="text-ink-3 text-[12px]">{t('myStore.noBatches')}</span>
                        ) : (
                          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px]">
                            {x.batches.map((b) => (
                              <li key={b.batchId} className="flex flex-wrap items-center gap-3">
                                <span className="w-28 font-semibold tabular-nums">
                                  {b.batchNo ?? '—'}
                                </span>
                                <ExpiryMark date={b.expiry} />
                                <span className="tabular-nums">
                                  {t('roomStores.unitsCount', { count: b.quantity })}
                                </span>
                                {b.unitCost != null && (
                                  <span className="text-ink-3 tabular-nums">
                                    {t('myStore.costEach', { cost: formatRwf(b.unitCost) })}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager {...paged} onPage={paged.setPage} />
      <MsgFlash msg={msg} onClose={() => setMsg(null)} />
    </Panel>
  )
}

/**
 * What a room store did in a period: given to patients (and charged on their bills), received
 * from the pharmacy, returned, written off and count differences, with a line per medicine.
 */
export function RoomStoreUse({ locationId, i = 3 }: { locationId: string; i?: number }) {
  const { t } = useTranslation()
  const period = usePeriod('month')
  const { data, error } = useRoomStoreSummary(locationId, { from: period.from, to: period.to })
  const money = (v: number | null | undefined) => (v == null ? null : formatRwf(Math.round(v)))
  return (
    <Panel i={i} icon={BarChart3} tint="violet" title={t('myStore.useTitle')}>
      <PeriodFilter period={period} />
      {error && <p className="text-red m-0 text-[14px]">{error.message}</p>}
      {data && (
        <>
          <div className="pc:grid-cols-[repeat(auto-fit,minmax(150px,1fr))] grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Kpi
              i={0}
              icon={Package}
              tint="mint"
              label={t('myStore.sum.given')}
              value={data.given.units}
              unit={t('myStore.sum.patients', { count: data.given.patients })}
            />
            <Kpi
              i={1}
              icon={Coins}
              tint="teal"
              label={t('myStore.sum.charged')}
              value={Math.round(data.given.charged)}
              unit="RWF"
            />
            <Kpi
              i={2}
              icon={Truck}
              tint="navy"
              label={t('myStore.sum.received')}
              value={data.received.units}
              unit={t('myStore.sum.notes', { count: data.received.notes })}
            />
            <Kpi
              i={3}
              icon={PackageMinus}
              tint="coral"
              label={t('myStore.sum.losses')}
              value={data.losses.writtenOff + data.losses.countDown}
              unit={t('stock.units.items')}
            />
          </div>
          <p className="text-ink-2 m-0 text-[14px]">
            {[
              t('myStore.sum.returned', { count: data.returned.units }),
              t('myStore.sum.stockNow', { count: data.stock.units }),
              data.stock.expiredUnits > 0
                ? t('stock.expired', { count: data.stock.expiredUnits })
                : null,
              money(data.stock.value)
                ? t('myStore.sum.valueNow', { value: money(data.stock.value) })
                : null,
              money(data.given.value)
                ? t('myStore.sum.givenCost', { value: money(data.given.value) })
                : null,
              data.losses.countUp > 0
                ? t('myStore.sum.countUp', { count: data.losses.countUp })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {data.items.length === 0 ? (
            <Empty>{t('stock.noMoves')}</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[14px]">
                <thead className="bg-surface">
                  <tr className="border-border border-b">
                    <th className={tableHead}>{t('stock.cols.item')}</th>
                    {(
                      [
                        'given',
                        'received',
                        'returned',
                        'writtenOff',
                        'countDiff',
                        'onHand',
                      ] as const
                    ).map((c) => (
                      <th key={c} className={cn(tableHead, 'text-right')}>
                        {t(`myStore.cols.${c}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((x) => (
                    <tr key={x.itemId} className={tableRow}>
                      <td className={tableFirstCell}>{x.item}</td>
                      <td className={cn(tableCell, 'text-right font-semibold tabular-nums')}>
                        {formatNumber(x.given)}
                      </td>
                      <td className={cn(tableCell, 'text-right tabular-nums')}>
                        {formatNumber(x.received)}
                      </td>
                      <td className={cn(tableCell, 'text-right tabular-nums')}>
                        {formatNumber(x.returned)}
                      </td>
                      <td
                        className={cn(
                          tableCell,
                          'text-right tabular-nums',
                          x.writtenOff > 0 && 'text-red',
                        )}
                      >
                        {formatNumber(x.writtenOff)}
                      </td>
                      <td
                        className={cn(
                          tableCell,
                          'text-right tabular-nums',
                          x.countDiff < 0 && 'text-red',
                        )}
                      >
                        {x.countDiff > 0 ? `+${x.countDiff}` : formatNumber(x.countDiff)}
                      </td>
                      <td className={cn(tableCell, 'text-right tabular-nums')}>
                        {formatNumber(x.onHand)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Panel>
  )
}

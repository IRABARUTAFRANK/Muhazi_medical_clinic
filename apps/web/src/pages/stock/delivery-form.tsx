import { Fragment, useState } from 'react'
import { FileText, Truck, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatNumber, formatRwf } from '@mmc/shared'
import { Empty, Panel } from '@/components/dash/kit'
import {
  expandedSection,
  selectedRow,
  tableCell,
  tableFirstCell,
  tableHead,
  tableRow,
} from '@/components/dash/kit-style'
import { PeriodFilter } from '@/components/dash/period-filter'
import { Button } from '@/components/ui/button'
import { Pager } from '@/components/ui/list-tools'
import { useDeliveries, useDeliveryDetail } from '@/lib/api/stock'
import { usePeriod } from '@/lib/period'
import { usePaged } from '@/lib/paging'
import { cn } from '@/lib/utils'

/**
 * Stock received: every delivery recorded in a period (GRN-…), each opening its lines. "Add
 * stock" now records stock without a supplier or a delivery note; older deliveries keep theirs.
 */

/* ---------------------------------------------------------------- deliveries received */
/** Every delivery received in a period, each opening its lines. */
export function DeliveriesList({ focusId }: { focusId?: string }) {
  const { t } = useTranslation()
  const period = usePeriod('month')
  const { data: list = [], isLoading } = useDeliveries({ from: period.from, to: period.to })
  const [open, setOpen] = useState<string | null>(focusId ?? null)
  const paged = usePaged(list, 12, `${period.from}|${period.to}`)
  const total = list.reduce((s, d) => s + d.totalCost, 0)
  return (
    <Panel
      i={1}
      icon={Truck}
      tint="navy"
      title={t('stockDelivery.listTitle')}
      right={t('stockDelivery.listRight', {
        count: list.length,
        value: formatRwf(Math.round(total)),
      })}
    >
      <PeriodFilter period={period} />
      {open && !list.some((d) => d.id === open) && (
        <DeliveryDetailView id={open} onClose={() => setOpen(null)} />
      )}
      {isLoading ? null : paged.total === 0 ? (
        <Empty icon={Truck}>{t('stockDelivery.none')}</Empty>
      ) : (
        <div className="flex flex-col">
          {paged.slice.map((d) => (
            <Fragment key={d.id}>
              <button
                type="button"
                aria-expanded={open === d.id}
                onClick={() => setOpen(open === d.id ? null : d.id)}
                className={cn(
                  tableRow,
                  'flex h-auto min-h-10 w-full flex-wrap items-center gap-3 px-2 py-1.5 text-left text-[14px]',
                  open === d.id && selectedRow,
                )}
              >
                <FileText size={16} aria-hidden="true" className="text-ink-3" />
                <span className="w-32 font-semibold tabular-nums">{d.number}</span>
                <span className="min-w-[180px] flex-1">
                  <span className="block font-semibold">{d.supplier ?? '—'}</span>
                  <span className="text-ink-3 block text-[12px]">
                    {[
                      d.reference ? t('stockDelivery.refShort', { ref: d.reference }) : null,
                      d.deliveredOn ? formatDate(new Date(d.deliveredOn)) : null,
                      d.store,
                      d.receivedBy,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="text-right tabular-nums">
                  <span className="block font-semibold">{formatRwf(Math.round(d.totalCost))}</span>
                  <span className="text-ink-3 block text-[12px]">
                    {t('stockDelivery.linesUnits', { count: d.lines, units: d.units })}
                  </span>
                </span>
              </button>
              {open === d.id && <DeliveryDetailView id={d.id} onClose={() => setOpen(null)} />}
            </Fragment>
          ))}
        </div>
      )}
      <Pager {...paged} onPage={paged.setPage} />
    </Panel>
  )
}

function DeliveryDetailView({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation()
  const { data: d, error } = useDeliveryDetail(id)
  if (error) return <p className="text-red m-0 text-[14px]">{error.message}</p>
  if (!d) return null
  return (
    <div
      className={cn(
        expandedSection,
        'border-border my-2 flex flex-col gap-2 rounded-md border p-3',
      )}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-[16px] font-semibold">
            <FileText size={16} aria-hidden="true" className="text-primary flex-none" />
            {d.number} · {d.supplier}
          </span>
          <span className="text-ink-3 block text-[12px]">
            {[
              d.reference ? t('stockDelivery.refShort', { ref: d.reference }) : null,
              d.deliveredOn ? formatDate(new Date(d.deliveredOn)) : null,
              d.store,
              d.receivedBy,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {d.note && <span className="text-ink-2 block text-[14px]">“{d.note}”</span>}
        </span>
        <Button
          size="icon"
          variant="ghost"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <X size={16} aria-hidden="true" />
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[14px]">
          <thead className="bg-surface">
            <tr className="border-border border-b">
              <th className={tableHead}>{t('stock.cols.item')}</th>
              <th className={tableHead}>{t('stock.batchNo')}</th>
              <th className={tableHead}>{t('stock.expiry')}</th>
              <th className={cn(tableHead, 'text-right')}>{t('stockDelivery.received')}</th>
              <th className={cn(tableHead, 'hidden text-right sm:table-cell')}>
                {t('stock.cols.cost')}
              </th>
              <th className={cn(tableHead, 'text-right')}>{t('stockDelivery.lineCost')}</th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l) => (
              <tr key={l.id} className={tableRow}>
                <td className={tableFirstCell}>{l.item}</td>
                <td className={cn(tableCell, 'tabular-nums')}>{l.batchNo ?? '—'}</td>
                <td className={tableCell}>{l.expiry ? formatDate(new Date(l.expiry)) : '—'}</td>
                <td className={cn(tableCell, 'text-right tabular-nums')}>
                  {l.unit === 'box'
                    ? t('stockDelivery.boxesOf', {
                        count: l.packs,
                        size: l.packSize,
                        units: l.units,
                      })
                    : formatNumber(l.units)}
                </td>
                <td className={cn(tableCell, 'hidden text-right tabular-nums sm:table-cell')}>
                  {l.packCost != null
                    ? t('stockDelivery.perBox', { cost: formatNumber(l.packCost) })
                    : formatNumber(l.unitCost)}
                </td>
                <td className={cn(tableCell, 'text-right font-semibold tabular-nums')}>
                  {formatNumber(Math.round(l.lineCost))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="m-0 text-right text-[14px] font-semibold tabular-nums">
        {t('stockDelivery.totalCost', { value: formatRwf(Math.round(d.totalCost)) })}
      </p>
    </div>
  )
}

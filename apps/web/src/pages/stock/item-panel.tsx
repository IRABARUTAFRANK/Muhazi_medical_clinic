import { useState, type FormEvent } from 'react'
import {
  AlertTriangle,
  ClipboardCheck,
  Clock,
  Layers,
  Package,
  PackageMinus,
  PackagePlus,
  SlidersHorizontal,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatNumber, formatRwf } from '@mmc/shared'
import { Empty } from '@/components/dash/kit'
import { card, tableCell, tableHead, tableRow } from '@/components/dash/kit-style'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Seg } from '@/components/ui/seg'
import { Select } from '@/components/ui/select'
import { SidePanel } from '@/components/ui/side-panel'
import { useNotOnList } from '@/lib/api/reference-list'
import { useItemBatches } from '@/lib/api/rooms'
import { useStockActions, type StockItem, type StockLocation } from '@/lib/api/stock'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { LevelEditor } from './reorder-tab'
import { MsgFlash, StatusTags } from './stock-shared'
import {
  errText,
  expiryState,
  itemName,
  itemStatuses,
  pharmacySide,
  splitStock,
  type Msg,
} from './stock-util'

type Action = 'level' | 'writeOff' | 'count'

/**
 * One item of the stock in a side panel (amber, the stock's hue): what is in the pharmacy, in the
 * room stores and in all; its batches store by store (number, expiry, quantity, cost); and, for
 * whoever manages the stock, the reorder point, a write-off with its reason and a count
 * correction. Room stores write off and count their own stock under "My store".
 */
export function ItemPanel({
  item,
  locations,
  manage,
  onClose,
  onAddStock,
}: {
  item: StockItem | null
  locations: StockLocation[]
  manage: boolean
  onClose: () => void
  onAddStock: (itemId: string) => void
}) {
  const { t } = useTranslation()
  // its code left the official list: insurers that follow the list have no price for it
  const { data: notOnList } = useNotOnList(!!item)
  return (
    <SidePanel
      open={!!item}
      onClose={onClose}
      hue="amber"
      icon={Package}
      title={item ? itemName(item) : ''}
      tags={
        item && notOnList?.has(item.id) ? (
          <Badge tone="yellow" title={t('stockPage.notOnListHint')}>
            {t('stockPage.notOnList')}
          </Badge>
        ) : undefined
      }
      subtitle={
        item
          ? [
              item.code,
              item.unit ? t('prices.meds.perUnit', { unit: item.unit }) : null,
              item.sellingPrice != null
                ? t('stockPage.panel.sellsAt', { price: formatRwf(item.sellingPrice) })
                : t('prices.noPrice'),
            ]
              .filter(Boolean)
              .join(' · ')
          : undefined
      }
    >
      {item && (
        <ItemBody
          key={item.id}
          item={item}
          locations={locations}
          manage={manage}
          onAddStock={onAddStock}
        />
      )}
    </SidePanel>
  )
}

function ItemBody({
  item,
  locations,
  manage,
  onAddStock,
}: {
  item: StockItem
  locations: StockLocation[]
  manage: boolean
  onAddStock: (itemId: string) => void
}) {
  const { t } = useTranslation()
  const split = splitStock(item, locations)
  const showCost = item.costShown !== false
  const [action, setAction] = useState<Action>('level')
  const figures: { label: string; value: string; tone?: string }[] = [
    { label: t('stockPage.cols.pharmacy'), value: formatNumber(split.pharmacy) },
    { label: t('stockPage.cols.rooms'), value: formatNumber(split.rooms) },
    { label: t('stockPage.cols.total'), value: formatNumber(split.total) },
    {
      label: t('stockPage.panel.reorderPoint'),
      value: item.reorderLevel > 0 ? formatNumber(item.reorderLevel) : '—',
    },
    ...(showCost
      ? [
          {
            label: t('stock.cols.cost'),
            value: item.avgCost == null ? '—' : formatRwf(Math.round(item.avgCost)),
          },
          { label: t('stock.cols.value'), value: formatRwf(Math.round(item.costValue)) },
        ]
      : []),
    ...(item.expiredUnits > 0
      ? [
          {
            label: t('stockPage.tiles.expired'),
            value: formatNumber(item.expiredUnits),
            tone: 'text-red',
          },
        ]
      : []),
  ]
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusTags statuses={itemStatuses(item)} />
        {manage && (
          <Button
            size="sm"
            variant="primary"
            className="ml-auto"
            onClick={() => onAddStock(item.id)}
          >
            <PackagePlus size={14} aria-hidden="true" />
            {t('stock.tabs.add')}
          </Button>
        )}
      </div>
      <dl className="m-0 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {figures.map((f) => (
          <div key={f.label} className={cn(card, 'gap-0.5 p-3')}>
            <dt className="text-ink-3 text-[12px]">{f.label}</dt>
            <dd className={cn('m-0 text-[18px] font-semibold tabular-nums', f.tone)}>{f.value}</dd>
          </div>
        ))}
      </dl>

      <Batches item={item} locations={locations} showCost={showCost} />

      {manage && (
        <section className="flex flex-col gap-3">
          <h3 className="text-ink m-0 flex items-center gap-2 text-[16px] font-semibold">
            <SlidersHorizontal size={16} aria-hidden="true" className="text-amber" />
            {t('stockPage.panel.actions')}
          </h3>
          <Seg
            label={t('stockPage.panel.actions')}
            value={action}
            onChange={setAction}
            options={[
              { value: 'level', label: t('stockPage.panel.level') },
              { value: 'writeOff', label: t('stockPage.panel.writeOff') },
              { value: 'count', label: t('stockPage.panel.count') },
            ]}
            className="self-start"
          />
          {action === 'level' && (
            <div className="flex flex-col gap-2">
              <p className="text-ink-2 m-0 text-[13px]">{t('stockPage.panel.levelLead')}</p>
              <LevelEditor item={item} />
            </div>
          )}
          {action === 'writeOff' && <WriteOffForm item={item} locations={locations} />}
          {action === 'count' && <CountForm item={item} locations={locations} />}
        </section>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- batches by store */
function Batches({
  item,
  locations,
  showCost,
}: {
  item: StockItem
  locations: StockLocation[]
  showCost: boolean
}) {
  const { t } = useTranslation()
  // the stores holding some of it, the pharmacy side first
  const ids = locations
    .filter((l) => (item.byLocation[l.id] ?? 0) !== 0)
    .sort((a, b) => Number(!!b.isMain) - Number(!!a.isMain))
    .map((l) => l.id)
  const { stores, isLoading, error } = useItemBatches(item.id, ids)
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-ink m-0 flex items-center gap-2 text-[16px] font-semibold">
        <Layers size={16} aria-hidden="true" className="text-amber" />
        {t('stockPage.panel.batches')}
      </h3>
      {error && <p className="text-red m-0 text-[14px]">{error.message}</p>}
      {!isLoading && stores.length === 0 && (
        <Empty icon={Layers}>{t('stockPage.panel.noBatches')}</Empty>
      )}
      {stores.map((s) => (
        <div key={s.storeId} className={cn(card, 'gap-0 overflow-hidden p-0')}>
          <div className="bg-surface border-border flex items-center gap-2 border-b px-3 py-2 text-[14px] font-semibold">
            {s.store}
            {s.isRoom && <Badge tone="blue">{t('stockPage.panel.roomStore')}</Badge>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[14px]">
              <thead>
                <tr className="border-border border-b">
                  <th className={tableHead}>{t('stock.batchNo')}</th>
                  <th className={tableHead}>{t('stock.expiry')}</th>
                  <th className={cn(tableHead, 'text-right')}>{t('stock.quantity')}</th>
                  {showCost && (
                    <th className={cn(tableHead, 'text-right')}>{t('stock.cols.cost')}</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {s.batches.map((b) => {
                  const state = b.expired ? 'expired' : expiryState(b.expiry)
                  return (
                    <tr key={b.batchId} className={tableRow}>
                      <td className={cn(tableCell, 'font-medium tabular-nums')}>
                        {b.batchNo ?? '—'}
                      </td>
                      <td className={cn(tableCell, 'tabular-nums')}>
                        {b.expiry ? formatDate(new Date(b.expiry)) : '—'}
                        {state === 'expired' && (
                          <Badge
                            tone="red"
                            className="ml-1.5"
                            icon={<AlertTriangle size={12} aria-hidden="true" />}
                          >
                            {t('stockPage.status.expired')}
                          </Badge>
                        )}
                        {state === 'soon' && (
                          <Badge
                            tone="yellow"
                            className="ml-1.5"
                            icon={<Clock size={12} aria-hidden="true" />}
                          >
                            {t('stockPage.status.expiringShort')}
                          </Badge>
                        )}
                      </td>
                      <td className={cn(tableCell, 'text-right font-semibold tabular-nums')}>
                        {formatNumber(b.quantity)}
                      </td>
                      {showCost && (
                        <td className={cn(tableCell, 'text-right tabular-nums')}>
                          {b.unitCost == null ? '—' : formatNumber(b.unitCost)}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  )
}

/* ---------------------------------------------------------------- write off */
const USE_REASONS = ['expired', 'damaged', 'usedAtDesk', 'countCorrection'] as const

/** Units leaving a pharmacy store without a sale (expired, damaged…), with the reason. */
function WriteOffForm({ item, locations }: { item: StockItem; locations: StockLocation[] }) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const confirm = useConfirm()
  const stores = pharmacySide(locations).filter((l) => (item.byLocation[l.id] ?? 0) > 0)
  const [chosen, setChosen] = useState('')
  const from = chosen || (stores.find((l) => l.isMain)?.id ?? stores[0]?.id ?? '')
  const [quantity, setQuantity] = useState('')
  const [why, setWhy] = useState<(typeof USE_REASONS)[number]>(
    item.expiredUnits > 0 ? 'expired' : 'damaged',
  )
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<Msg | null>(null)
  const available = item.byLocation[from] ?? 0
  if (stores.length === 0)
    return <p className="text-ink-3 m-0 text-[14px]">{t('stockPage.panel.nothingHere')}</p>
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    const q = Number(quantity)
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
      await actions.use.mutateAsync({ itemId: item.id, locationId: from, quantity: q, reason })
      setMsg({ ok: true, text: t('stock.used', { count: q, item: itemName(item) }) })
      setQuantity('')
      setNote('')
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
      <p className="text-ink-2 m-0 text-[13px]">{t('stockShared.useLead')}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Select
          label={t('stock.fromStore')}
          value={from}
          onChange={(e) => setChosen(e.target.value)}
        >
          {stores.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} · {item.byLocation[l.id] ?? 0}
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
          placeholder={String(available)}
          onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, ''))}
        />
      </div>
      <Field
        label={t('stock.reason')}
        value={note}
        placeholder={t('stock.useNotePh')}
        onChange={(e) => setNote(e.target.value)}
      />
      <MsgFlash msg={msg} onClose={() => setMsg(null)} />
      <Button
        type="submit"
        variant="danger-solid"
        className="self-start"
        loading={actions.use.isPending}
      >
        {!actions.use.isPending && <PackageMinus size={16} aria-hidden="true" />}
        {t('stock.useSave')}
      </Button>
    </form>
  )
}

/* ---------------------------------------------------------------- count */
/** The shelf of a pharmacy store was counted: the stock becomes the count, with the reason. */
function CountForm({ item, locations }: { item: StockItem; locations: StockLocation[] }) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const confirm = useConfirm()
  const stores = pharmacySide(locations)
  const [chosen, setChosen] = useState('')
  const locationId = chosen || (stores.find((l) => l.isMain)?.id ?? stores[0]?.id ?? '')
  const [counted, setCounted] = useState('')
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState<Msg | null>(null)
  const current = item.byLocation[locationId] ?? 0
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    const n = Number(counted)
    if (!locationId) return setMsg({ ok: false, text: t('stock.errors.store') })
    if (counted === '' || !Number.isInteger(n) || n < 0)
      return setMsg({ ok: false, text: t('stock.reorderBad') })
    if (reason.trim().length < 3) return setMsg({ ok: false, text: t('stock.errors.countWhy') })
    if (
      !(await confirm({
        title: t('confirm.stock.countTitle', {
          item: itemName(item),
          store: stores.find((l) => l.id === locationId)?.name ?? '',
          after: n,
        }),
        body: t('confirm.stock.countBody', { before: current, after: n }),
        confirmLabel: t('confirm.stock.countYes'),
        tone: n < current ? 'danger' : 'primary',
      }))
    )
      return
    try {
      await actions.adjust.mutateAsync({
        itemId: item.id,
        locationId,
        counted: n,
        reason: reason.trim(),
      })
      setMsg({
        ok: true,
        text: t('stock.countSaved', { item: itemName(item), before: current, after: n }),
      })
      setCounted('')
      setReason('')
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
      <p className="text-ink-2 m-0 text-[13px]">{t('stockStores.countLead')}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Select
          label={t('stock.store')}
          value={locationId}
          onChange={(e) => setChosen(e.target.value)}
        >
          {stores.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} · {item.byLocation[l.id] ?? 0}
            </option>
          ))}
        </Select>
        <Field
          label={t('stock.counted')}
          inputMode="numeric"
          value={counted}
          placeholder={String(current)}
          onChange={(e) => setCounted(e.target.value.replace(/[^\d]/g, ''))}
        />
      </div>
      <Field
        label={t('stock.countWhy')}
        value={reason}
        placeholder={t('stock.countWhyPh')}
        onChange={(e) => setReason(e.target.value)}
      />
      <p className="text-ink-3 m-0 text-[13px]">{t('stock.countNow', { count: current })}</p>
      <MsgFlash msg={msg} onClose={() => setMsg(null)} />
      <Button
        type="submit"
        variant="primary"
        className="self-start"
        loading={actions.adjust.isPending}
      >
        {!actions.adjust.isPending && <ClipboardCheck size={16} aria-hidden="true" />}
        {t('stock.countSave')}
      </Button>
    </form>
  )
}

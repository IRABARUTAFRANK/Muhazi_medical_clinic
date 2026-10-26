import { Fragment, useState, type FormEvent } from 'react'
import { FileText, PackagePlus, Plus, Trash2, Truck, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatNumber, formatRwf } from '@mmc/shared'
import { Empty, Panel } from '@/components/dash/kit'
import { PeriodFilter } from '@/components/dash/period-filter'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Pager } from '@/components/ui/list-tools'
import { Select } from '@/components/ui/select'
import { SearchSelect } from '@/components/ui/search-select'
import {
  medicineRefLabel,
  medicineRuleText,
  readableUnit,
  useMedicineReference,
  useMedicines,
} from '@/lib/api/catalogue'
import { ApiError } from '@/lib/api/errors'
import {
  useDeliveries,
  useDeliveryDetail,
  useStockActions,
  type DeliveryLineInput,
  type StockItem,
  type StockLocation,
} from '@/lib/api/stock'
import { useConfirm } from '@/lib/confirm'
import { usePeriod } from '@/lib/period'
import { usePaged } from '@/lib/paging'
import { cn } from '@/lib/utils'
import { MsgFlash } from './stock-shared'
import { errText, itemName, mainPharmacy, pharmacyStores, todayIso, type Msg } from './stock-util'

interface DLine {
  key: number
  /** A clinic medicine id, or "ref:<code>" for a medicine of the RHIA list. */
  pick: string
  batchNo: string
  expiry: string
  unit: 'box' | 'unit'
  packSize: string
  quantity: string
  /** Per box or per unit, as `unit` says. */
  cost: string
  /** The selling price per unit (a new medicine, or one without a price). */
  sellingPrice: string
}
let lineKey = 1
const newLine = (pick = ''): DLine => ({
  key: lineKey++,
  pick,
  batchNo: '',
  expiry: '',
  unit: 'unit',
  packSize: '',
  quantity: '',
  cost: '',
  sellingPrice: '',
})

const numOr = (s: string, fallback = 0) => (s.trim() === '' ? fallback : Number(s))

/**
 * A delivery from a supplier, received into the pharmacy (the main pharmacy store unless another
 * is chosen): the supplier, its delivery note or invoice number, the date, then one line per
 * medicine with its batch, expiry date (never in the past), the quantity in boxes or units (the
 * box size converts it), the cost per box or per unit and, for a medicine new to the clinic
 * (from the RHIA list) or without a price, its selling price. One confirmation records it all
 * under one number (GRN-…).
 */
export function DeliveryForm({
  items,
  locations,
  mainId,
  addsMedicines,
  preset,
}: {
  items: StockItem[]
  locations: StockLocation[]
  mainId: string | null
  /** The manager and the pharmacy may add medicines from the RHIA list. */
  addsMedicines: boolean
  preset?: { item?: string; location?: string }
}) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const confirm = useConfirm()
  const {
    data: reference = [],
    isLoading: refLoading,
    isError: refFailed,
  } = useMedicineReference(addsMedicines)
  const { data: medicines = [] } = useMedicines()
  const stores = pharmacyStores(locations)
  const [chosenStore, setStore] = useState('')
  const storeId =
    chosenStore ||
    stores.find((l) => l.id === preset?.location)?.id ||
    mainPharmacy(locations, mainId)?.id ||
    ''
  const [supplier, setSupplier] = useState('')
  const [reference2, setReference] = useState('')
  const [deliveredOn, setDeliveredOn] = useState(todayIso())
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<DLine[]>(() => [newLine(preset?.item ?? '')])
  const [msg, setMsg] = useState<Msg | null>(null)
  const [badLine, setBadLine] = useState<number | null>(null)
  const today = todayIso()

  const clinicCodes = new Set([...items.map((i) => i.code), ...medicines.map((m) => m.code)])
  const picked = new Set(lines.map((l) => l.pick))
  const optionsFor = (current: string) => [
    ...items
      .filter((i) => i.active)
      .map((i) => ({
        value: i.id,
        label: `${itemName(i)}${i.unit ? ` (${i.unit})` : ''}`,
      })),
    ...(addsMedicines ? reference : [])
      .filter(
        (r) =>
          !clinicCodes.has(r.code) && (!picked.has(`ref:${r.code}`) || current === `ref:${r.code}`),
      )
      .map((r) => ({ value: `ref:${r.code}`, label: medicineRefLabel(r, t) })),
  ]
  const itemOf = (l: DLine) => items.find((i) => i.id === l.pick)
  const refOf = (l: DLine) =>
    l.pick.startsWith('ref:') ? reference.find((r) => r.code === l.pick.slice(4)) : undefined
  const nameOf = (l: DLine) => {
    const r = refOf(l)
    return r ? r.generic : itemName(itemOf(l))
  }
  const set = (key: number, patch: Partial<DLine>) => {
    setBadLine(null)
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }
  const pick = (key: number, value: string) => {
    const it = items.find((i) => i.id === value)
    const r = value.startsWith('ref:') ? reference.find((x) => x.code === value.slice(4)) : null
    set(key, {
      pick: value,
      packSize: it?.packSize && it.packSize > 1 ? String(it.packSize) : '',
      unit: it?.packSize && it.packSize > 1 ? 'box' : 'unit',
      sellingPrice: r?.price != null ? String(r.price) : '',
    })
  }
  const packOf = (l: DLine) => (l.unit === 'box' ? numOr(l.packSize, 0) : 1)
  const unitsOf = (l: DLine) => numOr(l.quantity) * packOf(l)
  const costOf = (l: DLine) => numOr(l.quantity) * numOr(l.cost)
  const needsPrice = (l: DLine) =>
    l.pick.startsWith('ref:') || (!!itemOf(l) && itemOf(l)!.sellingPrice == null)
  const filled = lines.filter((l) => l.pick)
  const totalUnits = filled.reduce((s, l) => s + unitsOf(l), 0)
  const totalCost = filled.reduce((s, l) => s + costOf(l), 0)

  const check = (): string | null => {
    if (!storeId) return t('stock.errors.store')
    if (supplier.trim().length < 2) return t('stockDelivery.errors.supplier')
    if (deliveredOn > today) return t('stockDelivery.errors.future')
    if (filled.length === 0) return t('stockDelivery.errors.noLines')
    for (const [k, l] of lines.entries()) {
      const n = k + 1
      const bad = (text: string) => {
        setBadLine(l.key)
        return t('stockDelivery.errors.line', { n, text })
      }
      if (!l.pick) return bad(t('stock.errors.item'))
      const q = Number(l.quantity)
      if (!Number.isInteger(q) || q <= 0) return bad(t('stock.errors.quantity'))
      if (l.unit === 'box' && (!Number.isInteger(packOf(l)) || packOf(l) < 1))
        return bad(t('stockDelivery.errors.packSize'))
      const c = Number(l.cost)
      if (l.cost === '' || !Number.isFinite(c) || c < 0) return bad(t('stock.errors.cost'))
      if (!l.expiry) return bad(t('stock.errors.expiry'))
      if (l.expiry < today) return bad(t('stockDelivery.errors.past'))
      if (l.pick.startsWith('ref:')) {
        const p = Number(l.sellingPrice)
        if (l.sellingPrice === '' || !Number.isFinite(p) || p < 0)
          return bad(t('prices.errors.price'))
      }
    }
    return null
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    setBadLine(null)
    const problem = check()
    if (problem) return setMsg({ ok: false, text: problem })
    const storeName = stores.find((l) => l.id === storeId)?.name ?? ''
    const newOnes = lines.filter((l) => l.pick.startsWith('ref:')).length
    if (
      !(await confirm({
        title: t('confirm.delivery.title', {
          count: lines.length,
          supplier: supplier.trim(),
          store: storeName,
        }),
        body: [
          t('confirm.delivery.body', {
            units: formatNumber(totalUnits),
            value: formatRwf(Math.round(totalCost)),
          }),
          newOnes > 0 ? t('confirm.delivery.newBody', { count: newOnes }) : '',
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: t('confirm.delivery.yes'),
      }))
    )
      return
    const input: DeliveryLineInput[] = lines.map((l) => {
      const r = refOf(l)
      const price = l.sellingPrice.trim() === '' ? undefined : Math.round(Number(l.sellingPrice))
      return {
        itemId: r ? undefined : l.pick,
        refCode: r ? r.code : undefined,
        batchNo: l.batchNo.trim() || undefined,
        expiry: l.expiry,
        quantity: Number(l.quantity),
        unit: l.unit,
        packSize: l.unit === 'box' ? packOf(l) : undefined,
        cost: Number(l.cost),
        sellingPrice: needsPrice(l) ? price : undefined,
        newMedicine: r
          ? {
              code: r.code,
              name: r.generic,
              strength: r.presentation,
              unit: readableUnit(r.unit) || null,
              sellingPrice: price ?? null,
            }
          : undefined,
      }
    })
    try {
      const r = await actions.receiveDelivery.mutateAsync({
        supplier: supplier.trim(),
        reference: reference2.trim() || undefined,
        deliveredOn,
        locationId: storeId,
        note: note.trim() || undefined,
        lines: input,
      })
      setMsg({
        ok: true,
        text: t(r.number ? 'stockDelivery.saved' : 'stockDelivery.savedOld', {
          number: r.number ?? '',
          count: r.lines,
          units: formatNumber(r.units),
          value: formatRwf(Math.round(r.totalCost)),
          store: storeName,
        }),
      })
      setLines([newLine()])
      setReference('')
      setNote('')
    } catch (err) {
      if (err instanceof ApiError && err.line != null) setBadLine(lines[err.line - 1]?.key ?? null)
      setMsg({ ok: false, text: errText(err) })
    }
  }

  const pickHint = !addsMedicines
    ? t('stock.ref.askHint')
    : refLoading
      ? t('prices.meds.ref.loading')
      : refFailed
        ? t('stock.ref.failed')
        : t('stockDelivery.pickHint')

  return (
    <Panel i={1} icon={PackagePlus} tint="mint" title={t('stock.receiveTitle')}>
      <p className="text-ink-2 m-0 text-[14px]">{t('stockDelivery.lead')}</p>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label={t('stock.supplier')}
            value={supplier}
            placeholder={t('stock.supplierPh')}
            onChange={(e) => setSupplier(e.target.value)}
            required
          />
          <Field
            label={t('stockDelivery.reference')}
            value={reference2}
            placeholder={t('stockDelivery.referencePh')}
            onChange={(e) => setReference(e.target.value)}
          />
          <Field
            label={t('stockDelivery.date')}
            type="date"
            max={today}
            value={deliveredOn}
            onChange={(e) => setDeliveredOn(e.target.value)}
            required
          />
          <Select
            label={t('stock.store')}
            value={storeId}
            onChange={(e) => setStore(e.target.value)}
            required
          >
            {stores.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.isMain ? ` · ${t('stockStores.main')}` : ''}
              </option>
            ))}
          </Select>
        </div>
        <p className="text-ink-3 m-0 text-[12px]">{pickHint}</p>

        <div className="flex flex-col gap-2">
          {lines.map((l, k) => {
            const it = itemOf(l)
            const r = refOf(l)
            const units = unitsOf(l)
            return (
              <div
                key={l.key}
                className={cn(
                  'border-border flex flex-col gap-2 rounded-md border p-3',
                  badLine === l.key && 'border-red ring-red-bg ring-[3px]',
                )}
              >
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
                  <SearchSelect
                    label={t('stockShared.lineN', { n: k + 1 })}
                    value={l.pick}
                    onChange={(v) => pick(l.key, v)}
                    emptyLabel={t('visit.add.pickItem')}
                    options={optionsFor(l.pick)}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={lines.length === 1}
                    title={t('stockShared.removeLine')}
                    aria-label={t('stockShared.removeLine')}
                    onClick={() => setLines(lines.filter((x) => x.key !== l.key))}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
                </div>
                {r && (
                  <p className="text-ink-2 m-0 text-[12px]">
                    {[
                      t('stockDelivery.newFromList'),
                      r.rule ? medicineRuleText(r.rule, t) : null,
                      r.group ? t('prices.meds.ref.group', { group: r.group }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
                  <Field
                    label={t('stock.batchNo')}
                    value={l.batchNo}
                    placeholder={t('stock.batchPh')}
                    onChange={(e) => set(l.key, { batchNo: e.target.value })}
                    wrapperClassName="lg:col-span-2"
                  />
                  <Field
                    label={t('stock.expiry')}
                    type="date"
                    min={today}
                    value={l.expiry}
                    onChange={(e) => set(l.key, { expiry: e.target.value })}
                    wrapperClassName="lg:col-span-2"
                  />
                  <Select
                    label={t('stockDelivery.countedIn')}
                    value={l.unit}
                    onChange={(e) => set(l.key, { unit: e.target.value as DLine['unit'] })}
                  >
                    <option value="unit">{t('stockDelivery.units')}</option>
                    <option value="box">{t('stockDelivery.boxes')}</option>
                  </Select>
                  {l.unit === 'box' ? (
                    <Field
                      label={t('stockDelivery.packSize')}
                      inputMode="numeric"
                      value={l.packSize}
                      placeholder={it?.packSize ? String(it.packSize) : '100'}
                      onChange={(e) =>
                        set(l.key, { packSize: e.target.value.replace(/[^\d]/g, '') })
                      }
                    />
                  ) : (
                    <span className="hidden lg:block" />
                  )}
                  <Field
                    label={t(l.unit === 'box' ? 'stockDelivery.boxCount' : 'stock.quantity')}
                    inputMode="numeric"
                    value={l.quantity}
                    onChange={(e) => set(l.key, { quantity: e.target.value.replace(/[^\d]/g, '') })}
                  />
                  <Field
                    label={t(l.unit === 'box' ? 'stockDelivery.costBox' : 'stock.unitCost')}
                    inputMode="decimal"
                    value={l.cost}
                    onChange={(e) => set(l.key, { cost: e.target.value.replace(/[^\d.]/g, '') })}
                  />
                </div>
                {needsPrice(l) && (
                  <Field
                    label={t('stockDelivery.sellingPrice')}
                    inputMode="numeric"
                    value={l.sellingPrice}
                    placeholder={t('stockDelivery.sellingPricePh')}
                    onChange={(e) =>
                      set(l.key, { sellingPrice: e.target.value.replace(/[^\d]/g, '') })
                    }
                    wrapperClassName="sm:max-w-xs"
                  />
                )}
                {l.pick && numOr(l.quantity) > 0 && (
                  <p className="text-ink-2 m-0 text-[12px] tabular-nums">
                    {t('stockDelivery.lineSum', {
                      units: formatNumber(units),
                      value: formatRwf(Math.round(costOf(l))),
                      each:
                        units > 0 ? formatRwf(Math.round((costOf(l) / units) * 100) / 100) : '—',
                    })}
                    {r || it ? ` · ${nameOf(l)}` : ''}
                  </p>
                )}
              </div>
            )
          })}
          <Button size="sm" className="self-start" onClick={() => setLines([...lines, newLine()])}>
            <Plus size={14} aria-hidden="true" />
            {t('stockShared.addLine')}
          </Button>
        </div>

        <Field
          label={t('stock.reason')}
          value={note}
          placeholder={t('stockDelivery.notePh')}
          onChange={(e) => setNote(e.target.value)}
          wrapperClassName="sm:max-w-md"
        />
        <p className="bg-surface m-0 rounded-md px-3 py-2 text-[14px] font-semibold tabular-nums">
          {t('stockDelivery.total', {
            count: filled.length,
            units: formatNumber(totalUnits),
            value: formatRwf(Math.round(totalCost)),
          })}
        </p>
        <MsgFlash msg={msg} onClose={() => setMsg(null)} />
        <Button
          type="submit"
          variant="primary"
          className="self-start"
          loading={actions.receiveDelivery.isPending}
        >
          <PackagePlus size={16} aria-hidden="true" />
          {t('stockDelivery.save')}
        </Button>
      </form>
    </Panel>
  )
}

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
                className="border-grid hover:bg-hover flex flex-wrap items-center gap-3 border-b px-1 py-2 text-left text-[14px]"
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
    <div className="border-border bg-surface my-2 flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-start gap-2">
        <span className="flex-1">
          <span className="block text-[16px] font-semibold">
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
          <thead>
            <tr className="text-ink-3 text-left text-[12px]">
              <th className="border-border border-b py-2 pr-2 font-medium">
                {t('stock.cols.item')}
              </th>
              <th className="border-border border-b py-2 pr-2 font-medium">{t('stock.batchNo')}</th>
              <th className="border-border border-b py-2 pr-2 font-medium">{t('stock.expiry')}</th>
              <th className="border-border border-b py-2 pr-2 text-right font-semibold">
                {t('stockDelivery.received')}
              </th>
              <th className="border-border hidden border-b py-2 pr-2 text-right font-semibold sm:table-cell">
                {t('stock.cols.cost')}
              </th>
              <th className="border-border border-b py-2 text-right font-semibold">
                {t('stockDelivery.lineCost')}
              </th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l) => (
              <tr key={l.id} className="border-grid border-b last:border-b-0">
                <td className="py-2 pr-2 font-semibold">{l.item}</td>
                <td className="py-2 pr-2 tabular-nums">{l.batchNo ?? '—'}</td>
                <td className="py-2 pr-2">{l.expiry ? formatDate(new Date(l.expiry)) : '—'}</td>
                <td className="py-2 pr-2 text-right tabular-nums">
                  {l.unit === 'box'
                    ? t('stockDelivery.boxesOf', {
                        count: l.packs,
                        size: l.packSize,
                        units: l.units,
                      })
                    : formatNumber(l.units)}
                </td>
                <td className="hidden py-2 pr-2 text-right tabular-nums sm:table-cell">
                  {l.packCost != null
                    ? t('stockDelivery.perBox', { cost: formatNumber(l.packCost) })
                    : formatNumber(l.unitCost)}
                </td>
                <td className="py-2 text-right font-semibold tabular-nums">
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

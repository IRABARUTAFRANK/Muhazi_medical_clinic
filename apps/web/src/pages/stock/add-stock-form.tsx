import { useState, type FormEvent } from 'react'
import { PackagePlus, Plus, Sparkles, Trash2, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumber, formatRwf } from '@mmc/shared'
import { Panel } from '@/components/dash/kit'
import { card, tileClass } from '@/components/dash/kit-style'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { SearchSelect } from '@/components/ui/search-select'
import {
  medicineRefLabel,
  readableUnit,
  useMedicineReference,
  useMedicines,
} from '@/lib/api/catalogue'
import { ApiError } from '@/lib/api/errors'
import { useNotOnList } from '@/lib/api/reference-list'
import {
  useStockActions,
  type AddStockLineInput,
  type StockItem,
  type StockLocation,
} from '@/lib/api/stock'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { MsgFlash } from './stock-shared'
import { errText, itemName, mainPharmacy, pharmacyStores, todayIso, type Msg } from './stock-util'

interface ALine {
  key: number
  /** A clinic item id, "ref:<code>" (a medicine of the RHIA list) or "new" (typed here). */
  pick: string
  newName: string
  newStrength: string
  newForm: string
  newUnit: string
  newKind: 'medicine' | 'supply'
  batchNo: string
  expiry: string
  quantity: string
  /** The boxes × units-per-box helper fills the quantity. */
  inBoxes: boolean
  boxes: string
  perBox: string
  unitCost: string
  sellPrice: string
}
let lineKey = 1
const newLine = (pick = '', sellPrice = ''): ALine => ({
  key: lineKey++,
  pick,
  newName: '',
  newStrength: '',
  newForm: '',
  newUnit: '',
  newKind: 'medicine',
  batchNo: '',
  expiry: '',
  quantity: '',
  inBoxes: false,
  boxes: '',
  perBox: '',
  unitCost: '',
  sellPrice,
})

const digits = (s: string) => s.replace(/[^\d]/g, '')
const decimal = (s: string) => s.replace(/[^\d.]/g, '')

/**
 * Add stock: what arrived at the pharmacy, one line per batch. Each line names the item (picked
 * from the clinic's items or the RHIA list, or created here as a medicine or a product), its
 * batch number, expiry date (never in the past), the quantity (typed, or boxes × units per box),
 * the cost per unit and the selling price (filled from the item; a change updates the item's
 * price). No supplier, no delivery note, no date: it is today. The manager may choose another
 * pharmacy store; everyone else adds into the main pharmacy.
 */
export function AddStockForm({
  items,
  locations,
  mainId,
  isManager,
  preset,
}: {
  items: StockItem[]
  locations: StockLocation[]
  mainId: string | null
  isManager: boolean
  preset?: { item?: string; location?: string }
}) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const confirm = useConfirm()
  const { data: reference = [] } = useMedicineReference(true)
  const { data: medicines = [] } = useMedicines()
  // the clinic's medicines whose code left the current official list
  const { data: notOnList } = useNotOnList()
  const stores = pharmacyStores(locations)
  const main = mainPharmacy(locations, mainId)
  const [chosenStore, setStore] = useState('')
  const storeId =
    (isManager && (chosenStore || stores.find((l) => l.id === preset?.location)?.id)) ||
    main?.id ||
    ''
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<ALine[]>(() => {
    const it = items.find((i) => i.id === preset?.item)
    return [newLine(it?.id ?? '', it?.sellingPrice != null ? String(it.sellingPrice) : '')]
  })
  const [msg, setMsg] = useState<Msg | null>(null)
  const [badLine, setBadLine] = useState<number | null>(null)
  const today = todayIso()

  const clinicCodes = new Set([...items.map((i) => i.code), ...medicines.map((m) => m.code)])
  const options = [
    ...items
      .filter((i) => i.active)
      .map((i) => ({
        value: i.id,
        label: [
          `${itemName(i)}${i.unit ? ` (${i.unit})` : ''}`,
          notOnList?.has(i.id) ? t('stockPage.notOnList') : null,
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    ...reference
      .filter((r) => !clinicCodes.has(r.code))
      .map((r) => ({ value: `ref:${r.code}`, label: medicineRefLabel(r, t) })),
  ]
  const itemOf = (l: ALine) => items.find((i) => i.id === l.pick)
  const refOf = (l: ALine) =>
    l.pick.startsWith('ref:') ? reference.find((r) => r.code === l.pick.slice(4)) : undefined
  const isNew = (l: ALine) => l.pick === 'new' || l.pick.startsWith('ref:')
  const set = (key: number, patch: Partial<ALine>) => {
    setBadLine(null)
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }
  const pick = (key: number, value: string) => {
    const it = items.find((i) => i.id === value)
    // The official list's price is what insurers pay, not the clinic's cash price (owner's
    // decision): a medicine new from the list starts with an empty selling price to fill in.
    const price = it?.sellingPrice ?? null
    set(key, {
      pick: value,
      sellPrice: price != null ? String(price) : '',
      perBox: it?.packSize && it.packSize > 1 ? String(it.packSize) : '',
    })
  }
  const quantityOf = (l: ALine) =>
    l.inBoxes ? Number(l.boxes || 0) * Number(l.perBox || 0) : Number(l.quantity || 0)
  const costOf = (l: ALine) => quantityOf(l) * Number(l.unitCost || 0)
  const filled = lines.filter((l) => l.pick)
  const totalUnits = filled.reduce((s, l) => s + quantityOf(l), 0)
  const totalCost = filled.reduce((s, l) => s + costOf(l), 0)

  const check = (): string | null => {
    if (!storeId) return t('stock.errors.store')
    if (filled.length === 0) return t('stockDelivery.errors.noLines')
    const seen = new Map<string, string>()
    for (const [k, l] of lines.entries()) {
      const bad = (text: string) => {
        setBadLine(l.key)
        return t('stockDelivery.errors.line', { n: k + 1, text })
      }
      if (!l.pick) return bad(t('stockPage.add.errors.item'))
      if (l.pick === 'new' && l.newName.trim().length < 2)
        return bad(t('stockPage.add.errors.newName'))
      if (!l.batchNo.trim()) return bad(t('stockPage.add.errors.batch'))
      if (!l.expiry) return bad(t('stock.errors.expiry'))
      if (l.expiry < today) return bad(t('stockDelivery.errors.past'))
      const q = quantityOf(l)
      if (l.inBoxes && (!Number(l.boxes) || !Number(l.perBox)))
        return bad(t('stockPage.add.errors.boxes'))
      if (!Number.isInteger(q) || q <= 0) return bad(t('stock.errors.quantity'))
      const c = Number(l.unitCost)
      if (l.unitCost === '' || !Number.isFinite(c) || c < 0) return bad(t('stock.errors.cost'))
      if (isNew(l)) {
        const p = Number(l.sellPrice)
        if (l.sellPrice === '' || !Number.isFinite(p) || p < 0) return bad(t('prices.errors.price'))
      }
      // the same batch of the same item twice: one expiry date only
      if (!isNew(l)) {
        const id = `${l.pick}|${l.batchNo.trim().toUpperCase()}`
        const before = seen.get(id)
        if (before && before !== l.expiry) return bad(t('stockErrors.batchExpiry'))
        seen.set(id, l.expiry)
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
    const storeName = stores.find((l) => l.id === storeId)?.name ?? main?.name ?? ''
    const created = lines.filter(isNew).length
    if (
      !(await confirm({
        title: t('stockPage.add.confirmTitle', { count: lines.length, store: storeName }),
        body: [
          t('stockPage.add.confirmBody', {
            units: formatNumber(totalUnits),
            value: formatRwf(Math.round(totalCost)),
          }),
          created > 0 ? t('stockPage.add.confirmNew', { count: created }) : '',
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: t('stockPage.add.confirmYes'),
      }))
    )
      return
    const input: AddStockLineInput[] = lines.map((l) => {
      const r = refOf(l)
      const it = itemOf(l)
      const price = l.sellPrice.trim() === '' ? null : Math.round(Number(l.sellPrice))
      return {
        itemId: it?.id,
        newItem: r
          ? {
              name: r.generic,
              strength: r.presentation,
              unit: readableUnit(r.unit) || null,
              kind: 'medicine',
              // the item keeps the list's code: its insurer price and prescribing rule follow the list
              code: r.code,
            }
          : l.pick === 'new'
            ? {
                name: l.newName.trim(),
                strength: l.newStrength.trim() || null,
                form: l.newForm.trim() || null,
                unit: l.newUnit.trim() || null,
                kind: l.newKind,
              }
            : undefined,
        batchNo: l.batchNo.trim(),
        expiry: l.expiry,
        quantity: quantityOf(l),
        unitCost: Number(l.unitCost),
        // an existing item: only a price that changes is sent
        sellPrice: it && price === it.sellingPrice ? null : price,
      }
    })
    try {
      const r = await actions.addStock.mutateAsync({
        lines: input,
        locationId: isManager && storeId !== main?.id ? storeId : null,
        note: note.trim() || undefined,
      })
      setMsg({
        ok: true,
        text: [
          t('stockPage.add.saved', {
            count: lines.length,
            units: formatNumber(totalUnits),
            value: formatRwf(Math.round(r.totalCost || totalCost)),
            store: storeName,
          }),
          r.priceIgnored ? t('stockPage.add.priceIgnored') : '',
        ]
          .filter(Boolean)
          .join(' '),
      })
      setLines([newLine()])
      setNote('')
    } catch (err) {
      if (err instanceof ApiError && err.line != null) setBadLine(lines[err.line - 1]?.key ?? null)
      setMsg({ ok: false, text: errText(err) })
    }
  }

  return (
    <Panel i={1} icon={PackagePlus} tint="amber" title={t('stockPage.add.title')}>
      <p className="text-ink-2 m-0 text-[14px]">{t('stockPage.add.lead')}</p>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        {isManager && stores.length > 1 && (
          <Select
            label={t('stock.store')}
            value={storeId}
            onChange={(e) => setStore(e.target.value)}
            wrapperClassName="sm:max-w-xs"
          >
            {stores.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.isMain ? ` · ${t('stockStores.main')}` : ''}
              </option>
            ))}
          </Select>
        )}

        <div className="flex flex-col gap-2">
          {lines.map((l, k) => {
            const it = itemOf(l)
            const r = refOf(l)
            const q = quantityOf(l)
            const priceChanges =
              it && l.sellPrice !== '' && Number(l.sellPrice) !== (it.sellingPrice ?? -1)
            return (
              <div
                key={l.key}
                className={cn(
                  card,
                  'gap-2 p-3',
                  badLine === l.key && 'border-red ring-red-bg ring-[3px]',
                )}
              >
                <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-2">
                  {l.pick === 'new' ? (
                    <Field
                      label={t('stockPage.add.newName', { n: k + 1 })}
                      value={l.newName}
                      placeholder={t('stockPage.add.newNamePh')}
                      onChange={(e) => set(l.key, { newName: e.target.value })}
                    />
                  ) : (
                    <SearchSelect
                      label={t('stockShared.lineN', { n: k + 1 })}
                      value={l.pick}
                      onChange={(v) => pick(l.key, v)}
                      emptyLabel={t('stockPage.add.pickItem')}
                      options={options}
                    />
                  )}
                  <Button
                    variant={l.pick === 'new' ? 'tint-grey' : 'tint-teal'}
                    size="sm"
                    className="mb-0.5"
                    onClick={() =>
                      set(l.key, { pick: l.pick === 'new' ? '' : 'new', sellPrice: '' })
                    }
                  >
                    {l.pick === 'new' ? (
                      <Undo2 size={14} aria-hidden="true" />
                    ) : (
                      <Sparkles size={14} aria-hidden="true" />
                    )}
                    {l.pick === 'new' ? t('stockPage.add.pickInstead') : t('stockPage.add.create')}
                  </Button>
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
                {it && notOnList?.has(it.id) && (
                  <p className="border-yellow/30 bg-yellow-bg text-yellow m-0 rounded-md border px-3 py-1.5 text-[13px] font-medium">
                    {t('stockPage.notOnList')} · {t('stockPage.notOnListHint')}
                  </p>
                )}
                {l.pick === 'new' && (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Select
                      label={t('stockPage.add.kind')}
                      value={l.newKind}
                      onChange={(e) => set(l.key, { newKind: e.target.value as ALine['newKind'] })}
                    >
                      <option value="medicine">{t('stockPage.kind.medicine')}</option>
                      <option value="supply">{t('stockPage.kind.supply')}</option>
                    </Select>
                    <Field
                      label={t('stockPage.add.strength')}
                      value={l.newStrength}
                      placeholder="500 mg"
                      onChange={(e) => set(l.key, { newStrength: e.target.value })}
                    />
                    <Field
                      label={t('stockPage.add.form')}
                      value={l.newForm}
                      placeholder={t('stockPage.add.formPh')}
                      onChange={(e) => set(l.key, { newForm: e.target.value })}
                    />
                    <Field
                      label={t('stockPage.add.unit')}
                      value={l.newUnit}
                      placeholder={t('stockPage.add.unitPh')}
                      onChange={(e) => set(l.key, { newUnit: e.target.value })}
                    />
                  </div>
                )}
                {r && (
                  <p className="text-ink-2 m-0 text-[12px]">
                    {t('stockDelivery.newFromList')}
                    {r.price != null && (
                      <> · {t('stockPage.add.listTariff', { price: formatRwf(r.price) })}</>
                    )}
                  </p>
                )}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Field
                    label={t('stock.batchNo')}
                    value={l.batchNo}
                    placeholder={t('stockPage.add.batchPh')}
                    onChange={(e) => set(l.key, { batchNo: e.target.value })}
                  />
                  <Field
                    label={t('stock.expiry')}
                    type="date"
                    min={today}
                    value={l.expiry}
                    onChange={(e) => set(l.key, { expiry: e.target.value })}
                  />
                  {l.inBoxes ? (
                    <div className="col-span-2 grid grid-cols-2 gap-2">
                      <Field
                        label={t('stockDelivery.boxCount')}
                        inputMode="numeric"
                        value={l.boxes}
                        onChange={(e) => set(l.key, { boxes: digits(e.target.value) })}
                      />
                      <Field
                        label={t('stockDelivery.packSize')}
                        inputMode="numeric"
                        value={l.perBox}
                        placeholder={it?.packSize ? String(it.packSize) : '100'}
                        onChange={(e) => set(l.key, { perBox: digits(e.target.value) })}
                      />
                    </div>
                  ) : (
                    <Field
                      label={t('stockPage.add.quantity')}
                      inputMode="numeric"
                      value={l.quantity}
                      onChange={(e) => set(l.key, { quantity: digits(e.target.value) })}
                    />
                  )}
                  <Field
                    label={t('stockPage.add.unitCost')}
                    inputMode="decimal"
                    value={l.unitCost}
                    onChange={(e) => set(l.key, { unitCost: decimal(e.target.value) })}
                  />
                  <Field
                    label={t('stockDelivery.sellingPrice')}
                    inputMode="numeric"
                    value={l.sellPrice}
                    placeholder={t('stockDelivery.sellingPricePh')}
                    onChange={(e) => set(l.key, { sellPrice: digits(e.target.value) })}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                  <label className="text-ink-2 inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={l.inBoxes}
                      onChange={(e) =>
                        set(l.key, {
                          inBoxes: e.target.checked,
                          quantity: e.target.checked ? l.quantity : String(q || ''),
                        })
                      }
                    />
                    {t('stockPage.add.inBoxes')}
                  </label>
                  {q > 0 && (
                    <span className="text-ink-2 tabular-nums">
                      {t('stockPage.add.lineSum', {
                        units: formatNumber(q),
                        value: formatRwf(Math.round(costOf(l))),
                      })}
                    </span>
                  )}
                  {priceChanges && (
                    <span className="text-amber font-medium">
                      {t('stockPage.add.priceChanges', {
                        from: it.sellingPrice == null ? '—' : formatRwf(it.sellingPrice),
                        to: formatRwf(Number(l.sellPrice)),
                      })}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
          <Button size="sm" className="self-start" onClick={() => setLines([...lines, newLine()])}>
            <Plus size={14} aria-hidden="true" />
            {t('stockShared.addLine')}
          </Button>
        </div>

        <Field
          label={t('stockPage.add.note')}
          value={note}
          placeholder={t('stockPage.add.notePh')}
          onChange={(e) => setNote(e.target.value)}
          wrapperClassName="sm:max-w-md"
        />
        <p
          className={cn(
            'm-0 flex items-center gap-2 rounded-md border px-3 py-2 text-[14px] font-semibold tabular-nums',
            tileClass.amber,
          )}
        >
          <PackagePlus size={16} aria-hidden="true" className="text-amber flex-none" />
          {t('stockPage.add.total', {
            count: filled.length,
            units: formatNumber(totalUnits),
            value: formatRwf(Math.round(totalCost)),
          })}
        </p>
        <MsgFlash msg={msg} onClose={() => setMsg(null)} />
        <Button
          type="submit"
          variant="success"
          className="self-start"
          loading={actions.addStock.isPending}
        >
          {!actions.addStock.isPending && <PackagePlus size={16} aria-hidden="true" />}
          {t('stockPage.add.save')}
        </Button>
      </form>
    </Panel>
  )
}

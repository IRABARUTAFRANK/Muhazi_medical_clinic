import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { PackagePlus, Plus, Sparkles, Trash2, Undo2, WandSparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumber, formatRwf } from '@mmc/shared'
import { Panel } from '@/components/dash/kit'
import { card, tileClass } from '@/components/dash/kit-style'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { SearchSelect } from '@/components/ui/search-select'
import {
  medicineRefDisplay,
  medicineRefOption,
  medicineRefParts,
  readableUnit,
  sortMedicineRefs,
  useMedicineReference,
  useMedicines,
  type MedicineRef,
} from '@/lib/api/catalogue'
import { nameCollator, tidyName } from '@/lib/medicine-name'
import { supabase } from '@/lib/supabase'
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
import { useSession } from '@/store/session'
import { MsgFlash, QtyModeToggle } from './stock-shared'
import {
  emptyPack,
  packChanged,
  packDraftOf,
  packInput,
  packProblem,
  packSummary,
  type PackDraft,
} from './pack-draft'
import { PackagingFields } from './packaging-fields'
import {
  errText,
  itemName,
  mainPharmacy,
  packCountText,
  packsText,
  pharmacyStores,
  todayIso,
  packWord,
  pieceWord,
  tx,
  unitsText,
  type Msg,
  type QtyMode,
} from './stock-util'

/** Where a field filled by itself came from: the RHIA list, the item, its last delivery. */
type Filled = 'list' | 'item' | 'delivery' | 'average'

interface ALine {
  key: number
  /** A clinic item id, "ref:<code>" (a medicine of the RHIA list) or "new" (typed here). */
  pick: string
  /** Where the package and the prices came from, and the cost (cleared once the cost is typed). */
  packFrom?: Filled
  costFrom?: Filled
  newName: string
  newStrength: string
  newForm: string
  newKind: 'medicine' | 'supply'
  /** The package and how it is sold (0107): filled from the item or the list, changeable. */
  pack: PackDraft
  batchNo: string
  expiry: string
  /** As typed: pieces, or whole packs (qtyIn 'packs'). */
  quantity: string
  qtyIn: QtyMode
  /** The cost as typed: of one piece, or of one pack (costPer 'pack'). */
  cost: string
  costPer: 'piece' | 'pack'
}
let lineKey = 1
const newLine = (pick = '', pack: PackDraft = emptyPack()): ALine => ({
  key: lineKey++,
  pick,
  newName: '',
  newStrength: '',
  newForm: '',
  newKind: 'medicine',
  pack,
  batchNo: '',
  expiry: '',
  quantity: '',
  qtyIn: pack.kind === 'pack' ? 'packs' : 'pieces',
  cost: '',
  costPer: 'piece',
})

const digits = (s: string) => s.replace(/[^\d]/g, '')
const decimal = (s: string) => s.replace(/[^\d.]/g, '')

/**
 * The cost per unit of the item's latest batch received (the pharmacy and the manager may read
 * the batches); null when it never came in. Sample mode has no batches: null.
 */
async function lastBatchCost(itemId: string): Promise<number | null> {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('batch')
    .select('unit_cost')
    .eq('item_id', itemId)
    .is('deleted_at', null)
    .order('received_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  const c = Number((data as { unit_cost: number | string | null }).unit_cost)
  return Number.isFinite(c) ? c : null
}

/** A cost as the field takes it: no grouping, at most 2 decimals ("1200.5"). */
const costText = (n: number) => String(Math.round(n * 100) / 100)

/** The pieces in one pack the line says (null: pieces only). */
const sizeOf = (l: ALine): number | null => {
  const n = Number(l.pack.packSize)
  return l.pack.kind === 'pack' && Number.isInteger(n) && n >= 2 ? n : null
}

/**
 * Add stock: what arrived at the pharmacy, one line per batch. Each line names the item (picked
 * from the clinic's items or the RHIA list, or created here as a medicine or a product), its
 * package and how it is sold (0107: pieces only or a pack of N; by the piece, only by the whole
 * pack, or both, with the prices that apply), its batch number, expiry date (never in the past),
 * the quantity (in pieces or in packs) and the cost (of one piece or of one pack). A known item's
 * package and prices change only for the manager and the pharmacist (the price right); anyone
 * else sees them as they are. No supplier, no delivery note, no date: it is today. The manager
 * may choose another pharmacy store; everyone else adds into the main pharmacy.
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
  const qc = useQueryClient()
  const actions = useStockActions()
  const confirm = useConfirm()
  // the price right (item_price.write): the manager and the pharmacist
  const mayPrice = useSession((s) => s.user?.role === 'manager' || s.user?.role === 'pharmacist')
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
    return [it ? { ...newLine(it.id, packDraftOf(it)), packFrom: 'item' } : newLine()]
  })
  const [msg, setMsg] = useState<Msg | null>(null)
  const [badLine, setBadLine] = useState<number | null>(null)
  const today = todayIso()

  // the clinic's own items first (A to Z), then the RHIA list (by generic name and strength)
  const options = useMemo(() => {
    const clinicCodes = new Set([...items.map((i) => i.code), ...medicines.map((m) => m.code)])
    const refByCode = new Map(reference.map((r) => [r.code, r]))
    const clinicGroup = t('stockPage.add.groupClinic')
    const own = items
      .filter((i) => i.active)
      .map((i) => {
        // an item taken from the list unchanged reads like the list's clean name
        const r = refByCode.get(i.code)
        const fromList = r && i.name === r.generic ? medicineRefDisplay(r, t) : null
        return {
          value: i.id,
          label: fromList?.name ?? tidyName(itemName(i)),
          sub:
            [
              fromList?.sub,
              !fromList && i.unit ? i.unit : null,
              notOnList?.has(i.id) ? t('stockPage.notOnList') : null,
            ]
              .filter(Boolean)
              .join(' · ') || undefined,
          hint: i.sellingPrice == null ? undefined : formatRwf(i.sellingPrice),
          group: clinicGroup,
          keywords: `${i.code} ${itemName(i)}`,
        }
      })
      .sort((a, b) => nameCollator.compare(a.label, b.label))
    const list = sortMedicineRefs(reference)
      .filter((r) => !clinicCodes.has(r.code))
      .map((r) => medicineRefOption(r, t, `ref:${r.code}`))
    return [...own, ...list]
  }, [items, medicines, reference, notOnList, t])
  const itemOf = (l: ALine) => items.find((i) => i.id === l.pick)
  const refOf = (l: ALine) =>
    l.pick.startsWith('ref:') ? reference.find((r) => r.code === l.pick.slice(4)) : undefined
  const isNew = (l: ALine) => l.pick === 'new' || l.pick.startsWith('ref:')
  /** A known item the person may not re-price: its package and prices are shown, not edited. */
  const locked = (l: ALine) => !isNew(l) && !mayPrice
  const set = (key: number, patch: Partial<ALine>) => {
    setBadLine(null)
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }
  /** A filled field: a small note after its label ("from the list") and a light teal tint. */
  const filledLabel = (text: string, from?: Filled): ReactNode =>
    from ? (
      <span className="flex flex-wrap items-baseline gap-x-1.5">
        {text}
        <span className="text-primary text-[11px] font-normal">
          {t(`stockPage.add.filled.${from}`)}
        </span>
      </span>
    ) : (
      text
    )
  const filledClass = (from?: Filled) => (from ? 'bg-primary-tint border-primary/40' : undefined)
  /** The clinic name the list suggests: "Acetazolamide (Diamox)", "250 mg", "tablet". */
  const listNames = (r: MedicineRef) => {
    const p = medicineRefParts(r)
    return {
      newName: p.brand ? `${p.genericOnly} (${p.brand})` : (p.genericOnly ?? r.generic),
      newStrength: p.strengthText ?? '',
      newForm: p.form ?? '',
    }
  }
  /**
   * Picking fills what can be known, for the pharmacist to change only what differs:
   *   a clinic item: its package, how it is sold and its prices, the cost per unit of its last
   *     delivery (or, without one, the average cost of the stock);
   *   a medicine new from the RHIA list: the list's pack ("B/20") and its tariff as the price of
   *     one piece (owner, 2026-10-27: filled, to be changed when the clinic's cash price differs).
   */
  const pick = (key: number, value: string) => {
    const it = items.find((i) => i.id === value)
    const r = value.startsWith('ref:') ? reference.find((x) => x.code === value.slice(4)) : null
    let pack = emptyPack()
    let packFrom: Filled | undefined
    let cost = ''
    let costFrom: Filled | undefined
    if (it) {
      pack = packDraftOf(it)
      packFrom = 'item'
      if (it.avgCost != null && it.avgCost > 0) {
        cost = costText(it.avgCost)
        costFrom = 'average'
      }
    } else if (r) {
      const size = medicineRefParts(r).pack
      pack = {
        ...emptyPack(),
        kind: size && size > 1 ? 'pack' : 'pieces',
        packSize: size && size > 1 ? String(size) : '',
        packUnit: size && size > 1 ? 'box' : '',
        unit: readableUnit(r.unit) || '',
        piecePrice: r.price != null ? String(Math.round(r.price)) : '',
      }
      packFrom = 'list'
    }
    set(key, {
      pick: value,
      pack,
      packFrom,
      cost,
      costFrom,
      costPer: 'piece',
      qtyIn: pack.kind === 'pack' ? 'packs' : 'pieces',
      quantity: '',
      // a list medicine: its name and details fill fields the pharmacist may still change
      ...(r ? listNames(r) : {}),
    })
    if (!it) return
    // the cost of the last batch received, when the database has one, replaces the average
    void qc
      .fetchQuery({
        queryKey: ['stock', 'last-batch-cost', it.id],
        queryFn: () => lastBatchCost(it.id),
        staleTime: 60_000,
      })
      .then((c) => {
        if (c == null) return
        setLines((ls) =>
          ls.map((l) =>
            // only while the line still names this item and the cost was not typed
            l.key === key && l.pick === it.id && (l.cost === '' || l.costFrom)
              ? { ...l, cost: costText(c), costPer: 'piece', costFrom: 'delivery' }
              : l,
          ),
        )
      })
      .catch(() => {})
  }
  /** The pieces the line adds (packs × pieces in one when typed in packs). */
  const quantityOf = (l: ALine) => {
    const q = Number(l.quantity || 0)
    const size = sizeOf(l)
    return l.qtyIn === 'packs' && size ? q * size : q
  }
  /** The cost of one piece (a pack's cost / the pieces in one). */
  const pieceCostOf = (l: ALine) => {
    const c = Number(l.cost || 0)
    const size = sizeOf(l)
    return l.costPer === 'pack' && size ? c / size : c
  }
  const costOf = (l: ALine) => quantityOf(l) * pieceCostOf(l)
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
      if ((l.pick === 'new' || l.pick.startsWith('ref:')) && l.newName.trim().length < 2)
        return bad(t('stockPage.add.errors.newName'))
      if (!locked(l)) {
        const p = packProblem(t, l.pack)
        if (p) return bad(p)
      }
      if (!l.batchNo.trim()) return bad(t('stockPage.add.errors.batch'))
      if (!l.expiry) return bad(t('stock.errors.expiry'))
      if (l.expiry < today) return bad(t('stockDelivery.errors.past'))
      const q = quantityOf(l)
      if (!Number.isInteger(q) || q <= 0) return bad(t('stock.errors.quantity'))
      const c = Number(l.cost)
      if (l.cost === '' || !Number.isFinite(c) || c < 0) return bad(t('stock.errors.cost'))
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
      const p = r ? medicineRefParts(r) : null
      const it = itemOf(l)
      const pk = packInput(l.pack)
      const size = sizeOf(l)
      return {
        itemId: it?.id,
        newItem: r
          ? {
              // the list's clean wording, as the pharmacist may have changed it on the line
              name:
                l.newName.trim() ||
                (p?.brand ? `${p.genericOnly} (${p.brand})` : (p?.genericOnly ?? r.generic)),
              strength: l.newStrength.trim() || p?.strengthText || null,
              form: l.newForm.trim() || p?.form || null,
              unit: pk.unit || readableUnit(r.unit) || null,
              kind: 'medicine',
              // the item keeps the list's code: its insurer price and prescribing rule follow the list
              code: r.code,
            }
          : l.pick === 'new'
            ? {
                name: l.newName.trim(),
                strength: l.newStrength.trim() || null,
                form: l.newForm.trim() || null,
                unit: pk.unit,
                kind: l.newKind,
              }
            : undefined,
        batchNo: l.batchNo.trim(),
        expiry: l.expiry,
        // always in pieces (packs × pieces per pack)
        quantity: quantityOf(l),
        unitCost: Math.round(pieceCostOf(l) * 100) / 100,
        packCost: l.costPer === 'pack' && size ? Number(l.cost) : null,
        // the package and how it is sold: a known item the person may not re-price keeps its own
        ...(locked(l)
          ? { sellPrice: null, packSize: size }
          : {
              saleMode: pk.saleMode,
              packSize: pk.packSize,
              sellPrice: pk.saleMode === 'pack' ? null : pk.piecePrice,
              packPrice: pk.packPrice,
              packUnit: pk.packUnit,
              unit: pk.unit,
            }),
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
      <p className="text-ink-2 m-0 text-[14px]">
        {tx(
          t,
          'packaging.addLead',
          'One line per batch: the item (pick it, or create it as a medicine or a product), its package and how it is sold, the batch number, expiry date, quantity and cost. It goes into the main pharmacy today.',
        )}
      </p>
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

        <div className="@container flex flex-col gap-2">
          {lines.map((l, k) => {
            const it = itemOf(l)
            const r = refOf(l)
            const rd = r ? medicineRefDisplay(r, t) : null
            const q = quantityOf(l)
            const size = sizeOf(l)
            const pk = packInput(l.pack)
            const piece = pieceWord(t, pk.unit)
            const changes = it && !locked(l) && packChanged(l.pack, it)
            return (
              <div
                key={l.key}
                className={cn(
                  card,
                  'gap-2 p-3',
                  badLine === l.key && 'border-red ring-red-bg ring-[3px]',
                )}
              >
                {/* narrow (a phone): the item takes the whole row, its two buttons go under it */}
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 @md:grid-cols-[minmax(0,1fr)_auto_auto] [&>:first-child]:col-span-2 @md:[&>:first-child]:col-span-1">
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
                      set(l.key, {
                        pick: l.pick === 'new' ? '' : 'new',
                        pack: emptyPack(),
                        packFrom: undefined,
                        qtyIn: 'pieces',
                        cost: l.costFrom ? '' : l.cost,
                        costFrom: undefined,
                      })
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
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
                  </div>
                )}
                {r && (
                  // what the list says about it, read-only: it becomes the clinic's item as is
                  <div className="border-border bg-surface flex flex-col gap-0.5 rounded-md border px-3 py-2 text-[13px]">
                    <span className="text-ink-3 text-[12px]">{t('stockDelivery.newFromList')}</span>
                    <span className="text-ink font-semibold">{rd?.name}</span>
                    <span className="text-ink-2">
                      {[
                        rd?.sub,
                        r.unit ? t('stockPage.add.soldBy', { unit: readableUnit(r.unit) }) : null,
                        r.code,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    {r.price != null && (
                      <span className="text-ink-2">
                        {t('stockPage.add.listTariffFilled', { price: formatRwf(r.price) })}
                      </span>
                    )}
                  </div>
                )}
                {r && (
                  // the clinic's name for it: filled from the list, free to change before saving
                  <div className="flex flex-col gap-1.5">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,2fr)_repeat(2,minmax(0,1fr))]">
                      <Field
                        label={t('stockPage.add.clinicName')}
                        value={l.newName}
                        onChange={(e) => set(l.key, { newName: e.target.value })}
                        required
                      />
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
                    </div>
                    <p className="text-ink-3 m-0 text-[12.5px]">
                      {t('stockPage.add.clinicNameHint')}
                    </p>
                  </div>
                )}
                {l.pick && (
                  <PackagingFields
                    idPrefix={`add-${l.key}`}
                    value={l.pack}
                    onChange={(pack) =>
                      set(l.key, {
                        pack,
                        // pieces only: the quantity and the cost are in pieces
                        ...(pack.kind === 'pieces' ? { qtyIn: 'pieces', costPer: 'piece' } : {}),
                      })
                    }
                    readOnly={locked(l)}
                    current={it}
                    readOnlyNote={tx(
                      t,
                      'packaging.readOnlyStock',
                      'You add the stock; the package and the prices stay as they are (only the manager or the pharmacist changes them).',
                    )}
                    hint={
                      l.packFrom ? (
                        <span className="text-primary inline-flex items-center gap-1 text-[12px]">
                          <WandSparkles size={12} aria-hidden="true" />
                          {l.packFrom === 'list'
                            ? tx(
                                t,
                                'packaging.fromList',
                                'Filled from the official list (its pack and tariff): change what differs at the clinic.',
                              )
                            : tx(
                                t,
                                'packaging.fromItem',
                                'As saved for this item: a change here updates the item.',
                              )}
                        </span>
                      ) : undefined
                    }
                  />
                )}
                <div className="grid grid-cols-1 items-end gap-2 @xs:grid-cols-2 @lg:grid-cols-4">
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
                  <div className="flex items-end gap-1.5">
                    <Field
                      wrapperClassName="min-w-0 flex-1"
                      label={
                        l.qtyIn === 'packs' && size
                          ? tx(t, 'packaging.qtyPacks', 'Quantity · {{pack}} of {{size}}', {
                              size,
                              pack: packWord(t, pk.packUnit),
                            })
                          : tx(t, 'packaging.qtyPieces', 'Quantity ({{piece}})', { piece })
                      }
                      inputMode="numeric"
                      value={l.quantity}
                      onChange={(e) => set(l.key, { quantity: digits(e.target.value) })}
                    />
                    {size && (
                      <QtyModeToggle
                        mode={l.qtyIn}
                        className="mb-0.5"
                        onChange={(m) => {
                          // switching keeps the quantity: 3 boxes of 8 become 24 pieces, and back
                          const pieces = quantityOf(l)
                          set(l.key, {
                            qtyIn: m,
                            quantity:
                              pieces > 0
                                ? String(
                                    m === 'packs' ? Math.max(1, Math.floor(pieces / size)) : pieces,
                                  )
                                : l.quantity,
                          })
                        }}
                      />
                    )}
                  </div>
                  <div className="flex items-end gap-1.5">
                    <Field
                      wrapperClassName="min-w-0 flex-1"
                      label={filledLabel(
                        l.costPer === 'pack' && size
                          ? tx(t, 'packaging.costPack', 'Cost of one {{pack}} (RWF)', {
                              pack: packWord(t, pk.packUnit),
                            })
                          : tx(t, 'packaging.costPiece', 'Cost of one {{piece}} (RWF)', { piece }),
                        l.costFrom,
                      )}
                      inputMode="decimal"
                      value={l.cost}
                      className={filledClass(l.costFrom)}
                      onChange={(e) =>
                        set(l.key, { cost: decimal(e.target.value), costFrom: undefined })
                      }
                    />
                    {size && (
                      <select
                        aria-label={tx(t, 'packaging.costPer', 'Cost per')}
                        value={l.costPer}
                        onChange={(e) => {
                          const per = e.target.value as ALine['costPer']
                          const c = Number(l.cost)
                          // the same cost, said for the other unit
                          set(l.key, {
                            costPer: per,
                            cost:
                              l.cost === '' || !Number.isFinite(c)
                                ? l.cost
                                : costText(per === 'pack' ? c * size : c / size),
                          })
                        }}
                        className="border-border bg-surface text-ink-2 mb-0.5 h-8 rounded-md border px-1.5 text-[12px] font-medium"
                      >
                        <option value="piece">
                          {tx(t, 'packaging.perPieceShort', 'per {{piece}}', { piece })}
                        </option>
                        <option value="pack">
                          {tx(t, 'packaging.perPackShort', 'per {{pack}}', {
                            pack: packWord(t, pk.packUnit),
                          })}
                        </option>
                      </select>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                  {q > 0 && (
                    <span className="text-ink-2 font-medium tabular-nums">
                      {[
                        l.qtyIn === 'packs' && size
                          ? `${packCountText(t, Number(l.quantity), size, pk.packUnit)} = ${unitsText(q, pk.unit)}`
                          : unitsText(q, pk.unit),
                        l.qtyIn !== 'packs' ? packsText(t, q, size, pk.packUnit) : null,
                        tx(t, 'packaging.costTotal', 'cost {{value}}', {
                          value: formatRwf(Math.round(costOf(l))),
                        }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  )}
                  {changes && (
                    <span className="text-amber font-medium">
                      {tx(t, 'packaging.changes', 'The item changes: {{from}} → {{to}}', {
                        from: packSummary(t, it),
                        to: packSummary(t, {
                          packSize: pk.packSize,
                          saleMode: pk.saleMode,
                          packPrice: pk.packPrice,
                          sellingPrice: pk.piecePrice,
                          unit: pk.unit,
                          packUnit: pk.packUnit,
                        }),
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

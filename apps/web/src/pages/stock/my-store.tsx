import { useState, type FormEvent } from 'react'
import {
  AlertTriangle,
  Boxes,
  ClipboardCheck,
  ClipboardList,
  PackageMinus,
  PackagePlus,
  Store,
  Truck,
  Undo2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf, type StaffUser } from '@mmc/shared'
import { Empty, Kpi, Panel } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { SearchSelect } from '@/components/ui/search-select'
import { useMyStores, useRoomStoreActions, useStoreStock, type MyStore } from '@/lib/api/rooms'
import { useStockActions, useStockOverview } from '@/lib/api/stock'
import { useCan } from '@/lib/api/permissions'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { RefillRequestsList } from './refill-requests'
import { RoomStoreStock, RoomStoreUse } from './room-store-parts'
import { LinesEditor, MsgFlash } from './stock-shared'
import {
  cleanLines,
  draftLine,
  errText,
  itemName,
  todayIso,
  type DraftLine,
  type Msg,
} from './stock-util'
import { TransferNotesList } from './transfer-notes'

type Action = 'refill' | 'return' | 'count' | 'writeOff' | 'receive'

/**
 * "My store": the room stores I hold (a doctor's office, the dental room, a ward). What is in
 * it, expiring and expired marked; the notes on the way to confirm; asking the pharmacy for a
 * refill; returning stock to the pharmacy; counting and writing off with a reason; and what the
 * store gave to patients in a period. The manager decides who holds a store.
 */
export function MyStoreTab({
  user,
  storeId,
  noteId,
}: {
  user: StaffUser
  /** From the address (a notification): the store to open. */
  storeId?: string
  /** From the address: the note to open. */
  noteId?: string
}) {
  const { t } = useTranslation()
  const { data: stores = [], isLoading, error } = useMyStores()
  const [chosen, setChosen] = useState<string | null>(storeId ?? null)
  const store = stores.find((s) => s.id === chosen) ?? stores[0]
  const [openNote, setOpenNote] = useState<string | null>(noteId ?? null)
  const can = useCan(user)
  const [action, setAction] = useState<Action>('refill')

  if (isLoading) return null
  if (error) return <p className="text-red m-0 text-[13px]">{error.message}</p>
  if (!store)
    return (
      <Panel i={1} icon={Store} tint="amber" title={t('myStore.title')}>
        <Empty icon={Store}>{t('myStore.none')}</Empty>
      </Panel>
    )
  const actions: Action[] = [
    'refill',
    'return',
    'count',
    'writeOff',
    // the laboratory may still receive its reagents into its own store
    ...(store.type === 'lab' && can('stock.write') ? (['receive'] as const) : []),
  ]
  return (
    <div className="flex flex-col gap-4">
      {stores.length > 1 && (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('myStore.pick')}>
          {stores.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === store.id}
              onClick={() => {
                setChosen(s.id)
                setOpenNote(null)
              }}
              className={cn(
                'inline-flex min-h-10 items-center gap-2 rounded-full border px-3.5 text-[13px] font-semibold',
                s.id === store.id
                  ? 'bg-navy border-transparent text-white'
                  : 'border-border bg-card text-ink-2 hover:bg-hover',
              )}
            >
              <Store size={14} aria-hidden="true" />
              {s.name}
              {s.incoming > 0 && (
                <span className="bg-amber-bg text-amber rounded-full px-1.5 text-[12px]">
                  {s.incoming}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <StoreHeader store={store} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(170px,1fr))]">
        <Kpi
          i={0}
          icon={Boxes}
          tint="mint"
          label={t('myStore.tiles.items')}
          value={store.items}
          unit={t('myStore.tiles.units', { count: store.units })}
        />
        <Kpi
          i={1}
          icon={AlertTriangle}
          tint="amber"
          label={t('myStore.tiles.low')}
          value={store.low}
          unit={t('stock.units.items')}
        />
        <Kpi
          i={2}
          icon={AlertTriangle}
          tint="coral"
          label={t('myStore.tiles.expiring')}
          value={store.expiringUnits}
          unit={t('stock.units.in90')}
        />
        <Kpi
          i={3}
          icon={AlertTriangle}
          tint="coral"
          label={t('myStore.tiles.expired')}
          value={store.expiredUnits}
          unit={t('myStore.tiles.toWriteOff')}
        />
        <Kpi
          i={4}
          icon={Truck}
          tint="teal"
          label={t('myStore.tiles.incoming')}
          value={store.incoming}
          unit={t('myStore.tiles.toConfirm')}
        />
      </div>

      <TransferNotesList
        key={`notes-${store.id}`}
        i={1}
        locationId={store.id}
        initialStatus="in_transit"
        openId={openNote}
        onOpen={setOpenNote}
        title={t('myStore.notesTitle')}
      />

      <Panel i={2} icon={ClipboardCheck} tint="navy" title={t('myStore.actionsTitle')}>
        <div className="flex flex-wrap gap-1 self-start rounded-xl bg-white/70 p-1" role="tablist">
          {actions.map((a) => (
            <button
              key={a}
              type="button"
              role="tab"
              aria-selected={action === a}
              onClick={() => setAction(a)}
              className={cn(
                'inline-flex min-h-10 items-center rounded-lg px-3 text-[13px] font-semibold whitespace-nowrap',
                action === a ? 'bg-navy text-white' : 'text-ink-2 hover:bg-hover',
              )}
            >
              {t(`myStore.actions.${a}`)}
            </button>
          ))}
        </div>
        {action === 'refill' && <RefillForm key={store.id} store={store} />}
        {action === 'return' && <ReturnForm key={store.id} store={store} />}
        {action === 'count' && <CountForm key={store.id} store={store} />}
        {action === 'writeOff' && <WriteOffForm key={store.id} store={store} />}
        {action === 'receive' && <LabReceiveForm key={store.id} store={store} />}
      </Panel>

      <RoomStoreStock key={`stock-${store.id}`} locationId={store.id} i={3} />
      <RefillRequestsList key={`rq-${store.id}`} locationId={store.id} pharmacy={false} i={4} />
      <RoomStoreUse key={`use-${store.id}`} locationId={store.id} i={5} />
    </div>
  )
}

function StoreHeader({ store }: { store: MyStore }) {
  const { t } = useTranslation()
  return (
    <p className="text-ink-2 m-0 text-[13px]">
      <b className="text-ink text-[15px]">{store.name}</b>
      {' · '}
      {t(`stock.storeTypes.${store.type}`)}
      {' · '}
      {store.personal
        ? t('myStore.heldByMe')
        : t('myStore.heldByDept', { departments: store.departments.join(', ') })}
      {store.openRequests > 0 && ` · ${t('myStore.openRequests', { count: store.openRequests })}`}
      {store.returnsOnTheWay > 0 &&
        ` · ${t('myStore.returnsOnTheWay', { count: store.returnsOnTheWay })}`}
    </p>
  )
}

/** Medicines of the store (with what is there) as picker options. */
function useStoreOptions(storeId: string, withEmpty: boolean) {
  const { t } = useTranslation()
  const { data } = useStoreStock(storeId)
  const items = data?.items ?? []
  return {
    items,
    options: items
      .filter((x) => withEmpty || x.onHand > 0)
      .map((x) => ({
        value: x.itemId,
        label: `${x.item} · ${t('stock.onHandShort', { count: x.onHand })}${
          x.expired > 0 ? ` · ${t('stock.expired', { count: x.expired })}` : ''
        }`,
      })),
  }
}

/* ---------------------------------------------------------------- ask the pharmacy */
function RefillForm({ store }: { store: MyStore }) {
  const { t } = useTranslation()
  const actions = useRoomStoreActions()
  const confirm = useConfirm()
  const { data: overview } = useStockOverview()
  const { items: inStore } = useStoreOptions(store.id, true)
  const [lines, setLines] = useState<DraftLine[]>(() => [draftLine()])
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<Msg | null>(null)
  const options = (overview?.items ?? [])
    .filter((i) => i.active)
    .map((i) => ({ value: i.id, label: itemName(i) }))
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    const clean = cleanLines(lines)
    if (clean.length === 0) return setMsg({ ok: false, text: t('myStore.errors.lines') })
    if (
      !(await confirm({
        title: t('confirm.rooms.refillTitle', { count: clean.length, store: store.name }),
        body: t('confirm.rooms.refillBody'),
        confirmLabel: t('confirm.rooms.refillYes'),
      }))
    )
      return
    try {
      const r = await actions.requestRefill.mutateAsync({
        locationId: store.id,
        lines: clean,
        note: note.trim() || undefined,
      })
      setMsg({ ok: true, text: t('myStore.refillSent', { number: r.number }) })
      setLines([draftLine()])
      setNote('')
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
      <p className="text-ink-2 m-0 text-[13px]">{t('myStore.refillLead')}</p>
      <LinesEditor
        lines={lines}
        onChange={setLines}
        options={options}
        available={(id) => inStore.find((x) => x.itemId === id)?.usable ?? 0}
        availableKey="myStore.inMyStore"
      />
      <Field
        label={t('stock.reason')}
        value={note}
        placeholder={t('myStore.refillNotePh')}
        onChange={(e) => setNote(e.target.value)}
        wrapperClassName="sm:max-w-md"
      />
      <MsgFlash msg={msg} onClose={() => setMsg(null)} />
      <Button
        type="submit"
        variant="primary"
        className="self-start"
        loading={actions.requestRefill.isPending}
      >
        <ClipboardList size={16} aria-hidden="true" />
        {t('myStore.refillSend')}
      </Button>
    </form>
  )
}

/* ---------------------------------------------------------------- back to the pharmacy */
function ReturnForm({ store }: { store: MyStore }) {
  const { t } = useTranslation()
  const actions = useRoomStoreActions()
  const confirm = useConfirm()
  const { items, options } = useStoreOptions(store.id, false)
  const [lines, setLines] = useState<DraftLine[]>(() => [draftLine()])
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<Msg | null>(null)
  const send = async (all: boolean) => {
    setMsg(null)
    const clean = all ? null : cleanLines(lines)
    if (clean && clean.length === 0) return setMsg({ ok: false, text: t('myStore.errors.lines') })
    for (const l of clean ?? []) {
      const have = items.find((x) => x.itemId === l.itemId)?.onHand ?? 0
      if (l.quantity > have)
        return setMsg({
          ok: false,
          text: t('myStore.errors.more', {
            item: items.find((x) => x.itemId === l.itemId)?.item ?? '',
            count: have,
          }),
        })
    }
    if (all && items.every((x) => x.onHand === 0))
      return setMsg({ ok: false, text: t('myStore.errors.empty') })
    if (
      !(await confirm({
        title: all
          ? t('confirm.rooms.returnAllTitle', { store: store.name })
          : t('confirm.rooms.returnTitle', { count: clean!.length, store: store.name }),
        body: t('confirm.rooms.returnBody'),
        confirmLabel: t('confirm.rooms.returnYes'),
        tone: all ? 'danger' : 'primary',
      }))
    )
      return
    try {
      const r = await actions.returnToPharmacy.mutateAsync({
        locationId: store.id,
        lines: clean,
        note: note.trim() || undefined,
      })
      setMsg({ ok: true, text: t('myStore.returnSent', { number: r.number, count: r.units }) })
      setLines([draftLine()])
      setNote('')
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void send(false)
      }}
      className="flex flex-col gap-3"
    >
      <p className="text-ink-2 m-0 text-[13px]">{t('myStore.returnLead')}</p>
      <LinesEditor
        lines={lines}
        onChange={setLines}
        options={options}
        available={(id) => items.find((x) => x.itemId === id)?.onHand ?? 0}
        availableKey="myStore.inMyStore"
      />
      <Field
        label={t('stock.reason')}
        value={note}
        placeholder={t('myStore.returnNotePh')}
        onChange={(e) => setNote(e.target.value)}
        wrapperClassName="sm:max-w-md"
      />
      <MsgFlash msg={msg} onClose={() => setMsg(null)} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={actions.returnToPharmacy.isPending}>
          <Undo2 size={16} aria-hidden="true" />
          {t('myStore.returnSend')}
        </Button>
        <Button variant="danger" onClick={() => void send(true)}>
          {t('myStore.returnAll')}
        </Button>
      </div>
    </form>
  )
}

/* ---------------------------------------------------------------- count */
function CountForm({ store }: { store: MyStore }) {
  const { t } = useTranslation()
  const actions = useRoomStoreActions()
  const confirm = useConfirm()
  const { items, options } = useStoreOptions(store.id, true)
  const { data: overview } = useStockOverview()
  const [itemId, setItemId] = useState('')
  const [counted, setCounted] = useState('')
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState<Msg | null>(null)
  // a medicine found on the shelf that the system does not list here can be counted too
  const extra = (overview?.items ?? [])
    .filter((i) => i.active && !items.some((x) => x.itemId === i.id))
    .map((i) => ({ value: i.id, label: itemName(i) }))
  const current = items.find((x) => x.itemId === itemId)?.onHand ?? 0
  const name =
    items.find((x) => x.itemId === itemId)?.item ??
    itemName(overview?.items.find((i) => i.id === itemId))
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    const n = Number(counted)
    if (!itemId) return setMsg({ ok: false, text: t('stock.errors.item') })
    if (counted === '' || !Number.isInteger(n) || n < 0)
      return setMsg({ ok: false, text: t('stock.reorderBad') })
    if (reason.trim().length < 3) return setMsg({ ok: false, text: t('stock.errors.countWhy') })
    if (
      !(await confirm({
        title: t('confirm.stock.countTitle', { item: name, store: store.name, after: n }),
        body: t('confirm.stock.countBody', { before: current, after: n }),
        confirmLabel: t('confirm.stock.countYes'),
        tone: n < current ? 'danger' : 'primary',
      }))
    )
      return
    try {
      await actions.count.mutateAsync({
        locationId: store.id,
        itemId,
        counted: n,
        reason: reason.trim(),
      })
      setMsg({ ok: true, text: t('stock.countSaved', { item: name, before: current, after: n }) })
      setCounted('')
      setReason('')
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
      <p className="text-ink-2 m-0 text-[13px]">{t('stock.countLead')}</p>
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1.4fr)_140px]">
        <SearchSelect
          label={t('stock.cols.item')}
          value={itemId}
          onChange={setItemId}
          emptyLabel={t('visit.add.pickItem')}
          options={[...options, ...extra]}
        />
        <Field
          label={t('stock.counted')}
          inputMode="numeric"
          value={counted}
          placeholder={String(current)}
          onChange={(e) => setCounted(e.target.value.replace(/[^\d]/g, ''))}
        />
      </div>
      {itemId && (
        <p className="text-ink-3 m-0 text-[13px]">{t('stock.countNow', { count: current })}</p>
      )}
      <Field
        label={t('stock.countWhy')}
        value={reason}
        placeholder={t('stock.countWhyPh')}
        onChange={(e) => setReason(e.target.value)}
        wrapperClassName="sm:max-w-md"
      />
      <MsgFlash msg={msg} onClose={() => setMsg(null)} />
      <Button
        type="submit"
        variant="primary"
        className="self-start"
        loading={actions.count.isPending}
      >
        <ClipboardCheck size={16} aria-hidden="true" />
        {t('stock.countSave')}
      </Button>
    </form>
  )
}

/* ---------------------------------------------------------------- write off */
const WRITE_OFF = ['expired', 'damaged', 'other'] as const
function WriteOffForm({ store }: { store: MyStore }) {
  const { t } = useTranslation()
  const actions = useRoomStoreActions()
  const confirm = useConfirm()
  const { items, options } = useStoreOptions(store.id, false)
  const [itemId, setItemId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [why, setWhy] = useState<(typeof WRITE_OFF)[number]>('expired')
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<Msg | null>(null)
  const item = items.find((x) => x.itemId === itemId)
  const have = item?.onHand ?? 0
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    const q = Number(quantity)
    if (!item) return setMsg({ ok: false, text: t('stock.errors.item') })
    if (!Number.isInteger(q) || q <= 0)
      return setMsg({ ok: false, text: t('stock.errors.quantity') })
    if (q > have) return setMsg({ ok: false, text: t('stock.errors.short', { count: have }) })
    const reason = [t(`myStore.writeOffReasons.${why}`), note.trim()].filter(Boolean).join(': ')
    if (why === 'other' && note.trim().length < 3)
      return setMsg({ ok: false, text: t('myStore.errors.writeOffWhy') })
    if (
      !(await confirm({
        title: t('confirm.stock.useTitle', { quantity: q, item: item.item, store: store.name }),
        body: t('confirm.stock.useBody', { reason }),
        confirmLabel: t('confirm.stock.useYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await actions.writeOff.mutateAsync({ locationId: store.id, itemId, quantity: q, reason })
      setMsg({ ok: true, text: t('stock.used', { count: q, item: item.item }) })
      setQuantity('')
      setNote('')
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
      <p className="text-ink-2 m-0 text-[13px]">{t('myStore.writeOffLead')}</p>
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_120px]">
        <SearchSelect
          label={t('stock.cols.item')}
          value={itemId}
          onChange={setItemId}
          emptyLabel={t('visit.add.pickItem')}
          options={options}
        />
        <Select
          label={t('stock.useWhy')}
          value={why}
          onChange={(e) => setWhy(e.target.value as typeof why)}
        >
          {WRITE_OFF.map((r) => (
            <option key={r} value={r}>
              {t(`myStore.writeOffReasons.${r}`)}
            </option>
          ))}
        </Select>
        <Field
          label={t('stock.quantity')}
          inputMode="numeric"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, ''))}
        />
      </div>
      {item && (
        <p className="text-ink-3 m-0 text-[13px]">
          {t('stock.availableHere', { count: have })}
          {item.expired > 0 && ` · ${t('stock.expired', { count: item.expired })}`}
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
        loading={actions.writeOff.isPending}
      >
        <PackageMinus size={16} aria-hidden="true" />
        {t('stock.useSave')}
      </Button>
    </form>
  )
}

/* ---------------------------------------------------------------- the laboratory's own delivery */
function LabReceiveForm({ store }: { store: MyStore }) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const confirm = useConfirm()
  const { data: overview } = useStockOverview()
  const items = (overview?.items ?? []).filter((i) => i.active)
  const [itemId, setItemId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [batchNo, setBatchNo] = useState('')
  const [expiry, setExpiry] = useState('')
  const [supplier, setSupplier] = useState('')
  const [msg, setMsg] = useState<Msg | null>(null)
  const item = items.find((i) => i.id === itemId)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    const q = Number(quantity)
    const c = Number(unitCost)
    if (!item) return setMsg({ ok: false, text: t('stock.errors.item') })
    if (!Number.isInteger(q) || q <= 0)
      return setMsg({ ok: false, text: t('stock.errors.quantity') })
    if (unitCost === '' || !Number.isFinite(c) || c < 0)
      return setMsg({ ok: false, text: t('stock.errors.cost') })
    if (!expiry) return setMsg({ ok: false, text: t('stock.errors.expiry') })
    if (expiry < todayIso()) return setMsg({ ok: false, text: t('stockDelivery.errors.past') })
    if (
      !(await confirm({
        title: t('confirm.stock.receiveTitle', {
          quantity: q,
          item: itemName(item),
          store: store.name,
        }),
        body: t('confirm.stock.receiveBody', { value: formatRwf(Math.round(q * c)) }),
        confirmLabel: t('confirm.stock.receiveYes'),
      }))
    )
      return
    try {
      await actions.receive.mutateAsync({
        itemId,
        locationId: store.id,
        quantity: q,
        unitCost: c,
        batchNo,
        expiry,
        supplier,
      })
      setMsg({
        ok: true,
        text: t('stock.received', {
          count: q,
          item: itemName(item),
          value: formatRwf(Math.round(q * c)),
        }),
      })
      setQuantity('')
      setBatchNo('')
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
      <p className="text-ink-2 m-0 text-[13px]">{t('myStore.labReceiveLead')}</p>
      <SearchSelect
        label={t('stock.cols.item')}
        value={itemId}
        onChange={setItemId}
        emptyLabel={t('visit.add.pickItem')}
        options={items.map((i) => ({ value: i.id, label: itemName(i) }))}
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field
          label={t('stock.quantity')}
          inputMode="numeric"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, ''))}
        />
        <Field
          label={t('stock.unitCost')}
          inputMode="numeric"
          value={unitCost}
          onChange={(e) => setUnitCost(e.target.value.replace(/[^\d.]/g, ''))}
        />
        <Field
          label={t('stock.batchNo')}
          value={batchNo}
          placeholder={t('stock.batchPh')}
          onChange={(e) => setBatchNo(e.target.value)}
        />
        <Field
          label={t('stock.expiry')}
          type="date"
          min={todayIso()}
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
        />
      </div>
      <Field
        label={t('stock.supplier')}
        value={supplier}
        placeholder={t('stock.supplierPh')}
        onChange={(e) => setSupplier(e.target.value)}
        wrapperClassName="sm:max-w-md"
      />
      <MsgFlash msg={msg} onClose={() => setMsg(null)} />
      <Button
        type="submit"
        variant="primary"
        className="self-start"
        loading={actions.receive.isPending}
      >
        <PackagePlus size={16} aria-hidden="true" />
        {t('stock.receive')}
      </Button>
    </form>
  )
}

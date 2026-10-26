import { useState, type FormEvent } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ClipboardList,
  DoorOpen,
  Pencil,
  Plus,
  Send,
  Store,
  Truck,
  Undo2,
  Users,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf } from '@mmc/shared'
import { Empty, Kpi, Panel } from '@/components/dash/kit'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Reveal } from '@/components/ui/reveal'
import { Select } from '@/components/ui/select'
import { SearchSelect } from '@/components/ui/search-select'
import {
  useRefillRequests,
  useRoomStoreActions,
  useRoomStoreAdmin,
  useTransferNotes,
  type RefillRequest,
  type RoomStoreType,
} from '@/lib/api/rooms'
import type { StockItem, StockLocation, StockOverview } from '@/lib/api/stock'
import { useDepartments, useEmployees } from '@/lib/api/staff'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { RefillRequestsList } from './refill-requests'
import { RoomStoreStock, RoomStoreUse } from './room-store-parts'
import { holdersText } from './stock-util'
import { LinesEditor, MsgFlash } from './stock-shared'
import {
  cleanLines,
  draftLine,
  errText,
  itemName,
  mainPharmacy,
  pharmacyStores,
  roomStores,
  usableIn,
  type DraftLine,
  type Msg,
} from './stock-util'
import { TransferNoteView, TransferNotesList } from './transfer-notes'

const ROOM_TYPES: RoomStoreType[] = ['room', 'nursing', 'lab', 'theatre']

/** What the send form starts with (a refill request, or a store chosen in the list). */
interface SendPreset {
  storeId?: string
  lines?: { itemId: string; quantity: number }[]
  requestId?: string
  requestNumber?: string
}

/**
 * Room stores, for the pharmacy and the manager: the refill requests, sending a transfer note
 * to a room store, the notes on the way (returns to confirm), and every room store with its
 * stock, value and use by period. The manager also creates room stores, chooses who holds them
 * (named staff and/or departments), closes an empty one and opens it again.
 */
export function RoomStoresTab({
  overview,
  isManager,
  canAct,
  focusNote,
  focusRequest,
  focusStore,
}: {
  overview: StockOverview | undefined
  isManager: boolean
  /** "Manage stock" (or the manager): send notes, decline requests, cancel a note. Without it
   *  the tab stays readable, without the buttons. */
  canAct: boolean
  focusNote?: string
  focusRequest?: string
  /** A store a notice points to (a loss in a room store): opened in the list. */
  focusStore?: string
}) {
  const { t } = useTranslation()
  const locations = overview?.locations ?? []
  const items = overview?.items ?? []
  const [preset, setPreset] = useState<SendPreset>({})
  const [presetKey, setPresetKey] = useState(0)
  const [openNote, setOpenNote] = useState<string | null>(focusNote ?? null)
  const { data: openRequests = [] } = useRefillRequests('open')
  const { data: onTheWay = [] } = useTransferNotes({ status: 'in_transit' })
  const returnsToConfirm = onTheWay.filter((n) => n.direction === 'to_pharmacy' && n.canReceive)
  const prepare = (r: RefillRequest) => {
    setPreset({
      storeId: r.storeId,
      lines: r.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
      requestId: r.id,
      requestNumber: r.number,
    })
    setPresetKey((k) => k + 1)
    window.setTimeout(
      () => document.getElementById('send-note')?.scrollIntoView({ behavior: 'smooth' }),
      50,
    )
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(190px,1fr))]">
        <Kpi
          i={0}
          icon={ClipboardList}
          tint="amber"
          label={t('roomStores.tiles.requests')}
          value={openRequests.length}
          unit={t('roomStores.tiles.toPrepare')}
        />
        <Kpi
          i={1}
          icon={Truck}
          tint="teal"
          label={t('roomStores.tiles.onTheWay')}
          value={onTheWay.filter((n) => n.direction === 'to_room').length}
          unit={t('roomStores.tiles.notes')}
        />
        <Kpi
          i={2}
          icon={Undo2}
          tint="violet"
          label={t('roomStores.tiles.returns')}
          value={returnsToConfirm.length}
          unit={t('myStore.tiles.toConfirm')}
        />
        <Kpi
          i={3}
          icon={Store}
          tint="mint"
          label={t('roomStores.tiles.stores')}
          value={roomStores(locations).length}
          unit={t('roomStores.tiles.open')}
        />
      </div>
      <RefillRequestsList
        pharmacy
        canAct={canAct}
        focusId={focusRequest}
        onPrepare={prepare}
        i={1}
      />
      {canAct && (
        <SendNoteForm
          key={presetKey}
          locations={locations}
          items={items}
          mainId={overview?.mainPharmacyId ?? null}
          preset={preset}
          onClear={() => {
            setPreset({})
            setPresetKey((k) => k + 1)
          }}
        />
      )}
      <TransferNotesList
        i={3}
        initialStatus={focusNote ? 'all' : 'in_transit'}
        openId={openNote}
        onOpen={setOpenNote}
        canAct={canAct}
      />
      <RoomStoresList
        locations={locations}
        items={items}
        isManager={isManager}
        canAct={canAct}
        focusStore={focusStore}
        onSend={(storeId) => {
          setPreset({ storeId })
          setPresetKey((k) => k + 1)
          window.setTimeout(
            () => document.getElementById('send-note')?.scrollIntoView({ behavior: 'smooth' }),
            50,
          )
        }}
      />
    </div>
  )
}

/* ---------------------------------------------------------------- the pharmacy sends */
function SendNoteForm({
  locations,
  items,
  mainId,
  preset,
  onClear,
}: {
  locations: StockLocation[]
  items: StockItem[]
  mainId: string | null
  preset: SendPreset
  onClear: () => void
}) {
  const { t } = useTranslation()
  const actions = useRoomStoreActions()
  const confirm = useConfirm()
  const rooms = roomStores(locations)
  const sources = pharmacyStores(locations)
  const [to, setTo] = useState(preset.storeId ?? '')
  const [chosenFrom, setFrom] = useState('')
  const from = chosenFrom || (mainPharmacy(locations, mainId)?.id ?? '')
  const [lines, setLines] = useState<DraftLine[]>(() =>
    preset.lines?.length
      ? preset.lines.map((l) => draftLine(l.itemId, String(l.quantity)))
      : [draftLine()],
  )
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<Msg | null>(null)
  const [sentId, setSentId] = useState<string | null>(null)
  const options = items
    .filter((i) => i.active && usableIn(i, from) > 0)
    .map((i) => ({
      value: i.id,
      label: `${itemName(i)} · ${t('roomStores.inPharmacy', { count: usableIn(i, from) })}`,
    }))
  const toName = rooms.find((l) => l.id === to)?.name ?? ''
  const fromName = sources.find((l) => l.id === from)?.name ?? ''
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    if (!to) return setMsg({ ok: false, text: t('stock.errors.store') })
    const clean = cleanLines(lines)
    if (clean.length === 0) return setMsg({ ok: false, text: t('myStore.errors.lines') })
    for (const l of clean) {
      const it = items.find((i) => i.id === l.itemId)
      const have = usableIn(it, from)
      if (l.quantity > have)
        return setMsg({
          ok: false,
          text: t('roomStores.errors.short', { item: itemName(it), count: have, store: fromName }),
        })
    }
    const units = clean.reduce((s, l) => s + l.quantity, 0)
    if (
      !(await confirm({
        title: t('confirm.rooms.sendTitle', { count: clean.length, units, store: toName }),
        body: t('confirm.rooms.sendBody', { from: fromName, store: toName }),
        confirmLabel: t('confirm.rooms.sendYes'),
      }))
    )
      return
    try {
      const r = await actions.sendToRoom.mutateAsync({
        locationId: to,
        lines: clean,
        requestId: preset.requestId ?? null,
        note: note.trim() || undefined,
        fromLocationId: from || null,
      })
      setMsg({
        ok: true,
        text: t('roomStores.sentNote', { number: r.number, store: toName, count: r.units }),
      })
      setSentId(r.id)
      setLines([draftLine()])
      setNote('')
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <div id="send-note">
      <Panel i={2} icon={Send} tint="teal" title={t('roomStores.sendTitle')}>
        <p className="text-ink-2 m-0 text-[14px]">{t('roomStores.sendLead')}</p>
        {preset.requestNumber && (
          <p className="border-blue/30 bg-blue-bg text-blue m-0 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-[14px] font-medium">
            {t('roomStores.fromRequest', { number: preset.requestNumber })}
            <button type="button" className="underline" onClick={onClear}>
              {t('roomStores.clearRequest')}
            </button>
          </p>
        )}
        {rooms.length === 0 ? (
          <Empty icon={Store}>{t('roomStores.noRooms')}</Empty>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Select
                label={t('roomStores.toRoom')}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                required
              >
                <option value="">{t('stock.pickStore')}</option>
                {rooms.map((l) => (
                  // a store nobody holds is not sent to (nobody would confirm it)
                  <option key={l.id} value={l.id} disabled={(l.holders ?? []).length === 0}>
                    {l.name} · {holdersText(l.holders, t('roomStores.noHolder'))}
                  </option>
                ))}
              </Select>
              {sources.length > 1 && (
                <Select
                  label={t('stock.fromStore')}
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                >
                  {sources.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                      {l.isMain ? ` · ${t('stockStores.main')}` : ''}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            <LinesEditor
              lines={lines}
              onChange={setLines}
              options={options}
              available={(id) =>
                usableIn(
                  items.find((i) => i.id === id),
                  from,
                )
              }
              availableKey="roomStores.availableToSend"
            />
            <p className="text-ink-3 m-0 text-[12px]">{t('roomStores.fefoHint')}</p>
            <Field
              label={t('stock.reason')}
              value={note}
              placeholder={t('roomStores.sendNotePh')}
              onChange={(e) => setNote(e.target.value)}
              wrapperClassName="sm:max-w-md"
            />
            <MsgFlash msg={msg} onClose={() => setMsg(null)} />
            <Button
              type="submit"
              variant="primary"
              className="self-start"
              loading={actions.sendToRoom.isPending}
            >
              <Send size={16} aria-hidden="true" />
              {t('roomStores.send')}
            </Button>
          </form>
        )}
        {sentId && (
          <Reveal block="nearest">
            <TransferNoteView id={sentId} onClose={() => setSentId(null)} />
          </Reveal>
        )}
      </Panel>
    </div>
  )
}

/* ---------------------------------------------------------------- every room store */
function RoomStoresList({
  locations,
  items,
  isManager,
  canAct,
  focusStore,
  onSend,
}: {
  locations: StockLocation[]
  items: StockItem[]
  isManager: boolean
  canAct: boolean
  focusStore?: string
  onSend: (storeId: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState<string | null>(focusStore ?? null)
  const [editing, setEditing] = useState<StockLocation | 'new' | null>(null)
  const rooms = roomStores(locations, true).sort(
    (a, b) => Number(a.active === false) - Number(b.active === false),
  )
  const orphans = rooms.filter((l) => l.active !== false && (l.holders ?? []).length === 0)
  const unitsIn = (id: string) => items.reduce((s, i) => s + (i.byLocation[id] ?? 0), 0)
  const valueIn = (id: string) =>
    items.some((i) => i.costShown !== false && i.avgCost != null)
      ? items.reduce((s, i) => s + (i.byLocation[id] ?? 0) * (i.avgCost ?? 0), 0)
      : null
  return (
    <Panel
      i={4}
      icon={DoorOpen}
      tint="amber"
      title={t('roomStores.listTitle')}
      right={
        isManager ? (
          <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
            <Plus size={14} aria-hidden="true" />
            {t('roomStores.new')}
          </Button>
        ) : (
          String(rooms.length)
        )
      }
    >
      <p className="text-ink-2 m-0 text-[14px]">
        {t(isManager ? 'roomStores.listLeadManager' : 'roomStores.listLead')}
      </p>
      {/* open stores nobody holds: nobody can confirm a note or give from them */}
      {orphans.length > 0 && (
        <div className="bg-orange-bg text-orange flex flex-col gap-2 rounded-md px-3 py-2 text-[14px]">
          <p className="m-0 font-semibold">
            {t('roomStores.withoutHolder', { count: orphans.length })}
          </p>
          <p className="m-0">
            {t(isManager ? 'roomStores.withoutHolderManager' : 'roomStores.withoutHolderLead')}
          </p>
          <span className="flex flex-wrap gap-2">
            {orphans.map((l) =>
              isManager ? (
                <Button key={l.id} size="sm" onClick={() => setEditing(l)}>
                  <Users size={14} aria-hidden="true" />
                  {t('roomStores.assignHolder', { store: l.name })}
                </Button>
              ) : (
                <Badge key={l.id} tone="orange">
                  {l.name}
                </Badge>
              ),
            )}
          </span>
        </div>
      )}
      {editing && (
        <Reveal focus>
          <RoomStoreForm
            key={editing === 'new' ? 'new' : editing.id}
            store={editing === 'new' ? null : editing}
            onClose={() => setEditing(null)}
          />
        </Reveal>
      )}
      {rooms.length === 0 ? (
        <Empty icon={Store}>{t('roomStores.noRooms')}</Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {rooms.map((l) => {
            const units = unitsIn(l.id)
            const value = valueIn(l.id)
            const closed = l.active === false
            return (
              <div
                key={l.id}
                className={cn('border-border rounded-md border', closed && 'opacity-75')}
              >
                <button
                  type="button"
                  aria-expanded={open === l.id}
                  onClick={() => setOpen(open === l.id ? null : l.id)}
                  className="hover:bg-hover flex w-full flex-wrap items-center gap-3 rounded-md p-3 text-left"
                >
                  {open === l.id ? (
                    <ChevronDown size={16} aria-hidden="true" />
                  ) : (
                    <ChevronRight size={16} aria-hidden="true" />
                  )}
                  <span className="min-w-[200px] flex-1">
                    <span className="block font-semibold">{l.name}</span>
                    <span className="text-ink-3 flex items-center gap-1 text-[12px]">
                      <Users size={12} aria-hidden="true" />
                      {t(`stock.storeTypes.${l.type}`)} ·{' '}
                      {holdersText(l.holders, t('roomStores.noHolder'))}
                    </span>
                  </span>
                  <span className="text-[14px] tabular-nums">
                    {t('roomStores.unitsCount', { count: units })}
                    {value != null && (
                      <span className="text-ink-3 block text-[12px]">
                        {formatRwf(Math.round(value))}
                      </span>
                    )}
                  </span>
                  {closed ? (
                    <Badge tone="grey">{t('stockStores.closed')}</Badge>
                  ) : (l.holders ?? []).length === 0 ? (
                    <Badge tone="orange">{t('roomStores.noHolder')}</Badge>
                  ) : null}
                </button>
                {open === l.id && (
                  <div className="flex flex-col gap-3 px-3 pb-3">
                    <StoreAdminActions
                      store={l}
                      units={units}
                      isManager={isManager}
                      canAct={canAct}
                      onEdit={() => setEditing(l)}
                      onSend={() => onSend(l.id)}
                    />
                    <RoomStoreStock locationId={l.id} i={0} />
                    <RoomStoreUse locationId={l.id} i={1} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Panel>
  )
}

function StoreAdminActions({
  store,
  units,
  isManager,
  canAct,
  onEdit,
  onSend,
}: {
  store: StockLocation
  units: number
  isManager: boolean
  canAct: boolean
  onEdit: () => void
  onSend: () => void
}) {
  const { t } = useTranslation()
  const admin = useRoomStoreAdmin()
  const actions = useRoomStoreActions()
  const confirm = useConfirm()
  const [msg, setMsg] = useState<Msg | null>(null)
  const closed = store.active === false
  const setActive = async (active: boolean) => {
    setMsg(null)
    if (!active && units > 0) return setMsg({ ok: false, text: t('roomStores.errors.notEmpty') })
    if (
      !(await confirm({
        title: t(active ? 'confirm.stock.openStoreTitle' : 'confirm.stock.closeStoreTitle', {
          name: store.name,
        }),
        body: active ? t('confirm.rooms.reopenBody') : t('confirm.rooms.closeBody'),
        confirmLabel: t(active ? 'confirm.stock.openStoreYes' : 'confirm.stock.closeStoreYes'),
        tone: active ? 'primary' : 'danger',
      }))
    )
      return
    try {
      await admin.setActive.mutateAsync({ id: store.id, active })
      setMsg({
        ok: true,
        text: t(active ? 'roomStores.reopened' : 'roomStores.closed', { name: store.name }),
      })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    }
  }
  const returnAll = async () => {
    setMsg(null)
    if (
      !(await confirm({
        title: t('confirm.rooms.returnAllTitle', { store: store.name }),
        body: t('confirm.rooms.returnBody'),
        confirmLabel: t('confirm.rooms.returnYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      const r = await actions.returnToPharmacy.mutateAsync({ locationId: store.id, lines: null })
      setMsg({ ok: true, text: t('myStore.returnSent', { number: r.number, count: r.units }) })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {!closed && canAct && (
          <Button size="sm" variant="primary" onClick={onSend}>
            <Send size={14} aria-hidden="true" />
            {t('roomStores.sendHere')}
          </Button>
        )}
        {isManager && (
          <Button size="sm" onClick={onEdit}>
            <Pencil size={14} aria-hidden="true" />
            {t('roomStores.edit')}
          </Button>
        )}
        {isManager && !closed && units > 0 && (
          <Button
            size="sm"
            loading={actions.returnToPharmacy.isPending}
            onClick={() => void returnAll()}
          >
            <Undo2 size={14} aria-hidden="true" />
            {t('roomStores.returnAll')}
          </Button>
        )}
        {isManager && (
          <Button
            size="sm"
            variant={closed ? 'default' : 'danger'}
            loading={admin.setActive.isPending}
            onClick={() => void setActive(closed)}
          >
            {closed ? t('stock.storeOpen') : t('stock.storeClose')}
          </Button>
        )}
      </div>
      {isManager && !closed && units > 0 && (
        <p className="text-ink-3 m-0 text-[12px]">{t('roomStores.closeHint')}</p>
      )}
      <MsgFlash msg={msg} onClose={() => setMsg(null)} />
    </div>
  )
}

/* ---------------------------------------------------------------- the manager's form */
function RoomStoreForm({ store, onClose }: { store: StockLocation | null; onClose: () => void }) {
  const { t } = useTranslation()
  const admin = useRoomStoreAdmin()
  const confirm = useConfirm()
  const { data: employees = [] } = useEmployees()
  const { data: departments = [] } = useDepartments()
  const [name, setName] = useState(store?.name ?? '')
  const [type, setType] = useState<RoomStoreType>(
    store && ROOM_TYPES.includes(store.type as RoomStoreType)
      ? (store.type as RoomStoreType)
      : 'room',
  )
  const [staff, setStaff] = useState<string[]>(
    (store?.holders ?? []).flatMap((h) => (h.profileId ? [h.profileId] : [])),
  )
  const [depts, setDepts] = useState<string[]>(
    (store?.holders ?? []).flatMap((h) => (h.departmentId ? [h.departmentId] : [])),
  )
  const [msg, setMsg] = useState<Msg | null>(null)
  const active = employees.filter((e) => e.active)
  const nameOf = (id: string) =>
    employees.find((e) => e.id === id)?.fullName ??
    store?.holders?.find((h) => h.profileId === id)?.name ??
    id
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    if (name.trim().length < 2) return setMsg({ ok: false, text: t('stock.errors.storeName') })
    if (staff.length + depts.length === 0)
      return setMsg({ ok: false, text: t('roomStores.errors.holders') })
    const who = [
      ...staff.map(nameOf),
      ...depts.map((d) => departments.find((x) => x.id === d)?.name ?? ''),
    ]
      .filter(Boolean)
      .join(', ')
    if (
      !(await confirm({
        title: t(store ? 'confirm.rooms.saveStoreTitle' : 'confirm.rooms.newStoreTitle', {
          name: name.trim(),
        }),
        body: t('confirm.rooms.holdersBody', { who }),
        confirmLabel: t('confirm.stock.saveYes'),
      }))
    )
      return
    try {
      await admin.save.mutateAsync({
        id: store?.id ?? null,
        name: name.trim(),
        type,
        staff,
        departments: depts,
      })
      onClose()
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="border-border bg-surface flex flex-col gap-3 rounded-md border p-3"
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[16px] font-semibold">
          {store ? t('roomStores.editTitle', { name: store.name }) : t('roomStores.new')}
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Field
          label={t('stock.storeName')}
          value={name}
          placeholder={t('roomStores.namePh')}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Select
          label={t('stock.storeType')}
          value={type}
          onChange={(e) => setType(e.target.value as RoomStoreType)}
        >
          {ROOM_TYPES.map((x) => (
            <option key={x} value={x}>
              {t(`stock.storeTypes.${x}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-ink-2 text-[14px] font-semibold">{t('roomStores.people')}</span>
        <SearchSelect
          label={t('roomStores.addPerson')}
          value=""
          onChange={(id) => id && !staff.includes(id) && setStaff([...staff, id])}
          emptyLabel={t('roomStores.pickPerson')}
          options={active
            .filter((e) => !staff.includes(e.id))
            .map((e) => ({
              value: e.id,
              label: `${e.fullName} · ${t(`roles.${e.role}`, { defaultValue: e.role })}${
                e.departmentName ? ` · ${e.departmentName}` : ''
              }`,
            }))}
        />
        {staff.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {staff.map((id) => (
              <span
                key={id}
                className="border-border bg-card inline-flex items-center gap-1 rounded-md border py-0.5 pr-1 pl-2.5 text-[14px]"
              >
                {nameOf(id)}
                <button
                  type="button"
                  className="hover:bg-hover rounded-full p-1"
                  aria-label={t('roomStores.removeHolder', { name: nameOf(id) })}
                  title={t('roomStores.removeHolder', { name: nameOf(id) })}
                  onClick={() => setStaff(staff.filter((x) => x !== id))}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="text-ink-2 mb-1 text-[14px] font-semibold">
          {t('roomStores.departments')}
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {departments.map((d) => {
            const on = depts.includes(d.id)
            return (
              <label
                key={d.id}
                className={cn(
                  'inline-flex min-h-8 cursor-pointer items-center gap-2 rounded-md border px-3 text-[14px]',
                  on
                    ? 'border-primary bg-primary-tint text-primary font-semibold'
                    : 'border-border',
                )}
              >
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={on}
                  onChange={() => setDepts(on ? depts.filter((x) => x !== d.id) : [...depts, d.id])}
                />
                {d.name}
              </label>
            )
          })}
        </div>
        <span className="text-ink-3 text-[12px]">{t('roomStores.holdersHint')}</span>
      </fieldset>
      <MsgFlash msg={msg} onClose={() => setMsg(null)} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={admin.save.isPending}>
          {t('prices.form.save')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('staff.form.cancel')}
        </Button>
      </div>
    </form>
  )
}

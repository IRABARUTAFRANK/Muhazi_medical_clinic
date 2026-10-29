import { isoDate } from '@mmc/shared'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DayRange } from './lab'
import { apiError, isMissingFunction, sampleRefusal } from './errors'
import {
  isRoomStore,
  sampleIsAdmin,
  sampleIsManager,
  sampleStock,
  sampleUserId,
  type StockLocationType,
  type StoreHolder,
} from './stock'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { sellValueOf, type SaleMode } from '@/lib/pack-pricing'

/**
 * Room stores (migration 0083): a doctor's office, the dental room, the maternity ward. The
 * pharmacy is the main store; the manager creates room stores and decides who holds them (named
 * staff and/or whole departments). Holders get "My store": they ask the pharmacy for a refill,
 * confirm what arrives on a transfer note, give medicines to patients from it ("given here",
 * charged to the visit's bill), count it, write stock off and return stock to the pharmacy.
 *
 * Live: my_stores, store_stock, save_room_store, assign_store_holder, unassign_store_holder,
 * set_store_holders, set_location_active, set_store_min, request_refill, refill_requests,
 * decline_refill, cancel_refill, send_to_room, return_to_pharmacy, confirm_receipt,
 * cancel_transfer, transfer_notes, transfer_note, room_store_summary, adjust_stock, use_stock.
 * On a database before 0083 the lists are empty (no room store feature yet).
 */

export type RoomStoreType = Extract<StockLocationType, 'room' | 'nursing' | 'lab' | 'theatre'>

/** A store I hold ("My store"). */
export interface MyStore {
  id: string
  name: string
  type: RoomStoreType
  active: boolean
  /** Held by me by name (else through a department). */
  personal: boolean
  /** My departments that hold it. */
  departments: string[]
  items: number
  units: number
  expiredUnits: number
  expiringUnits: number
  /** Medicines below the store's minimum. */
  low: number
  /** Transfer notes from the pharmacy waiting for my confirmation. */
  incoming: number
  /** Return notes on the way to the pharmacy. */
  returnsOnTheWay: number
  openRequests: number
}

export interface StoreBatch {
  batchId: string
  batchNo: string | null
  expiry: string | null
  quantity: number
  expired: boolean
  /** Pharmacy and manager only. */
  unitCost: number | null
}
export interface StoreStockItem {
  itemId: string
  item: string
  code: string
  unit: string | null
  packSize: number | null
  /** How it is sold, the pack's word and price (0107). */
  saleMode?: SaleMode | null
  packUnit?: string | null
  packPrice?: number | null
  /** The usable stock at selling price: whole packs at the pack price (0107). */
  sellValue?: number | null
  onHand: number
  usable: number
  expired: number
  expiringSoon: number
  earliestExpiry: string | null
  minLevel: number | null
  low: boolean
  price: number | null
  /** Pharmacy and manager only. */
  value: number | null
  batches: StoreBatch[]
}
export interface OnTheWayNote {
  id: string
  number: string
  direction: TransferDirection
  sentAt: string
  from: string
  to: string
  lines: number
  units: number
}
/** One store's stock, batch by batch. */
export interface StoreStock {
  store: {
    id: string
    name: string
    type: StockLocationType
    active: boolean
    isMain: boolean
    isRoom: boolean
    holders: StoreHolder[]
  }
  /** I hold it. */
  held: boolean
  /** I may count it and write stock off. */
  canManage: boolean
  items: StoreStockItem[]
  onTheWay: OnTheWayNote[]
  /** Pharmacy and manager only. */
  value: number | null
  /** The usable stock at selling price (0107): everyone who sees the store. */
  sellValue?: number | null
}

export type RefillStatus = 'open' | 'fulfilled' | 'declined' | 'cancelled'
export interface RefillRequest {
  id: string
  /** RQ-YYMMDD-NNN */
  number: string
  status: RefillStatus
  storeId: string
  store: string
  note: string | null
  at: string
  by: string | null
  mine: boolean
  decidedAt: string | null
  decidedBy: string | null
  declineReason: string | null
  transferId: string | null
  transferNumber: string | null
  lines: {
    itemId: string
    item: string
    unit: string | null
    quantity: number
    /** Unexpired units in the main pharmacy / in the store now. */
    inPharmacy: number
    inStore: number
    /** How it was typed, and the package (0107). */
    mode?: 'pieces' | 'packs' | null
    packSize?: number | null
    packUnit?: string | null
    saleMode?: SaleMode | null
  }[]
}

export type TransferDirection = 'to_room' | 'to_pharmacy'
export type TransferStatus = 'in_transit' | 'received' | 'cancelled'
/** A transfer note (T-…, pharmacy to a room store) or a return note (RT-…, back to the pharmacy). */
export interface TransferNote {
  id: string
  number: string
  direction: TransferDirection
  status: TransferStatus
  fromId: string
  from: string
  toId: string
  to: string
  sentAt: string
  sentBy: string | null
  receivedAt: string | null
  receivedBy: string | null
  cancelledAt: string | null
  cancelledBy: string | null
  cancelReason: string | null
  note: string | null
  receiveNote: string | null
  requestId: string | null
  requestNumber: string | null
  hasDifference: boolean
  /** Not on a single note's detail (its items are). */
  lines?: number
  units?: number
  /** Pharmacy and manager only. */
  value: number | null
  /** The value at selling price, as the lines were written (0107). */
  sellValue?: number | null
  /** I may confirm its receipt / cancel it now. */
  canReceive: boolean
  canCancel: boolean
}
export interface TransferNoteLine {
  lineId: string
  itemId: string
  item: string
  unit: string | null
  batchId: string
  batchNo: string | null
  expiry: string | null
  expired: boolean
  quantity: number
  /** Null until received. */
  received: number | null
  differenceAction: 'returned' | 'loss' | null
  differenceReason: string | null
  unitCost: number | null
  value: number | null
  /**
   * The package and the prices as they were when the line was written (0107): pieces in one pack,
   * the pack's word, how it was sold, typed in packs, the piece and pack prices, and the value
   * at selling price.
   */
  packSize?: number | null
  packUnit?: string | null
  saleMode?: SaleMode | null
  inPacks?: boolean
  unitPrice?: number | null
  packPrice?: number | null
  sellValue?: number | null
}
export interface TransferNoteDetail extends TransferNote {
  items: TransferNoteLine[]
}
export interface TransferTotals {
  id: string
  number: string
  direction: TransferDirection
  status: TransferStatus
  lines: number
  units: number
  value: number
  /** At selling price (0107). */
  sellValue?: number | null
}
export interface ReceiptResult {
  id: string
  number: string
  status: 'received'
  received: number
  returned: number
  lost: number
}

/** What a room store did in a period (values: pharmacy and manager only). */
export interface RoomStoreSummary {
  store: {
    id: string
    name: string
    type: StockLocationType
    active: boolean
    holders: StoreHolder[]
  }
  from: string
  to: string
  stock: { units: number; expiredUnits: number; value: number | null }
  given: {
    lines: number
    patients: number
    units: number
    value: number | null
    /** What was put on the patients' bills. */
    charged: number
  }
  received: { notes: number; units: number; value: number | null }
  returned: { notes: number; units: number; value: number | null }
  losses: {
    writtenOff: number
    writtenOffValue: number | null
    countDown: number
    countUp: number
    countValue: number | null
  }
  items: {
    itemId: string
    item: string
    given: number
    received: number
    returned: number
    writtenOff: number
    countDiff: number
    onHand: number
  }[]
}

export interface NoteLineInput {
  itemId: string
  /** Always in pieces. */
  quantity: number
  /** How it was typed (0107): the note shows "4 boxes of 8" when typed in packs. */
  mode?: 'pieces' | 'packs'
  /** A pack-only medicine sent in pieces: "split a pack" (the pharmacy only). */
  split?: boolean
}
export interface ReceiptLineInput {
  lineId: string
  /** The quantity that really arrived. */
  received: number
  /** Required when it differs from what was sent. */
  reason?: string
  /** The difference goes back to the sender, or is recorded as a loss. */
  action?: 'returned' | 'loss'
}

// ---------------------------------------------------------------- sample mode
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const today = () => new Date().toISOString().slice(0, 10)
const dayCode = () => new Date().toISOString().slice(2, 10).replace(/-/g, '')
const me = () => useSession.getState().user?.name ?? null

const sampleRequests: RefillRequest[] = [
  {
    id: 'rq-1',
    number: `RQ-${dayCode()}-001`,
    status: 'open',
    storeId: 'l-cons',
    store: 'Dr. Mukamana’s office',
    note: 'For the week',
    at: ago(45),
    by: 'Dr. Mukamana Béatrice',
    mine: false,
    decidedAt: null,
    decidedBy: null,
    declineReason: null,
    transferId: null,
    transferNumber: null,
    lines: [
      {
        itemId: 'it-2',
        item: 'Paracetamol 500 mg',
        unit: 'tab',
        quantity: 100,
        inPharmacy: 500,
        inStore: 0,
      },
    ],
  },
]
const sampleNotes: TransferNoteDetail[] = [
  {
    id: 'tn-1',
    number: `T-${dayCode()}-001`,
    direction: 'to_room',
    status: 'received',
    fromId: 'l-pharm',
    from: 'Pharmacy',
    toId: 'l-cons',
    to: 'Dr. Mukamana’s office',
    sentAt: ago(120),
    sentBy: 'Mugabo Théogène',
    receivedAt: ago(100),
    receivedBy: 'Dr. Mukamana Béatrice',
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    note: null,
    receiveNote: null,
    requestId: null,
    requestNumber: null,
    hasDifference: false,
    value: 4800,
    canReceive: false,
    canCancel: false,
    items: [
      {
        lineId: 'tl-1',
        itemId: 'it-1',
        item: 'Amoxicillin 500 mg',
        unit: 'cap',
        batchId: 'b-it-1',
        batchNo: 'B261020-001',
        expiry: '2027-06-30',
        expired: false,
        quantity: 40,
        received: 40,
        differenceAction: null,
        differenceReason: null,
        unitCost: 120,
        value: 4800,
      },
    ],
  },
]
const storeName = (id: string) => sampleStock.locations.find((l) => l.id === id)?.name ?? ''
const holdersOf = (id: string): StoreHolder[] => sampleStock.holdersOf(id)
const mayReceive = (n: TransferNote) =>
  n.status === 'in_transit' &&
  (n.direction === 'to_room' ? sampleIsManager() || sampleStock.holds(n.toId) : sampleIsAdmin())
const mayCancel = (n: TransferNote) =>
  n.status === 'in_transit' &&
  (n.direction === 'to_room' ? sampleIsAdmin() : sampleIsManager() || sampleStock.holds(n.fromId))
const withRights = (n: TransferNoteDetail): TransferNoteDetail => ({
  ...n,
  lines: new Set(n.items.map((i) => i.itemId)).size,
  units: n.items.reduce((s, i) => s + i.quantity, 0),
  canReceive: mayReceive(n),
  canCancel: mayCancel(n),
  value: sampleIsAdmin() ? n.value : null,
})
const totals = (n: TransferNoteDetail): TransferTotals => ({
  id: n.id,
  number: n.number,
  direction: n.direction,
  status: n.status,
  lines: new Set(n.items.map((i) => i.itemId)).size,
  units: n.items.reduce((s, i) => s + i.quantity, 0),
  value: n.items.reduce((s, i) => s + (i.value ?? 0), 0),
  sellValue: n.items.reduce((s, i) => s + (i.sellValue ?? 0), 0),
})
const sampleMayWork = (locationId: string) => sampleIsManager() || sampleStock.holds(locationId)

function sampleMyStores(): MyStore[] {
  const uid = sampleUserId()
  return sampleStock.locations
    .filter((l) => l.active !== false && isRoomStore(l) && sampleStock.holds(l.id))
    .map((l) => {
      const items = sampleStock.items.filter((i) => (i.byLocation[l.id] ?? 0) > 0)
      return {
        id: l.id,
        name: l.name,
        type: l.type as RoomStoreType,
        active: l.active !== false,
        personal: sampleStock.holders.some((h) => h.locationId === l.id && h.profileId === uid),
        departments: [],
        items: items.length,
        units: items.reduce((s, i) => s + (i.byLocation[l.id] ?? 0), 0),
        expiredUnits: 0,
        expiringUnits: 0,
        low: 0,
        incoming: sampleNotes.filter((n) => n.toId === l.id && n.status === 'in_transit').length,
        returnsOnTheWay: sampleNotes.filter(
          (n) => n.fromId === l.id && n.direction === 'to_pharmacy' && n.status === 'in_transit',
        ).length,
        openRequests: sampleRequests.filter((r) => r.storeId === l.id && r.status === 'open')
          .length,
      }
    })
}

function sampleStoreStock(id: string): StoreStock {
  const l = sampleStock.locations.find((x) => x.id === id)
  if (!l) throw sampleRefusal('notFound', 'P0002')
  const admin = sampleIsAdmin()
  const held = sampleStock.holds(id)
  if (!admin && !held) throw sampleRefusal('notHolder', '42501')
  const items: StoreStockItem[] = sampleStock.items
    .filter((i) => (i.byLocation[id] ?? 0) > 0)
    .map((i) => {
      const q = i.byLocation[id] ?? 0
      return {
        itemId: i.id,
        item: sampleStock.label(i.id),
        code: i.code,
        unit: i.unit,
        packSize: i.packSize ?? null,
        saleMode: i.saleMode ?? null,
        packUnit: i.packUnit ?? null,
        packPrice: i.packPrice ?? null,
        sellValue: Math.round(sellValueOf(i, q)),
        onHand: q,
        usable: q,
        expired: 0,
        expiringSoon: 0,
        earliestExpiry: i.earliestExpiry,
        minLevel: null,
        low: false,
        price: i.sellingPrice,
        value: admin ? q * (i.avgCost ?? 0) : null,
        batches: [
          {
            batchId: `b-${i.id}`,
            batchNo: sampleStock.batchNo[i.id] ?? null,
            expiry: i.earliestExpiry,
            quantity: q,
            expired: false,
            unitCost: admin ? i.avgCost : null,
          },
        ],
      }
    })
  return {
    store: {
      id: l.id,
      name: l.name,
      type: l.type,
      active: l.active !== false,
      isMain: !!l.isMain,
      isRoom: isRoomStore(l),
      holders: holdersOf(l.id),
    },
    held,
    canManage: sampleIsManager() || (isRoomStore(l) ? held : admin),
    items,
    onTheWay: sampleNotes
      .filter((n) => n.status === 'in_transit' && (n.toId === id || n.fromId === id))
      .map((n) => ({
        id: n.id,
        number: n.number,
        direction: n.direction,
        sentAt: n.sentAt,
        from: n.from,
        to: n.to,
        lines: totals(n).lines,
        units: totals(n).units,
      })),
    value: admin ? items.reduce((s, i) => s + (i.value ?? 0), 0) : null,
    sellValue: items.reduce((s, i) => s + (i.sellValue ?? 0), 0),
  }
}

function sampleNote(
  direction: TransferDirection,
  from: string,
  to: string,
  lines: NoteLineInput[],
  note?: string,
  requestId?: string | null,
): TransferNoteDetail {
  const n: TransferNoteDetail = {
    id: `tn-${Date.now()}`,
    number: `${direction === 'to_room' ? 'T' : 'RT'}-${dayCode()}-${String(sampleNotes.length + 1).padStart(3, '0')}`,
    direction,
    status: 'in_transit',
    fromId: from,
    from: storeName(from),
    toId: to,
    to: storeName(to),
    sentAt: new Date().toISOString(),
    sentBy: me(),
    receivedAt: null,
    receivedBy: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    note: note?.trim() || null,
    receiveNote: null,
    requestId: requestId ?? null,
    requestNumber: sampleRequests.find((r) => r.id === requestId)?.number ?? null,
    hasDifference: false,
    value: 0,
    canReceive: false,
    canCancel: false,
    items: lines.map((x, k) => {
      const it = sampleStock.items.find((i) => i.id === x.itemId)
      if (sampleStock.usable(x.itemId, from) < x.quantity) throw sampleRefusal('short', '23514')
      // the units leave the sender at once: they are on the way
      sampleStock.move(x.itemId, from, null, x.quantity)
      return {
        lineId: `tl-${Date.now()}-${k}`,
        itemId: x.itemId,
        item: sampleStock.label(x.itemId),
        unit: it?.unit ?? null,
        batchId: `b-${x.itemId}`,
        batchNo: sampleStock.batchNo[x.itemId] ?? null,
        expiry: it?.earliestExpiry ?? null,
        expired: false,
        quantity: x.quantity,
        received: null,
        differenceAction: null,
        differenceReason: null,
        unitCost: it?.avgCost ?? null,
        value: x.quantity * (it?.avgCost ?? 0),
        // the package and the prices of the day (0107)
        packSize: it?.packSize && it.packSize >= 2 ? it.packSize : null,
        packUnit: it?.packUnit ?? null,
        saleMode: it?.saleMode ?? 'piece',
        inPacks: x.mode === 'packs',
        unitPrice: it?.sellingPrice ?? null,
        packPrice: it?.saleMode && it.saleMode !== 'piece' ? (it.packPrice ?? null) : null,
        sellValue: Math.round(sellValueOf(it, x.quantity)),
      }
    }),
  }
  n.value = n.items.reduce((s, i) => s + (i.value ?? 0), 0)
  n.sellValue = n.items.reduce((s, i) => s + (i.sellValue ?? 0), 0)
  sampleNotes.unshift(n)
  return n
}

// ---------------------------------------------------------------- reading
const KEY = ['stock', 'rooms'] as const
const num = (v: unknown, fallback = 0): number =>
  v == null || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v)
const numOrNull = (v: unknown): number | null =>
  v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v)

/** The room stores I hold ("My store"); empty for everyone else and on an old database. */
export function useMyStores(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'mine', sampleUserId()],
    enabled,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<MyStore[]> => {
      if (!supabase) return sampleMyStores()
      const { data, error } = await supabase.rpc('my_stores')
      if (error) {
        if (isMissingFunction(error)) return []
        throw apiError(error)
      }
      return ((data ?? []) as MyStore[]).map((s) => ({
        ...s,
        departments: s.departments ?? [],
        items: num(s.items),
        units: num(s.units),
        expiredUnits: num(s.expiredUnits),
        expiringUnits: num(s.expiringUnits),
        low: num(s.low),
        incoming: num(s.incoming),
        returnsOnTheWay: num(s.returnsOnTheWay),
        openRequests: num(s.openRequests),
      }))
    },
  })
}

/**
 * Whether I hold a room store: the "My store" menu entry and page, and "Given here" when
 * prescribing (the manager may give from any room store without holding one).
 */
export function useHoldsStore() {
  const q = useMyStores()
  const stores = q.data ?? []
  return { holds: stores.length > 0, stores, isLoading: q.isLoading }
}

/** One store's stock, batch by batch (store_stock). */
async function fetchStoreStock(locationId: string): Promise<StoreStock> {
  if (!supabase) return sampleStoreStock(locationId)
  const { data, error } = await supabase.rpc('store_stock', { p_location_id: locationId })
  if (error) throw apiError(error)
  const d = data as StoreStock
  return {
    ...d,
    store: { ...d.store, holders: d.store.holders ?? [] },
    value: numOrNull(d.value),
    sellValue: numOrNull(d.sellValue),
    items: (d.items ?? []).map((i) => ({
      ...i,
      packSize: numOrNull(i.packSize),
      packPrice: numOrNull(i.packPrice),
      sellValue: numOrNull(i.sellValue),
      onHand: num(i.onHand),
      usable: num(i.usable),
      expired: num(i.expired),
      expiringSoon: num(i.expiringSoon),
      minLevel: numOrNull(i.minLevel),
      price: numOrNull(i.price),
      value: numOrNull(i.value),
      batches: (i.batches ?? []).map((b) => ({
        ...b,
        quantity: num(b.quantity),
        unitCost: numOrNull(b.unitCost),
      })),
    })),
    onTheWay: (d.onTheWay ?? []).map((n) => ({
      ...n,
      lines: num(n.lines),
      units: num(n.units),
    })),
  }
}

const storeStockQuery = (locationId: string | null) => ({
  queryKey: [...KEY, 'store', locationId] as const,
  enabled: !!locationId,
  refetchInterval: 60_000,
  queryFn: () => fetchStoreStock(locationId!),
})

/** One store's stock, batch by batch (its holders, the pharmacy, the manager). */
export function useStoreStock(locationId: string | null) {
  return useQuery(storeStockQuery(locationId))
}

/** One item's batches in a store. */
export interface ItemStoreBatches {
  storeId: string
  store: string
  isRoom: boolean
  batches: StoreBatch[]
}

/**
 * One item's batches in each of the given stores (the stock page's item panel), from the same
 * cache as each store's stock: stores where the item has none are left out.
 */
export function useItemBatches(itemId: string | null, locationIds: readonly string[]) {
  const results = useQueries({
    queries: locationIds.map((id) => ({ ...storeStockQuery(itemId ? id : null) })),
  })
  const stores: ItemStoreBatches[] = []
  for (const r of results) {
    const d = r.data
    const it = d?.items.find((x) => x.itemId === itemId)
    if (!d || !it || it.batches.length === 0) continue
    stores.push({
      storeId: d.store.id,
      store: d.store.name,
      isRoom: d.store.isRoom,
      batches: it.batches,
    })
  }
  return {
    stores,
    isLoading: results.some((r) => r.isLoading),
    error: results.find((r) => r.error)?.error ?? null,
  }
}

/** Refill requests: the pharmacy and the manager see all, holders those of their stores. */
export function useRefillRequests(
  status: RefillStatus | null = null,
  locationId: string | null = null,
) {
  return useQuery({
    queryKey: [...KEY, 'requests', status, locationId],
    refetchInterval: 30_000,
    queryFn: async (): Promise<RefillRequest[]> => {
      if (!supabase)
        return sampleRequests.filter(
          (r) =>
            (!status || r.status === status) &&
            (!locationId || r.storeId === locationId) &&
            (sampleIsAdmin() || sampleStock.holds(r.storeId)),
        )
      const { data, error } = await supabase.rpc('refill_requests', {
        p_status: status,
        p_location_id: locationId,
      })
      if (error) {
        if (isMissingFunction(error)) return []
        throw apiError(error)
      }
      return ((data ?? []) as RefillRequest[]).map((r) => ({
        ...r,
        lines: (r.lines ?? []).map((l) => ({
          ...l,
          quantity: num(l.quantity),
          inPharmacy: num(l.inPharmacy),
          inStore: num(l.inStore),
        })),
      }))
    },
  })
}

export interface TransferNotesFilter {
  status?: TransferStatus | null
  locationId?: string | null
  from?: string | null
  to?: string | null
}

const toNote = <T extends TransferNote>(n: T): T => ({
  ...n,
  lines: n.lines == null ? undefined : num(n.lines),
  units: n.units == null ? undefined : num(n.units),
  value: numOrNull(n.value),
  sellValue: numOrNull(n.sellValue),
  hasDifference: !!n.hasDifference,
})

/** Transfer and return notes (at most 300, open ones first). */
export function useTransferNotes(f: TransferNotesFilter = {}) {
  return useQuery({
    queryKey: [
      ...KEY,
      'notes',
      f.status ?? null,
      f.locationId ?? null,
      f.from ?? null,
      f.to ?? null,
    ],
    refetchInterval: 30_000,
    queryFn: async (): Promise<TransferNote[]> => {
      if (!supabase)
        return sampleNotes
          .filter(
            (n) =>
              (!f.status || n.status === f.status) &&
              (!f.locationId || n.fromId === f.locationId || n.toId === f.locationId) &&
              (!f.from || isoDate(new Date(n.sentAt)) >= f.from) &&
              (!f.to || isoDate(new Date(n.sentAt)) <= f.to) &&
              (sampleIsAdmin() || sampleStock.holds(n.fromId) || sampleStock.holds(n.toId)),
          )
          .map((n) => {
            // the list carries no lines (a note's detail does)
            const row: TransferNote & { items?: TransferNoteLine[] } = withRights(n)
            delete row.items
            return row
          })
          .sort((a, b) => Number(b.status === 'in_transit') - Number(a.status === 'in_transit'))
      const { data, error } = await supabase.rpc('transfer_notes', {
        p_status: f.status ?? null,
        p_location_id: f.locationId ?? null,
        p_from: f.from ?? null,
        p_to: f.to ?? null,
      })
      if (error) {
        if (isMissingFunction(error)) return []
        throw apiError(error)
      }
      return ((data ?? []) as TransferNote[]).map(toNote)
    },
  })
}

/** One note, line by line with batch and expiry (the screen and the printed note). */
export function useTransferNote(id: string | null) {
  return useQuery({
    queryKey: [...KEY, 'note', id],
    enabled: !!id,
    queryFn: async (): Promise<TransferNoteDetail | null> => {
      if (!supabase) {
        const n = sampleNotes.find((x) => x.id === id)
        return n ? withRights(n) : null
      }
      const { data, error } = await supabase.rpc('transfer_note', { p_id: id })
      if (error) throw apiError(error)
      if (!data) return null
      const n = toNote(data as TransferNoteDetail)
      return {
        ...n,
        items: (n.items ?? []).map((l) => ({
          ...l,
          quantity: num(l.quantity),
          received: numOrNull(l.received),
          unitCost: numOrNull(l.unitCost),
          value: numOrNull(l.value),
          packSize: numOrNull(l.packSize),
          unitPrice: numOrNull(l.unitPrice),
          packPrice: numOrNull(l.packPrice),
          sellValue: numOrNull(l.sellValue),
          inPacks: !!l.inPacks,
        })),
      }
    },
  })
}

/** What a room store did in a period (default this month): given, received, returned, losses. */
export function useRoomStoreSummary(storeId: string | null, period?: DayRange | null) {
  return useQuery({
    queryKey: [...KEY, 'summary', storeId, period?.from ?? null, period?.to ?? null],
    enabled: !!storeId,
    queryFn: async (): Promise<RoomStoreSummary> => {
      if (!supabase) {
        const s = sampleStoreStock(storeId!)
        const admin = sampleIsAdmin()
        return {
          store: {
            id: s.store.id,
            name: s.store.name,
            type: s.store.type,
            active: s.store.active,
            holders: s.store.holders,
          },
          from: period?.from ?? `${today().slice(0, 8)}01`,
          to: period?.to ?? today(),
          stock: {
            units: s.items.reduce((t, i) => t + i.onHand, 0),
            expiredUnits: 0,
            value: s.value,
          },
          given: { lines: 3, patients: 3, units: 21, value: admin ? 2520 : null, charged: 6300 },
          received: { notes: 1, units: 40, value: admin ? 4800 : null },
          returned: { notes: 0, units: 0, value: admin ? 0 : null },
          losses: {
            writtenOff: 0,
            writtenOffValue: admin ? 0 : null,
            countDown: 0,
            countUp: 0,
            countValue: admin ? 0 : null,
          },
          items: s.items.map((i) => ({
            itemId: i.itemId,
            item: i.item,
            given: 21,
            received: 40,
            returned: 0,
            writtenOff: 0,
            countDiff: 0,
            onHand: i.onHand,
          })),
        }
      }
      const { data, error } = await supabase.rpc('room_store_summary', {
        p_store: storeId,
        p_from: period?.from ?? null,
        p_to: period?.to ?? null,
      })
      if (error) throw apiError(error)
      const d = data as RoomStoreSummary
      return {
        ...d,
        store: { ...d.store, holders: d.store.holders ?? [] },
        stock: {
          units: num(d.stock?.units),
          expiredUnits: num(d.stock?.expiredUnits),
          value: numOrNull(d.stock?.value),
        },
        given: {
          lines: num(d.given?.lines),
          patients: num(d.given?.patients),
          units: num(d.given?.units),
          value: numOrNull(d.given?.value),
          charged: num(d.given?.charged),
        },
        received: {
          notes: num(d.received?.notes),
          units: num(d.received?.units),
          value: numOrNull(d.received?.value),
        },
        returned: {
          notes: num(d.returned?.notes),
          units: num(d.returned?.units),
          value: numOrNull(d.returned?.value),
        },
        losses: {
          writtenOff: num(d.losses?.writtenOff),
          writtenOffValue: numOrNull(d.losses?.writtenOffValue),
          countDown: num(d.losses?.countDown),
          countUp: num(d.losses?.countUp),
          countValue: numOrNull(d.losses?.countValue),
        },
        items: (d.items ?? []).map((i) => ({
          ...i,
          given: num(i.given),
          received: num(i.received),
          returned: num(i.returned),
          writtenOff: num(i.writtenOff),
          countDiff: num(i.countDiff),
          onHand: num(i.onHand),
        })),
      }
    },
  })
}

// ---------------------------------------------------------------- actions
function useRefresh() {
  const qc = useQueryClient()
  return () => {
    // every stock figure (the overview, the desk, the room stores) and the notices
    void qc.invalidateQueries({ queryKey: ['stock'] })
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase!.rpc(fn, args)
  if (error) throw apiError(error)
  return data as T
}

/**
 * The manager's room-store admin: create or rename a room store and name who holds it (staff
 * and/or departments), add or remove one holder, close (empty, nothing on the way) and reopen.
 */
export function useRoomStoreAdmin() {
  const refresh = useRefresh()
  /** Creates (no id) or changes a room store; given lists replace its holders. */
  const save = useMutation({
    mutationFn: async (i: {
      id?: string | null
      name: string
      type?: RoomStoreType
      staff?: string[] | null
      departments?: string[] | null
    }): Promise<string> => {
      if (!supabase) {
        if (!sampleIsManager()) throw sampleRefusal('notHolder', '42501')
        let id = i.id ?? null
        if (id) {
          const l = sampleStock.locations.find((x) => x.id === id)
          if (l) {
            l.name = i.name.trim()
            l.type = i.type ?? l.type
          }
        } else {
          id = `l-${Math.random().toString(36).slice(2, 7)}`
          sampleStock.locations.push({
            id,
            name: i.name.trim(),
            type: i.type ?? 'room',
            department: null,
            active: true,
          })
        }
        if (i.staff || i.departments) {
          for (let k = sampleStock.holders.length - 1; k >= 0; k--)
            if (sampleStock.holders[k]!.locationId === id) sampleStock.holders.splice(k, 1)
          for (const p of i.staff ?? [])
            sampleStock.holders.push({
              id: `h-${Date.now()}-${p}`,
              locationId: id,
              profileId: p,
              name: p,
              role: null,
              departmentId: null,
              department: null,
            })
          for (const d of i.departments ?? [])
            sampleStock.holders.push({
              id: `h-${Date.now()}-${d}`,
              locationId: id,
              profileId: null,
              name: null,
              role: null,
              departmentId: d,
              department: d,
            })
        }
        return id
      }
      return rpc<string>('save_room_store', {
        p_id: i.id ?? null,
        p_name: i.name.trim(),
        p_type: i.type ?? 'room',
        p_staff: i.staff ?? null,
        p_departments: i.departments ?? null,
      })
    },
    onSuccess: refresh,
  })
  /** One holder more: a person or a department (they are told). */
  const assignHolder = useMutation({
    mutationFn: async (i: {
      locationId: string
      profileId?: string | null
      departmentId?: string | null
    }): Promise<string> => {
      if (!supabase) {
        const id = `h-${Date.now()}`
        sampleStock.holders.push({
          id,
          locationId: i.locationId,
          profileId: i.profileId ?? null,
          name: i.profileId ?? null,
          role: null,
          departmentId: i.departmentId ?? null,
          department: i.departmentId ?? null,
        })
        return id
      }
      return rpc<string>('assign_store_holder', {
        p_location_id: i.locationId,
        p_profile_id: i.profileId ?? null,
        p_department_id: i.departmentId ?? null,
      })
    },
    onSuccess: refresh,
  })
  const unassignHolder = useMutation({
    mutationFn: async (holderId: string) => {
      if (!supabase) {
        const k = sampleStock.holders.findIndex((h) => h.id === holderId)
        if (k >= 0) sampleStock.holders.splice(k, 1)
        return
      }
      await rpc('unassign_store_holder', { p_holder_id: holderId })
    },
    onSuccess: refresh,
  })
  /** The whole list of holders at once: those left out stop holding the store. */
  const setHolders = useMutation({
    mutationFn: async (i: {
      locationId: string
      staff: string[]
      departments: string[]
    }): Promise<StoreHolder[]> => {
      if (!supabase) {
        for (let k = sampleStock.holders.length - 1; k >= 0; k--)
          if (sampleStock.holders[k]!.locationId === i.locationId) sampleStock.holders.splice(k, 1)
        for (const p of i.staff)
          sampleStock.holders.push({
            id: `h-${Date.now()}-${p}`,
            locationId: i.locationId,
            profileId: p,
            name: p,
            role: null,
            departmentId: null,
            department: null,
          })
        for (const d of i.departments)
          sampleStock.holders.push({
            id: `h-${Date.now()}-${d}`,
            locationId: i.locationId,
            profileId: null,
            name: null,
            role: null,
            departmentId: d,
            department: d,
          })
        return holdersOf(i.locationId)
      }
      return (
        (await rpc<StoreHolder[] | null>('set_store_holders', {
          p_location_id: i.locationId,
          p_staff: i.staff,
          p_departments: i.departments,
        })) ?? []
      )
    },
    onSuccess: refresh,
  })
  /** Close (empty and nothing on the way; its open refill requests are cancelled) or reopen. */
  const setActive = useMutation({
    mutationFn: async (i: { id: string; active: boolean }) => {
      if (!supabase) {
        const l = sampleStock.locations.find((x) => x.id === i.id)
        if (l) {
          if (!i.active && sampleStock.items.some((x) => (x.byLocation[l.id] ?? 0) > 0))
            throw sampleRefusal('storeHasStock', '23514')
          l.active = i.active
        }
        return
      }
      await rpc('set_location_active', { p_id: i.id, p_active: i.active })
    },
    onSuccess: refresh,
  })
  return { save, assignHolder, unassignHolder, setHolders, setActive }
}

/**
 * Supplying and using room stores: refill requests (holders), transfer notes (the pharmacy
 * sends; holders confirm what arrived), return notes (holders send back; the pharmacy confirms),
 * cancelling a note on the way, the store's minimums, counts and write-offs.
 */
export function useRoomStoreActions() {
  const refresh = useRefresh()
  /** A holder asks the pharmacy for medicines (RQ-…; the pharmacy is told). */
  const requestRefill = useMutation({
    mutationFn: async (i: {
      locationId: string
      lines: NoteLineInput[]
      note?: string
    }): Promise<{ id: string; number: string; lines: number }> => {
      if (!supabase) {
        if (!sampleMayWork(i.locationId)) throw sampleRefusal('notHolder', '42501')
        const r: RefillRequest = {
          id: `rq-${Date.now()}`,
          number: `RQ-${dayCode()}-${String(sampleRequests.length + 1).padStart(3, '0')}`,
          status: 'open',
          storeId: i.locationId,
          store: storeName(i.locationId),
          note: i.note?.trim() || null,
          at: new Date().toISOString(),
          by: me(),
          mine: true,
          decidedAt: null,
          decidedBy: null,
          declineReason: null,
          transferId: null,
          transferNumber: null,
          lines: i.lines.map((l) => {
            const it = sampleStock.items.find((x) => x.id === l.itemId)
            return {
              itemId: l.itemId,
              item: sampleStock.label(l.itemId),
              unit: it?.unit ?? null,
              quantity: l.quantity,
              mode: l.mode ?? 'pieces',
              packSize: it?.packSize ?? null,
              packUnit: it?.packUnit ?? null,
              saleMode: it?.saleMode ?? null,
              inPharmacy: sampleStock.usable(l.itemId, 'l-pharm'),
              inStore: sampleStock.usable(l.itemId, i.locationId),
            }
          }),
        }
        sampleRequests.unshift(r)
        return { id: r.id, number: r.number, lines: r.lines.length }
      }
      const d = await rpc<{ id: string; number: string; lines: number }>('request_refill', {
        p_location_id: i.locationId,
        p_lines: i.lines,
        p_note: i.note?.trim() || null,
      })
      return { ...d, lines: num(d.lines) }
    },
    onSuccess: refresh,
  })
  /** The pharmacy (or the manager) declines a request with a reason; the requester is told. */
  const declineRefill = useMutation({
    mutationFn: async (i: { requestId: string; reason: string }) => {
      if (!supabase) {
        const r = sampleRequests.find((x) => x.id === i.requestId)
        if (r)
          Object.assign(r, {
            status: 'declined',
            declineReason: i.reason.trim(),
            decidedAt: new Date().toISOString(),
            decidedBy: me(),
          })
        return
      }
      await rpc('decline_refill', { p_request_id: i.requestId, p_reason: i.reason.trim() })
    },
    onSuccess: refresh,
  })
  /** The requester (a holder, or the manager) withdraws an open request. */
  const cancelRefill = useMutation({
    mutationFn: async (requestId: string) => {
      if (!supabase) {
        const r = sampleRequests.find((x) => x.id === requestId)
        if (r) r.status = 'cancelled'
        return
      }
      await rpc('cancel_refill', { p_request_id: requestId })
    },
    onSuccess: refresh,
  })
  /**
   * The pharmacy sends medicines to a room store (T-YYMMDD-NNN): batches earliest expiry first,
   * never expired; the units leave the pharmacy at once and are on the way until the holder
   * confirms. With `requestId` the request becomes fulfilled.
   */
  const sendToRoom = useMutation({
    mutationFn: async (i: {
      locationId: string
      lines: NoteLineInput[]
      requestId?: string | null
      note?: string
      fromLocationId?: string | null
    }): Promise<TransferTotals> => {
      if (!supabase) {
        if (!sampleIsAdmin()) throw sampleRefusal('notHolder', '42501')
        const n = sampleNote(
          'to_room',
          i.fromLocationId ?? 'l-pharm',
          i.locationId,
          i.lines,
          i.note,
          i.requestId,
        )
        const r = sampleRequests.find((x) => x.id === i.requestId)
        if (r)
          Object.assign(r, {
            status: 'fulfilled',
            transferId: n.id,
            transferNumber: n.number,
            decidedAt: n.sentAt,
            decidedBy: me(),
          })
        return totals(n)
      }
      const d = await rpc<TransferTotals>('send_to_room', {
        p_location_id: i.locationId,
        p_lines: i.lines,
        p_request_id: i.requestId ?? null,
        p_note: i.note?.trim() || null,
        p_from_location_id: i.fromLocationId ?? null,
      })
      return {
        ...d,
        lines: num(d.lines),
        units: num(d.units),
        value: num(d.value),
        sellValue: numOrNull(d.sellValue),
      }
    },
    onSuccess: refresh,
  })
  /**
   * A holder returns stock to the pharmacy (RT-YYMMDD-NNN): the lines given, or everything in
   * the store (before it closes) when no lines are given. The pharmacy confirms it.
   */
  const returnToPharmacy = useMutation({
    mutationFn: async (i: {
      locationId: string
      lines?: NoteLineInput[] | null
      note?: string
    }): Promise<TransferTotals> => {
      if (!supabase) {
        if (!sampleMayWork(i.locationId)) throw sampleRefusal('notHolder', '42501')
        const lines =
          i.lines ??
          sampleStock.items
            .filter((x) => (x.byLocation[i.locationId] ?? 0) > 0)
            .map((x) => ({ itemId: x.id, quantity: x.byLocation[i.locationId]! }) as NoteLineInput)
        return totals(sampleNote('to_pharmacy', i.locationId, 'l-pharm', lines, i.note))
      }
      const d = await rpc<TransferTotals>('return_to_pharmacy', {
        p_location_id: i.locationId,
        p_lines: i.lines ?? null,
        p_note: i.note?.trim() || null,
      })
      return { ...d, lines: num(d.lines), units: num(d.units), value: num(d.value) }
    },
    onSuccess: refresh,
  })
  /**
   * The receiver confirms: everything as sent (no lines), or line by line with the quantity that
   * arrived; a difference needs a reason and goes back to the sender or is a loss (the manager
   * and the pharmacy are told). Only then is the stock in the receiving store.
   */
  const confirmReceipt = useMutation({
    mutationFn: async (i: {
      transferId: string
      lines?: ReceiptLineInput[] | null
      note?: string
    }): Promise<ReceiptResult> => {
      if (!supabase) {
        const n = sampleNotes.find((x) => x.id === i.transferId)
        if (!n || n.status !== 'in_transit') throw sampleRefusal('alreadyDone', '23505')
        let received = 0
        let returned = 0
        let lost = 0
        for (const l of n.items) {
          const given = i.lines?.find((x) => x.lineId === l.lineId)
          const got = given ? given.received : l.quantity
          const diff = l.quantity - got
          if (diff !== 0 && !given?.reason?.trim()) throw sampleRefusal('differenceReason', '22023')
          l.received = got
          sampleStock.move(l.itemId, null, n.toId, got)
          received += got
          if (diff > 0) {
            l.differenceAction = given?.action ?? 'returned'
            l.differenceReason = given?.reason?.trim() ?? null
            if (l.differenceAction === 'returned') {
              sampleStock.move(l.itemId, null, n.fromId, diff)
              returned += diff
            } else lost += diff
          }
        }
        Object.assign(n, {
          status: 'received',
          receivedAt: new Date().toISOString(),
          receivedBy: me(),
          receiveNote: i.note?.trim() || null,
          hasDifference: returned + lost > 0,
        })
        return { id: n.id, number: n.number, status: 'received', received, returned, lost }
      }
      const d = await rpc<ReceiptResult>('confirm_receipt', {
        p_transfer_id: i.transferId,
        p_lines: i.lines
          ? i.lines.map((l) => ({
              lineId: l.lineId,
              received: l.received,
              reason: l.reason?.trim() || null,
              action: l.action ?? null,
            }))
          : null,
        p_note: i.note?.trim() || null,
      })
      return {
        ...d,
        received: num(d.received),
        returned: num(d.returned),
        lost: num(d.lost),
      }
    },
    onSuccess: refresh,
  })
  /** A note not yet received is cancelled: every unit goes back where it came from. */
  const cancelTransfer = useMutation({
    mutationFn: async (i: {
      transferId: string
      reason: string
    }): Promise<{ id: string; number: string; status: 'cancelled'; units: number }> => {
      if (!supabase) {
        const n = sampleNotes.find((x) => x.id === i.transferId)
        if (!n || n.status !== 'in_transit') throw sampleRefusal('alreadyDone', '23505')
        for (const l of n.items) sampleStock.move(l.itemId, null, n.fromId, l.quantity)
        Object.assign(n, {
          status: 'cancelled',
          cancelledAt: new Date().toISOString(),
          cancelledBy: me(),
          cancelReason: i.reason.trim(),
        })
        const r = sampleRequests.find((x) => x.transferId === n.id)
        if (r) Object.assign(r, { status: 'open', transferId: null, transferNumber: null })
        return { id: n.id, number: n.number, status: 'cancelled', units: totals(n).units }
      }
      const d = await rpc<{ id: string; number: string; status: 'cancelled'; units: number }>(
        'cancel_transfer',
        { p_transfer_id: i.transferId, p_reason: i.reason.trim() },
      )
      return { ...d, units: num(d.units) }
    },
    onSuccess: refresh,
  })
  /** The minimum a room store keeps of a medicine (0 or null: none); holders are told below it. */
  const setStoreMin = useMutation({
    mutationFn: async (i: { locationId: string; itemId: string; min: number | null }) => {
      if (!supabase) return
      await rpc('set_store_min', {
        p_location_id: i.locationId,
        p_item_id: i.itemId,
        p_min: i.min ?? null,
      })
    },
    onSuccess: refresh,
  })
  /** The holder counted the shelf: the store's stock becomes that count (reason kept). */
  const count = useMutation({
    mutationFn: async (i: {
      locationId: string
      itemId: string
      counted: number
      reason: string
    }) => {
      if (!supabase) {
        if (!sampleMayWork(i.locationId)) throw sampleRefusal('notHolder', '42501')
        const before = sampleStock.usable(i.itemId, i.locationId)
        sampleStock.move(i.itemId, i.locationId, null, before - i.counted)
        return
      }
      await rpc('adjust_stock', {
        p_item_id: i.itemId,
        p_location_id: i.locationId,
        p_counted: i.counted,
        p_reason: i.reason.trim(),
      })
    },
    onSuccess: refresh,
  })
  /** Stock written off (expired, damaged…) with a reason of at least 3 characters. */
  const writeOff = useMutation({
    mutationFn: async (i: {
      locationId: string
      itemId: string
      quantity: number
      reason: string
    }) => {
      if (!supabase) {
        if (!sampleMayWork(i.locationId)) throw sampleRefusal('notHolder', '42501')
        sampleStock.move(i.itemId, i.locationId, null, i.quantity)
        return
      }
      await rpc('use_stock', {
        p_item_id: i.itemId,
        p_location_id: i.locationId,
        p_quantity: i.quantity,
        p_encounter_id: null,
        p_reason: i.reason.trim(),
      })
    },
    onSuccess: refresh,
  })
  return {
    requestRefill,
    declineRefill,
    cancelRefill,
    sendToRoom,
    returnToPharmacy,
    confirmReceipt,
    cancelTransfer,
    setStoreMin,
    count,
    writeOff,
  }
}

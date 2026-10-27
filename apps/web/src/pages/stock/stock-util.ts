import { isoDate } from '@mmc/shared'
import type { StockItem, StockLocation, StoreHolder } from '@/lib/api/stock'
import { isLowStock, isRoomStore } from '@/lib/api/stock'
import { EXPIRY_WINDOW_DAYS } from '@/lib/api/pharmacy'

/**
 * The six tabs of the stock page (the pharmacy and the manager), and "My store" for room
 * holders. The address may still name an older tab: it opens the tab that now holds it.
 */
export type MainTab = 'stock' | 'prescriptions' | 'walkin' | 'add' | 'rooms' | 'reports' | 'mine'
/** Older tab names, kept so old links and notices still open the right place. */
export type OldTab =
  | 'pharmacy'
  | 'receive'
  | 'deliveries'
  | 'reorder'
  | 'send'
  | 'use'
  | 'medicines'
  | 'moves'
  | 'sales'
  | 'stores'
export type Tab = MainTab | OldTab
export const MAIN_TABS: readonly MainTab[] = [
  'stock',
  'prescriptions',
  'walkin',
  'add',
  'rooms',
  'reports',
  'mine',
]
export const STOCK_TABS: readonly Tab[] = [
  ...MAIN_TABS,
  'pharmacy',
  'receive',
  'deliveries',
  'reorder',
  'send',
  'use',
  'medicines',
  'moves',
  'sales',
  'stores',
]
/** Where an older tab now lives (and the part of it to show first). */
const OLD_TABS: Record<OldTab, { tab: MainTab; part?: string }> = {
  pharmacy: { tab: 'prescriptions' },
  receive: { tab: 'add' },
  deliveries: { tab: 'reports', part: 'deliveries' },
  reorder: { tab: 'stock', part: 'order' },
  use: { tab: 'stock' },
  medicines: { tab: 'stock', part: 'prices' },
  moves: { tab: 'reports', part: 'moves' },
  sales: { tab: 'reports', part: 'sales' },
  stores: { tab: 'rooms', part: 'stores' },
  send: { tab: 'rooms', part: 'send' },
}
/** The tab an address names, with the part of it to open. */
export const mainTab = (tab: Tab | undefined): { tab: MainTab | undefined; part?: string } =>
  !tab ? { tab: undefined } : tab in OLD_TABS ? OLD_TABS[tab as OldTab] : { tab: tab as MainTab }

/**
 * Helpers the stock screens share: messages, names, dates and expiry, the store filters of the
 * pickers and the lines of a note.
 */

export const errorBox =
  'border-red/30 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium'

export interface Msg {
  ok: boolean
  text: string
}

/** The sentence of anything thrown (ApiError messages are already translated). */
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** "Amoxicillin 500 mg". */
export const itemName = (i: Pick<StockItem, 'name' | 'strength'> | undefined | null): string =>
  i ? `${i.name}${i.strength ? ` ${i.strength}` : ''}` : ''

export const todayIso = () => isoDate(new Date())

/** Days from today to an ISO date (negative: past). */
export const daysUntil = (iso: string): number => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`)
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.round((d.getTime() - now.getTime()) / 86_400_000)
}

export type ExpiryState = 'expired' | 'soon' | 'ok'
/** Expired (before today), expiring within the expiry window (30 days), or fine. */
export const expiryState = (iso: string | null | undefined): ExpiryState | null => {
  if (!iso) return null
  const d = daysUntil(iso)
  return d < 0 ? 'expired' : d <= EXPIRY_WINDOW_DAYS ? 'soon' : 'ok'
}

/** What the stock list tags an item with: expired units on a shelf, expiring soon, low. */
export type ItemStatus = 'expired' | 'expiring' | 'low'
export const itemStatuses = (i: StockItem): ItemStatus[] => {
  const out: ItemStatus[] = []
  if (i.expiredUnits > 0) out.push('expired')
  if (expiryState(i.nextExpiry ?? i.earliestExpiry) === 'soon') out.push('expiring')
  if (isLowStock(i)) out.push('low')
  return out
}

/** Open stores of the pharmacy side (pharmacy stores and the old main store). */
export const pharmacySide = (locations: StockLocation[], withClosed = false) =>
  locations.filter(
    (l) => (l.type === 'pharmacy' || l.type === 'main_store') && (withClosed || l.active !== false),
  )
/** Open pharmacy stores, the main one first. */
export const pharmacyStores = (locations: StockLocation[]) =>
  locations
    .filter((l) => l.type === 'pharmacy' && l.active !== false)
    .sort((a, b) => Number(!!b.isMain) - Number(!!a.isMain))
/** The main (receiving) pharmacy store. */
export const mainPharmacy = (locations: StockLocation[], mainId?: string | null) =>
  locations.find((l) => l.id === mainId && l.active !== false) ??
  locations.find((l) => l.type === 'pharmacy' && l.isMain && l.active !== false) ??
  pharmacyStores(locations)[0]
/** Room stores (room, ward, laboratory, theatre), open ones unless asked. */
export const roomStores = (locations: StockLocation[], withClosed = false) =>
  locations.filter((l) => isRoomStore(l) && (withClosed || l.active !== false))

/** Units of a medicine in a store that are not expired (when the database splits them). */
export const usableIn = (i: StockItem | undefined, locationId: string): number =>
  i ? ((i.byLocationUsable ?? i.byLocation)[locationId] ?? 0) : 0

/** Usable units in the pharmacy (its stores and the old main store), in the room stores, in all. */
export const splitStock = (i: StockItem, locations: StockLocation[]) => {
  const pharmacy =
    i.pharmacyUsable ?? pharmacySide(locations, true).reduce((s, l) => s + usableIn(i, l.id), 0)
  const rooms = roomStores(locations, true).reduce((s, l) => s + usableIn(i, l.id), 0)
  return { pharmacy, rooms, total: i.usable ?? Math.max(0, i.onHand - i.expiredUnits) }
}

// ---------------------------------------------------------------- lines of a note
export interface DraftLine {
  key: number
  itemId: string
  quantity: string
}
let nextKey = 1
export const draftLine = (itemId = '', quantity = ''): DraftLine => ({
  key: nextKey++,
  itemId,
  quantity,
})

/** Lines filled in (a medicine and a quantity above zero), merged by medicine. */
export function cleanLines(lines: DraftLine[]): { itemId: string; quantity: number }[] {
  const by = new Map<string, number>()
  for (const l of lines) {
    const q = Number(l.quantity)
    if (!l.itemId || !Number.isInteger(q) || q <= 0) continue
    by.set(l.itemId, (by.get(l.itemId) ?? 0) + q)
  }
  return [...by].map(([itemId, quantity]) => ({ itemId, quantity }))
}

/** "Dr Kamanzi, Maternity department". */
export const holdersText = (holders: StoreHolder[] | undefined, none: string): string =>
  holders && holders.length
    ? holders
        .map((h) => h.name ?? h.department ?? '')
        .filter(Boolean)
        .join(', ')
    : none

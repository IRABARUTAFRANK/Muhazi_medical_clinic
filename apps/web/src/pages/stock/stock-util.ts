import type { TFunction } from 'i18next'
import { formatNumber, isoDate } from '@mmc/shared'
import type { StockItem, StockLocation, StoreHolder } from '@/lib/api/stock'
import { isLowStock, isRoomStore } from '@/lib/api/stock'
import { EXPIRY_WINDOW_DAYS } from '@/lib/api/pharmacy'
import { splitPacks } from '@/lib/medicine-name'
import {
  knownPackWord,
  PIECE_WORDS,
  packSizeOf,
  priceQuantity,
  saleModeOf,
  type Packaging,
  type PricedQuantity,
} from '@/lib/pack-pricing'

// ---------------------------------------------------------------- packs and pieces
/**
 * A translation with its English wording as the default, for the keys of this change while they
 * wait to be merged into the language files ({ one, other } for a count).
 */
export const tx = (
  t: TFunction,
  key: string,
  en: string | { one: string; other: string },
  vars: Record<string, unknown> = {},
): string =>
  typeof en === 'string'
    ? t(key, { defaultValue: en, ...vars })
    : t(key, { defaultValue: en.one, defaultValue_other: en.other, ...vars })

/** How a quantity is typed: in pieces (tablets, ml…) or in whole packs. */
export type QtyMode = 'pieces' | 'packs'

/** An item sold by the pack: 2 or more pieces in one. */
export const hasPacks = (i: { packSize?: number | null } | null | undefined): boolean =>
  (i?.packSize ?? 1) > 1

/**
 * "2 boxes of 8", "1 strip of 10", "3 × bag of 8" (a word typed by hand), "2 packs of 8" (no
 * word): whole packs in the item's pack word (0107).
 */
export function packCountText(
  t: TFunction,
  count: number,
  size: number,
  word?: string | null,
): string {
  const known = knownPackWord(word)
  if (known) {
    // the English wording until the translations are merged ("2 boxes of 8")
    const plural = known === 'box' ? 'boxes' : `${known}s`
    return tx(
      t,
      `packaging.packOf.${known}`,
      { one: `{{count}} ${known} of {{size}}`, other: `{{count}} ${plural} of {{size}}` },
      { count, size },
    )
  }
  const typed = (word ?? '').trim()
  if (typed)
    return tx(t, 'packaging.packOfWord', '{{count}} × {{word}} of {{size}}', {
      count,
      size,
      word: typed,
    })
  return tx(
    t,
    'stockShared.packs.of',
    { one: '{{count}} pack of {{size}}', other: '{{count}} packs of {{size}}' },
    { count, size },
  )
}

/**
 * "25 packs of 20", "25 packs of 20 + 3", "62 boxes of 8 + 7" (with the item's pack word); null
 * when the item has no pack or fewer than one.
 */
export function packsText(
  t: TFunction,
  units: number,
  packSize: number | null | undefined,
  packUnit?: string | null,
): string | null {
  const p = splitPacks(units, packSize)
  if (!p) return null
  if (packUnit?.trim()) {
    const packs = packCountText(t, p.packs, p.size, packUnit)
    return p.rest > 0 ? `${packs} + ${formatNumber(p.rest)}` : packs
  }
  return p.rest > 0
    ? tx(
        t,
        'stockShared.packs.ofPlus',
        {
          one: '{{count}} pack of {{size}} + {{rest}}',
          other: '{{count}} packs of {{size}} + {{rest}}',
        },
        { count: p.packs, size: p.size, rest: p.rest },
      )
    : tx(
        t,
        'stockShared.packs.of',
        { one: '{{count}} pack of {{size}}', other: '{{count}} packs of {{size}}' },
        { count: p.packs, size: p.size },
      )
}

/** "503 tab" (the piece unit when the item has one). */
export const unitsText = (units: number, unit: string | null | undefined): string =>
  unit ? `${formatNumber(units)} ${unit}` : formatNumber(units)

/** "503 tab · 25 packs of 20 + 3": the pieces first, the packs beside them. */
export function piecesAndPacks(
  t: TFunction,
  units: number,
  i:
    { unit?: string | null; packSize?: number | null; packUnit?: string | null } | null | undefined,
): string {
  const packs = packsText(t, units, i?.packSize, i?.packUnit)
  const pieces = unitsText(units, i?.unit)
  return packs ? `${pieces} · ${packs}` : pieces
}

/** "2 × 20 = 40 tab": what a number of packs comes to in pieces. */
export const packsEquals = (
  t: TFunction,
  packs: number,
  packSize: number,
  unit: string | null | undefined,
): string =>
  tx(t, 'stockShared.packs.equals', '{{packs}} × {{size}} = {{units}}', {
    packs,
    size: packSize,
    units: unitsText(packs * packSize, unit),
  })

/** "pack {{price}}": the pack price beside the piece price in a row's sub-text. */
export const packPriceText = (
  t: TFunction,
  i: Packaging,
  money: (n: number) => string,
): string | null =>
  i.packPrice != null && hasPacks(i) && saleModeOf(i) !== 'piece'
    ? tx(t, 'stockShared.packs.price', 'pack of {{size}}: {{price}}', {
        size: i.packSize,
        price: money(i.packPrice),
      })
    : null

/** "By the piece", "By the box only", "By the box or the piece": how the item is sold. */
export function saleModeText(t: TFunction, i: Packaging): string {
  const mode = saleModeOf(i)
  if (!packSizeOf(i)) return tx(t, 'packaging.soldPiecesOnly', 'Pieces only, sold by the piece')
  return t(`packaging.sold.${mode}`, {
    defaultValue:
      mode === 'pack'
        ? 'Sold only by the whole pack'
        : mode === 'both'
          ? 'Sold by the pack or by the piece'
          : 'Sold by the piece',
  })
}

/**
 * "1 box of 8 + 3 tablet": what a priced quantity is made of (whole packs at the pack price, the
 * pieces left at the piece price); pieces only: "3 bottle".
 */
export function breakdownText(
  t: TFunction,
  p: Pick<PricedQuantity, 'packs' | 'pieces' | 'size'>,
  i: { unit?: string | null; packUnit?: string | null } | null | undefined,
): string {
  const parts: string[] = []
  if (p.packs > 0 && p.size) parts.push(packCountText(t, p.packs, p.size, i?.packUnit))
  if (p.pieces > 0 || parts.length === 0) parts.push(unitsText(p.pieces, i?.unit))
  return parts.join(' + ')
}

/** "1 box of 8 × 1,500 + 3 tablet × 200 = 2,100": the price line of a priced quantity. */
export function priceLineText(
  t: TFunction,
  p: PricedQuantity,
  i: { unit?: string | null; packUnit?: string | null } | null | undefined,
  money: (n: number) => string,
): string {
  const parts: string[] = []
  if (p.packs > 0 && p.size && p.packPrice != null)
    parts.push(`${packCountText(t, p.packs, p.size, i?.packUnit)} × ${money(p.packPrice)}`)
  if (p.pieces > 0 || parts.length === 0)
    parts.push(`${unitsText(p.pieces, i?.unit)} × ${money(p.piecePrice)}`)
  return `${parts.join(' + ')} = ${money(p.total)}`
}

/**
 * "Paracetamol 500 mg is sold only in whole boxes of 8: give 8 or 16": said before the database
 * refuses a quantity that is not whole packs.
 */
export function wholePacksText(
  t: TFunction,
  pieces: number,
  i: Packaging & { packUnit?: string | null },
): string {
  const size = packSizeOf(i) ?? 1
  const below = Math.floor(pieces / size) * size
  const above = below + size
  return tx(
    t,
    'packaging.wholePacksOnly',
    'Sold only by the whole pack ({{pack}}): {{pieces}} is not whole packs. Give {{below}} or {{above}}.',
    {
      pack: packCountText(t, 1, size, i.packUnit),
      pieces: formatNumber(pieces),
      below: formatNumber(below > 0 ? below : size),
      above: formatNumber(below > 0 ? above : size * 2),
    },
  )
}

/** The pieces a typed quantity means: packs × pack size, or the pieces themselves. */
export const piecesOf = (typed: number, mode: QtyMode, packSize: number | null | undefined) =>
  mode === 'packs' ? typed * Math.max(1, packSize ?? 1) : typed

/**
 * What a cash sale of `units` pieces costs, by how the item is sold (0107; the database charges
 * the same way): whole packs at the pack price, pieces at the piece price.
 */
export function cashCost(units: number, i: Packaging): PricedQuantity & { byPack: boolean } {
  const p = priceQuantity(i, units)
  return { ...p, byPack: p.packs > 0 }
}

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
  /** As typed: pieces, or whole packs (mode 'packs', 0107). */
  quantity: string
  mode?: QtyMode
  /** A pack-only medicine sent in pieces: a pack is split (the pharmacy only). */
  split?: boolean
}
let nextKey = 1
export const draftLine = (itemId = '', quantity = '', mode: QtyMode = 'pieces'): DraftLine => ({
  key: nextKey++,
  itemId,
  quantity,
  mode,
})

/** The package of a note line's medicine (0107). */
export type LineItem = Packaging & { unit?: string | null; packUnit?: string | null }

/** The pieces a note line means: packs × pieces in one when typed in packs. */
export const draftPieces = (l: DraftLine, item: LineItem | null | undefined): number => {
  const q = Number(l.quantity)
  if (!Number.isInteger(q) || q <= 0) return 0
  const size = packSizeOf(item)
  return l.mode === 'packs' && size ? q * size : q
}

/**
 * A pack-only medicine asked in pieces that are not whole packs (not split, not a return): the
 * database refuses it (0107).
 */
export const draftNotWhole = (
  l: DraftLine,
  item: LineItem | null | undefined,
  piecesOk = false,
): boolean => {
  const size = packSizeOf(item)
  const n = draftPieces(l, item)
  return !piecesOk && !l.split && saleModeOf(item) === 'pack' && !!size && n > 0 && n % size !== 0
}

/**
 * Lines filled in (a medicine and a quantity above zero), merged by medicine, in pieces; with how
 * they were typed (packs) and whether a pack is split.
 */
export function cleanLines(
  lines: DraftLine[],
  itemOf?: (itemId: string) => LineItem | null | undefined,
): { itemId: string; quantity: number; mode: QtyMode; split?: boolean }[] {
  const by = new Map<string, { quantity: number; mode: QtyMode; split?: boolean }>()
  for (const l of lines) {
    const q = draftPieces(l, itemOf?.(l.itemId))
    if (!l.itemId || q <= 0) continue
    const was = by.get(l.itemId)
    by.set(l.itemId, {
      quantity: (was?.quantity ?? 0) + q,
      mode: was?.mode === 'packs' || l.mode === 'packs' ? 'packs' : 'pieces',
      ...(was?.split || l.split ? { split: true } : {}),
    })
  }
  return [...by].map(([itemId, x]) => ({ itemId, ...x }))
}

/** "Dr Kamanzi, Maternity department". */
export const holdersText = (holders: StoreHolder[] | undefined, none: string): string =>
  holders && holders.length
    ? holders
        .map((h) => h.name ?? h.department ?? '')
        .filter(Boolean)
        .join(', ')
    : none

/** The pack's word in the reader's language: "box" → "boîte" (a word typed by hand as written). */
export const packWord = (t: TFunction, w: string | null | undefined): string => {
  const k = knownPackWord(w)
  if (k) return t(`packaging.word.${k}`, { defaultValue: k })
  return w?.trim() || tx(t, 'packaging.pack', 'pack')
}

/** The piece's word in the reader's language: "tablet" → "comprimé" (others as written). */
export const pieceWord = (t: TFunction, w: string | null | undefined): string => {
  const k = (w ?? '').trim().toLowerCase()
  if ((PIECE_WORDS as readonly string[]).includes(k))
    return t(`packaging.pieceWord.${k}`, { defaultValue: k })
  return w?.trim() || tx(t, 'packaging.piece', 'piece')
}

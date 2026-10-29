/**
 * How a medicine is packed and sold, and what a quantity of it costs (0107). The same rule as the
 * database's price_quantity, so every screen shows the price the bill will say:
 *
 *   'piece' — sold by the piece at the piece price (packs typed only count pieces);
 *   'pack'  — sold only by whole packs at the pack price (pieces that are not whole packs are
 *             refused); the piece price is the pack price / pieces in one;
 *   'both'  — whole packs at the pack price and the pieces left at the piece price.
 *
 * Only a cash-priced line (no insurer, or an insurer without its own price) is priced by the
 * pack: an insurer's own price stays per piece. Stock is always held in pieces.
 */
export type SaleMode = 'piece' | 'pack' | 'both'
export const SALE_MODES: readonly SaleMode[] = ['piece', 'pack', 'both']

export interface Packaging {
  /** Pieces in one pack; empty or 1: pieces only. */
  packSize?: number | null
  /** How it is sold; missing on an older database (a pack price then means both, as 0103). */
  saleMode?: SaleMode | null
  /** The price of one whole pack. */
  packPrice?: number | null
  /** The cash price of one piece. */
  sellingPrice?: number | null
  /** The piece: tablet, capsule, bottle… */
  unit?: string | null
  /** The pack: box, strip, blister… */
  packUnit?: string | null
}

/** The pieces in one pack, or null when the item has no pack (pieces only). */
export const packSizeOf = (i: Packaging | null | undefined): number | null =>
  i?.packSize != null && i.packSize >= 2 ? i.packSize : null

/** How the item is sold (pieces only: always by the piece). */
export function saleModeOf(i: Packaging | null | undefined): SaleMode {
  if (!packSizeOf(i)) return 'piece'
  const m = i?.saleMode
  if (m === 'pack' || m === 'both' || m === 'piece')
    return m !== 'piece' && i?.packPrice == null ? 'piece' : m
  return i?.packPrice != null ? 'both' : 'piece'
}

/** The price of one piece: a pack-only item's is the pack price / pieces in one. */
export function piecePriceOf(i: Packaging | null | undefined): number | null {
  const size = packSizeOf(i)
  if (saleModeOf(i) === 'pack' && size && i?.packPrice != null)
    return Math.round(i.packPrice / size)
  return i?.sellingPrice ?? null
}

/** True when `pieces` is a whole number of packs of `size`. */
export const isWholePacks = (pieces: number, size: number | null | undefined): boolean =>
  !!size && size >= 2 && pieces > 0 && Number.isInteger(pieces) && pieces % size === 0

export interface PricedQuantity {
  mode: SaleMode
  /** Pieces in one pack (null: pieces only). */
  size: number | null
  /** Whole packs charged at the pack price. */
  packs: number
  /** Pieces charged at the piece price. */
  pieces: number
  packPrice: number | null
  piecePrice: number
  total: number
  /** false: a pack-only item asked in pieces that are not whole packs (refused). */
  ok: boolean
}

/**
 * What `pieces` pieces cost. `piecePrice` is the price of one piece on the line (the insurer's
 * own, or the cash price; default the item's); `cash` false keeps the line per piece.
 */
export function priceQuantity(
  i: Packaging | null | undefined,
  pieces: number,
  o: { cash?: boolean; piecePrice?: number | null } = {},
): PricedQuantity {
  const mode = saleModeOf(i)
  const size = packSizeOf(i)
  const q = Math.max(0, pieces || 0)
  const piecePrice = Math.round(o.piecePrice ?? piecePriceOf(i) ?? 0)
  const whole = isWholePacks(q, size)
  const ok = mode !== 'pack' || whole
  const cash = o.cash ?? true
  const packPrice = mode !== 'piece' && i?.packPrice != null ? Math.round(i.packPrice) : null
  if (cash && size && packPrice != null && q > 0 && (mode === 'both' || whole)) {
    const packs = Math.floor(q / size)
    const rest = q - packs * size
    return {
      mode,
      size,
      packs,
      pieces: rest,
      packPrice,
      piecePrice,
      total: packs * packPrice + Math.round(piecePrice * rest),
      ok,
    }
  }
  return {
    mode,
    size,
    packs: 0,
    pieces: q,
    packPrice,
    piecePrice,
    total: Math.round(piecePrice * q),
    ok,
  }
}

/** The pack words the forms offer (any other word may be typed). */
export const PACK_WORDS = ['box', 'strip', 'blister', 'bottle', 'sachet', 'tube', 'carton'] as const
/** The piece words the forms offer (any other word may be typed). */
export const PIECE_WORDS = [
  'tablet',
  'capsule',
  'sachet',
  'ampoule',
  'vial',
  'bottle',
  'tube',
  'suppository',
  'piece',
  'ml',
] as const

/** A pack word the screens know how to say ("box" → "1 box of 8", "2 boxes of 8"). */
export const knownPackWord = (w: string | null | undefined): string | null => {
  const k = (w ?? '').trim().toLowerCase()
  return (PACK_WORDS as readonly string[]).includes(k) ? k : null
}

/**
 * What `pieces` pieces are worth at selling price (0107, the database's sell_value): whole packs
 * at the pack price (sold by the pack or both), the pieces left at the piece price (a pack-only
 * medicine: the pack price / pieces in one); sold by the piece: pieces × the piece price.
 */
export function sellValueOf(i: Packaging | null | undefined, pieces: number): number {
  const q = Math.max(0, pieces || 0)
  const mode = saleModeOf(i)
  const size = packSizeOf(i)
  if (mode !== 'piece' && size && i?.packPrice != null) {
    const packs = Math.floor(q / size)
    const rest = q - packs * size
    const each = mode === 'pack' ? i.packPrice / size : (i.sellingPrice ?? 0)
    return packs * i.packPrice + rest * each
  }
  return q * (i?.sellingPrice ?? 0)
}

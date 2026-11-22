import type { TFunction } from 'i18next'
import { formatRwf } from '@mmc/shared'
import { packsText } from '@/pages/stock/stock-util'
import { priceQuantity, type SaleMode } from './pack-pricing'

/**
 * What an order of step 6 will do when it is marked given or done (0193), worked out while the
 * doctor types — the box above the Send button says it in words:
 *   ok          the pieces leave the clinic's stock and go on the bill (amount at the cash price);
 *   short       the stock holds fewer pieces than asked (Send stays blocked);
 *   wholePacks  a medicine sold only by the whole box is not asked in whole boxes (blocked);
 *   noPrice     no price is set: nothing goes on the bill;
 *   typed       an act written by hand (not in the price list): nothing goes on the bill.
 * The same rule as the database (price_quantity, assert_whole_packs, room_store_for).
 */
export type SummaryTone = 'ok' | 'short' | 'wholePacks' | 'noPrice' | 'typed'

export interface SummaryPack {
  size: number
  mode: SaleMode
  packPrice: number | null
  packUnit: string | null
}

export interface OrderSummaryInput {
  kind: 'act' | 'drug'
  /** A medicine: whole pieces given here and to take home. */
  here: number
  home: number
  /** Pieces the clinic's stock holds (not expired); null when not known. */
  stockUnits: number | null
  /** The medicine's box (null: sold by the piece only). */
  pack: SummaryPack | null
  /** The cash price of one piece (null: no price set). */
  cashPrice: number | null
  /** An act: a treatment of the price list was chosen (false: written by hand). */
  service: boolean
  servicePrice: number | null
  /** An act: how many on the bill. */
  actCount: number
}

export interface OrderSummary {
  /** A medicine: here + to take home. */
  pieces: number
  /** Pieces in the clinic's stock now (null: not known). */
  left: number | null
  /** What goes on the bill at the cash price (null: nothing). */
  amount: number | null
  /** Whole boxes billed at the box price, and the pieces in one. */
  packs: number
  packSize: number | null
  /** A box-only medicine: the next whole number of boxes, in pieces. */
  nextWhole: number | null
  tone: SummaryTone
}

export function summarizeOrder(i: OrderSummaryInput): OrderSummary {
  if (i.kind === 'act') {
    const base = { pieces: 0, left: null, packs: 0, packSize: null, nextWhole: null }
    if (!i.service) return { ...base, amount: null, tone: 'typed' }
    if (i.servicePrice == null) return { ...base, amount: null, tone: 'noPrice' }
    return { ...base, amount: Math.round(i.servicePrice * i.actCount), tone: 'ok' }
  }
  const pieces = Math.max(0, i.here) + Math.max(0, i.home)
  const size = i.pack && i.pack.size >= 2 ? i.pack.size : null
  const q = priceQuantity(
    {
      packSize: size,
      saleMode: i.pack?.mode ?? 'piece',
      packPrice: i.pack?.packPrice ?? null,
      sellingPrice: i.cashPrice,
    },
    pieces,
    { cash: true },
  )
  const priced = i.cashPrice != null || (q.mode === 'pack' && q.packPrice != null)
  const tone: SummaryTone =
    i.stockUnits != null && pieces > i.stockUnits
      ? 'short'
      : !q.ok
        ? 'wholePacks'
        : priced
          ? 'ok'
          : 'noPrice'
  return {
    pieces,
    left: i.stockUnits,
    amount: priced ? q.total : null,
    packs: q.packs,
    packSize: size,
    nextWhole: size ? Math.max(1, Math.ceil(pieces / size)) * size : null,
    tone,
  }
}

/** The rest of the box after the pieces given here ("the rest of the box goes home"). */
export const restOfBox = (here: number, size: number | null | undefined): number | null => {
  if (!size || size < 2) return null
  const rest = size - (Math.max(0, here) % size)
  return rest === size && here > 0 ? null : rest
}

/** The box's sentence (also said in the question before Send). */
export function summaryWords(
  t: TFunction,
  s: OrderSummary,
  c: { kind: 'act' | 'drug'; unit: string; act: string; actCount: number; packUnit: string | null },
): string {
  const amount = s.amount != null ? formatRwf(s.amount) : ''
  const left = s.left ?? '—'
  if (c.kind === 'act')
    return s.tone === 'typed'
      ? t('nurseOrders.summaryTyped')
      : s.tone === 'noPrice'
        ? t('nurseOrders.summaryNoPrice')
        : t('nurseOrders.summaryAct', { act: c.act, count: c.actCount, amount })
  if (s.tone === 'short')
    return t('nurseOrders.notEnough', { count: s.left ?? 0, unit: c.unit, asked: s.pieces })
  if (s.tone === 'wholePacks')
    return t('nurseOrders.wholePacksNote', {
      pack: c.packUnit || t('nurseOrders.pack'),
      size: s.packSize ?? 0,
      next: s.nextWhole ?? 0,
    })
  if (s.tone === 'noPrice')
    return t('nurseOrders.summaryDrugNoPrice', { total: s.pieces, unit: c.unit, left })
  return [
    t('nurseOrders.summaryDrug', { total: s.pieces, unit: c.unit, left, amount }),
    s.packs > 0 && s.packSize
      ? t('nurseOrders.summaryAsPacks', {
          packs: packsText(t, s.pieces, s.packSize, c.packUnit) ?? '',
        })
      : null,
    t('nurseOrders.summaryInsurer'),
  ]
    .filter(Boolean)
    .join(' ')
}

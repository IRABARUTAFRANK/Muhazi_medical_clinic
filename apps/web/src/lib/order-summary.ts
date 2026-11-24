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
  /**
   * 0198: the part of a piece given here (0.5; 0.05 = 5 ml of a 100 ml bottle), its price (null:
   * no price), and whether it opens one more piece (the opened ones hold less than the part).
   */
  part?: number
  partPrice?: number | null
  partOpens?: boolean
  /** 0198: a repeated order: how many times (null: until stopped); undefined: once. */
  times?: number | null
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
  /** 0198: the part (0 when none) and its price; whether it opens one more piece. */
  part: number
  partAmount: number | null
  partOpens: boolean
  /**
   * A repeated order: what one time puts on the bill (whole pieces here + the part), the times
   * (null: until stopped) and all of them if all are given. Null: once.
   */
  repeat: { each: number | null; times: number | null; all: number | null } | null
  /** A repeated order with some to take home: that part is its own order, priced apart. */
  homeAmount: number | null
}

export function summarizeOrder(i: OrderSummaryInput): OrderSummary {
  const repeated = i.times !== undefined
  const many = (each: number | null) =>
    repeated
      ? {
          each,
          times: i.times ?? null,
          all: each != null && i.times != null ? each * i.times : null,
        }
      : null
  if (i.kind === 'act') {
    const base = {
      pieces: 0,
      left: null,
      packs: 0,
      packSize: null,
      nextWhole: null,
      part: 0,
      partAmount: null,
      partOpens: false,
      homeAmount: null,
    }
    if (!i.service) return { ...base, amount: null, tone: 'typed', repeat: many(null) }
    if (i.servicePrice == null)
      return { ...base, amount: null, tone: 'noPrice', repeat: many(null) }
    const amount = Math.round(i.servicePrice * i.actCount)
    return { ...base, amount, tone: 'ok', repeat: many(amount) }
  }
  const here = Math.max(0, i.here)
  const home = Math.max(0, i.home)
  // a repeated order: the pieces of one time; what goes home is its own order (priced apart)
  const pieces = repeated ? here : here + home
  const part = Math.max(0, i.part ?? 0)
  const partOpens = part > 0 && !!i.partOpens
  const size = i.pack && i.pack.size >= 2 ? i.pack.size : null
  const price = (n: number) =>
    priceQuantity(
      {
        packSize: size,
        saleMode: i.pack?.mode ?? 'piece',
        packPrice: i.pack?.packPrice ?? null,
        sellingPrice: i.cashPrice,
      },
      n,
      { cash: true },
    )
  const q = price(pieces)
  const qHome = repeated && home > 0 ? price(home) : null
  const priced = i.cashPrice != null || (q.mode === 'pack' && q.packPrice != null)
  const partAmount = part > 0 ? (i.partPrice ?? null) : null
  // the stock: the whole pieces (here and home), and one more piece opened for the part
  const need = here + home + (partOpens ? 1 : 0)
  const tone: SummaryTone =
    i.stockUnits != null && need > i.stockUnits
      ? 'short'
      : !q.ok || (qHome && !qHome.ok)
        ? 'wholePacks'
        : priced || partAmount != null
          ? 'ok'
          : 'noPrice'
  const wholeAmount = priced ? q.total : null
  const amount =
    wholeAmount == null && partAmount == null ? null : (wholeAmount ?? 0) + (partAmount ?? 0)
  return {
    pieces,
    left: i.stockUnits,
    amount,
    packs: q.packs,
    packSize: size,
    nextWhole: size ? Math.max(1, Math.ceil(pieces / size)) * size : null,
    tone,
    part,
    partAmount,
    partOpens,
    repeat: many(amount),
    homeAmount: qHome && priced ? qHome.total : null,
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
  c: {
    kind: 'act' | 'drug'
    unit: string
    act: string
    actCount: number
    packUnit: string | null
    /** 0198: the part in words ("½ tab", "5 ml"). */
    partText?: string | null
    /** 0198: the pieces to take home of a repeated order (its own order). */
    home?: number
  },
): string {
  const amount = s.amount != null ? formatRwf(s.amount) : ''
  const left = s.left ?? '—'
  if (c.kind === 'act')
    return [
      s.tone === 'typed'
        ? t('nurseOrders.summaryTyped')
        : s.tone === 'noPrice'
          ? t('nurseOrders.summaryNoPrice')
          : t('nurseOrders.summaryAct', { act: c.act, count: c.actCount, amount }),
      repeatWords(t, s),
    ]
      .filter(Boolean)
      .join(' ')
  if (s.tone === 'short')
    return t('nurseOrders.notEnough', { count: s.left ?? 0, unit: c.unit, asked: s.pieces })
  if (s.tone === 'wholePacks')
    return t('nurseOrders.wholePacksNote', {
      pack: c.packUnit || t('nurseOrders.pack'),
      size: s.packSize ?? 0,
      next: s.nextWhole ?? 0,
    })
  // 0198: a part of a piece ("2 tab + ½ tab"), said with how the stock gives it
  const withPart = s.part > 0 && !!c.partText
  const what = withPart
    ? [s.pieces > 0 ? `${s.pieces} ${c.unit}` : null, c.partText].filter(Boolean).join(' + ')
    : null
  const partWords = withPart
    ? t(s.partOpens ? 'nurseOrders.summaryPartOpens' : 'nurseOrders.summaryPartFromOpen', {
        unit: c.unit,
      })
    : null
  const homeOrder =
    s.repeat && c.home
      ? t('nurseOrders.summaryHomeOrder', {
          count: c.home,
          unit: c.unit,
          amount: s.homeAmount != null ? formatRwf(s.homeAmount) : '—',
        })
      : null
  if (s.tone === 'noPrice')
    return [
      what
        ? t('nurseOrders.summaryDrugWhatNoPrice', { what, unit: c.unit, left })
        : t('nurseOrders.summaryDrugNoPrice', { total: s.pieces, unit: c.unit, left }),
      partWords,
      homeOrder,
    ]
      .filter(Boolean)
      .join(' ')
  return [
    what
      ? t('nurseOrders.summaryDrugWhat', { what, unit: c.unit, left, amount })
      : t('nurseOrders.summaryDrug', { total: s.pieces, unit: c.unit, left, amount }),
    partWords,
    s.packs > 0 && s.packSize
      ? t('nurseOrders.summaryAsPacks', {
          packs: packsText(t, s.pieces, s.packSize, c.packUnit) ?? '',
        })
      : null,
    repeatWords(t, s),
    homeOrder,
    t('nurseOrders.summaryInsurer'),
  ]
    .filter(Boolean)
    .join(' ')
}

/** 0198: a repeated order: "The same each time: 9 times = 675 RWF if all are given." */
function repeatWords(t: TFunction, s: OrderSummary): string | null {
  if (!s.repeat) return null
  if (s.repeat.times == null) return t('nurseOrders.summaryRepeatUntil')
  return s.repeat.all != null
    ? t('nurseOrders.summaryRepeat', { count: s.repeat.times, total: formatRwf(s.repeat.all) })
    : t('nurseOrders.summaryRepeatNoPrice', { count: s.repeat.times })
}

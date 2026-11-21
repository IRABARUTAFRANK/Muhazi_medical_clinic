import { formatRwf } from '@mmc/shared'
import {
  isOnce,
  orderParts,
  type GiveResult,
  type NotBilledWhy,
  type NurseOrder,
  type UndoResult,
} from './api/nurse-orders'

/**
 * The words of an order of step 6 (0193), shared by the order, the bill line, the nurse's Home and
 * the printed record, so each says the same thing: its parts (given here / to take home), the
 * button and the question before it, what happened, and what Undo does.
 */
type TFn = (key: string, vars?: Record<string, unknown>) => string
/** What the words need of an order (the printed record passes a looser shape). */
export type OrderLike = Pick<NurseOrder, 'kind' | 'quantity' | 'status' | 'dosesPlanned'> &
  Partial<
    Pick<
      NurseOrder,
      | 'dose'
      | 'route'
      | 'frequency'
      | 'unit'
      | 'service'
      | 'serviceId'
      | 'homeQuantity'
      | 'homeDose'
      | 'homeFrequency'
      | 'homeDays'
      | 'homeInstructions'
    >
  >

/** What one press does: Given (a medicine, some or all here), Handed over (all to take home), Done (an act). */
export type OrderAction = 'give' | 'hand' | 'done'
export function orderAction(o: Pick<OrderLike, 'kind' | 'quantity' | 'homeQuantity'>): OrderAction {
  if (o.kind === 'act') return 'done'
  const { here, home } = orderParts(o)
  return here <= 0 && home > 0 ? 'hand' : 'give'
}

const unitOf = (t: TFn, o: Pick<OrderLike, 'unit'>) => o.unit || t('nurseOrders.unit')
const routeWord = (t: TFn, r: string) => t(`clinical.routes.${r}`, { defaultValue: r })
const frequencyWord = (t: TFn, f: string) => t(`clinical.frequencies.${f}`, { defaultValue: f })

/** "Given here: 2 cap · 1 g · By mouth (oral)" (and how often, sent by a screen of before 0193). */
export function hereLine(t: TFn, o: OrderLike): string | null {
  const { here } = orderParts(o)
  if (o.kind !== 'drug' || here <= 0) return null
  return [
    t('nurseOrders.partHere', { count: here, unit: unitOf(t, o) }),
    o.dose,
    o.route ? routeWord(t, o.route) : null,
    o.frequency ? frequencyWord(t, o.frequency) : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
/** "To take home: 8 cap — 1 capsule, Three times a day (TDS), for 3 days, after meals". */
export function homeLine(t: TFn, o: OrderLike): string | null {
  const { home } = orderParts(o)
  if (o.kind !== 'drug' || home <= 0) return null
  const how = [
    o.homeDose,
    o.homeFrequency ? frequencyWord(t, o.homeFrequency) : null,
    o.homeDays ? t('pharmacy.labelDays', { count: o.homeDays }) : null,
    o.homeInstructions,
  ]
    .filter(Boolean)
    .join(', ')
  const part = t('nurseOrders.partHome', { count: home, unit: unitOf(t, o) })
  return how ? `${part} — ${how}` : part
}
/** An act: "On the bill as Injection (IM/IV) × 1", or "Not in the price list: not billed". */
export function actLine(t: TFn, o: OrderLike): string | null {
  if (o.kind !== 'act') return null
  return o.service
    ? t('nurseOrders.actBilled', { service: o.service, count: Number(o.quantity) || 1 })
    : t('nurseOrders.actNotBilled')
}
/** The lines that say what an order is (one-time orders, 0193). */
export function partLines(t: TFn, o: OrderLike): string[] {
  return [hereLine(t, o), homeLine(t, o), actLine(t, o)].filter((x): x is string => !!x)
}

/** The state of an order in words: To do / Given / Handed over / Done / Not done / Cancelled. */
export function stateWord(t: TFn, o: OrderLike): string {
  if (o.status === 'done' && isOnce(o))
    return t(
      orderAction(o) === 'hand'
        ? 'nurseOrders.status.handed'
        : o.kind === 'drug'
          ? 'nurseOrders.status.given'
          : 'nurseOrders.status.done',
    )
  return t(`nurseOrders.status.${o.status}`)
}

/** The word on the button of one press, by action (also named in the doctor's send words). */
export const BUTTON_WORD = {
  give: 'nurseOrders.give1',
  hand: 'nurseOrders.handOver',
  done: 'nurseOrders.done1',
} as const

/** The button of one press. */
export const giveButton = (t: TFn, o: NurseOrder) => t(BUTTON_WORD[orderAction(o)])
/** The question before it. */
export const giveTitle = (t: TFn, o: NurseOrder, name: string) =>
  t(
    { give: 'nurseOrders.giveQ', hand: 'nurseOrders.handQ', done: 'nurseOrders.doneQ' }[
      orderAction(o)
    ],
    { what: o.text, name },
  )
/** What one press does, in a sentence. */
export function giveBody(t: TFn, o: NurseOrder): string {
  if (o.kind === 'act')
    return t(o.serviceId ? 'nurseOrders.doneBodyAct' : 'nurseOrders.doneBodyTyped')
  const { here, home, total } = orderParts(o)
  const unit = unitOf(t, o)
  if (here > 0 && home > 0) return t('nurseOrders.giveBodyBoth', { here, home, total, unit })
  if (home > 0) return t('nurseOrders.giveBodyHome', { count: home, unit })
  return t('nurseOrders.giveBodyHere', { count: here, unit })
}
export const giveYes = (t: TFn, o: NurseOrder) =>
  t(
    { give: 'nurseOrders.giveYes', hand: 'nurseOrders.handYes', done: 'nurseOrders.doneYes' }[
      orderAction(o)
    ],
  )

/** Why a time is not on the bill. */
export const notBilledWord = (t: TFn, why: NotBilledWhy | null | undefined) =>
  t(
    why === 'bill_closed'
      ? 'nurseOrders.whyBillClosed'
      : why === 'not_in_price_list'
        ? 'nurseOrders.whyNotListed'
        : 'nurseOrders.whyNoPrice',
  )

/** The message after one press. */
export function giveMessage(t: TFn, o: NurseOrder, res: GiveResult): string {
  // a database before 0193 answers only `charged`
  if (res.billed == null && res.notBilled === undefined)
    return t(o.kind === 'drug' ? 'nurseOrders.givenSaved' : 'nurseOrders.doneSaved', {
      what: o.text,
    })
  if (res.charged === false || res.billed == null)
    return t('nurseOrders.savedNotBilled', { what: o.text, why: notBilledWord(t, res.notBilled) })
  const amount = formatRwf(Number(res.billed))
  const action = orderAction(o)
  if (action === 'done') return t('nurseOrders.doneOnBill', { what: o.text, amount })
  const { here, home } = orderParts(o)
  // some given here and the rest handed over to take home: both are said
  if (home > 0 && isOnce(o))
    return t(here > 0 ? 'nurseOrders.givenHandedOnBill' : 'nurseOrders.handedOnBill', {
      what: o.text,
      amount,
    })
  return t('nurseOrders.givenOnBill', { what: o.text, amount })
}

/**
 * What Undo will do, in sentences (the question's body), from what was really given or done: who
 * did it (Given / Handed over / Done by), what goes back to the stock, and the bill only when a
 * time is on it (a written act, an unpriced time or a line the manager removed is not).
 */
export function undoBody(
  t: TFn,
  o: NurseOrder,
  w: {
    /** The doctor who wrote it or the manager: the order ends cancelled. */
    endsOrder: boolean
    /** The visit is finished (a nurse's Undo then ends it as not done). */
    visitOver: boolean
    /** The bill is closed: a credit note instead of removing the line. */
    billClosed: boolean
    /** The person and time of the time(s) given. */
    by?: string | null
    when?: string | null
  },
): string {
  const given = o.doses.filter((d) => d.given)
  const units = given.reduce((s, d) => s + Number(d.quantity ?? 0) + Number(d.homeQuantity ?? 0), 0)
  // an older database says only charged
  const onBill = given.some((d) => d.onBill ?? d.charged)
  const stock = o.kind === 'drug' && units > 0
  const byKey = {
    give: 'nurseOrders.undoBy',
    hand: 'nurseOrders.undoHandedBy',
    done: 'nurseOrders.undoDoneBy',
  }[orderAction(o)]
  // an order already over (cancelled, or not done) stays so: only its times are undone
  const over = o.status === 'cancelled' || o.status === 'not_done'
  return [
    w.by ? t(byKey, { by: w.by, when: w.when ?? '' }) : null,
    stock
      ? t(onBill ? 'nurseOrders.undoBack' : 'nurseOrders.undoBackStock', {
          count: units,
          unit: unitOf(t, o),
        })
      : t(onBill ? 'nurseOrders.undoBackAct' : 'nurseOrders.undoNotOnBill'),
    w.billClosed && onBill ? t('nurseOrders.undoCredit') : null,
    over
      ? t('nurseOrders.undoStays')
      : w.endsOrder
        ? t('nurseOrders.undoEnds')
        : w.visitOver
          ? t('nurseOrders.undoVisitOver')
          : t('nurseOrders.undoReopens'),
  ]
    .filter(Boolean)
    .join(' ')
}
/**
 * The message after Undo: the credit note's whole amount when the bill was closed (and the
 * patient's and insurer's parts when an insurer pays some), else what went back to the stock and
 * what came off the bill.
 */
export function undoMessage(t: TFn, o: NurseOrder, res: UndoResult): string {
  const total = Number(res.creditTotal ?? 0)
  const insurer = Number(res.creditInsurer ?? 0)
  if (res.creditNoteId && total > 0)
    return insurer > 0
      ? t('nurseOrders.undoneCreditSplit', {
          what: o.text,
          amount: formatRwf(total),
          patient: formatRwf(Number(res.credit ?? 0)),
          insurer: formatRwf(insurer),
        })
      : t('nurseOrders.undoneCredit', { what: o.text, amount: formatRwf(total) })
  const back = Number(res.units ?? 0) > 0
  const off = res.removed == null ? true : res.removed > 0
  return t(
    back && off
      ? 'nurseOrders.undone'
      : back
        ? 'nurseOrders.undoneStock'
        : off
          ? 'nurseOrders.undoneBill'
          : 'nurseOrders.undonePlain',
    { what: o.text },
  )
}

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

/** "Given here: 2 cap · 1 g · By mouth (oral)". */
export function hereLine(t: TFn, o: OrderLike): string | null {
  const { here } = orderParts(o)
  if (o.kind !== 'drug' || here <= 0) return null
  return [
    t('nurseOrders.partHere', { count: here, unit: unitOf(t, o) }),
    o.dose,
    o.route ? routeWord(t, o.route) : null,
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

/** The button of one press. */
export const giveButton = (t: TFn, o: NurseOrder) =>
  t(
    { give: 'nurseOrders.give1', hand: 'nurseOrders.handOver', done: 'nurseOrders.done1' }[
      orderAction(o)
    ],
  )
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
  if (orderParts(o).home > 0 && isOnce(o))
    return t('nurseOrders.handedOnBill', { what: o.text, amount })
  return t('nurseOrders.givenOnBill', { what: o.text, amount })
}

/** What Undo will do, in sentences (the question's body). */
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
  const units = o.doses
    .filter((d) => d.given)
    .reduce((s, d) => s + Number(d.quantity ?? 0) + Number(d.homeQuantity ?? 0), 0)
  return [
    w.by ? t('nurseOrders.undoBy', { by: w.by, when: w.when ?? '' }) : null,
    o.kind === 'drug' && units > 0
      ? t('nurseOrders.undoBack', { count: units, unit: unitOf(t, o) })
      : t('nurseOrders.undoBackAct'),
    w.billClosed ? t('nurseOrders.undoCredit') : null,
    w.endsOrder
      ? t('nurseOrders.undoEnds')
      : w.visitOver
        ? t('nurseOrders.undoVisitOver')
        : t('nurseOrders.undoReopens'),
  ]
    .filter(Boolean)
    .join(' ')
}
/** The message after Undo. */
export const undoMessage = (t: TFn, o: NurseOrder, res: UndoResult) =>
  res.mode === 'credit' && Number(res.credit ?? 0) > 0
    ? t('nurseOrders.undoneCredit', { what: o.text, amount: formatRwf(Number(res.credit)) })
    : t('nurseOrders.undone', { what: o.text })

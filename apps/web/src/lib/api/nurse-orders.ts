import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import i18n from '@/i18n'
import { supabase } from '@/lib/supabase'
import { priceQuantity, type SaleMode } from '@/lib/pack-pricing'
import { partPrice, type PartMode } from '@/lib/dose'
import { useSession } from '@/store/session'
import type { Station } from '@/lib/api/visits'
import { sampleDropOrderCharges, sampleOrderCharge } from './billing'
import { sampleBeds } from './desk-ops'
import { apiError, isMissingFunction } from './errors'
import { sampleItemDoses, sampleOpenPieces } from './sample-dose'
import { sampleStock } from './stock'

/**
 * Step 6 of the visit (0127): the doctor's orders, carried out here by a nurse or by himself. Since
 * 0173 there is one clinic stock; since 0193 an order is carried out ONCE:
 *   - a MEDICAL ACT (an injection, a dressing, an IV line…): one press of Done; a treatment of the
 *     price list goes on the bill ("How many on the bill", usually 1), a written one is not billed;
 *   - a MEDICINE of the clinic's stock: what is given here and what the patient takes home leave the
 *     stock together at one press of Given and go on the bill (a whole box at the box price). The
 *     take-home part carries how to take it, printed on the dispensing label.
 * For one nurse, all the nurses, or the doctor himself ("Me"). Undo (the person who recorded it the
 * same day, or the manager) puts the pieces back in the stock and takes the line off the bill.
 * Orders written before 0193 with several times keep counting until they end.
 */
export type NurseOrderKind = 'act' | 'drug'
export type NurseOrderStatus = 'open' | 'done' | 'not_done' | 'cancelled'
/** Why a time carried out is not on the bill (0193). */
export type NotBilledWhy = 'no_price' | 'bill_closed' | 'not_in_price_list'
export interface NurseOrderBatch {
  batchNo: string | null
  expiry: string | null
  quantity: number
}
export interface NurseOrderDose {
  n: number
  given: boolean
  at: string
  by: string | null
  /** Given: the nurse's note; not given: the reason. */
  note: string | null
  charged: boolean
  store?: string | null
  /** 0193 (absent on an older database): the time's id, who recorded it and when. */
  id?: string
  byId?: string | null
  recordedAt?: string | null
  /** A medicine: pieces given here at this time (an older order: each time). */
  quantity?: number | null
  /** Pieces handed over to take home at this time. */
  homeQuantity?: number | null
  /** The desk its bill line went to. */
  office?: string | null
  /** The money its bill lines carry (patient and insurer). */
  billed?: number | null
  onBill?: boolean
  /** The batches it was taken from, earliest expiry first (for the label). */
  batches?: NurseOrderBatch[]
  /** 0198: the time it was planned for, and the part of a piece given then (0.5; 0.05 = 5 ml). */
  dueAt?: string | null
  part?: number | null
}
/** A time undone (0193): back in the stock, off the bill. */
export interface NurseOrderUndone {
  n: number
  at: string
  by: string | null
  quantity: number | null
  homeQuantity: number | null
  undoneAt: string
  undoneBy: string | null
  reason: string | null
  /** 0198: given (or not given), the part, the planned time. */
  given?: boolean
  part?: number | null
  dueAt?: string | null
}
/**
 * 0198: one planned time of a repeated order: given, not given, late (more than an hour past),
 * due (from 30 min before to an hour after), later, or stopped (the order ended before it).
 */
export type TimeState = 'given' | 'not_given' | 'late' | 'due' | 'later' | 'stopped'
export interface OrderTime {
  n: number
  dueAt: string
  state: TimeState
  /** The time recorded (given or not given): its id, who, when. */
  doseId: string | null
  at: string | null
  by: string | null
  byId?: string | null
  recordedAt?: string | null
  note: string | null
  /** Given: whole pieces and the part. */
  quantity: number | null
  part: number | null
  /** Recorded: the money of its bill lines. */
  billed: number | null
}
export interface NurseOrder {
  id: string
  encounterId: string
  kind: NurseOrderKind
  /** What to do (an act), or the medicine (a drug). */
  text: string
  serviceId: string | null
  service: string | null
  itemId: string | null
  item: string | null
  /** An act: how many go on the bill; a drug: pieces given here (an older order: each time). */
  quantity: number
  dose: string | null
  route: string | null
  frequency: string | null
  /** Times planned: 1 for a one-time order; null for a repeated order "until stopped" (0198). */
  dosesPlanned: number | null
  given: number
  notGiven: number
  /** null: all the nurses. */
  assignedTo: string | null
  assignedName: string | null
  status: NurseOrderStatus
  notes: string | null
  at: string
  by: string | null
  byId: string | null
  endedAt: string | null
  endedBy: string | null
  endReason: string | null
  /** For the reader: sent to them by name, or to all nurses and they work at the nursing desk. */
  mine: boolean
  doses: NurseOrderDose[]
  /** 0193: the medicine's piece and box. */
  unit?: string | null
  packSize?: number | null
  packUnit?: string | null
  saleMode?: SaleMode | null
  /** 0193: the part to take home and how to take it. */
  homeQuantity?: number | null
  homeDose?: string | null
  homeFrequency?: string | null
  homeDays?: number | null
  homeInstructions?: string | null
  /** 0193: the times undone (who, when, why). */
  undone?: NurseOrderUndone[]
  /** On the nurse's Home list (nurse_orders_for_me). */
  patient?: string
  fileNumber?: string | null
  patientId?: string
  ticket?: string | null
  /** 0198 (absent on an older database). The dose as typed (the words stay in `dose`). */
  doseAmount?: number | null
  doseUnit?: string | null
  /** The part of a piece given here each time (0.5; 0.05 = 5 ml of a 100 ml bottle), its words. */
  part?: number | null
  partText?: string | null
  /** The price of the part changed on the order (null: by the medicine's rule), who and why. */
  partPrice?: number | null
  partPriceBy?: string | null
  partPriceById?: string | null
  partPriceReason?: string | null
  partMode?: PartMode | null
  /** The (first) time to give; for older orders, when it was written. */
  firstAt?: string
  /** Written with a time (0198 orders). */
  timed?: boolean
  /** Repeated every … minutes; null: once. */
  everyMinutes?: number | null
  untilStopped?: boolean
  /** 0200: recorded by the nurse after doing it, for this task of the doctor (null: an order). */
  taskId?: string | null
  taskTitle?: string | null
  /** 0200: why she recorded it although it was ordered or just given. */
  recordedWhy?: string | null
  /** The earliest planned time not recorded (null: over, or all recorded). */
  nextDueAt?: string | null
  late?: boolean
  /** A repeated order: its planned times (until stopped: up to a day ahead). */
  times?: OrderTime[] | null
  /** The nurse's Home: the bed the patient is in, if any. */
  bed?: string | null
}

/** The new order the doctor writes (0193: carried out once). */
export interface NurseOrderInput {
  encounterId: string
  kind: NurseOrderKind
  /** An act written by hand (not in the price list). */
  text?: string
  serviceId?: string | null
  /** Sample mode: the treatment's name. */
  serviceName?: string | null
  itemId?: string | null
  /** Sample mode: the medicine's name and piece. */
  itemName?: string | null
  itemUnit?: string | null
  /** An act: how many on the bill; a medicine: how many given here (whole pieces). */
  quantity?: number
  dose?: string
  route?: string
  /** 0198: the part of a piece given here each time: 0.5/0.25/0.75 with 'piece', or ml with 'ml'. */
  partAmount?: number | null
  partUnit?: 'piece' | 'ml' | null
  /** Sample mode: the part's words ("½ tab", "5 ml"); the database makes its own. */
  partText?: string | null
  /** The price of the part changed on the order, and why. */
  partPrice?: number | null
  partPriceReason?: string | null
  /** The dose as a number and unit (1, "g"). */
  doseAmount?: number | null
  doseUnit?: string | null
  /** Give at (ISO); null: now. */
  firstAt?: string | null
  /** Repeat: every … minutes, how many times, or until stopped. */
  everyMinutes?: number | null
  times?: number | null
  untilStopped?: boolean
  /** A medicine: how many to take home (whole pieces) and how to take them. */
  homeQuantity?: number
  homeDose?: string
  homeFrequency?: string
  homeDays?: number | null
  homeInstructions?: string
  /** null: all the nurses. */
  assignedTo?: string | null
  /** Sample mode: the nurse's name. */
  assignedName?: string | null
  notes?: string
}

/** What one press of Given / Done answers (0193; an older database: charged only). */
export interface GiveResult {
  charged?: boolean
  notBilled?: NotBilledWhy | null
  billed?: number | null
  doseId?: string | null
}
/** What Undo answers (0193). */
export interface UndoResult {
  /** Pieces back in the clinic's stock. */
  units?: number
  /** 'bill': the lines came off the open bill; 'credit': the bill is closed. */
  mode?: 'bill' | 'credit'
  creditNoteId?: string | null
  /** The credit note: the patient's part, its whole amount, and the insurer's part. */
  credit?: number
  creditTotal?: number
  creditInsurer?: number
  /** Bill lines taken off the open bill. */
  removed?: number
  balance?: number
}

/** How far the order is: "2/3 given". */
export const orderDone = (o: Pick<NurseOrder, 'given' | 'notGiven'>) => o.given + o.notGiven
/** One line of how it is given: "500 mg · oral · TDS · 3 times". */
export const orderHow = (
  o: Pick<NurseOrder, 'dose' | 'route' | 'frequency'>,
  routeWord: (r: string) => string,
  frequencyWord: (f: string) => string,
) =>
  [o.dose, o.route ? routeWord(o.route) : null, o.frequency ? frequencyWord(o.frequency) : null]
    .filter(Boolean)
    .join(' · ')

/** 0198: an order repeated every few hours, recorded time by time. */
export const isRepeated = (o: Partial<Pick<NurseOrder, 'everyMinutes'>>) => o.everyMinutes != null
/**
 * 0193: an order carried out once (every new order without Repeat). Careful: a repeated order
 * "until stopped" has no number of times (null), and `null <= 1` is true in JS.
 */
export const isOnce = (
  o: Pick<NurseOrder, 'dosesPlanned'> & Partial<Pick<NurseOrder, 'everyMinutes'>>,
) => !isRepeated(o) && o.dosesPlanned != null && o.dosesPlanned <= 1
/** An order written before 0193 with several times (given "the next time", bar and log). */
export const isOldTimes = (
  o: Pick<NurseOrder, 'dosesPlanned'> & Partial<Pick<NurseOrder, 'everyMinutes'>>,
) => !isRepeated(o) && (o.dosesPlanned ?? 1) > 1

const MIN = 60_000
/**
 * A planned time against the clock (as the database says it): late more than an hour after it;
 * due from 30 minutes before to an hour after; later before that.
 */
export function dueState(dueAt: string, now = Date.now()): 'late' | 'due' | 'later' {
  const due = Date.parse(dueAt)
  if (now - due > 60 * MIN) return 'late'
  if (due - now <= 30 * MIN) return 'due'
  return 'later'
}
/** A time may be given (or said not given) from two hours before it (the database's limit). */
export const EARLY_MINUTES = 120
export const mayGiveNow = (dueAt: string | null | undefined, now = Date.now()) =>
  !dueAt || Date.parse(dueAt) - now <= EARLY_MINUTES * MIN
/** The state of a planned time now (the database's own, worked out again as the clock moves). */
export function timeState(t: Pick<OrderTime, 'state' | 'dueAt'>, now = Date.now()): TimeState {
  if (t.state === 'given' || t.state === 'not_given' || t.state === 'stopped') return t.state
  return dueState(t.dueAt, now)
}
/** The next time of a repeated order to record: the earliest not recorded (null: none left). */
export function nextTime(o: Pick<NurseOrder, 'status' | 'times'>): OrderTime | null {
  if (o.status !== 'open') return null
  return (o.times ?? []).find((t) => !t.doseId && t.state !== 'stopped') ?? null
}
/** When the order is to be given next: its next planned time, else (older orders) when written. */
export const dueAtOf = (o: Pick<NurseOrder, 'nextDueAt' | 'firstAt' | 'at'>): string =>
  o.nextDueAt ?? o.firstAt ?? o.at
/** "14:05" at the clinic (Kigali, UTC+2), whatever the device's own time zone. */
export const kigaliHM = (iso: string) =>
  new Date(Date.parse(iso) + 2 * 3_600_000).toISOString().slice(11, 16)
/** A medicine's parts: pieces given here, pieces to take home, both together. */
export const orderParts = (o: Pick<NurseOrder, 'kind' | 'quantity' | 'homeQuantity'>) => {
  const here = o.kind === 'drug' ? Number(o.quantity) || 0 : 0
  const home = o.kind === 'drug' ? Number(o.homeQuantity ?? 0) || 0 : 0
  return { here, home, total: here + home }
}
/** The clinic day (Kigali) of a moment. */
const kigaliDay = (iso: string) =>
  new Date(Date.parse(iso) + 2 * 3_600_000).toISOString().slice(0, 10)
const kigaliNow = () => new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10)
/** The times given or done that are still standing. */
export const givenDoses = (o: Pick<NurseOrder, 'doses'>) => o.doses.filter((d) => d.given)
/**
 * Who may undo what was given or done (0193, as undo_nurse_order): the person who recorded every
 * time, the same day; the manager, any day. Not on a cancelled order, and never on a database
 * without 0193 (its times carry no id there, and Undo would always be refused).
 */
export function canUndoOrder(
  o: Pick<NurseOrder, 'status' | 'doses'> & Partial<Pick<NurseOrder, 'everyMinutes'>>,
  myId: string | null | undefined,
  isManager: boolean,
): boolean {
  if (o.status === 'cancelled') return false
  // 0198: a repeated order is undone time by time (canUndoTime)
  if (isRepeated(o)) return false
  const given = givenDoses(o)
  if (!given.length || !given.every((d) => !!d.id)) return false
  if (isManager) return true
  const today = kigaliNow()
  return given.every((d) => !!myId && d.byId === myId && kigaliDay(d.recordedAt ?? d.at) === today)
}
/**
 * 0198: who may undo one recorded time of a repeated order (undo_order_time): the person who
 * recorded it, the same day; the manager, any day.
 */
export function canUndoTime(
  t: Pick<OrderTime, 'doseId' | 'byId' | 'recordedAt' | 'at'>,
  myId: string | null | undefined,
  isManager: boolean,
): boolean {
  if (!t.doseId) return false
  if (isManager) return true
  const when = t.recordedAt ?? t.at
  return !!myId && t.byId === myId && !!when && kigaliDay(when) === kigaliNow()
}
/** Undo ends the order (cancelled) for the doctor who wrote it and the manager; a nurse's Undo
 *  makes it to do again. */
export const undoEndsOrder = (
  o: Pick<NurseOrder, 'byId'>,
  myId: string | null | undefined,
  isManager: boolean,
) => isManager || (!!myId && o.byId === myId)

// ---------------------------------------------------------------- sample mode
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const SAMPLE_MAIN = 'l-pharm'
const sampleOrders: NurseOrder[] = [
  {
    id: 'no-s1',
    encounterId: 'e-1',
    kind: 'act',
    text: 'Injection (IM/IV)',
    serviceId: 'sv-inj',
    service: 'Injection (IM/IV)',
    itemId: null,
    item: null,
    quantity: 1,
    dose: null,
    route: null,
    frequency: null,
    dosesPlanned: 1,
    given: 0,
    notGiven: 0,
    assignedTo: null,
    assignedName: null,
    status: 'open',
    notes: 'Artesunate 120 mg IM; check the allergy band first',
    at: ago(20),
    by: 'Dr. Mukamana Béatrice',
    byId: 'u-doc',
    endedAt: null,
    endedBy: null,
    endReason: null,
    mine: true,
    doses: [],
  },
  // an order written before 0193: three times, still counted
  {
    id: 'no-s2',
    encounterId: 'e-1',
    kind: 'drug',
    text: 'Paracetamol 500 mg',
    serviceId: null,
    service: null,
    itemId: 'it-2',
    item: 'Paracetamol 500 mg',
    quantity: 2,
    dose: '1 g (2 tablets)',
    route: 'oral',
    frequency: 'Q6H',
    dosesPlanned: 3,
    given: 1,
    notGiven: 0,
    assignedTo: 'u-nur',
    assignedName: 'Nyirahabimana Chantal',
    status: 'open',
    notes: null,
    at: ago(19),
    by: 'Dr. Mukamana Béatrice',
    byId: 'u-doc',
    endedAt: null,
    endedBy: null,
    endReason: null,
    mine: true,
    unit: 'tab',
    packSize: 20,
    packUnit: 'box',
    saleMode: 'both',
    doses: [
      {
        id: 'nd-s2-1',
        n: 1,
        given: true,
        at: ago(12),
        by: 'Nyirahabimana Chantal',
        byId: 'u-nur',
        recordedAt: ago(12),
        note: 'With water, temperature 38.9 °C',
        charged: true,
        store: 'Main pharmacy',
        quantity: 2,
        billed: 100,
        onBill: true,
      },
    ],
  },
  // 0193: some given here and the rest of the box to take home, at one press
  {
    id: 'no-s3',
    encounterId: 'e-1',
    kind: 'drug',
    text: 'Paracetamol 500 mg',
    serviceId: null,
    service: null,
    itemId: 'it-2',
    item: 'Paracetamol 500 mg',
    quantity: 2,
    dose: '1 g',
    route: 'oral',
    frequency: null,
    dosesPlanned: 1,
    given: 0,
    notGiven: 0,
    assignedTo: 'u-doc',
    assignedName: 'Dr. Mukamana Béatrice',
    status: 'open',
    notes: null,
    at: ago(8),
    by: 'Dr. Mukamana Béatrice',
    byId: 'u-doc',
    endedAt: null,
    endedBy: null,
    endReason: null,
    mine: true,
    unit: 'tab',
    packSize: 20,
    packUnit: 'box',
    saleMode: 'both',
    homeQuantity: 18,
    homeDose: '2 tablets',
    homeFrequency: 'TDS',
    homeDays: 3,
    homeInstructions: 'after meals',
    doses: [],
  },
  // 0193: a different medicine, only to take home, for the nurses to hand over
  {
    id: 'no-s4',
    encounterId: 'e-1',
    kind: 'drug',
    text: 'Cough syrup 100 ml',
    serviceId: null,
    service: null,
    itemId: 'it-6',
    item: 'Cough syrup 100 ml',
    quantity: 0,
    dose: null,
    route: null,
    frequency: null,
    dosesPlanned: 1,
    given: 0,
    notGiven: 0,
    assignedTo: null,
    assignedName: null,
    status: 'open',
    notes: null,
    at: ago(6),
    by: 'Dr. Mukamana Béatrice',
    byId: 'u-doc',
    endedAt: null,
    endedBy: null,
    endReason: null,
    mine: true,
    unit: 'bottle',
    packSize: null,
    packUnit: null,
    saleMode: 'piece',
    homeQuantity: 1,
    homeDose: '10 ml',
    homeFrequency: 'TDS',
    homeDays: 5,
    homeInstructions: null,
    doses: [],
  },
  // 0198: half a tablet, planned for later (in 1 h 30): one tablet is opened, the half goes on the bill
  {
    ...sampleOnce(),
    id: 'no-s5',
    kind: 'drug',
    text: 'Paracetamol 500 mg',
    itemId: 'it-2',
    item: 'Paracetamol 500 mg',
    quantity: 0,
    dose: '250 mg',
    doseAmount: 250,
    doseUnit: 'mg',
    route: 'oral',
    part: 0.5,
    partText: '½ tab',
    partMode: 'half',
    assignedTo: 'u-nur',
    assignedName: 'Nyirahabimana Chantal',
    at: ago(5),
    firstAt: ago(-90),
    timed: true,
    unit: 'tab',
    packSize: 20,
    packUnit: 'box',
    saleMode: 'both',
  },
  // 0198: repeated every 6 hours, 6 times: given, late, due now, then later
  {
    ...sampleOnce(),
    id: 'no-s6',
    kind: 'drug',
    text: 'Paracetamol 500 mg',
    itemId: 'it-2',
    item: 'Paracetamol 500 mg',
    quantity: 2,
    dose: '1 g',
    doseAmount: 1,
    doseUnit: 'g',
    route: 'oral',
    dosesPlanned: 6,
    given: 1,
    assignedTo: 'u-nur',
    assignedName: 'Nyirahabimana Chantal',
    notes: 'Fever: check the temperature before each time',
    at: ago(13 * 60),
    firstAt: ago(12 * 60 + 40),
    timed: true,
    everyMinutes: 360,
    unit: 'tab',
    packSize: 20,
    packUnit: 'box',
    saleMode: 'both',
    partMode: 'half',
    doses: [
      {
        id: 'nd-s6-1',
        n: 1,
        given: true,
        at: ago(12 * 60 + 30),
        recordedAt: ago(12 * 60 + 30),
        by: 'Umutoni Aline',
        byId: 'u-nur2',
        note: 'Temperature 39.1 °C',
        charged: true,
        store: 'Main pharmacy',
        quantity: 2,
        billed: 100,
        onBill: true,
        dueAt: ago(12 * 60 + 40),
      },
    ],
  },
]
/** A sample order's blank (0198 fields included): what create fills in. */
function sampleOnce(): NurseOrder {
  return {
    id: '',
    encounterId: 'e-1',
    kind: 'drug',
    text: '',
    serviceId: null,
    service: null,
    itemId: null,
    item: null,
    quantity: 1,
    dose: null,
    route: null,
    frequency: null,
    dosesPlanned: 1,
    given: 0,
    notGiven: 0,
    assignedTo: null,
    assignedName: null,
    status: 'open',
    notes: null,
    at: new Date().toISOString(),
    by: 'Dr. Mukamana Béatrice',
    byId: 'u-doc',
    endedAt: null,
    endedBy: null,
    endReason: null,
    mine: false,
    doses: [],
    undone: [],
    everyMinutes: null,
    untilStopped: false,
  }
}
const SAMPLE_PATIENT: Record<string, { patient: string; fileNumber: string; ticket: string }> = {
  'e-1': { patient: 'Mukamana Alice', fileNumber: 'MMC-000124', ticket: 'A-012' },
}
const sampleMine = (o: NurseOrder) => {
  const u = useSession.getState().user
  if (!u) return false
  return o.assignedTo ? o.assignedTo === u.id : u.role === 'nurse'
}
/** Sample mode: the planned times of a repeated order, as order_times / nurse_order_json say them. */
function sampleTimes(o: NurseOrder, now: number): OrderTime[] | null {
  if (o.everyMinutes == null) return null
  const t0 = Date.parse(o.firstAt ?? o.at)
  const step = o.everyMinutes * MIN
  const ended = o.endedAt ? Date.parse(o.endedAt) : Infinity
  const count =
    o.dosesPlanned ??
    Math.min(2000, Math.max(1, Math.floor((Math.min(now + 24 * 60 * MIN, ended) - t0) / step) + 1))
  return Array.from({ length: count }, (_, k): OrderTime => {
    const n = k + 1
    const dueAt = new Date(t0 + k * step).toISOString()
    const d = o.doses.find((x) => x.n === n)
    return {
      n,
      dueAt,
      state: d
        ? d.given
          ? 'given'
          : 'not_given'
        : o.status !== 'open'
          ? 'stopped'
          : dueState(dueAt, now),
      doseId: d?.id ?? null,
      at: d?.at ?? null,
      by: d?.by ?? null,
      byId: d?.byId ?? null,
      recordedAt: d?.recordedAt ?? null,
      note: d?.note ?? null,
      quantity: d?.given && o.kind === 'drug' ? (d.quantity ?? o.quantity) : null,
      part: d?.given ? (d.part ?? null) : null,
      billed: d ? (d.billed ?? 0) : null,
    }
  })
}
const copy = (o: NurseOrder): NurseOrder => {
  const now = Date.now()
  const times = sampleTimes(o, now)
  const firstAt = o.firstAt ?? o.at
  const nextDueAt =
    o.status !== 'open'
      ? null
      : times
        ? (times.find((x) => !x.doseId)?.dueAt ?? null)
        : orderDone(o) < (o.dosesPlanned ?? 1)
          ? firstAt
          : null
  return {
    ...o,
    mine: sampleMine(o),
    doses: o.doses.map((d) => ({ ...d })),
    undone: (o.undone ?? []).map((d) => ({ ...d })),
    firstAt,
    timed: !!o.timed,
    untilStopped: o.everyMinutes != null && o.dosesPlanned == null,
    times,
    nextDueAt,
    late: !!o.timed && !!nextDueAt && now - Date.parse(nextDueAt) > 60 * MIN,
  }
}
/** Sample mode: the visit's orders (all, or the reader's part: theirs and those they gave). */
export function sampleVisitNurseOrders(encounterId: string, desk = false): NurseOrder[] {
  const u = useSession.getState().user
  return sampleOrders
    .filter((o) => o.encounterId === encounterId)
    .filter((o) => !desk || sampleMine(o) || o.byId === u?.id)
    .map(copy)
}
const sampleRefuse = (code: string, message: string, hint?: string) =>
  apiError({ code, message, hint: hint ?? null })
const sampleFind = (id: string) => {
  const o = sampleOrders.find((x) => x.id === id)
  if (!o) throw sampleRefuse('P0002', 'order not found', 'not_found')
  return o
}
const sampleOpen = (id: string) => {
  const o = sampleFind(id)
  if (o.status !== 'open') throw sampleRefuse('22023', 'this order is already over', 'order_over')
  return o
}
/** The next time's number: after the highest one standing (an Undo leaves gaps), as the database. */
const sampleNextTime = (o: NurseOrder) => Math.max(0, ...o.doses.map((d) => d.n)) + 1
const sampleClose = (o: NurseOrder) => {
  // until stopped: never over by itself
  if (o.dosesPlanned != null && orderDone(o) >= o.dosesPlanned) {
    o.status = o.given > 0 ? 'done' : 'not_done'
    o.endedAt = new Date().toISOString()
    o.endedBy = useSession.getState().user?.name ?? null
  }
}
const sampleItem = (itemId: string | null) => sampleStock.items.find((x) => x.id === itemId)
/** Sample mode: what the clinic's stock holds and how each boxed medicine is sold. */
const sampleClinicStock = (): ClinicStock => ({
  units: Object.fromEntries(
    sampleStock.items.map((x) => [x.id, Math.max(0, sampleStock.usable(x.id, SAMPLE_MAIN))]),
  ),
  packs: Object.fromEntries(
    sampleStock.items
      .filter((x) => (x.packSize ?? 1) >= 2)
      .map((x) => [
        x.id,
        {
          size: x.packSize ?? 0,
          packUnit: x.packUnit ?? null,
          mode: (x.saleMode ?? 'piece') as SaleMode,
          packPrice: x.packPrice ?? null,
        },
      ]),
  ),
  // 0198: what the opened pieces still hold at the main pharmacy
  open: sampleOpenPieces
    .filter((p) => p.storeId === SAMPLE_MAIN)
    .reduce<Record<string, number>>(
      (m, p) => ({ ...m, [p.itemId]: (m[p.itemId] ?? 0) + p.left }),
      {},
    ),
  ready198: true,
})

/**
 * 0198 (sample mode): a part of a piece given: taken from the opened piece of the main pharmacy,
 * or one more piece is opened (it leaves the stock whole) when the open one holds less.
 */
function sampleTakePart(itemId: string, itemName: string, part: number, unit: string | null) {
  let rest = part
  for (const p of sampleOpenPieces.filter(
    (x) => x.itemId === itemId && x.storeId === SAMPLE_MAIN,
  )) {
    const use = Math.min(p.left, rest)
    p.left = Math.round((p.left - use) * 1e6) / 1e6
    rest = Math.round((rest - use) * 1e6) / 1e6
    if (rest <= 0) break
  }
  for (let k = sampleOpenPieces.length - 1; k >= 0; k--)
    if (sampleOpenPieces[k]!.left < 1e-6) sampleOpenPieces.splice(k, 1)
  if (rest <= 0) return 0
  if (sampleStock.usable(itemId, SAMPLE_MAIN) < 1)
    throw sampleRefuse('MS003', 'not enough of this medicine', 'room_short')
  sampleStock.move(itemId, SAMPLE_MAIN, null, 1)
  const left = Math.round((1 - rest) * 1e6) / 1e6
  if (left > 1e-6)
    sampleOpenPieces.push({
      id: `op-${Date.now()}`,
      itemId,
      item: itemName,
      storeId: SAMPLE_MAIN,
      store: 'Pharmacy',
      left,
      leftText: `${left} ${unit ?? 'piece'}`,
      batchNo: sampleStock.batchNo[itemId] ?? null,
      expiry: null,
      openedAt: new Date().toISOString(),
      openedBy: useSession.getState().user?.name ?? null,
    })
  return 1
}

/** Sample mode: the price of a part by the medicine's rule (cash bill). */
function samplePartPrice(o: NurseOrder): number | null {
  if (!o.part) return null
  if (o.partPrice != null) return o.partPrice
  const it = sampleItem(o.itemId)
  if (!it || it.sellingPrice == null) return null
  const dose = o.itemId ? sampleItemDoses[o.itemId] : null
  return partPrice(dose, o.part, it.sellingPrice, {
    mode: o.partMode ?? 'half',
    contentMl: dose?.contentAmount ?? null,
    cash: true,
  })
}

/**
 * Sample mode: one time given or done, as give_nurse_order / give_order_time do it: the whole
 * pieces (a one-time order: here + to take home) and the part (from the opened piece, or one more
 * piece opened) leave the stock; the pieces and the part go on the bill as their own lines.
 * `n`: the time of a repeated order (null: the next one).
 */
function sampleGive(
  o: NurseOrder,
  n: number | null,
  note?: string,
  at?: string | null,
): NurseOrder & GiveResult {
  const u = useSession.getState().user
  const { here, home } = orderParts(o)
  const once = isOnce(o)
  const repeated = isRepeated(o)
  if (!repeated && n != null && n !== 1)
    throw sampleRefuse('22023', 'this time is not planned on this order', 'no_such_time')
  if (repeated && n == null)
    throw sampleRefuse(
      '22023',
      'this order is repeated: record each time on its own line',
      'use_time',
    )
  const time = repeated ? (sampleTimes(o, Date.now()) ?? []).find((x) => x.n === n) : null
  if (repeated && !time)
    throw sampleRefuse('22023', 'this time is not planned on this order', 'no_such_time')
  if (time?.doseId) throw sampleRefuse('22023', 'this time is already recorded', 'time_done')
  const dueAt = time?.dueAt ?? (o.timed ? (o.firstAt ?? null) : null)
  if (!mayGiveNow(dueAt))
    throw sampleRefuse(
      '22023',
      'too early: this is planned for more than 2 hours later',
      'too_early',
    )
  const pieces = o.kind === 'drug' ? (once ? here + home : here) : 0
  const it = sampleItem(o.itemId)
  if (o.kind === 'drug' && it && sampleStock.usable(it.id, SAMPLE_MAIN) < pieces)
    throw sampleRefuse('MS003', 'not enough of this medicine', 'room_short')
  if (o.kind === 'drug' && it && pieces > 0) sampleStock.move(it.id, SAMPLE_MAIN, null, pieces)
  // the part: from the opened piece, or one more piece opened
  const part = o.kind === 'drug' && o.part ? o.part : 0
  const opened = part > 0 && it ? sampleTakePart(it.id, o.text, part, o.unit ?? null) : 0
  const wholeBill =
    o.kind === 'drug' && it && pieces > 0
      ? priceQuantity(it, pieces, { cash: true, piecePrice: it.sellingPrice }).total
      : null
  const partBill = part > 0 ? samplePartPrice(o) : null
  const billed =
    o.kind === 'drug'
      ? wholeBill == null && partBill == null
        ? null
        : (wholeBill ?? 0) + (partBill ?? 0)
      : o.serviceId
        ? 1000 * o.quantity
        : null
  const now = new Date().toISOString()
  const doseId = `nd-${Date.now()}`
  const office: Station = u?.role === 'nurse' ? 'nursing' : 'consultation'
  const line = (description: string, quantity: number, total: number) =>
    sampleOrderCharge(o.encounterId, {
      orderId: o.id,
      doseId,
      description,
      itemId: o.kind === 'drug' ? o.itemId : null,
      serviceId: o.kind === 'act' ? o.serviceId : null,
      quantity,
      total,
      office,
      by: u?.name ?? null,
      byId: u?.id ?? null,
    })
  // the bill lines it makes, linked to the order and the time (the bill's Undo)
  if (o.kind === 'drug') {
    if (wholeBill != null) line(o.text, pieces, wholeBill)
    if (partBill != null) line(`${o.text} · ${o.partText ?? part}`, 1, partBill)
  } else if (billed != null) line(o.text, o.quantity, billed)
  o.doses.push({
    id: doseId,
    n: n ?? sampleNextTime(o),
    given: true,
    at: at ?? now,
    recordedAt: now,
    by: u?.name ?? null,
    byId: u?.id ?? null,
    note: note?.trim() || null,
    charged: billed != null,
    store: o.kind === 'drug' ? 'Main pharmacy' : null,
    quantity: o.kind === 'drug' ? here : null,
    homeQuantity: o.kind === 'drug' && once ? (o.homeQuantity ?? null) : null,
    office,
    billed,
    onBill: billed != null,
    dueAt,
    part: part || null,
    batches:
      o.kind === 'drug'
        ? [
            {
              batchNo: sampleStock.batchNo[o.itemId ?? ''] ?? null,
              expiry: it?.earliestExpiry ?? null,
              quantity: pieces + opened,
            },
          ]
        : [],
  })
  o.given += 1
  sampleClose(o)
  return {
    ...copy(o),
    charged: billed != null,
    notBilled: billed != null ? null : 'not_in_price_list',
    billed,
    doseId,
  }
}

/** Sample mode: one recorded time undone (the pieces back, its lines off the bill). */
function sampleUndoDoses(o: NurseOrder, doses: NurseOrderDose[], reason: string): number {
  const u = useSession.getState().user
  const now = new Date().toISOString()
  let units = 0
  for (const d of doses) {
    const pieces = d.given ? Number(d.quantity ?? 0) + Number(d.homeQuantity ?? 0) : 0
    if (o.kind === 'drug' && o.itemId && pieces > 0) {
      sampleStock.move(o.itemId, null, SAMPLE_MAIN, pieces)
      units += pieces
    }
    // the part goes back to its opened piece
    if (d.given && d.part && o.itemId) {
      const p = sampleOpenPieces.find((x) => x.itemId === o.itemId && x.storeId === SAMPLE_MAIN)
      if (p) p.left = Math.min(1, Math.round((p.left + d.part) * 1e6) / 1e6)
    }
    o.undone = [
      ...(o.undone ?? []),
      {
        n: d.n,
        at: d.at,
        by: d.by,
        quantity: d.quantity ?? null,
        homeQuantity: d.homeQuantity ?? null,
        undoneAt: now,
        undoneBy: u?.name ?? null,
        reason,
        given: d.given,
        part: d.part ?? null,
        dueAt: d.dueAt ?? null,
      },
    ]
    if (d.given) o.given -= 1
    else o.notGiven -= 1
  }
  const ids = new Set(doses.map((d) => d.id))
  o.doses = o.doses.filter((d) => !ids.has(d.id))
  sampleDropOrderCharges(
    o.encounterId,
    doses.map((d) => d.id ?? ''),
  )
  return units
}

// ---------------------------------------------------------------- hooks
/** The nurse's Home: the open orders for her (by name, or for all nurses at her desk). */
export function useMyNurseOrders(enabled = true) {
  return useQuery({
    queryKey: ['nurse-orders', 'mine'],
    enabled,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<NurseOrder[]> => {
      if (!supabase)
        return sampleOrders
          .filter((o) => o.status === 'open' && sampleMine(o))
          .map((o) => ({
            ...copy(o),
            mine: true,
            ...SAMPLE_PATIENT[o.encounterId],
            bed:
              sampleBeds.find((b) => b.state === 'occupied' && b.encounterId === o.encounterId)
                ?.name ?? null,
          }))
          .sort((a, b) => Date.parse(dueAtOf(a)) - Date.parse(dueAtOf(b)))
      // 0198: the times more than an hour late are told to the nurses (once a minute at most)
      void catchUpOrderTimes()
      const { data, error } = await supabase.rpc('nurse_orders_for_me')
      if (error) {
        if (isMissingFunction(error)) return []
        throw apiError(error)
      }
      return ((data as NurseOrder[] | null) ?? []).map(numbers)
    },
  })
}

/** The numbers of an order as numbers (numeric columns may come as text). */
export function numbers(o: NurseOrder): NurseOrder {
  const n = (v: unknown) => (v == null || v === '' ? null : Number(v))
  return {
    ...o,
    quantity: Number(o.quantity),
    homeQuantity: n(o.homeQuantity),
    doseAmount: n(o.doseAmount),
    part: n(o.part),
    partPrice: n(o.partPrice),
    everyMinutes: n(o.everyMinutes),
  }
}

let catchUpAt = 0
/**
 * 0198: the times of the orders more than an hour late are told to the nurses, once per time
 * (order_times_catch_up; there is no clock in the database). Run at most once a minute by the
 * nurse's Home list; quiet on a database without it (not asked again for an hour).
 */
export async function catchUpOrderTimes(): Promise<void> {
  if (!supabase) return
  const now = Date.now()
  if (now - catchUpAt < 60_000) return
  catchUpAt = now
  try {
    const { error } = await supabase.rpc('order_times_catch_up')
    if (error && isMissingFunction(error)) catchUpAt = now + 3_600_000
  } catch {
    // the list shows as it is
  }
}

/** The nurses an order may be sent to by name (0127 order_nurses). */
export function useOrderNurses(enabled = true) {
  return useQuery({
    queryKey: ['nurse-orders', 'nurses'],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<{ id: string; name: string }[]> => {
      if (!supabase)
        return [
          { id: 'u-nur', name: 'Nyirahabimana Chantal' },
          { id: 'u-nur2', name: 'Umutoni Aline' },
        ]
      const { data, error } = await supabase.rpc('order_nurses')
      if (error) {
        if (isMissingFunction(error)) return []
        throw apiError(error)
      }
      return (data as { id: string; name: string }[] | null) ?? []
    },
  })
}

/** A boxed medicine (0193 rx_stock packs): pieces in one box, its word, how it is sold, its price. */
export interface ClinicPack {
  size: number
  packUnit: string | null
  mode: SaleMode
  packPrice: number | null
}
/** The clinic's stock as the order form sees it: usable pieces per medicine and the boxes. */
export interface ClinicStock {
  units: Record<string, number>
  packs: Record<string, ClinicPack>
  /** 0198: what the opened pieces still hold (of one piece), per medicine, at the main pharmacy. */
  open?: Record<string, number>
  /**
   * The database has 0198 (rx_stock answers `open`): the order form offers a part of a piece,
   * Give at and Repeat. Without it the form is the one of 0193.
   */
  ready198: boolean
}
/**
 * The order form's picker (0193): how many of each medicine the clinic's stock holds (not expired)
 * and each box. Null before 0100 (the form then says nothing about the stock).
 */
export function useClinicStock(enabled = true) {
  return useQuery({
    queryKey: ['stock', 'rx-stock', 'packs'],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<ClinicStock | null> => {
      if (!supabase) return sampleClinicStock()
      const { data, error } = await supabase.rpc('rx_stock')
      if (error) {
        if (isMissingFunction(error)) return null
        throw apiError(error)
      }
      const d = (data ?? {}) as {
        items?: Record<string, number | string>
        packs?: Record<
          string,
          { size: number | string; packUnit: string | null; mode: string; packPrice: number | null }
        >
        open?: Record<string, number | string>
      }
      return {
        // 0198: `open` is always there on a database that has it (the probe)
        ready198: !!d.open && typeof d.open === 'object',
        open: Object.fromEntries(Object.entries(d.open ?? {}).map(([k, v]) => [k, Number(v)])),
        units: Object.fromEntries(Object.entries(d.items ?? {}).map(([k, v]) => [k, Number(v)])),
        packs: Object.fromEntries(
          Object.entries(d.packs ?? {}).map(([k, p]) => [
            k,
            {
              size: Number(p.size),
              packUnit: p.packUnit ?? null,
              mode: (p.mode === 'pack' || p.mode === 'both' ? p.mode : 'piece') as SaleMode,
              packPrice: p.packPrice == null ? null : Number(p.packPrice),
            },
          ]),
        ),
      }
    },
  })
}

export function useNurseOrderActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['nurse-orders'] })
    void qc.invalidateQueries({ queryKey: ['visit'] })
    void qc.invalidateQueries({ queryKey: ['nav-counts'] })
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }
  /** Given / Undo move the stock too. */
  const refreshStock = () => {
    refresh()
    void qc.invalidateQueries({ queryKey: ['stock'] })
  }
  const call = async <R = object>(fn: string, args: Record<string, unknown>) => {
    const { data, error } = await supabase!.rpc(fn, args)
    if (error) throw apiError(error)
    return data as NurseOrder & R
  }
  /** The doctor writes an order (0193 create_order_here; doctors only). */
  const create = useMutation({
    mutationFn: async (i: NurseOrderInput): Promise<NurseOrder> => {
      const here = i.kind === 'drug' ? (i.quantity ?? 0) : 0
      const home = i.kind === 'drug' ? (i.homeQuantity ?? 0) : 0
      const partAmount = i.kind === 'drug' ? (i.partAmount ?? 0) : 0
      const repeated = i.everyMinutes != null
      if (!supabase) {
        const u = useSession.getState().user
        if (i.kind === 'drug' && !i.itemId)
          throw sampleRefuse('22023', 'choose the medicine from the stock', 'item_needed')
        if (i.kind === 'drug' && (!Number.isInteger(here) || !Number.isInteger(home)))
          throw sampleRefuse(
            '22023',
            'a medicine is counted in whole pieces (tablets, capsules, bottles): write a half in the dose',
          )
        if (i.kind === 'drug' && here + home + partAmount <= 0)
          throw sampleRefuse('22023', 'say how many are given here or taken home')
        if (repeated && i.kind === 'drug' && here + partAmount <= 0)
          throw sampleRefuse(
            '22023',
            'a repeated order gives something here each time',
            'repeat_here',
          )
        const it = sampleItem(i.itemId ?? null)
        const doseOf = i.itemId ? sampleItemDoses[i.itemId] : null
        // the part in pieces: ½ = 0.5; 5 ml of a 100 ml bottle = 0.05
        const part =
          partAmount > 0
            ? i.partUnit === 'ml'
              ? partAmount / (doseOf?.contentAmount || 1)
              : partAmount
            : null
        const o: NurseOrder = {
          id: `no-${Date.now()}`,
          encounterId: i.encounterId,
          kind: i.kind,
          text:
            i.kind === 'drug'
              ? (i.itemName ?? '')
              : i.serviceId
                ? (i.serviceName ?? '')
                : (i.text ?? '').trim(),
          serviceId: i.kind === 'act' ? (i.serviceId ?? null) : null,
          service: i.kind === 'act' ? (i.serviceName ?? null) : null,
          itemId: i.kind === 'drug' ? (i.itemId ?? null) : null,
          item: i.kind === 'drug' ? (i.itemName ?? null) : null,
          quantity: i.kind === 'drug' ? here : (i.quantity ?? 1),
          dose: i.kind === 'drug' && here + partAmount > 0 ? i.dose?.trim() || null : null,
          route: i.kind === 'drug' && here + partAmount > 0 ? i.route || null : null,
          frequency: null,
          given: 0,
          notGiven: 0,
          assignedTo: i.assignedTo ?? null,
          assignedName: i.assignedName ?? null,
          status: 'open',
          notes: i.notes?.trim() || null,
          at: new Date().toISOString(),
          by: u?.name ?? null,
          byId: u?.id ?? null,
          endedAt: null,
          endedBy: null,
          endReason: null,
          mine: false,
          doses: [],
          unit: i.itemUnit ?? it?.unit ?? null,
          packSize: it?.packSize ?? null,
          packUnit: it?.packUnit ?? null,
          saleMode: (it?.saleMode as SaleMode | undefined) ?? null,
          homeQuantity: home > 0 ? home : null,
          homeDose: home > 0 ? i.homeDose?.trim() || null : null,
          homeFrequency: home > 0 ? i.homeFrequency || null : null,
          homeDays: home > 0 ? (i.homeDays ?? null) : null,
          homeInstructions: home > 0 ? i.homeInstructions?.trim() || null : null,
          undone: [],
          // 0198
          doseAmount: i.doseAmount ?? null,
          doseUnit: i.doseUnit ?? null,
          part,
          partText: part ? (i.partText ?? null) : null,
          partPrice: part && i.partPrice != null ? i.partPrice : null,
          partPriceBy: part && i.partPrice != null ? (u?.name ?? null) : null,
          partPriceById: part && i.partPrice != null ? (u?.id ?? null) : null,
          partPriceReason: part && i.partPrice != null ? (i.partPriceReason ?? null) : null,
          partMode: doseOf?.partModeNow ?? null,
          firstAt: i.firstAt ?? new Date().toISOString(),
          timed: i.kind === 'act' || here + partAmount > 0,
          everyMinutes: i.everyMinutes ?? null,
          dosesPlanned: repeated ? (i.untilStopped ? null : (i.times ?? 2)) : 1,
          untilStopped: repeated && !!i.untilStopped,
        }
        if (o.text.trim().length < 2) throw sampleRefuse('22023', 'say what must be done')
        // a repeated order with some to take home: two orders, the one to take home handed over once
        if (repeated && home > 0) {
          const homeOrder: NurseOrder = {
            ...o,
            id: `${o.id}-home`,
            quantity: 0,
            dose: null,
            route: null,
            doseAmount: null,
            doseUnit: null,
            part: null,
            partText: null,
            partPrice: null,
            everyMinutes: null,
            dosesPlanned: 1,
            untilStopped: false,
            timed: false,
          }
          sampleOrders.push(
            {
              ...o,
              homeQuantity: null,
              homeDose: null,
              homeFrequency: null,
              homeDays: null,
              homeInstructions: null,
            },
            homeOrder,
          )
          return copy(sampleOrders.at(-2)!)
        }
        sampleOrders.push(o)
        return copy(o)
      }
      // 0198: the dose as a number, a part of a piece, give at, repeat
      const usesNew = partAmount > 0 || repeated || !!i.firstAt
      const planned = await supabase.rpc('create_order_planned', {
        p_encounter_id: i.encounterId,
        p_kind: i.kind,
        p_item_id: i.kind === 'drug' ? (i.itemId ?? null) : null,
        p_service_id: i.kind === 'act' ? (i.serviceId ?? null) : null,
        p_text: i.kind === 'act' && !i.serviceId ? i.text?.trim() || null : null,
        p_quantity: i.kind === 'drug' ? here : (i.quantity ?? 1),
        p_part_amount: partAmount > 0 ? partAmount : null,
        p_part_unit: partAmount > 0 ? (i.partUnit ?? 'piece') : null,
        p_dose_amount: i.doseAmount ?? null,
        p_dose_unit: i.doseAmount != null ? i.doseUnit?.trim() || null : null,
        p_dose: i.dose?.trim() || null,
        p_route: i.route || null,
        p_part_price: partAmount > 0 && i.partPrice != null ? i.partPrice : null,
        p_part_price_reason:
          partAmount > 0 && i.partPrice != null ? i.partPriceReason?.trim() || null : null,
        p_first_at: i.firstAt ?? null,
        p_every_minutes: i.everyMinutes ?? null,
        p_times: repeated && !i.untilStopped ? (i.times ?? null) : null,
        p_until_stopped: repeated && !!i.untilStopped,
        p_home_quantity: home > 0 ? home : null,
        p_home_dose: i.homeDose?.trim() || null,
        p_home_frequency: i.homeFrequency || null,
        p_home_days: i.homeDays ?? null,
        p_home_instructions: i.homeInstructions?.trim() || null,
        p_assigned_to: i.assignedTo ?? null,
        p_notes: i.notes?.trim() || null,
      })
      if (!planned.error) {
        const d = planned.data as NurseOrder | { order: NurseOrder; homeOrder: NurseOrder }
        return 'order' in d && d.order ? d.order : (d as NurseOrder)
      }
      if (!isMissingFunction(planned.error)) throw apiError(planned.error)
      // a database before 0198: only an order of before (no part, no time, no repeat)
      if (usesNew) throw new Error(i18n.t('nurseOrders.dbOld'))
      const { data, error } = await supabase.rpc('create_order_here', {
        p_encounter_id: i.encounterId,
        p_kind: i.kind,
        p_item_id: i.kind === 'drug' ? (i.itemId ?? null) : null,
        p_service_id: i.kind === 'act' ? (i.serviceId ?? null) : null,
        p_text: i.kind === 'act' && !i.serviceId ? i.text?.trim() || null : null,
        p_quantity: i.kind === 'drug' ? here : (i.quantity ?? 1),
        p_dose: i.dose?.trim() || null,
        p_route: i.route || null,
        p_home_quantity: home > 0 ? home : null,
        p_home_dose: i.homeDose?.trim() || null,
        p_home_frequency: i.homeFrequency || null,
        p_home_days: i.homeDays ?? null,
        p_home_instructions: i.homeInstructions?.trim() || null,
        p_assigned_to: i.assignedTo ?? null,
        p_notes: i.notes?.trim() || null,
      })
      if (!error) return data as NurseOrder
      if (!isMissingFunction(error)) throw apiError(error)
      // a database before 0193: the order of before, carried out once (nothing to take home)
      if (home > 0) throw new Error(i18n.t('nurseOrders.dbOld'))
      return call('create_nurse_order', {
        p_encounter_id: i.encounterId,
        p_kind: i.kind,
        p_text: i.kind === 'act' && !i.serviceId ? i.text?.trim() || null : null,
        p_service_id: i.kind === 'act' ? (i.serviceId ?? null) : null,
        p_item_id: i.kind === 'drug' ? (i.itemId ?? null) : null,
        p_quantity: i.kind === 'drug' ? here : (i.quantity ?? 1),
        p_dose: i.dose?.trim() || null,
        p_route: i.route || null,
        p_frequency: null,
        p_doses: 1,
        p_assigned_to: i.assignedTo ?? null,
        p_notes: i.notes?.trim() || null,
      })
    },
    onSuccess: refresh,
  })
  /** Given / Handed over / Done: one press (a medicine: here + to take home, from the clinic's
   *  stock; billed). An older order of several times: one time. */
  const give = useMutation({
    mutationFn: async (i: {
      id: string
      note?: string
      at?: string | null
    }): Promise<NurseOrder & GiveResult> => {
      if (!supabase) return sampleGive(sampleOpen(i.id), null, i.note, i.at)
      return call<GiveResult>('give_nurse_order', {
        p_order_id: i.id,
        p_note: i.note?.trim() || null,
        p_at: i.at ?? null,
      })
    },
    onSuccess: refreshStock,
  })
  /** One time not given, with the reason (an older order of several times). */
  const skip = useMutation({
    mutationFn: async (i: { id: string; reason: string }) => {
      if (!supabase) {
        const o = sampleOpen(i.id)
        if (i.reason.trim().length < 3) throw sampleRefuse('22023', 'say why')
        o.doses.push({
          n: sampleNextTime(o),
          given: false,
          at: new Date().toISOString(),
          by: useSession.getState().user?.name ?? null,
          note: i.reason.trim(),
          charged: false,
        })
        o.notGiven += 1
        sampleClose(o)
        return copy(o)
      }
      return call('skip_nurse_dose', { p_order_id: i.id, p_reason: i.reason.trim() })
    },
    onSuccess: refresh,
  })
  /** The doctor cancels the order; the nurse says the rest will not be done. */
  const stop = useMutation({
    mutationFn: async (i: { id: string; reason: string }) => {
      if (!supabase) {
        const o = sampleOpen(i.id)
        if (i.reason.trim().length < 3) throw sampleRefuse('22023', 'say why')
        const u = useSession.getState().user
        const doctor = o.byId === u?.id || u?.role === 'manager'
        if (isRepeated(o)) {
          // 0198: the doctor stops the rest of a repeated order; the nurse says Not given per time
          if (!doctor)
            throw sampleRefuse(
              '42501',
              'only the doctor who wrote it (or the manager) stops a repeated order',
              'doctor_stops',
            )
          o.status = o.given > 0 ? 'done' : 'cancelled'
          o.endReason = `stopped: ${i.reason.trim()}`
        } else {
          o.status = doctor ? 'cancelled' : 'not_done'
          o.endReason = i.reason.trim()
        }
        o.endedAt = new Date().toISOString()
        o.endedBy = u?.name ?? null
        return copy(o)
      }
      return call('stop_nurse_order', { p_order_id: i.id, p_reason: i.reason.trim() })
    },
    onSuccess: refresh,
  })
  /** 0198: one time of a repeated order given or done (give_order_time). */
  const giveTime = useMutation({
    mutationFn: async (i: {
      id: string
      n: number
      note?: string
      at?: string | null
    }): Promise<NurseOrder & GiveResult> => {
      if (!supabase) return sampleGive(sampleOpen(i.id), i.n, i.note, i.at)
      const { data, error } = await supabase.rpc('give_order_time', {
        p_order_id: i.id,
        p_n: i.n,
        p_note: i.note?.trim() || null,
        p_at: i.at ?? null,
      })
      if (error) {
        if (isMissingFunction(error)) throw new Error(i18n.t('nurseOrders.dbOld'))
        throw apiError(error)
      }
      return data as NurseOrder & GiveResult
    },
    onSuccess: refreshStock,
  })
  /** 0198: one time of a repeated order not given, with the reason (skip_order_time). */
  const skipTime = useMutation({
    mutationFn: async (i: { id: string; n: number; reason: string }): Promise<NurseOrder> => {
      const reason = i.reason.trim()
      if (!supabase) {
        const o = sampleOpen(i.id)
        if (reason.length < 3) throw sampleRefuse('22023', 'say why')
        const time = (sampleTimes(o, Date.now()) ?? []).find((x) => x.n === i.n)
        if (!time)
          throw sampleRefuse('22023', 'this time is not planned on this order', 'no_such_time')
        if (time.doseId) throw sampleRefuse('22023', 'this time is already recorded', 'time_done')
        if (!mayGiveNow(time.dueAt))
          throw sampleRefuse(
            '22023',
            'too early: this is planned for more than 2 hours later',
            'too_early',
          )
        const u = useSession.getState().user
        const now = new Date().toISOString()
        o.doses.push({
          id: `nd-${Date.now()}`,
          n: i.n,
          given: false,
          at: now,
          recordedAt: now,
          by: u?.name ?? null,
          byId: u?.id ?? null,
          note: reason,
          charged: false,
          dueAt: time.dueAt,
        })
        o.notGiven += 1
        sampleClose(o)
        return copy(o)
      }
      const { data, error } = await supabase.rpc('skip_order_time', {
        p_order_id: i.id,
        p_n: i.n,
        p_reason: reason,
      })
      if (error) {
        if (isMissingFunction(error)) throw new Error(i18n.t('nurseOrders.dbOld'))
        throw apiError(error)
      }
      return data as NurseOrder
    },
    onSuccess: refresh,
  })
  /**
   * 0198: one recorded time of a repeated order undone (undo_order_time): a Given time back to
   * the stock and off the bill (a credit note on a closed bill); a Not given one withdrawn. The
   * order stays open and the time can be recorded again.
   */
  const undoTime = useMutation({
    mutationFn: async (i: {
      orderId: string
      doseId: string
      reason: string
    }): Promise<NurseOrder & UndoResult> => {
      const reason = i.reason.trim()
      if (!supabase) {
        const o = sampleFind(i.orderId)
        const u = useSession.getState().user
        if (reason.length < 3) throw sampleRefuse('22023', 'say why')
        const d = o.doses.find((x) => x.id === i.doseId)
        if (!d)
          throw sampleRefuse(
            'P0002',
            'this time is not recorded (or already undone)',
            'no_such_time',
          )
        const t = { doseId: d.id ?? null, byId: d.byId, recordedAt: d.recordedAt, at: d.at }
        if (!canUndoTime(t, u?.id, u?.role === 'manager'))
          throw sampleRefuse('42501', 'only the person who gave it (or the manager) can undo it')
        const units = sampleUndoDoses(o, [d], reason)
        // an order over only because every time was recorded opens again while the visit is open
        if (o.status === 'done' || o.status === 'not_done') {
          if (!o.endReason) {
            o.status = 'open'
            o.endedAt = null
            o.endedBy = null
          }
        }
        return {
          ...copy(o),
          units,
          mode: 'bill',
          creditNoteId: null,
          credit: 0,
          creditTotal: 0,
          creditInsurer: 0,
          removed: d.given && d.billed != null ? 1 : 0,
          balance: 0,
        }
      }
      const { data, error } = await supabase.rpc('undo_order_time', {
        p_dose_id: i.doseId,
        p_reason: reason,
      })
      if (error) {
        if (isMissingFunction(error)) throw new Error(i18n.t('nurseOrders.dbOld'))
        throw apiError(error)
      }
      return data as NurseOrder & UndoResult
    },
    onSuccess: refreshStock,
  })
  /**
   * Undo what was given or done (0193 undo_nurse_order): back to the clinic's stock, off the bill
   * (a credit note on a closed bill). The doctor who wrote it or the manager: the order is
   * cancelled; the nurse who gave it: it is to do again.
   */
  const undo = useMutation({
    mutationFn: async (i: { id: string; reason: string }): Promise<NurseOrder & UndoResult> => {
      const reason = i.reason.trim()
      if (!supabase) {
        const o = sampleFind(i.id)
        const u = useSession.getState().user
        const manager = u?.role === 'manager'
        if (reason.length < 3) throw sampleRefuse('22023', 'say why')
        const given = givenDoses(o)
        if (!given.length)
          throw sampleRefuse(
            '22023',
            'nothing was given or done on this order: there is nothing to undo',
          )
        if (!canUndoOrder(o, u?.id, manager))
          throw sampleRefuse('42501', 'only the person who gave it (or the manager) can undo it')
        const now = new Date().toISOString()
        const lines = given.filter((d) => d.onBill ?? d.charged).length
        // the pieces back, the part back to its opened piece, the lines off the bill
        const units = sampleUndoDoses(o, given, reason)
        const removed = lines
        // an order already over (cancelled or not done) stays so: only its times are undone
        const over = o.status === 'cancelled' || o.status === 'not_done'
        if (!over && undoEndsOrder(o, u?.id, manager)) {
          o.status = 'cancelled'
          o.endedAt = now
          o.endedBy = u?.name ?? null
          o.endReason = `undone: ${reason}`
        } else if (!over) {
          o.status = 'open'
          o.endedAt = null
          o.endedBy = null
          o.endReason = null
        }
        return {
          ...copy(o),
          units,
          mode: 'bill',
          creditNoteId: null,
          credit: 0,
          creditTotal: 0,
          creditInsurer: 0,
          removed,
          balance: 0,
        }
      }
      const { data, error } = await supabase.rpc('undo_nurse_order', {
        p_order_id: i.id,
        p_reason: reason,
      })
      if (error) {
        if (isMissingFunction(error)) throw new Error(i18n.t('nurseOrders.dbOld'))
        throw apiError(error)
      }
      return data as NurseOrder & UndoResult
    },
    onSuccess: refreshStock,
  })
  return { create, give, skip, stop, undo, giveTime, skipTime, undoTime }
}

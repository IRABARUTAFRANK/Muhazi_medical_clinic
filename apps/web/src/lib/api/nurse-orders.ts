import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import i18n from '@/i18n'
import { supabase } from '@/lib/supabase'
import { priceQuantity, type SaleMode } from '@/lib/pack-pricing'
import { useSession } from '@/store/session'
import { apiError, isMissingFunction } from './errors'
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
  dosesPlanned: number
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
  units?: number
  mode?: 'bill' | 'credit'
  creditNoteId?: string | null
  credit?: number
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

/** 0193: an order carried out once (every new order); an older one may count several times. */
export const isOnce = (o: Pick<NurseOrder, 'dosesPlanned'>) => o.dosesPlanned <= 1
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
 * time, the same day; the manager, any day. Not on a cancelled order.
 */
export function canUndoOrder(
  o: Pick<NurseOrder, 'status' | 'doses'>,
  myId: string | null | undefined,
  isManager: boolean,
): boolean {
  if (o.status === 'cancelled') return false
  const given = givenDoses(o)
  if (!given.length) return false
  if (isManager) return true
  const today = kigaliNow()
  return given.every((d) => !!myId && d.byId === myId && kigaliDay(d.recordedAt ?? d.at) === today)
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
]
const SAMPLE_PATIENT: Record<string, { patient: string; fileNumber: string; ticket: string }> = {
  'e-1': { patient: 'Mukamana Alice', fileNumber: 'MMC-000124', ticket: 'A-012' },
}
const sampleMine = (o: NurseOrder) => {
  const u = useSession.getState().user
  if (!u) return false
  return o.assignedTo ? o.assignedTo === u.id : u.role === 'nurse'
}
const copy = (o: NurseOrder): NurseOrder => ({
  ...o,
  mine: sampleMine(o),
  doses: o.doses.map((d) => ({ ...d })),
  undone: (o.undone ?? []).map((d) => ({ ...d })),
})
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
const sampleClose = (o: NurseOrder) => {
  if (orderDone(o) >= o.dosesPlanned) {
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
})

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
          .map((o) => ({ ...copy(o), mine: true, ...SAMPLE_PATIENT[o.encounterId] }))
      const { data, error } = await supabase.rpc('nurse_orders_for_me')
      if (error) {
        if (isMissingFunction(error)) return []
        throw apiError(error)
      }
      return ((data as NurseOrder[] | null) ?? []).map((o) => ({
        ...o,
        quantity: Number(o.quantity),
      }))
    },
  })
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
      }
      return {
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
      if (!supabase) {
        const u = useSession.getState().user
        if (i.kind === 'drug' && !i.itemId)
          throw sampleRefuse('22023', 'choose the medicine from the stock', 'item_needed')
        if (i.kind === 'drug' && (!Number.isInteger(here) || !Number.isInteger(home)))
          throw sampleRefuse(
            '22023',
            'a medicine is counted in whole pieces (tablets, capsules, bottles): write a half in the dose',
          )
        if (i.kind === 'drug' && here + home <= 0)
          throw sampleRefuse('22023', 'say how many are given here or taken home')
        const it = sampleItem(i.itemId ?? null)
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
          dose: i.kind === 'drug' && here > 0 ? i.dose?.trim() || null : null,
          route: i.kind === 'drug' && here > 0 ? i.route || null : null,
          frequency: null,
          dosesPlanned: 1,
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
        }
        if (o.text.trim().length < 2) throw sampleRefuse('22023', 'say what must be done')
        sampleOrders.push(o)
        return o
      }
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
      if (!supabase) {
        const o = sampleOpen(i.id)
        const u = useSession.getState().user
        const { here, home } = orderParts(o)
        const pieces = o.kind === 'drug' ? (isOnce(o) ? here + home : here) : 0
        const it = sampleItem(o.itemId)
        if (o.kind === 'drug' && it && sampleStock.usable(it.id, SAMPLE_MAIN) < pieces)
          throw sampleRefuse('MS003', 'not enough of this medicine', 'room_short')
        if (o.kind === 'drug' && it) sampleStock.move(it.id, SAMPLE_MAIN, null, pieces)
        const billed =
          o.kind === 'drug' && it
            ? priceQuantity(it, pieces, { cash: true, piecePrice: it.sellingPrice }).total
            : o.serviceId
              ? 1000 * o.quantity
              : null
        const now = new Date().toISOString()
        o.doses.push({
          id: `nd-${Date.now()}`,
          n: o.doses.length + 1,
          given: true,
          at: i.at ?? now,
          recordedAt: now,
          by: u?.name ?? null,
          byId: u?.id ?? null,
          note: i.note?.trim() || null,
          charged: billed != null,
          store: o.kind === 'drug' ? 'Main pharmacy' : null,
          quantity: o.kind === 'drug' ? here : null,
          homeQuantity: o.kind === 'drug' && isOnce(o) ? (o.homeQuantity ?? null) : null,
          office: u?.role === 'nurse' ? 'nursing' : 'consultation',
          billed,
          onBill: billed != null,
          batches:
            o.kind === 'drug'
              ? [
                  {
                    batchNo: sampleStock.batchNo[o.itemId ?? ''] ?? null,
                    expiry: it?.earliestExpiry ?? null,
                    quantity: pieces,
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
          doseId: o.doses.at(-1)?.id ?? null,
        }
      }
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
          n: o.doses.length + 1,
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
        o.status = o.byId === u?.id || u?.role === 'manager' ? 'cancelled' : 'not_done'
        o.endReason = i.reason.trim()
        o.endedAt = new Date().toISOString()
        o.endedBy = u?.name ?? null
        return copy(o)
      }
      return call('stop_nurse_order', { p_order_id: i.id, p_reason: i.reason.trim() })
    },
    onSuccess: refresh,
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
        let units = 0
        const now = new Date().toISOString()
        for (const d of given) {
          const pieces = Number(d.quantity ?? 0) + Number(d.homeQuantity ?? 0)
          if (o.kind === 'drug' && o.itemId && pieces > 0) {
            sampleStock.move(o.itemId, null, SAMPLE_MAIN, pieces)
            units += pieces
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
            },
          ]
        }
        o.doses = o.doses.filter((d) => !d.given)
        o.given = 0
        if (undoEndsOrder(o, u?.id, manager)) {
          o.status = 'cancelled'
          o.endedAt = now
          o.endedBy = u?.name ?? null
          o.endReason = `undone: ${reason}`
        } else {
          o.status = 'open'
          o.endedAt = null
          o.endedBy = null
          o.endReason = null
        }
        return { ...copy(o), units, mode: 'bill', creditNoteId: null, credit: 0, balance: 0 }
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
  return { create, give, skip, stop, undo }
}

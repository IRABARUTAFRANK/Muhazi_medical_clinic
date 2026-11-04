import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { apiError, isMissingFunction } from './errors'

/**
 * Step 6 of the visit (0127): the doctor's orders to the nurses. A MEDICAL ACT (an injection, a
 * dressing, an IV line…; a treatment of the catalogue is billed each time it is done) or a DRUG TO
 * GIVE (a medicine of the stock: dose, route, how often, how many times; taken from the room
 * store the nurse holds and billed each time it is given). For one nurse, or all the nurses (the
 * nursing desk). The nurse records each time given (when, by whom) or not given with the reason;
 * the order ends done, not done (the nurse) or cancelled (the doctor).
 */
export type NurseOrderKind = 'act' | 'drug'
export type NurseOrderStatus = 'open' | 'done' | 'not_done' | 'cancelled'
export interface NurseOrderDose {
  n: number
  given: boolean
  at: string
  by: string | null
  /** Given: the nurse's note; not given: the reason. */
  note: string | null
  charged: boolean
  store?: string | null
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
  /** An act: how many are charged each time; a drug: units of the medicine each time. */
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
  /** On the nurse's Home list (nurse_orders_for_me). */
  patient?: string
  fileNumber?: string | null
  patientId?: string
  ticket?: string | null
}

/** The new order the doctor writes. */
export interface NurseOrderInput {
  encounterId: string
  kind: NurseOrderKind
  text?: string
  serviceId?: string | null
  /** Sample mode: the treatment's name. */
  serviceName?: string | null
  itemId?: string | null
  /** Sample mode: the medicine's name. */
  itemName?: string | null
  quantity?: number
  dose?: string
  route?: string
  frequency?: string
  doses?: number
  /** null: all the nurses. */
  assignedTo?: string | null
  /** Sample mode: the nurse's name. */
  assignedName?: string | null
  notes?: string
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

// ---------------------------------------------------------------- sample mode
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const sampleOrders: NurseOrder[] = [
  {
    id: 'no-s1',
    encounterId: 'e-1',
    kind: 'act',
    text: 'IM injection: artesunate 120 mg, now',
    serviceId: 'sv-inj',
    service: 'Injection (IM/IV)',
    itemId: null,
    item: null,
    quantity: 1,
    dose: null,
    route: 'IM',
    frequency: 'STAT',
    dosesPlanned: 1,
    given: 0,
    notGiven: 0,
    assignedTo: null,
    assignedName: null,
    status: 'open',
    notes: 'Check the allergy band first',
    at: ago(20),
    by: 'Dr. Mukamana Béatrice',
    byId: 'u-doc',
    endedAt: null,
    endedBy: null,
    endReason: null,
    mine: true,
    doses: [],
  },
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
    doses: [
      {
        n: 1,
        given: true,
        at: ago(12),
        by: 'Nyirahabimana Chantal',
        note: 'With water, temperature 38.9 °C',
        charged: true,
        store: 'Ward store',
      },
    ],
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
/** Sample mode: the visit's orders (all, or the reader's part: theirs and those they gave). */
export function sampleVisitNurseOrders(encounterId: string, desk = false): NurseOrder[] {
  const u = useSession.getState().user
  return sampleOrders
    .filter((o) => o.encounterId === encounterId)
    .filter((o) => !desk || sampleMine(o) || o.byId === u?.id)
    .map((o) => ({ ...o, mine: sampleMine(o), doses: [...o.doses] }))
}
const sampleRefuse = (code: string, message: string, hint?: string) =>
  apiError({ code, message, hint: hint ?? null })
const sampleFind = (id: string) => {
  const o = sampleOrders.find((x) => x.id === id)
  if (!o) throw sampleRefuse('P0002', 'order not found', 'not_found')
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
          .map((o) => ({ ...o, mine: true, ...SAMPLE_PATIENT[o.encounterId] }))
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

export function useNurseOrderActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['nurse-orders'] })
    void qc.invalidateQueries({ queryKey: ['visit'] })
    void qc.invalidateQueries({ queryKey: ['nav-counts'] })
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }
  const call = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await supabase!.rpc(fn, args)
    if (error) throw apiError(error)
    return data as NurseOrder & { charged?: boolean }
  }
  /** The doctor gives an order (0127 create_nurse_order: doctors only). */
  const create = useMutation({
    mutationFn: async (i: NurseOrderInput) => {
      if (!supabase) {
        const u = useSession.getState().user
        const o: NurseOrder = {
          id: `no-${Date.now()}`,
          encounterId: i.encounterId,
          kind: i.kind,
          text: i.text?.trim() || (i.kind === 'drug' ? (i.itemName ?? '') : (i.serviceName ?? '')),
          serviceId: i.kind === 'act' ? (i.serviceId ?? null) : null,
          service: i.kind === 'act' ? (i.serviceName ?? null) : null,
          itemId: i.kind === 'drug' ? (i.itemId ?? null) : null,
          item: i.kind === 'drug' ? (i.itemName ?? null) : null,
          quantity: i.quantity ?? 1,
          dose: i.dose?.trim() || null,
          route: i.route || null,
          frequency: i.frequency || null,
          dosesPlanned: i.doses ?? 1,
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
        }
        if (o.kind === 'drug' && !o.itemId)
          throw sampleRefuse('22023', 'choose the medicine from the stock', 'item_needed')
        if (o.text.trim().length < 2) throw sampleRefuse('22023', 'say what must be done')
        sampleOrders.push(o)
        return o
      }
      return call('create_nurse_order', {
        p_encounter_id: i.encounterId,
        p_kind: i.kind,
        p_text: i.text?.trim() || null,
        p_service_id: i.kind === 'act' ? (i.serviceId ?? null) : null,
        p_item_id: i.kind === 'drug' ? (i.itemId ?? null) : null,
        p_quantity: i.quantity ?? 1,
        p_dose: i.dose?.trim() || null,
        p_route: i.route || null,
        p_frequency: i.frequency || null,
        p_doses: i.doses ?? 1,
        p_assigned_to: i.assignedTo ?? null,
        p_notes: i.notes?.trim() || null,
      })
    },
    onSuccess: refresh,
  })
  /** The nurse records one time given (a drug: from her room store; billed). */
  const give = useMutation({
    mutationFn: async (i: { id: string; note?: string; at?: string | null }) => {
      if (!supabase) {
        const o = sampleFind(i.id)
        o.doses.push({
          n: o.doses.length + 1,
          given: true,
          at: i.at ?? new Date().toISOString(),
          by: useSession.getState().user?.name ?? null,
          note: i.note?.trim() || null,
          charged: o.kind === 'drug' || !!o.serviceId,
          store: o.kind === 'drug' ? 'Ward store' : null,
        })
        o.given += 1
        sampleClose(o)
        return { ...o, charged: true }
      }
      return call('give_nurse_order', {
        p_order_id: i.id,
        p_note: i.note?.trim() || null,
        p_at: i.at ?? null,
      })
    },
    onSuccess: refresh,
  })
  /** One time not given, with the reason. */
  const skip = useMutation({
    mutationFn: async (i: { id: string; reason: string }) => {
      if (!supabase) {
        const o = sampleFind(i.id)
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
        return o
      }
      return call('skip_nurse_dose', { p_order_id: i.id, p_reason: i.reason.trim() })
    },
    onSuccess: refresh,
  })
  /** The doctor cancels the order; the nurse says the rest will not be done. */
  const stop = useMutation({
    mutationFn: async (i: { id: string; reason: string }) => {
      if (!supabase) {
        const o = sampleFind(i.id)
        if (i.reason.trim().length < 3) throw sampleRefuse('22023', 'say why')
        const u = useSession.getState().user
        o.status = o.byId === u?.id || u?.role === 'manager' ? 'cancelled' : 'not_done'
        o.endReason = i.reason.trim()
        o.endedAt = new Date().toISOString()
        o.endedBy = u?.name ?? null
        return o
      }
      return call('stop_nurse_order', { p_order_id: i.id, p_reason: i.reason.trim() })
    },
    onSuccess: refresh,
  })
  return { create, give, skip, stop }
}

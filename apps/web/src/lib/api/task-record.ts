import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { sampleRecordForTask } from './desk-ops'
import { apiError } from './errors'
import { sampleVisitNurseOrders, type NurseOrder } from './nurse-orders'

/**
 * 0200 · The nurse records what she gave or did for a task of the doctor (record_for_task): a
 * medicine of the clinic's stock (whole pieces, the dose and route in words) or a medical act (of
 * the price list, or in words). It is written as her order carried out now: the pieces leave the
 * stock and go on the bill as for an order of the doctor marked given.
 */
export interface TaskRecordInput {
  taskId: string
  kind: 'drug' | 'act'
  itemId?: string | null
  serviceId?: string | null
  /** An act not in the price list, in words (nothing is billed). */
  text?: string | null
  quantity: number
  dose?: string | null
  route?: string | null
  note?: string | null
  /** Recorded although the doctor ordered it, or it was just given (with why). */
  evenSo?: boolean
  why?: string | null
  /** The task is done in the same press. */
  taskDone?: boolean
  /** For the sample mode and the words of the answer. */
  label: string
  unit?: string | null
  /** The cash price of one (the sample mode bills it). */
  price?: number | null
}

export interface TaskRecordAnswer {
  id: string
  charged: boolean
  notBilled: string | null
  billed: number
  taskDone: boolean
}

/** Every order of a visit (for the same thing ordered twice), whoever it is for. */
export function useVisitOrdersAll(encounterId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['nurse-orders', 'visit-all', encounterId],
    enabled: enabled && !!encounterId,
    staleTime: 15_000,
    queryFn: async (): Promise<NurseOrder[]> => {
      if (!encounterId) return []
      if (!supabase) return sampleVisitNurseOrders(encounterId)
      const { data, error } = await supabase.rpc('visit_nurse_orders', {
        p_encounter_id: encounterId,
        p_desk: false,
      })
      if (error) throw apiError(error)
      return (data as NurseOrder[]) ?? []
    },
  })
}

/** What the duplicate is: ordered by the doctor and still to do, or given lately on the visit. */
export type TaskDuplicate =
  | { kind: 'ordered'; order: NurseOrder }
  | { kind: 'given'; order: NurseOrder; at: string; by: string | null }

/** The same medicine or act on the visit (as the database refuses it): to say before sending. */
export function findDuplicate(
  orders: readonly NurseOrder[],
  r: Pick<TaskRecordInput, 'kind' | 'itemId' | 'serviceId' | 'text'>,
  now = Date.now(),
): TaskDuplicate | null {
  const same = (o: NurseOrder) =>
    r.kind === 'drug'
      ? !!r.itemId && o.itemId === r.itemId
      : r.serviceId
        ? o.serviceId === r.serviceId
        : o.kind === 'act' &&
          !o.serviceId &&
          !!r.text?.trim() &&
          o.text.trim().toLowerCase() === r.text.trim().toLowerCase()
  const ordered = orders.find((o) => o.status === 'open' && same(o))
  if (ordered) return { kind: 'ordered', order: ordered }
  // given in the last 12 hours (a medicine, or an act of the price list)
  if (r.kind === 'act' && !r.serviceId) return null
  let last: TaskDuplicate | null = null
  for (const o of orders) {
    if (!same(o)) continue
    for (const d of o.doses ?? []) {
      if (!d.given) continue
      const t = new Date(d.at).getTime()
      if (now - t > 12 * 3600_000) continue
      if (!last || last.kind !== 'given' || t > new Date(last.at).getTime())
        last = { kind: 'given', order: o, at: d.at, by: d.by ?? null }
    }
  }
  return last
}

export function useRecordForTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (i: TaskRecordInput): Promise<TaskRecordAnswer> => {
      if (!supabase) {
        const u = useSession.getState().user
        const id = `rec-${Date.now()}`
        sampleRecordForTask(
          i.taskId,
          {
            id,
            kind: i.kind,
            text: i.label,
            quantity: i.quantity,
            unit: i.unit ?? null,
            at: new Date().toISOString(),
            by: u?.name ?? null,
            status: 'done',
          },
          !!i.taskDone,
        )
        const billed = Math.round((i.price ?? 0) * i.quantity)
        return {
          id,
          charged: i.price != null,
          notBilled: i.price != null ? null : 'no_price',
          billed,
          taskDone: !!i.taskDone,
        }
      }
      const { data, error } = await supabase.rpc('record_for_task', {
        p_task_id: i.taskId,
        p_kind: i.kind,
        p_item_id: i.kind === 'drug' ? (i.itemId ?? null) : null,
        p_service_id: i.kind === 'act' ? (i.serviceId ?? null) : null,
        p_text: i.kind === 'act' && !i.serviceId ? (i.text?.trim() ?? null) : null,
        p_quantity: i.quantity,
        p_dose: i.kind === 'drug' ? i.dose?.trim() || null : null,
        p_route: i.kind === 'drug' ? i.route || null : null,
        p_note: i.note?.trim() || null,
        p_even_so: !!i.evenSo,
        p_why: i.evenSo ? i.why?.trim() || null : null,
        p_task_done: !!i.taskDone,
      })
      if (error) throw apiError(error)
      const d = (data ?? {}) as Partial<TaskRecordAnswer> & { billed?: number | string }
      return {
        id: String(d.id ?? ''),
        charged: !!d.charged,
        notBilled: d.notBilled ?? null,
        billed: Number(d.billed ?? 0),
        taskDone: !!d.taskDone,
      }
    },
    onSuccess: () => {
      for (const k of [
        'tasks',
        'nurse-orders',
        'visit',
        'stock',
        'nav-counts',
        'notifications',
        'desk',
      ])
        void qc.invalidateQueries({ queryKey: [k] })
    },
  })
}

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { DispenseLabel } from '@/lib/dispense-label'
import { sampleStock } from '@/lib/api/stock'
import { kigaliToday } from '@/lib/clock'
import { supabase } from '@/lib/supabase'

/**
 * What the pharmacy has just handed over today, kept for the labels: they are printed AFTER the
 * hand-over from what was really given (batch and expiry of the stock taken), and can be printed
 * again ("Reprint"). Kept in this tab's sessionStorage for the day, so a reload does not lose
 * them; yesterday's go when the day changes.
 */

export interface HandedGroup {
  /** The visit (encounter id) or the counter sale (sale id). */
  key: string
  kind: 'visit' | 'sale'
  patient: { name: string; fileNumber: string }
  lines: DispenseLabel[]
  at: number
  /** Labels printed at least once. */
  printed: boolean
  /** What the patient pays at the end of the visit (visits), when known. */
  toPay: number | null
  /** No more medicines waiting for this visit: the patient goes on (to the cashier when money is due). */
  done: boolean
}

interface HandedState {
  groups: HandedGroup[]
  /** The clinic day (Kigali) the groups belong to. */
  day: string
  add: (
    g: Pick<HandedGroup, 'key' | 'kind' | 'patient'>,
    line: DispenseLabel,
    extra?: Partial<Pick<HandedGroup, 'toPay' | 'done'>>,
  ) => void
  update: (key: string, patch: Partial<Pick<HandedGroup, 'toPay' | 'done' | 'printed'>>) => void
  remove: (key: string) => void
}

/** At most this many patients or buyers are kept for a reprint. */
const KEEP = 12

/** Yesterday's labels are not reprinted: only today's groups count. */
const today = (s: Pick<HandedState, 'groups' | 'day'>): HandedGroup[] =>
  s.day === kigaliToday() ? s.groups : []

export const useHanded = create<HandedState>()(
  persist(
    (set) => ({
      groups: [],
      day: kigaliToday(),
      add: (g, line, extra) =>
        set((s) => {
          const groups = today(s)
          const old = groups.find((x) => x.key === g.key)
          const next: HandedGroup = old
            ? { ...old, lines: [...old.lines, line], at: Date.now(), printed: false, ...extra }
            : {
                ...g,
                lines: [line],
                at: Date.now(),
                printed: false,
                toPay: null,
                done: false,
                ...extra,
              }
          return {
            day: kigaliToday(),
            groups: [next, ...groups.filter((x) => x.key !== g.key)].slice(0, KEEP),
          }
        }),
      update: (key, patch) =>
        set((s) => ({ groups: s.groups.map((x) => (x.key === key ? { ...x, ...patch } : x)) })),
      remove: (key) => set((s) => ({ groups: s.groups.filter((x) => x.key !== key) })),
    }),
    {
      name: 'mmc-handed',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ groups: s.groups, day: s.day }),
      // a tab reopened on a later day starts empty
      merge: (saved, current) => {
        const p = (saved ?? {}) as Partial<Pick<HandedState, 'groups' | 'day'>>
        const day = p.day ?? ''
        return { ...current, day, groups: today({ day, groups: p.groups ?? [] }) }
      },
    },
  ),
)

export interface DispensedBatch {
  batchNo: string | null
  expiry: string | null
  quantity: number
}

/**
 * The batches a hand-over took (earliest expiry first), read from the stock ledger by the
 * dispense id. Not in lib/api (no hook returns them yet): a small local read. An error or an
 * old database gives an empty list; the label is then printed without batch and expiry.
 */
export async function fetchDispensedBatches(
  dispenseId: string | null,
  itemId: string,
  quantity: number,
): Promise<DispensedBatch[]> {
  if (!supabase) {
    const it = sampleStock.items.find((x) => x.id === itemId)
    return [
      {
        batchNo: sampleStock.batchNo[itemId] ?? null,
        expiry: it?.earliestExpiry ?? null,
        quantity,
      },
    ]
  }
  if (!dispenseId) return []
  try {
    const { data, error } = await supabase
      .from('stock_movement')
      .select('quantity, batch:batch_id(batch_no, expiry)')
      .eq('dispense_id', dispenseId)
      .eq('type', 'dispense')
      .is('deleted_at', null)
    if (error || !data) return []
    type Row = {
      quantity: number | string
      batch:
        | { batch_no: string | null; expiry: string | null }
        | { batch_no: string | null; expiry: string | null }[]
        | null
    }
    return (data as Row[])
      .map((r) => {
        const b = Array.isArray(r.batch) ? r.batch[0] : r.batch
        return {
          batchNo: b?.batch_no ?? null,
          expiry: b?.expiry ?? null,
          quantity: Number(r.quantity) || 0,
        }
      })
      .sort((a, b) => (a.expiry ?? '9999').localeCompare(b.expiry ?? '9999'))
  } catch {
    return []
  }
}

/** One label's batch and expiry: the batches joined, the earliest expiry (the one to watch). */
export function batchOnLabel(batches: readonly DispensedBatch[]): {
  batchNo: string | null
  expiry: string | null
} {
  const nos = [...new Set(batches.map((b) => b.batchNo).filter(Boolean))] as string[]
  const expiries = batches.map((b) => b.expiry).filter(Boolean) as string[]
  expiries.sort()
  return { batchNo: nos.length ? nos.join(' / ') : null, expiry: expiries[0] ?? null }
}

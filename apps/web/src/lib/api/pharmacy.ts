import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { apiError, isMissingFunction, sampleRefusal } from './errors'
import { isLowStock, sampleStock, type PharmacyLine } from './stock'
import { kigaliToday } from '@/lib/clock'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { priceQuantity } from '@/lib/pack-pricing'

/**
 * The simplified pharmacy (migration 20261207090000): what the pharmacy desk adds to stock.ts.
 *
 * - Part hand-over: dispense_prescription with p_quantity (10 of 20); the line stays at the
 *   desk with what remains, and rx_not_given closes the rest (stock.ts notGiven).
 * - stock_totals: inventory cost, selling value, low / expiring (30 days) / expired.
 * - message_manager: a notice to every manager from the person signed in.
 * - stock_alert_check: the stock notices (low, expiring, expired, one daily summary), called once
 *   per Kigali day per person on the pharmacy home (useDailyStockAlertCheck).
 *
 * Each keeps working on a database without the migration: the part falls back to the whole
 * line, the totals to null (the page counts from stock_overview), the check is skipped.
 */

/** "Expiring soon" means within this many days (setting stock.expiry_days, default 30). */
export const EXPIRY_WINDOW_DAYS = 30

const KEY = ['stock'] as const
const num = (v: unknown, fallback = 0): number =>
  v == null || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v)

// ---------------------------------------------------------------- part hand-over
/** A queue line as the new database sends it: what was given already and what remains. */
export type PartLine = PharmacyLine & {
  given?: number | string | null
  remaining?: number | string | null
}

/** Sample mode: units given per prescription line, and lines finished (all given). */
const sampleGiven = new Map<string, number>()
const sampleDone = new Set<string>()

/**
 * Prescribed, given and remaining of a queue line. An old database sends only the quantity:
 * nothing given yet, all of it remains.
 */
export function partOf(q: PharmacyLine): { prescribed: number; given: number; remaining: number } {
  const l = q as PartLine
  const prescribed = num(l.quantity)
  const given = l.given == null ? (sampleGiven.get(q.requestId) ?? 0) : num(l.given)
  const remaining =
    l.remaining == null ? Math.max(0, prescribed - given) : Math.max(0, num(l.remaining))
  return { prescribed, given, remaining }
}

/** Sample mode: hides the lines handed over in full (the database drops them from the queue). */
export const withoutDone = <T extends PharmacyLine>(lines: readonly T[]): T[] =>
  supabase ? [...lines] : lines.filter((l) => !sampleDone.has(l.requestId))

/**
 * What one unit of the line costs on the bill (total, insurer, patient): the price on the visit's
 * list and the insurer's percentage, so it holds whatever quantity the line's totals were made
 * for; used for "Give 10 of 20". An old line without a list price: its totals per prescribed unit.
 */
export function perUnit(q: PharmacyLine): { total: number; insurer: number; patient: number } {
  if (!q.priced) return { total: 0, insurer: 0, patient: 0 }
  if (q.payerPrice != null) {
    const insurer = (q.payerPrice * num(q.coveragePct)) / 100
    return { total: q.payerPrice, insurer, patient: q.payerPrice - insurer }
  }
  const n = num(q.quantity)
  if (n <= 0) return { total: 0, insurer: 0, patient: 0 }
  return { total: q.lineTotal / n, insurer: q.insurerShare / n, patient: q.patientShare / n }
}

/**
 * What `n` pieces of a line cost on the bill, as the database charges them (0107,
 * price_quantity): by how the medicine is sold — whole packs at the pack price and the pieces
 * left at the piece price when the line is cash-priced (the desk then sends the pack price), else
 * pieces × the price; the insurer's share rounded on each bill line, the patient paying the rest.
 * `ok` false: a medicine sold only by the whole pack, asked in pieces that are not whole packs.
 */
export function costOf(
  q: PharmacyLine,
  n: number,
): {
  total: number
  insurer: number
  patient: number
  byPack: boolean
  packs: number
  pieces: number
  ok: boolean
} {
  const p = priceQuantity(
    {
      packSize: q.packSize,
      saleMode: q.saleMode ?? (q.packPrice != null ? 'both' : 'piece'),
      packPrice: q.packPrice,
    },
    n,
    { cash: q.packPrice != null, piecePrice: perUnit(q).total },
  )
  if (!q.priced || n <= 0)
    return { total: 0, insurer: 0, patient: 0, byPack: false, packs: 0, pieces: 0, ok: p.ok }
  const pct = num(q.coveragePct)
  // the bill writes the whole packs and the pieces as two lines, each with its insurer share
  const packPart = p.packs * (p.packPrice ?? 0)
  const insurer =
    Math.round((packPart * pct) / 100) + Math.round(((p.total - packPart) * pct) / 100)
  return {
    total: p.total,
    insurer,
    patient: p.total - insurer,
    byPack: p.packs > 0,
    packs: p.packs,
    pieces: p.pieces,
    ok: p.ok,
  }
}

export interface DispensePartResult {
  charged: boolean
  dispenseId: string | null
  /** Units given now. */
  quantity: number
  /** Units still to give on the line after this hand-over (0: the line is done). */
  remaining: number
}

export function usePharmacyActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEY })
    void qc.invalidateQueries({ queryKey: ['visit'] })
    void qc.invalidateQueries({ queryKey: ['queue'] })
    void qc.invalidateQueries({ queryKey: ['finance'] })
    void qc.invalidateQueries({ queryKey: ['home'] })
  }

  /**
   * Hands over `quantity` units of a prescription line (earliest expiry first, onto the visit's
   * bill). Less than what remains: a part; the rest stays to give and the prescriber is told.
   */
  const dispensePart = useMutation({
    mutationFn: async (i: {
      line: PharmacyLine
      quantity: number
      locationId?: string | null
    }): Promise<DispensePartResult> => {
      const { remaining } = partOf(i.line)
      // a medicine sold only by the whole pack: the last pack may pass what remains (due, 0107)
      const n = Math.min(i.quantity, Math.max(remaining, i.line.due ?? remaining))
      if (!supabase) {
        if (i.line.doctorHolds) throw sampleRefusal('doctorHolds', 'MS002')
        const loc = i.locationId ?? 'l-pharm'
        if (sampleStock.usable(i.line.itemId, loc) < n) throw sampleRefusal('short', '23514')
        sampleStock.move(i.line.itemId, loc, null, n)
        sampleGiven.set(i.line.requestId, (sampleGiven.get(i.line.requestId) ?? 0) + n)
        if (n >= remaining) sampleDone.add(i.line.requestId)
        return {
          charged: i.line.priced,
          dispenseId: `d-${Date.now()}`,
          quantity: n,
          remaining: Math.max(0, remaining - n),
        }
      }
      const args: Record<string, unknown> = {
        p_medication_request_id: i.line.requestId,
        p_location_id: i.locationId ?? null,
      }
      // the whole remainder: no quantity (an old database knows no p_quantity)
      if (n !== remaining) args.p_quantity = n
      const { data, error } = await supabase.rpc('dispense_prescription', args)
      if (error) throw apiError(error)
      const d = (data ?? {}) as {
        charged?: boolean
        dispenseId?: string
        given?: number
        quantity?: number
        remaining?: number
      }
      return {
        charged: !!d.charged,
        dispenseId: d.dispenseId ?? null,
        quantity: n,
        remaining: d.remaining == null ? Math.max(0, remaining - n) : num(d.remaining),
      }
    },
    onSuccess: refresh,
  })

  /** A message to every manager (3 to 500 characters), as a notice from the person. */
  const messageManager = useMutation({
    mutationFn: async (text: string) => {
      const body = text.trim()
      // sample mode: nothing is sent (the dialog checks the length)
      if (!supabase) return
      const { error } = await supabase.rpc('message_manager', { p_text: body })
      if (error) throw apiError(error)
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  })

  return { dispensePart, messageManager }
}

// ---------------------------------------------------------------- totals
export interface StockTotals {
  /** What the stock cost (unexpired and expired). */
  inventoryCost: number
  /** What the stock sells for at the cash price. */
  sellingValue: number
  items: number
  low: number
  expiring30: number
  expiredUnits: number
  expiredCost: number
  /** The "expiring soon" window in days (setting stock.expiry_days). */
  expiryDays?: number
}

const dayMs = 86_400_000
const within = (iso: string | null | undefined, days: number) => {
  if (!iso) return false
  const left = (Date.parse(iso.slice(0, 10)) - Date.parse(kigaliToday())) / dayMs
  return left >= 0 && left <= days
}

/** An item's earliest unexpired batch expires within the window (30 days by default). */
export const expiresSoon = (
  i: { nextExpiry?: string | null; earliestExpiry: string | null },
  days: number = EXPIRY_WINDOW_DAYS,
) => within(i.nextExpiry ?? i.earliestExpiry, days)

const sampleTotals = (): StockTotals => {
  const items = sampleStock.items.filter((i) => i.active)
  return {
    inventoryCost: Math.round(items.reduce((s, i) => s + i.costValue, 0)),
    sellingValue: Math.round(items.reduce((s, i) => s + i.onHand * (i.sellingPrice ?? 0), 0)),
    items: items.length,
    low: items.filter(isLowStock).length,
    expiring30: items.filter((i) => expiresSoon(i)).length,
    expiredUnits: items.reduce((s, i) => s + i.expiredUnits, 0),
    expiredCost: Math.round(items.reduce((s, i) => s + i.expiredUnits * (i.avgCost ?? 0), 0)),
    expiryDays: EXPIRY_WINDOW_DAYS,
  }
}

/**
 * The stock totals of a store (null: the pharmacy, or every store for the manager). null on a
 * database without stock_totals: the page counts from the stock overview instead.
 */
export function useStockTotals(locationId: string | null = null) {
  return useQuery({
    queryKey: [...KEY, 'totals', locationId],
    refetchInterval: 60_000,
    queryFn: async (): Promise<StockTotals | null> => {
      if (!supabase) return sampleTotals()
      const { data, error } = await supabase.rpc('stock_totals', { p_location_id: locationId })
      if (error) {
        if (isMissingFunction(error)) return null
        throw apiError(error)
      }
      const d = (data ?? {}) as Record<string, unknown>
      return {
        inventoryCost: num(d.inventory_cost ?? d.inventoryCost),
        sellingValue: num(d.selling_value ?? d.sellingValue),
        items: num(d.items),
        low: num(d.low),
        expiring30: num(d.expiring_30 ?? d.expiring30),
        expiredUnits: num(d.expired_units ?? d.expiredUnits),
        expiredCost: num(d.expired_cost ?? d.expiredCost),
        expiryDays: num(d.expiry_days ?? d.expiryDays, EXPIRY_WINDOW_DAYS) || EXPIRY_WINDOW_DAYS,
      }
    },
  })
}

// ---------------------------------------------------------------- alerts
/**
 * Once per Kigali day per person (this tab's sessionStorage): the database looks for stock to
 * reorder, batches expiring within 30 days and expired batches on the shelf, and sends the
 * notices (once each) with one daily summary. Errors are quiet: the notices are a help, the page
 * works without them.
 */
export function useDailyStockAlertCheck(enabled = true) {
  const qc = useQueryClient()
  const userId = useSession((s) => s.user?.id ?? null)
  useEffect(() => {
    if (!enabled || !userId || !supabase) return
    const key = `mmc-stock-alert-check:${userId}`
    const day = kigaliToday()
    try {
      if (sessionStorage.getItem(key) === day) return
      sessionStorage.setItem(key, day)
    } catch {
      // no storage (private window): check on each visit of the page
    }
    void supabase.rpc('stock_alert_check').then(({ error }) => {
      if (!error) void qc.invalidateQueries({ queryKey: ['notifications'] })
    })
  }, [enabled, userId, qc])
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiError, isMissingFunction, sampleRefusal } from './errors'
import { isRoomStore, sampleStock } from './stock'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { priceQuantity, type Packaging, type SaleMode } from '@/lib/pack-pricing'

/**
 * Counter sales (migration 0083): a walk-in buyer without a visit pays FIRST, then collects.
 * The pharmacy writes the sale (S-YYMMDD-NNN, cash prices) and takes the payment itself (since
 * 20261207 the pharmacist may, for counter sales only; or the cashier, when the sale is sent
 * there): a receipt RCT-…, counted in the receiver's own cash count and in the day's revenue.
 * Then the pharmacy hands the medicines over (earliest expiry first, never expired). A patient on a visit is different: what
 * they get joins the visit's bill and they pay once at the end.
 *
 * Live: create_counter_sale, counter_sales, take_counter_payment, hand_over_counter_sale,
 * cancel_counter_sale (void_payment reopens a paid sale not yet handed over: finance.ts).
 */

export type CounterSaleStatus = 'open' | 'paid' | 'handed_over' | 'cancelled'
export type CounterPaymentMethod = 'cash' | 'momo' | 'airtel' | 'card' | 'bank'

export interface CounterSaleLine {
  itemId: string
  item: string
  unit: string | null
  /** Pieces sold (the stock leaves in pieces). */
  quantity: number
  /** The price of one piece. */
  unitPrice: number
  lineTotal: number
  /** Unexpired units in the sale's store now. */
  inStock: number
  /** Pieces in one pack (0102). */
  packSize?: number | null
  /** Charged as whole packs at the item's pack price: how many, and the price of one pack. */
  packs?: number | null
  packPrice?: number | null
  byPack?: boolean
  /** How it is sold and the pack's word (0107); the pieces charged beside the whole packs. */
  saleMode?: SaleMode | null
  packUnit?: string | null
  pieces?: number | null
}

/**
 * The lines as the receipt prints them: a line charged by the pack reads "Amoxicillin 500 mg ·
 * B/20 × 2 at the pack price", so quantity × unit price is the line total on paper too.
 */
export const receiptLines = (lines: readonly CounterSaleLine[]): CounterSaleLine[] =>
  lines.flatMap((l) => {
    if (!(l.byPack && l.packs && l.packPrice != null)) return [l]
    // 0107: the whole packs at the pack price, and the pieces left at the piece price
    const rest = l.pieces ?? Math.max(0, l.quantity - l.packs * (l.packSize ?? 1))
    const packLine: CounterSaleLine = {
      ...l,
      item: `${l.item} · B/${l.packSize ?? ''}`,
      quantity: l.packs,
      unitPrice: l.packPrice,
      lineTotal: l.packs * l.packPrice,
      unit: null,
    }
    return rest > 0
      ? [
          packLine,
          { ...l, quantity: rest, lineTotal: l.lineTotal - packLine.lineTotal, byPack: false },
        ]
      : [packLine]
  })

/** Sample mode: a cash line's total as the database charges it (whole packs at the pack price). */
const sampleLineCost = (
  it: Packaging,
  quantity: number,
): Pick<
  CounterSaleLine,
  'lineTotal' | 'packs' | 'packPrice' | 'byPack' | 'packSize' | 'saleMode' | 'packUnit' | 'pieces'
> => {
  // the same rule as the database (0107): by how the medicine is sold
  const p = priceQuantity(it, quantity)
  if (!p.ok)
    throw new Error(`sold only in whole packs of ${p.size}: ${quantity} is not whole packs`)
  return {
    lineTotal: p.total,
    packs: p.packs > 0 ? p.packs : null,
    packPrice: p.packs > 0 ? p.packPrice : null,
    byPack: p.packs > 0,
    packSize: it.packSize ?? null,
    saleMode: p.mode,
    packUnit: it.packUnit ?? null,
    pieces: p.pieces,
  }
}
export interface CounterSale {
  id: string
  number: string
  status: CounterSaleStatus
  buyer: string | null
  phone: string | null
  storeId: string
  store: string
  /** Sold from a room store by its holder (0109), not by the pharmacy. */
  roomStore?: boolean
  total: number
  note: string | null
  at: string
  by: string | null
  paidAt: string | null
  receipt: string | null
  method: string | null
  cashier: string | null
  handedOverAt: string | null
  handedOverBy: string | null
  cancelledAt: string | null
  cancelReason: string | null
  lines: CounterSaleLine[]
}
export interface CounterHandOver {
  id: string
  number: string
  status: 'handed_over'
  buyer: string | null
  lines: {
    itemId: string
    item: string
    quantity: number
    batches: { batchNo: string | null; expiry: string | null; quantity: number }[]
  }[]
}

// ---------------------------------------------------------------- sample mode
const dayCode = () => new Date().toISOString().slice(2, 10).replace(/-/g, '')
const me = () => useSession.getState().user?.name ?? null
const sampleSales: CounterSale[] = [
  {
    id: 'cs-1',
    number: `S-${dayCode()}-001`,
    status: 'open',
    buyer: 'Walk-in buyer',
    phone: null,
    storeId: 'l-pharm',
    store: 'Pharmacy',
    total: 1000,
    note: null,
    at: new Date(Date.now() - 12 * 60_000).toISOString(),
    by: 'Kalisa Pascal',
    paidAt: null,
    receipt: null,
    method: null,
    cashier: null,
    handedOverAt: null,
    handedOverBy: null,
    cancelledAt: null,
    cancelReason: null,
    lines: [
      {
        itemId: 'it-2',
        item: 'Paracetamol 500 mg',
        unit: 'tab',
        quantity: 20,
        unitPrice: 50,
        lineTotal: 900,
        inStock: 500,
        packSize: 20,
        packs: 1,
        packPrice: 900,
        byPack: true,
        saleMode: 'both',
        packUnit: 'box',
        pieces: 0,
      },
    ],
  },
]
// the sample sale above is one whole pack at the pack price
sampleSales[0]!.total = 900
/** The sales waiting at the cashier (sample mode: cashier_summary's counterToPay). */
export const sampleCounterToPay = () =>
  sampleSales
    .filter((s) => s.status === 'open')
    .map((s) => ({
      id: s.id,
      number: s.number,
      buyer: s.buyer,
      phone: s.phone,
      total: s.total,
      at: s.at,
      by: s.by,
      lines: s.lines.length,
    }))

// ---------------------------------------------------------------- reading
const KEY = ['stock', 'counter-sales'] as const
const num = (v: unknown, fallback = 0): number =>
  v == null || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v)

/**
 * Counter sales: by status and/or the days (both included). Without days: the open and paid
 * ones, plus the last 7 days. For the pharmacy, the cashier and the manager.
 */
export function useCounterSales(
  status: CounterSaleStatus | null = null,
  period?: { from: string; to: string } | null,
) {
  return useQuery({
    queryKey: [...KEY, status, period?.from ?? null, period?.to ?? null],
    refetchInterval: 20_000,
    queryFn: async (): Promise<CounterSale[]> => {
      if (!supabase)
        return sampleSales
          .filter((s) => !status || s.status === status)
          .map((s) => ({
            ...s,
            lines: s.lines.map((l) => ({
              ...l,
              inStock: sampleStock.usable(l.itemId, s.storeId),
            })),
          }))
      const { data, error } = await supabase.rpc('counter_sales', {
        p_status: status,
        p_from: period?.from ?? null,
        p_to: period?.to ?? null,
      })
      if (error) {
        if (isMissingFunction(error)) return []
        throw apiError(error)
      }
      return ((data ?? []) as CounterSale[]).map((s) => ({
        ...s,
        total: num(s.total),
        lines: (s.lines ?? []).map((l) => ({
          ...l,
          quantity: num(l.quantity),
          unitPrice: num(l.unitPrice),
          lineTotal: num(l.lineTotal),
          inStock: num(l.inStock),
          packSize: l.packSize == null ? null : num(l.packSize),
          packs: l.packs == null ? null : num(l.packs),
          packPrice: l.packPrice == null ? null : num(l.packPrice),
          byPack: !!l.byPack,
          saleMode: l.saleMode ?? null,
          packUnit: l.packUnit ?? null,
          pieces: l.pieces == null ? null : num(l.pieces),
        })),
      }))
    },
  })
}

// ---------------------------------------------------------------- actions
export function useCounterSaleActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['stock'] })
    void qc.invalidateQueries({ queryKey: ['finance'] })
    void qc.invalidateQueries({ queryKey: ['home'] })
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await supabase!.rpc(fn, args)
    if (error) throw apiError(error)
    return data as T
  }
  const find = (id: string) => {
    const s = sampleSales.find((x) => x.id === id)
    if (!s) throw sampleRefusal('notFound', 'P0002')
    return s
  }

  /** The pharmacy writes the sale at cash prices; the cashier is told. Stock is checked. */
  const create = useMutation({
    mutationFn: async (i: {
      lines: { itemId: string; quantity: number }[]
      buyerName?: string
      buyerPhone?: string
      locationId?: string | null
      note?: string
    }): Promise<{ id: string; number: string; total: number; status: 'open' }> => {
      if (!supabase) {
        const loc = i.locationId ?? 'l-pharm'
        const lines = i.lines.map((l) => {
          const it = sampleStock.items.find((x) => x.id === l.itemId)
          if (it?.sellingPrice == null) throw sampleRefusal('noPrice', '22023')
          if (sampleStock.usable(l.itemId, loc) < l.quantity) throw sampleRefusal('short', '23514')
          return {
            itemId: l.itemId,
            item: sampleStock.label(l.itemId),
            unit: it.unit,
            quantity: l.quantity,
            unitPrice: it.sellingPrice,
            inStock: sampleStock.usable(l.itemId, loc),
            ...sampleLineCost(it, l.quantity),
          }
        })
        const s: CounterSale = {
          id: `cs-${Date.now()}`,
          number: `S-${dayCode()}-${String(sampleSales.length + 1).padStart(3, '0')}`,
          status: 'open',
          buyer: i.buyerName?.trim() || null,
          phone: i.buyerPhone?.trim() || null,
          storeId: loc,
          store: sampleStock.locations.find((l) => l.id === loc)?.name ?? '',
          roomStore: sampleStock.locations.some((l) => l.id === loc && isRoomStore(l)),
          total: lines.reduce((t, l) => t + l.lineTotal, 0),
          note: i.note?.trim() || null,
          at: new Date().toISOString(),
          by: me(),
          paidAt: null,
          receipt: null,
          method: null,
          cashier: null,
          handedOverAt: null,
          handedOverBy: null,
          cancelledAt: null,
          cancelReason: null,
          lines,
        }
        sampleSales.unshift(s)
        return { id: s.id, number: s.number, total: s.total, status: 'open' }
      }
      const d = await rpc<{ id: string; number: string; total: number; status: 'open' }>(
        'create_counter_sale',
        {
          p_lines: i.lines,
          p_buyer_name: i.buyerName?.trim() || null,
          p_buyer_phone: i.buyerPhone?.trim() || null,
          p_location_id: i.locationId ?? null,
          p_note: i.note?.trim() || null,
        },
      )
      return { ...d, total: num(d.total) }
    },
    onSuccess: refresh,
  })
  /**
   * The whole total is taken (momo, airtel, card and bank need a reference): by the pharmacist
   * at the pharmacy desk or by the cashier; the payment records who received it.
   */
  const pay = useMutation({
    mutationFn: async (i: {
      saleId: string
      method: CounterPaymentMethod
      reference?: string
      payerPhone?: string
    }): Promise<{
      id: string
      number: string
      status: 'paid'
      amount: number
      receipt: string | null
      paymentId: string
    }> => {
      if (!supabase) {
        const s = find(i.saleId)
        Object.assign(s, {
          status: 'paid',
          paidAt: new Date().toISOString(),
          method: i.method,
          receipt: `RCT-${new Date().getFullYear()}-000${sampleSales.length}`,
          cashier: me(),
        })
        return {
          id: s.id,
          number: s.number,
          status: 'paid',
          amount: s.total,
          receipt: s.receipt,
          paymentId: `pay-${s.id}`,
        }
      }
      const d = await rpc<{
        id: string
        number: string
        status: 'paid'
        amount: number
        receipt: string | null
        paymentId: string
      }>('take_counter_payment', {
        p_sale_id: i.saleId,
        p_method: i.method,
        p_reference: i.reference?.trim() || null,
        p_payer_phone: i.payerPhone?.trim() || null,
      })
      return { ...d, amount: num(d.amount) }
    },
    onSuccess: refresh,
  })
  /** After payment the pharmacy hands the medicines over (not paid: refused, not_paid). */
  const handOver = useMutation({
    mutationFn: async (saleId: string): Promise<CounterHandOver> => {
      if (!supabase) {
        const s = find(saleId)
        if (s.status !== 'paid') throw sampleRefusal('notPaid', '22023')
        for (const l of s.lines) sampleStock.move(l.itemId, s.storeId, null, l.quantity)
        Object.assign(s, {
          status: 'handed_over',
          handedOverAt: new Date().toISOString(),
          handedOverBy: me(),
        })
        return {
          id: s.id,
          number: s.number,
          status: 'handed_over',
          buyer: s.buyer,
          lines: s.lines.map((l) => ({
            itemId: l.itemId,
            item: l.item,
            quantity: l.quantity,
            batches: [
              {
                batchNo: sampleStock.batchNo[l.itemId] ?? null,
                expiry: sampleStock.items.find((x) => x.id === l.itemId)?.earliestExpiry ?? null,
                quantity: l.quantity,
              },
            ],
          })),
        }
      }
      const d = await rpc<CounterHandOver>('hand_over_counter_sale', { p_sale_id: saleId })
      return {
        ...d,
        lines: (d.lines ?? []).map((l) => ({
          ...l,
          quantity: num(l.quantity),
          batches: (l.batches ?? []).map((b) => ({ ...b, quantity: num(b.quantity) })),
        })),
      }
    },
    onSuccess: refresh,
  })
  /** A sale not yet paid is cancelled with a reason. */
  const cancel = useMutation({
    mutationFn: async (i: { saleId: string; reason: string }) => {
      if (!supabase) {
        const s = find(i.saleId)
        Object.assign(s, {
          status: 'cancelled',
          cancelledAt: new Date().toISOString(),
          cancelReason: i.reason.trim(),
        })
        return
      }
      await rpc('cancel_counter_sale', { p_sale_id: i.saleId, p_reason: i.reason.trim() })
    },
    onSuccess: refresh,
  })
  return { create, pay, handOver, cancel }
}

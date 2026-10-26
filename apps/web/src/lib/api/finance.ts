import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiError } from './errors'
import { sampleCounterToPay } from './counter-sales'
import { supabase } from '@/lib/supabase'

/**
 * Finance (migration 0036): one day of money for the cashier and the manager. Totals by method
 * and by cashier, every payment with its receipt, and what is still to collect.
 */
export interface CashPayment {
  id: string
  at: string
  method: 'cash' | 'momo' | 'airtel' | string
  amount: number
  reference: string | null
  invoice: string | null
  /** null for a counter sale (a walk-in buyer without a visit; migration 0083). */
  encounterId: string | null
  /** The patient, or the buyer's name for a counter sale. */
  patient: string
  fileNumber: string | null
  /** The counter sale paid (S-YYMMDD-NNN), when it is one. */
  counterSaleId?: string | null
  counterSale?: string | null
  cashier: string | null
  /** Receipt number, taken by me, and already counted in a day close (migration 0062). */
  receipt?: string | null
  mine?: boolean
  counted?: boolean
}
export interface VoidedPayment {
  id: string
  at: string
  method: string
  amount: number
  receipt: string | null
  patient: string
  /** The counter sale (S-…) the payment was for, when it is one. */
  counterSale?: string | null
  reason: string | null
  by: string | null
  voidedAt: string | null
}
export interface CashClose {
  cashier: string | null
  mine: boolean
  expected: Record<string, number>
  counted: Record<string, number>
  variance: number
  note: string | null
  at: string
}
export interface CashierSummary {
  day: string
  /** 'desk': the whole cash desk (the cashier, reception); 'mine': only what I took (someone
   *  else the manager allows to take payments, migration 0087). Absent before 0087: the desk. */
  scope?: 'desk' | 'mine'
  total: number
  count: number
  previousTotal: number
  mine: number
  byMethod: { method: string; amount: number; count: number }[]
  byCashier: { name: string; amount: number; count: number }[]
  payments: CashPayment[]
  openBills: number
  openDue: number
  voided?: VoidedPayment[]
  closes?: CashClose[]
  /** What I should hold per method (my payments of the day less money I gave back). */
  myExpected?: Record<string, number>
  /** Patients the cashier desk finished with that day (0064). */
  served?: number
  /** Money given back that day (an overpaid bill). */
  refunded?: number
  refunds?: Refund[]
  /** Money still owed on visits already over. */
  debts?: number
  debtsDue?: number
  /** Counter sales paid in the period (migration 0083). */
  counterSales?: { count: number; total: number }
  /** Counter sales written by the pharmacy, waiting for payment (the buyer pays first). */
  counterToPay?: CounterToPay[]
  /**
   * A period was asked but the database is older than migration 0078: the figures are today's.
   * Set here, not by the server.
   */
  todayOnly?: boolean
}
/** A walk-in buyer's sale waiting at the cashier (pay first, then collect at the pharmacy). */
export interface CounterToPay {
  id: string
  number: string
  buyer: string | null
  phone: string | null
  total: number
  at: string
  by: string | null
  lines: number
}
export interface Refund {
  id: string
  at: string
  method: string
  amount: number
  reference: string | null
  reason: string
  patient: string
  cashier: string | null
  mine: boolean
}

const at = (h: number, m: number) => {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}
const samplePayments: CashPayment[] = [
  ['Iradukunda Sandrine', 'cash', 18300, null, 11, 52],
  ['Rukundo Kevin', 'momo', 45000, 'MP261020.1131.K4', 11, 31],
  ['Uwase Claudine', 'airtel', 12600, 'AT261020.1102.Q9', 11, 2],
  ['Hakizimana Emmanuel', 'cash', 7500, null, 10, 40],
  ['Mukamana Alice', 'momo', 23000, 'MP261020.1015.B2', 10, 15],
  ['Kayitesi Rose', 'cash', 5000, null, 9, 22],
].map(([patient, method, amount, reference, h, m], i) => ({
  id: `pay-${i}`,
  at: at(h as number, m as number),
  method: method as string,
  amount: amount as number,
  reference: reference as string | null,
  invoice: `INV-2026-00${40 + i}`,
  encounterId: `e-${i}`,
  patient: patient as string,
  fileNumber: `MMC-00013${i}`,
  cashier: 'Mugisha Samuel',
}))

/**
 * One day of money (`day`, null = today), or with `period` the money of those days (the cashier
 * home; migration 0078). The day close (what I hold, the counts) stays about one day.
 */
export function useCashierSummary(
  day: string | null,
  period?: { from: string; to: string } | null,
) {
  return useQuery({
    queryKey: ['finance', 'day', day, period?.from ?? null, period?.to ?? null],
    refetchInterval: 30_000,
    queryFn: async (): Promise<CashierSummary> => {
      if (!supabase) {
        const total = samplePayments.reduce((s, p) => s + p.amount, 0)
        const by = (m: string) => samplePayments.filter((p) => p.method === m)
        return {
          day: day ?? new Date().toISOString().slice(0, 10),
          total,
          count: samplePayments.length,
          previousTotal: 96400,
          mine: total,
          byMethod: ['cash', 'momo', 'airtel'].map((m) => ({
            method: m,
            amount: by(m).reduce((s, p) => s + p.amount, 0),
            count: by(m).length,
          })),
          byCashier: [{ name: 'Mugisha Samuel', amount: total, count: samplePayments.length }],
          payments: samplePayments,
          openBills: 5,
          openDue: 108900,
          counterSales: { count: 0, total: 0 },
          counterToPay: sampleCounterToPay(),
        }
      }
      if (period) {
        const { data, error } = await supabase.rpc('cashier_summary', {
          p_day: day,
          p_from: period.from,
          p_to: period.to,
        })
        if (!error) return toSummary(data)
        // before migration 0078 there is only the one-day summary: show today's, and say so
        if (!/function|schema cache/i.test(error.message)) throw new Error(error.message)
        const old = await supabase.rpc('cashier_summary', { p_day: day })
        if (old.error) throw new Error(old.error.message)
        return { ...toSummary(old.data), todayOnly: true }
      }
      const { data, error } = await supabase.rpc('cashier_summary', { p_day: day })
      if (error) throw apiError(error)
      return toSummary(data)
    },
  })
}

/** Money figures arrive as numbers or numeric strings: the counter-sale ones are made numbers. */
function toSummary(data: unknown): CashierSummary {
  const d = (data ?? {}) as CashierSummary
  return {
    ...d,
    counterSales: d.counterSales
      ? { count: Number(d.counterSales.count ?? 0), total: Number(d.counterSales.total ?? 0) }
      : undefined,
    counterToPay: d.counterToPay?.map((c) => ({
      ...c,
      total: Number(c.total ?? 0),
      lines: Number(c.lines ?? 0),
    })),
  }
}

/**
 * An unpaid bill (the patient pays once at the end of the visit; migration 0059, widened in
 * 0082): a visit closed or left with money due, or a visit of an earlier day still open with
 * money due and nothing left to do. Never lost: listed for the cashier and the manager.
 */
export interface Debt {
  encounterId: string
  patientId: string
  patient: string
  fileNumber: string
  phone: string | null
  /** What is still owed. */
  amount: number
  closedAt: string | null
  /** Why the manager closed it unpaid (the patient left). */
  reason: string | null
  closedBy: string | null
  /** When the visit began (0082). */
  since?: string | null
  /** open: an earlier day's visit still open; left: closed by the manager with a reason. */
  status?: 'open' | 'left' | 'closed'
  billNumber?: string | null
  /** The patient's share of the bill, and what was paid of it. */
  total?: number | null
  paid?: number | null
}

const sampleDebts: Debt[] = [
  {
    encounterId: 'e-debt-1',
    patientId: 'p-debt-1',
    patient: 'Nsengiyumva Jean',
    fileNumber: 'MMC-000098',
    phone: '0788 123 456',
    amount: 4500,
    closedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
    reason: 'Left without paying, promised to come back',
    closedBy: 'Mugabo Théogène',
    since: new Date(Date.now() - 28 * 3_600_000).toISOString(),
    status: 'left',
    billNumber: 'INV-2026-000031',
    total: 7500,
    paid: 3000,
  },
]

/** The unpaid bills (cashier and manager). */
export function useUnpaidDebts() {
  return useQuery({
    queryKey: ['finance', 'debts'],
    refetchInterval: 60_000,
    queryFn: async (): Promise<Debt[]> => {
      if (!supabase) return sampleDebts
      const { data, error } = await supabase.rpc('unpaid_debts')
      if (error) throw apiError(error)
      return ((data as Debt[]) ?? []).map((d) => ({
        ...d,
        amount: Number(d.amount),
        total: d.total == null ? null : Number(d.total),
        paid: d.paid == null ? null : Number(d.paid),
      }))
    },
  })
}
/** The same list, by its name on the screens: unpaid bills. */
export const useUnpaidBills = useUnpaidDebts

/** Cancel a wrong payment; count the cash at the end of the day (migration 0062). */
export function useCashActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['finance'] })
    void qc.invalidateQueries({ queryKey: ['visit'] })
    void qc.invalidateQueries({ queryKey: ['home'] })
    // a voided counter-sale payment reopens the sale at the pharmacy
    void qc.invalidateQueries({ queryKey: ['stock', 'counter-sales'] })
  }
  return {
    voidPayment: useMutation({
      /**
       * A visit's payment: its bill owes it again. A counter sale's payment (not yet handed
       * over): the sale is unpaid again (counterSaleId set, encounterId null).
       */
      mutationFn: async (i: {
        id: string
        reason: string
      }): Promise<{
        encounterId: string | null
        counterSaleId: string | null
        balance: number | null
      }> => {
        if (!supabase) return { encounterId: null, counterSaleId: null, balance: null }
        const { data, error } = await supabase.rpc('void_payment', {
          p_payment_id: i.id,
          p_reason: i.reason,
        })
        if (error) throw apiError(error)
        const d = (data ?? {}) as {
          encounterId?: string | null
          counterSaleId?: string | null
          balance?: number | string | null
        }
        return {
          encounterId: d.encounterId ?? null,
          counterSaleId: d.counterSaleId ?? null,
          balance: d.balance == null ? null : Number(d.balance),
        }
      },
      onSuccess: refresh,
    }),
    closeDay: useMutation({
      mutationFn: async (i: { day: string; counted: Record<string, number>; note?: string }) => {
        if (!supabase) return { variance: 0 }
        const { data, error } = await supabase.rpc('close_cash_day', {
          p_day: i.day,
          p_counted: i.counted,
          p_note: i.note?.trim() || null,
        })
        if (error) throw new Error(error.message)
        return data as { variance: number }
      },
      onSuccess: refresh,
    }),
  }
}

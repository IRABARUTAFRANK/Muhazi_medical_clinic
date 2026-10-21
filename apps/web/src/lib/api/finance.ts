import { useQuery } from '@tanstack/react-query'
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
  encounterId: string
  patient: string
  fileNumber: string
  cashier: string | null
}
export interface CashierSummary {
  day: string
  total: number
  count: number
  previousTotal: number
  mine: number
  byMethod: { method: string; amount: number; count: number }[]
  byCashier: { name: string; amount: number; count: number }[]
  payments: CashPayment[]
  openBills: number
  openDue: number
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

export function useCashierSummary(day: string | null) {
  return useQuery({
    queryKey: ['finance', 'day', day],
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
        }
      }
      const { data, error } = await supabase.rpc('cashier_summary', { p_day: day })
      if (error) throw new Error(error.message)
      return data as CashierSummary
    },
  })
}

/** What finished visits still owe (the patient left without paying; migration 0059). */
export interface Debt {
  encounterId: string
  patientId: string
  patient: string
  fileNumber: string
  phone: string | null
  amount: number
  closedAt: string | null
  reason: string | null
  closedBy: string | null
}

export function useUnpaidDebts() {
  return useQuery({
    queryKey: ['finance', 'debts'],
    refetchInterval: 60_000,
    queryFn: async (): Promise<Debt[]> => {
      if (!supabase) return []
      const { data, error } = await supabase.rpc('unpaid_debts')
      if (error) throw new Error(error.message)
      return ((data as Debt[]) ?? []).map((d) => ({ ...d, amount: Number(d.amount) }))
    },
  })
}

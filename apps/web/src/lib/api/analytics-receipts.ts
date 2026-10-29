import { useQuery } from '@tanstack/react-query'
import type { ReceiptDoc } from '@/lib/receipt-doc'
import type { LetterheadWithLegacy } from '@/lib/report-parts'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { apiError, isMissingFunction } from './errors'

/**
 * The receipts of a period (migration 0102, receipts_in_period): every payment taken between
 * two days, sorted by time, with what the receipt printed at the cash desk needs (the bill's
 * lines, the insurer's and the patient's shares, what was paid up to that payment). Filtered by
 * cashier and payment method. The manager and whoever reads the bills see the whole desk;
 * someone who only takes payments sees the receipts they gave. Before 0102: empty with
 * `needsUpdate`.
 */

export interface ReceiptLineRow {
  description: string
  quantity: number
  unitPrice: number
  fullAmount: number
  /** The patient's share of the line. */
  amount: number
}
export interface ReceiptRow {
  id: string
  receiptNo: string | null
  /** The bill's number (INV-…), or the counter sale's (S-…). */
  invoiceNo: string | null
  visitNo: string | null
  encounterId: string | null
  counterSaleId: string | null
  at: string
  /** cash, momo, airtel, card, bank… */
  method: string
  amount: number
  reference: string | null
  cashierId: string | null
  cashier: string | null
  /** Already counted in a day close. */
  counted: boolean
  patient: { name: string; fileNumber: string; insurer: string | null; memberNo: string | null }
  lines: ReceiptLineRow[]
  /** Full charges before the insurer split. */
  subtotal: number
  /** The patient's share of the bill. */
  total: number
  insurerAmount: number
  insurerPct: number | null
  /** Paid on the bill up to and including this payment; what was still due after it. */
  paid: number
  balance: number
}
export interface ReceiptsInPeriod {
  needsUpdate: boolean
  from: string
  to: string
  /** 'desk': the whole cash desk; 'mine': the receipts I gave. */
  scope: 'desk' | 'mine'
  count: number
  total: number
  byMethod: { method: string; count: number; amount: number }[]
  byCashier: { id: string | null; name: string; count: number; amount: number }[]
  /** The cashiers of the period, for the filter. */
  cashiers: { id: string; name: string }[]
  receipts: ReceiptRow[]
}
export interface ReceiptFilters {
  cashier?: string | null
  method?: string | null
}

type Raw = Record<string, unknown>
const n0 = (v: unknown): number => {
  const x = Number(v ?? 0)
  return Number.isFinite(x) ? x : 0
}
const nn = (v: unknown): number | null => (v == null ? null : n0(v))
const s0 = (v: unknown): string => (v == null ? '' : String(v))
const sn = (v: unknown): string | null => (v == null ? null : String(v))
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : [])
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {})

export function toReceiptsInPeriod(data: unknown): ReceiptsInPeriod {
  const d = obj(data)
  return {
    needsUpdate: false,
    from: s0(d.from),
    to: s0(d.to),
    scope: d.scope === 'mine' ? 'mine' : 'desk',
    count: n0(d.count),
    total: n0(d.total),
    byMethod: arr(d.byMethod).map((x) => ({
      method: s0(x.method),
      count: n0(x.count),
      amount: n0(x.amount),
    })),
    byCashier: arr(d.byCashier).map((x) => ({
      id: sn(x.id),
      name: s0(x.name),
      count: n0(x.count),
      amount: n0(x.amount),
    })),
    cashiers: arr(d.cashiers).map((x) => ({ id: s0(x.id), name: s0(x.name) })),
    receipts: arr(d.receipts).map((x) => {
      const p = obj(x.patient)
      return {
        id: s0(x.id),
        receiptNo: sn(x.receiptNo),
        invoiceNo: sn(x.invoiceNo),
        visitNo: sn(x.visitNo),
        encounterId: sn(x.encounterId),
        counterSaleId: sn(x.counterSaleId),
        at: s0(x.at),
        method: s0(x.method),
        amount: n0(x.amount),
        reference: sn(x.reference),
        cashierId: sn(x.cashierId),
        cashier: sn(x.cashier),
        counted: !!x.counted,
        patient: {
          name: s0(p.name),
          fileNumber: s0(p.fileNumber),
          insurer: sn(p.insurer),
          memberNo: sn(p.memberNo),
        },
        lines: arr(x.lines).map((l) => ({
          description: s0(l.description),
          quantity: n0(l.quantity),
          unitPrice: n0(l.unitPrice),
          fullAmount: n0(l.fullAmount),
          amount: n0(l.amount),
        })),
        subtotal: n0(x.subtotal),
        total: n0(x.total),
        insurerAmount: n0(x.insurerAmount),
        insurerPct: nn(x.insurerPct),
        paid: n0(x.paid),
        balance: n0(x.balance),
      }
    }),
  }
}

export const emptyReceipts = (
  p: { from: string; to: string },
  needsUpdate = true,
): ReceiptsInPeriod => ({
  ...toReceiptsInPeriod({}),
  needsUpdate,
  from: p.from,
  to: p.to,
})

// ------------------------------------------------------------------ sample mode

const SAMPLE_CASHIERS = [
  { id: 'u-cash', name: 'Mugisha Samuel' },
  { id: 'u-rec', name: 'Uwimana Josiane' },
]
const SAMPLE_PATIENTS = [
  ['Iradukunda Sandrine', 'MMC-000130'],
  ['Rukundo Kevin', 'MMC-000131'],
  ['Uwase Claudine', 'MMC-000132'],
  ['Hakizimana Emmanuel', 'MMC-000133'],
  ['Mukamana Alice', 'MMC-000124'],
  ['Kayitesi Rose', 'MMC-000135'],
] as const
const SAMPLE_LINES: ReceiptLineRow[][] = [
  [
    { description: 'Consultation', quantity: 1, unitPrice: 5000, fullAmount: 5000, amount: 5000 },
    { description: 'Malaria RDT', quantity: 1, unitPrice: 2000, fullAmount: 2000, amount: 2000 },
  ],
  [
    {
      description: 'Dental extraction',
      quantity: 1,
      unitPrice: 15000,
      fullAmount: 15000,
      amount: 15000,
    },
  ],
  [
    { description: 'Consultation', quantity: 1, unitPrice: 5000, fullAmount: 5000, amount: 750 },
    {
      description: 'Amoxicillin 500 mg',
      quantity: 21,
      unitPrice: 300,
      fullAmount: 6300,
      amount: 945,
    },
  ],
]
const METHODS = ['cash', 'momo', 'airtel'] as const

/** About eight receipts a day, the same ones from one render to the next. */
function sampleReceipts(p: { from: string; to: string }, f: ReceiptFilters): ReceiptsInPeriod {
  const day = 86_400_000
  const a = Date.parse(`${p.from}T00:00:00Z`)
  const b = Date.parse(`${p.to}T00:00:00Z`)
  const n = Math.max(1, Math.min(31, Math.round((b - a) / day) + 1))
  const rows: ReceiptRow[] = []
  let seq = 400
  for (let i = 0; i < n; i++) {
    const d = new Date(a + i * day)
    const dayNo = d.getUTCDate()
    const count = 6 + (dayNo % 3)
    for (let k = 0; k < count; k++) {
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 6 + k, (k * 17 + dayNo) % 60)
      if (at.getTime() > Date.now()) continue
      const pt = SAMPLE_PATIENTS[(k + dayNo) % SAMPLE_PATIENTS.length]!
      const lines = SAMPLE_LINES[(k + dayNo) % SAMPLE_LINES.length]!
      const insured = lines === SAMPLE_LINES[2]
      const subtotal = lines.reduce((s, l) => s + l.fullAmount, 0)
      const total = lines.reduce((s, l) => s + l.amount, 0)
      const cashier = SAMPLE_CASHIERS[k % 4 === 3 ? 1 : 0]!
      const method = METHODS[(k + dayNo) % 3]!
      seq += 1
      rows.push({
        id: `pay-${i}-${k}`,
        receiptNo: `RCT-2026-${String(seq).padStart(6, '0')}`,
        invoiceNo: `INV-2026-${String(seq - 100).padStart(6, '0')}`,
        visitNo: `V-2026-${String(seq + 20).padStart(6, '0')}`,
        encounterId: `e-${k % 4}`,
        counterSaleId: null,
        at: at.toISOString(),
        method,
        amount: total,
        reference: method === 'cash' ? null : `MP2610${dayNo}.${String(k).padStart(2, '0')}`,
        cashierId: cashier.id,
        cashier: cashier.name,
        counted: i < n - 1,
        patient: {
          name: pt[0],
          fileNumber: pt[1],
          insurer: insured ? 'RSSB (CBHI)' : null,
          memberNo: insured ? '1198800123456' : null,
        },
        lines,
        subtotal,
        total,
        insurerAmount: subtotal - total,
        insurerPct: insured ? 85 : null,
        paid: total,
        balance: 0,
      })
    }
  }
  const kept = rows.filter(
    (r) => (!f.cashier || r.cashierId === f.cashier) && (!f.method || r.method === f.method),
  )
  const group = <K extends string>(key: (r: ReceiptRow) => K) => {
    const m = new Map<K, { count: number; amount: number }>()
    for (const r of kept) {
      const g = m.get(key(r)) ?? { count: 0, amount: 0 }
      g.count += 1
      g.amount += r.amount
      m.set(key(r), g)
    }
    return [...m.entries()].sort((x, y) => y[1].amount - x[1].amount)
  }
  return {
    needsUpdate: false,
    from: p.from,
    to: p.to,
    scope: 'desk',
    count: kept.length,
    total: kept.reduce((s, r) => s + r.amount, 0),
    byMethod: group((r) => r.method).map(([method, g]) => ({ method, ...g })),
    byCashier: group((r) => r.cashier ?? '—').map(([name, g]) => ({
      id: SAMPLE_CASHIERS.find((c) => c.name === name)?.id ?? null,
      name,
      ...g,
    })),
    cashiers: SAMPLE_CASHIERS,
    receipts: kept,
  }
}

// ------------------------------------------------------------------ hook

export const receiptsKey = (p: { from: string; to: string }, f: ReceiptFilters) =>
  ['analytics', 'receipts', p.from, p.to, f.cashier ?? null, f.method ?? null] as const

export function useReceiptsInPeriod(
  period: { from: string; to: string },
  filters: ReceiptFilters = {},
  enabled = true,
) {
  const userId = useSession((s) => s.user?.id ?? null)
  return useQuery({
    queryKey: [...receiptsKey(period, filters), userId],
    enabled: enabled && !!userId,
    staleTime: 60_000,
    queryFn: async (): Promise<ReceiptsInPeriod> => {
      if (!supabase) return sampleReceipts(period, filters)
      const { data, error } = await supabase.rpc('receipts_in_period', {
        p_from: period.from,
        p_to: period.to,
        p_cashier: filters.cashier ?? null,
        p_method: filters.method ?? null,
      })
      if (error) {
        if (isMissingFunction(error)) return emptyReceipts(period)
        throw apiError(error)
      }
      return toReceiptsInPeriod(data)
    },
  })
}

// ------------------------------------------------------------------ to the receipt builder

/** One row as the receipt builder prints it (the same shape the cash desk's print passes). */
export function receiptDocOf(r: ReceiptRow, clinic: LetterheadWithLegacy): ReceiptDoc {
  return {
    receiptNo: r.receiptNo,
    invoiceNo: r.invoiceNo,
    visitNo: r.visitNo,
    at: new Date(r.at),
    clinic,
    patient: {
      name: r.patient.name,
      fileNumber: r.patient.fileNumber,
      insurer: r.patient.insurer,
      memberNo: r.patient.memberNo,
    },
    lines: r.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      fullAmount: l.fullAmount,
      amount: l.amount,
    })),
    total: r.total,
    subtotal: r.subtotal,
    insurer:
      r.insurerAmount > 0
        ? { name: r.patient.insurer ?? '', amount: r.insurerAmount, pct: r.insurerPct }
        : null,
    // the method code: the receipt writes it in the reader's language
    payment: { method: r.method, amount: r.amount, reference: r.reference },
    paid: r.paid,
    balance: r.balance,
    cashier: r.cashier ?? '',
  }
}

import { useQuery } from '@tanstack/react-query'
import { isMissingFunction } from '@/lib/api/errors'
import { supabase } from '@/lib/supabase'

/**
 * Money to give back after a medicine was returned once the bill was posted (migration 0082): the
 * return writes a credit note (CN-…) for the patient's share, and the bill then holds more than it
 * owes. The cashier gives the difference back here (or from the visit's payment card).
 *
 * There is no list function for this in lib/api yet, so this file reads it itself: the credit
 * notes of the last 120 days, then the balance of their bills (visit_bill); only bills still
 * holding money to give back are kept.
 */
export interface RefundDue {
  invoiceId: string
  encounterId: string
  patient: string
  fileNumber: string | null
  phone: string | null
  billNumber: string | null
  /** What is still to give back (the bill's balance below zero, as a positive amount). */
  amount: number
  /** The credit notes behind it (newest first). */
  notes: { id: string; number: string | null; amount: number; reason: string; at: string }[]
}

const DAYS = 120

// sample mode: one return waiting, gone once given back
export const sampleRefunds: RefundDue[] = [
  {
    invoiceId: 'inv-e-ret-1',
    encounterId: 'e-ret-1',
    patient: 'Uwimana Grace',
    fileNumber: 'MMC-000117',
    phone: '0788 555 210',
    billNumber: 'INV-2026-000052',
    amount: 1200,
    notes: [
      {
        id: 'cn-1',
        number: 'CN-2026-000003',
        amount: 1200,
        reason: 'Amoxicillin 500 mg returned unopened',
        at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      },
    ],
  },
]

interface NoteRow {
  id: string
  number: string | null
  reason: string | null
  created_at: string
  patient_amount: number | string | null
  invoice_id: string
  invoice: {
    encounter: {
      patient: {
        surname: string | null
        given_names: string | null
        file_number: string | null
        phone_1: string | null
      } | null
    } | null
  } | null
}
interface BillRow {
  invoice_id: string
  encounter_id: string
  number: string | null
  balance: number | string | null
}

/** The bills holding money to give back after a medicine return (cashier and manager). */
export function useRefundsDue() {
  return useQuery({
    queryKey: ['finance', 'refunds-due'],
    refetchInterval: 60_000,
    queryFn: async (): Promise<RefundDue[]> => {
      if (!supabase) return sampleRefunds.filter((r) => r.amount > 0)
      const since = new Date(Date.now() - DAYS * 86_400_000).toISOString()
      const notes = await supabase
        .from('credit_note')
        .select(
          'id, number, reason, created_at, patient_amount, invoice_id, invoice:invoice_id(encounter:encounter_id(patient:patient_id(surname, given_names, file_number, phone_1)))',
        )
        .is('deleted_at', null)
        .gt('patient_amount', 0)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(300)
      if (notes.error) {
        // a database older than migration 0082 has no patient_amount: nothing to show yet
        if (isMissingFunction(notes.error) || /patient_amount|column/i.test(notes.error.message))
          return []
        throw new Error(notes.error.message)
      }
      const rows = (notes.data ?? []) as unknown as NoteRow[]
      const ids = [...new Set(rows.map((r) => r.invoice_id))]
      if (ids.length === 0) return []
      const bills = await supabase
        .from('visit_bill')
        .select('invoice_id, encounter_id, number, balance')
        .in('invoice_id', ids)
      if (bills.error) throw new Error(bills.error.message)
      const out: RefundDue[] = []
      for (const b of (bills.data ?? []) as BillRow[]) {
        const balance = Number(b.balance ?? 0)
        if (!(balance < 0)) continue
        const mine = rows.filter((r) => r.invoice_id === b.invoice_id)
        const p = mine[0]?.invoice?.encounter?.patient
        out.push({
          invoiceId: b.invoice_id,
          encounterId: b.encounter_id,
          patient: [p?.surname, p?.given_names].filter(Boolean).join(' ') || '—',
          fileNumber: p?.file_number ?? null,
          phone: p?.phone_1 ?? null,
          billNumber: b.number,
          amount: -balance,
          notes: mine.map((r) => ({
            id: r.id,
            number: r.number,
            amount: Number(r.patient_amount ?? 0),
            reason: r.reason ?? '',
            at: r.created_at,
          })),
        })
      }
      return out.sort((a, b) => (b.notes[0]?.at ?? '').localeCompare(a.notes[0]?.at ?? ''))
    },
  })
}

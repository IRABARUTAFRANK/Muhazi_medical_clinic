import { useQuery } from '@tanstack/react-query'
import { isMissingFunction } from '@/lib/api/errors'
import { supabase } from '@/lib/supabase'

/**
 * Money to give back: a bill that holds more than it owes. After a medicine was returned once the
 * bill was posted (migration 0082) the return writes a credit note (CN-…) for the patient's share;
 * on a visit still open a paid treatment removed or a medicine returned leaves the balance below
 * zero with no note. The cashier gives the difference back here (or from the visit's payment card).
 *
 * There is no list function for this in lib/api yet, so this file reads it itself: every bill
 * whose balance is below zero (visit_bill), the credit notes behind it when there are any, and the
 * patient of each visit.
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
  /** The credit notes behind it (newest first); none on an open bill with a paid line removed. */
  notes: { id: string; number: string | null; amount: number; reason: string; at: string }[]
}

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
}
interface BillRow {
  invoice_id: string
  encounter_id: string
  number: string | null
  balance: number | string | null
}
interface PatientRow {
  id: string
  patient: {
    surname: string | null
    given_names: string | null
    file_number: string | null
    phone_1: string | null
  } | null
}

/** The bills holding money to give back (cashier and manager). */
export function useRefundsDue() {
  return useQuery({
    queryKey: ['finance', 'refunds-due'],
    refetchInterval: 60_000,
    queryFn: async (): Promise<RefundDue[]> => {
      if (!supabase) return sampleRefunds.filter((r) => r.amount > 0)
      // every bill holding more than it owes: after a credit note, or on an open visit
      const bills = await supabase
        .from('visit_bill')
        .select('invoice_id, encounter_id, number, balance')
        .lt('balance', 0)
        .limit(300)
      if (bills.error) {
        // a database older than migration 0082 has no refunds to list yet
        if (isMissingFunction(bills.error)) return []
        throw new Error(bills.error.message)
      }
      const rows = ((bills.data ?? []) as BillRow[]).filter((b) => Number(b.balance ?? 0) < 0)
      if (rows.length === 0) return []
      const [notes, patients] = await Promise.all([
        supabase
          .from('credit_note')
          .select('id, number, reason, created_at, patient_amount, invoice_id')
          .is('deleted_at', null)
          .gt('patient_amount', 0)
          .in(
            'invoice_id',
            rows.map((b) => b.invoice_id),
          )
          .order('created_at', { ascending: false })
          .limit(300),
        supabase
          .from('encounter')
          .select('id, patient:patient_id(surname, given_names, file_number, phone_1)')
          .in(
            'id',
            rows.map((b) => b.encounter_id),
          ),
      ])
      // a database older than 0082 has no patient_amount: the bills are listed without notes
      if (
        notes.error &&
        !(isMissingFunction(notes.error) || /patient_amount|column/i.test(notes.error.message))
      )
        throw new Error(notes.error.message)
      if (patients.error) throw new Error(patients.error.message)
      const noteRows = ((notes.data ?? []) as unknown as NoteRow[]) ?? []
      const people = (patients.data ?? []) as unknown as PatientRow[]
      const out: RefundDue[] = rows.map((b) => {
        const mine = noteRows.filter((r) => r.invoice_id === b.invoice_id)
        const p = people.find((x) => x.id === b.encounter_id)?.patient
        return {
          invoiceId: b.invoice_id,
          encounterId: b.encounter_id,
          patient: [p?.surname, p?.given_names].filter(Boolean).join(' ') || '—',
          fileNumber: p?.file_number ?? null,
          phone: p?.phone_1 ?? null,
          billNumber: b.number,
          amount: -Number(b.balance ?? 0),
          notes: mine.map((r) => ({
            id: r.id,
            number: r.number,
            amount: Number(r.patient_amount ?? 0),
            reason: r.reason ?? '',
            at: r.created_at,
          })),
        }
      })
      // the latest credit note first; bills without one after them
      return out.sort((a, b) => (b.notes[0]?.at ?? '').localeCompare(a.notes[0]?.at ?? ''))
    },
  })
}

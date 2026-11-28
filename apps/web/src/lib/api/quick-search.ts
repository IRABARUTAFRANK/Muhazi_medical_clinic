import { useQuery } from '@tanstack/react-query'
import { STAFF } from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import { apiError, isMissingFunction } from './errors'
import { sampleStock } from './stock'
import { samplePatients } from './visits'

/**
 * 0213: the search bar at the top of every screen suggests as one types (quick_search): a few
 * patients, visits, bills, receipts, bookings, employees and medicines — each kind only for those
 * who may see it (the database decides). The menu's pages are matched by the screen itself.
 */

export interface QsPatient {
  id: string
  fileNumber: string | null
  name: string
  sex: string | null
  birthDate: string | null
  phone: string | null
  /** The visit open now, if any. */
  openEncounterId: string | null
}
export interface QsVisit {
  encounterId: string
  reference: string | null
  status: string
  at: string
  patientId: string
  name: string
  fileNumber: string | null
}
export interface QsBill {
  encounterId: string
  number: string
  status: string
  total: number
  at: string
  name: string
  fileNumber: string | null
}
export interface QsReceipt {
  /** Null for a counter sale's receipt (a buyer without a visit). */
  encounterId: string | null
  receiptNo: string
  amount: number
  method: string
  at: string
  name: string | null
  fileNumber: string | null
  sale: string | null
}
export interface QsBooking {
  id: string
  reference: string | null
  status: string
  startsAt: string | null
  preferredAt: string | null
  name: string | null
  phone: string | null
  doctor: string | null
}
export interface QsStaff {
  id: string
  name: string
  staffId: string | null
  role: string
  active: boolean
}
export interface QsItem {
  id: string
  name: string
  code: string
}
export interface QuickResults {
  patients: QsPatient[]
  visits: QsVisit[]
  bills: QsBill[]
  receipts: QsReceipt[]
  bookings: QsBooking[]
  staff: QsStaff[]
  items: QsItem[]
}

export const EMPTY_RESULTS: QuickResults = {
  patients: [],
  visits: [],
  bills: [],
  receipts: [],
  bookings: [],
  staff: [],
  items: [],
}

const has = (hay: (string | null | undefined)[], needle: string) =>
  hay.some((h) => (h ?? '').toLowerCase().includes(needle))

/** The sample app: the sample patients, staff and medicines, a receipt and a request. */
function sampleSearch(q: string, isManager: boolean): QuickResults {
  const n = q.toLowerCase()
  const digits = q.replace(/\D/g, '')
  const num = q.length >= 3 && digits !== ''
  const receipts: QsReceipt[] = [
    {
      encounterId: 'e-0',
      receiptNo: 'RCT-2026-000123',
      amount: 2000,
      method: 'mtn_momo',
      at: new Date(Date.now() - 50 * 60_000).toISOString(),
      name: 'Uwase Claudine',
      fileNumber: 'MMC-000124',
      sale: null,
    },
  ]
  const bookings: QsBooking[] = [
    {
      id: 'q-1',
      reference: 'MMC-2026-0011',
      status: 'inquiry',
      startsAt: null,
      preferredAt: new Date(Date.now() + 86_400_000).toISOString(),
      name: 'Nsengiyumva Claude',
      phone: '0788000000',
      doctor: null,
    },
  ]
  return {
    patients: samplePatients
      .filter(
        (p) =>
          has([`${p.surname} ${p.givenNames}`, `${p.givenNames} ${p.surname}`], n) ||
          (num && has([p.fileNumber], n)) ||
          (digits.length >= 4 && (p.phone ?? '').replace(/\D/g, '').includes(digits)),
      )
      .slice(0, 6)
      .map((p) => ({
        id: p.id,
        fileNumber: p.fileNumber,
        name: `${p.surname} ${p.givenNames}`,
        sex: p.sex,
        birthDate: p.birthDate ?? null,
        phone: p.phone ?? null,
        openEncounterId: p.hasOpenVisit ? 'e-1' : null,
      })),
    visits: [],
    bills: [],
    receipts: num ? receipts.filter((r) => has([r.receiptNo], n)) : [],
    bookings: bookings.filter((b) => (num && has([b.reference], n)) || has([b.name], n)),
    staff: isManager
      ? STAFF.filter((s) => has([s.name, s.staffId, s.username], n))
          .slice(0, 4)
          .map((s) => ({
            id: s.id,
            name: s.name,
            staffId: s.staffId ?? null,
            role: s.role,
            active: true,
          }))
      : [],
    items: sampleStock.items
      .filter((i) => has([i.name, i.code], n))
      .slice(0, 5)
      .map((i) => ({
        id: i.id,
        name: [i.name, i.strength].filter(Boolean).join(' '),
        code: i.code,
      })),
  }
}

/** The suggestions for what is typed (2 characters at least). */
export function useQuickSearch(query: string, isManager: boolean) {
  const q = query.trim()
  return useQuery({
    queryKey: ['quick-search', q],
    enabled: q.length >= 2,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<QuickResults> => {
      if (!supabase) return sampleSearch(q, isManager)
      const { data, error } = await supabase.rpc('quick_search', { p_query: q })
      // a database before 0213: the patients only, as the patient register finds them
      if (error && isMissingFunction(error)) {
        const old = await supabase.rpc('find_patients', { p_query: q, p_limit: 6 })
        if (old.error) throw apiError(old.error)
        return {
          ...EMPTY_RESULTS,
          patients: (
            (old.data ?? []) as {
              id: string
              file_number: string | null
              surname: string
              given_names: string
              sex: string | null
              birth_date: string | null
              phone_1: string | null
            }[]
          ).map((r) => ({
            id: r.id,
            fileNumber: r.file_number,
            name: `${r.surname} ${r.given_names}`,
            sex: r.sex,
            birthDate: r.birth_date,
            phone: r.phone_1,
            openEncounterId: null,
          })),
        }
      }
      if (error) throw apiError(error)
      const d = (data ?? {}) as Partial<QuickResults>
      return {
        patients: d.patients ?? [],
        visits: d.visits ?? [],
        bills: (d.bills ?? []).map((b) => ({ ...b, total: Number(b.total) })),
        receipts: (d.receipts ?? []).map((r) => ({ ...r, amount: Number(r.amount) })),
        bookings: d.bookings ?? [],
        staff: d.staff ?? [],
        items: d.items ?? [],
      }
    },
  })
}

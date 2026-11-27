import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isoDate } from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { apiError, isMissingFunction } from './errors'
import { withLeftUnseen } from './booking-status'

/**
 * The bookings made with the signed-in person (`my_bookings`, 0099): every booking still
 * waiting for their answer, and the others from 30 days back to 3 weeks ahead, each with its
 * history. The manager may read a colleague's (`userId`). Sample mode shows example bookings
 * (kept for the session, so the actions below can be tried).
 * 0208: the person closes a missed booking ("Did not come", "Cancel the booking") and takes a
 * wrong "Did not come" back (`set_appointment_outcome`, `undo_no_show`).
 */

export type MyBookingStatus =
  | 'approved'
  | 'confirmed'
  | 'arrived'
  | 'in_progress'
  | 'completed'
  | 'no_show'
  | 'cancelled'
  | 'declined'
  /** Came, but the visit closed before anyone saw the patient (0101). */
  | 'left_unseen'

export interface MyBookingStep {
  at: string
  by: string | null
  status: string | null
  startsAt: string | null
  /** The time changed at this step. */
  moved: boolean
  /** 0125: why the booking was moved (change_booking). */
  why?: string | null
}

export interface MyBooking {
  id: string
  status: MyBookingStatus
  startsAt: string
  endsAt: string | null
  reason: string | null
  /** 0125: the note of the person who booked (book_follow_up, change_booking). */
  note?: string | null
  /** 0125: the visit the booking was made from (a follow-up). */
  fromEncounter?: string | null
  category: string | null
  source: string | null
  reference: string | null
  channel: string | null
  cancelReason: string | null
  createdAt: string
  patientId: string | null
  fileNumber: string | null
  name: string
  phone: string | null
  /** Reception (or whoever) who booked it, and when. */
  bookedBy: string | null
  bookedAt: string | null
  acceptedBy: string | null
  acceptedAt: string | null
  /** The visit opened on arrival. */
  encounterId: string | null
  late: boolean
  history: MyBookingStep[]
}

export interface MyBookings {
  userId: string
  name: string | null
  /** The person's booking length: the steps of "Another time". */
  slotMinutes: number
  rows: MyBooking[]
  /** The database has no my_bookings yet (the website was updated first). */
  missing?: boolean
}

const addDays = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d
}
/** n days from today at h:m, local time. */
const at = (days: number, h: number, m = 0) => {
  const d = addDays(days)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

function sampleBookings(): MyBookings {
  const row = (
    id: string,
    days: number,
    h: number,
    m: number,
    status: MyBookingStatus,
    name: string,
    reason: string | null,
    extra: Partial<MyBooking> = {},
  ): MyBooking => {
    const startsAt = at(days, h, m)
    const createdAt = at(Math.min(days, 0) - 3, 9, 12)
    const bookedAt = at(Math.min(days, 0) - 3, 9, 15)
    const history: MyBookingStep[] = [
      { at: createdAt, by: 'Uwimana Josiane', status: 'inquiry', startsAt, moved: false },
      { at: bookedAt, by: 'Uwimana Josiane', status: 'approved', startsAt, moved: false },
    ]
    if (status !== 'approved' && status !== 'declined')
      history.push({
        at: at(Math.min(days, 0) - 2, 8, 40),
        by: 'Dr. Mukamana Béatrice',
        status: 'confirmed',
        startsAt,
        moved: false,
      })
    if (status !== 'approved' && status !== 'confirmed')
      history.push({
        at: at(Math.min(days, 0), Math.min(h + 1, 23), m),
        by: status === 'declined' ? 'Dr. Mukamana Béatrice' : 'Uwimana Josiane',
        status,
        startsAt,
        moved: false,
      })
    return {
      id,
      status,
      startsAt,
      endsAt: null,
      reason,
      category: null,
      source: 'reception',
      reference: null,
      channel: 'sms',
      cancelReason: null,
      createdAt,
      patientId: `p-${id}`,
      fileNumber: `MMC-000${100 + id.length * 7}`,
      name,
      phone: '0788123456',
      bookedBy: 'Uwimana Josiane',
      bookedAt,
      acceptedBy: status === 'approved' || status === 'declined' ? null : 'Dr. Mukamana Béatrice',
      acceptedAt: status === 'approved' || status === 'declined' ? null : at(days - 2, 8, 40),
      encounterId: status === 'arrived' || status === 'in_progress' ? 'e-1' : null,
      late: false,
      history,
      ...extra,
    }
  }
  return {
    userId: 'sample',
    name: null,
    slotMinutes: 30,
    rows: [
      row('mb-1', 1, 10, 30, 'approved', 'Ingabire Diane', 'Back pain for two weeks', {
        source: 'online',
        reference: 'MMC-2026-0042',
        channel: 'whatsapp',
      }),
      row('mb-2', 3, 9, 0, 'approved', 'Nshimiyimana Patrick', 'Follow-up of blood pressure'),
      row('mb-3', 0, 8, 30, 'arrived', 'Mukamana Alice', 'Follow-up'),
      row('mb-4', 0, 15, 0, 'confirmed', 'Habimana Eric', 'Tooth pain'),
      row('mb-5', 2, 11, 0, 'confirmed', 'Uwase Claudine', 'Results of the scan'),
      row('mb-6', 8, 14, 30, 'confirmed', 'Mugisha Kevin', null),
      row('mb-7', -1, 10, 0, 'no_show', 'Iradukunda Sandrine', 'Check-up'),
      row('mb-8', -4, 9, 30, 'completed', 'Rukundo Kevin', 'Cough and fever'),
      row('mb-9', -6, 16, 0, 'declined', 'Niyonzima Jean Bosco', 'Certificate', {
        cancelReason: 'On leave that afternoon; please book with Dr. Ndayisaba.',
      }),
      row('mb-10', -9, 11, 30, 'cancelled', 'Mukeshimana Grace', 'Pregnancy check', {
        cancelReason: 'The patient called to cancel.',
      }),
      // 0208: two confirmed bookings whose time passed without the patient (to close)
      row('mb-11', -2, 9, 0, 'confirmed', 'Mutoni Aline', 'Blood pressure check'),
      row('mb-12', -1, 14, 30, 'confirmed', 'Hakizimana Yves', 'Wound dressing', {
        phone: null,
      }),
    ],
  }
}

// the sample bookings live for the session: the actions change them
let sample: MyBookings | null = null
const sampleStore = () => (sample ??= sampleBookings())
const sampleRow = (id: string) => (supabase ? undefined : sample?.rows.find((b) => b.id === id))
const sampleStep = (status: string, startsAt: string, extra: Partial<MyBookingStep> = {}) => ({
  at: new Date().toISOString(),
  by: useSession.getState().user?.name ?? null,
  status,
  startsAt,
  moved: false,
  ...extra,
})

/** Sample mode: a booking of My bookings moved (Change booking) keeps the page in step. */
export function sampleMyBookingMoved(id: string, startsAt: string | null, why: string | null) {
  const b = sampleRow(id)
  if (!b || !startsAt || startsAt === b.startsAt) return
  b.startsAt = startsAt
  b.late = false
  b.history = [...b.history, sampleStep(b.status, startsAt, { moved: true, why })]
}

/** Sample mode: a booking made with oneself ("Book again") shows in My bookings. */
export function sampleMyBookingAdded(i: {
  id: string
  patientId: string
  name: string
  startsAt: string
  reason: string | null
  note: string | null
}) {
  if (supabase || !sample) return
  const from = sample.rows.find((b) => b.patientId === i.patientId)
  const me = useSession.getState().user?.name ?? null
  const now = new Date().toISOString()
  sample.rows.push({
    id: i.id,
    status: 'confirmed',
    startsAt: i.startsAt,
    endsAt: null,
    reason: i.reason,
    note: i.note,
    category: null,
    source: 'clinician',
    reference: null,
    channel: null,
    cancelReason: null,
    createdAt: now,
    patientId: i.patientId,
    fileNumber: from?.fileNumber ?? null,
    name: i.name,
    phone: from?.phone ?? null,
    bookedBy: me,
    bookedAt: now,
    acceptedBy: me,
    acceptedAt: now,
    encounterId: null,
    late: false,
    history: [sampleStep('confirmed', i.startsAt)],
  })
}

export type BookingOutcome = 'no_show' | 'cancelled'

/**
 * 0208: what the person does with a booking of theirs that will not happen: "Did not come"
 * (its time passed), "Cancel the booking" (with the reason; it stays in the history as
 * cancelled), and "Undo" of a wrong "Did not come" (back to what it was before).
 */
export function useMyBookingActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['appointments'] })
    void qc.invalidateQueries({ queryKey: ['home'] })
    void qc.invalidateQueries({ queryKey: ['nav-counts'] })
  }
  const outcome = useMutation({
    mutationFn: async (i: { id: string; status: BookingOutcome; reason?: string | null }) => {
      if (!supabase) {
        const b = sampleRow(i.id)
        if (b) {
          b.status = i.status
          b.late = false
          if (i.reason?.trim()) b.cancelReason = i.reason.trim()
          b.history = [...b.history, sampleStep(i.status, b.startsAt)]
        }
        return
      }
      const { error } = await supabase.rpc('set_appointment_outcome', {
        p_appointment_id: i.id,
        p_status: i.status,
        p_reason: i.reason?.trim() || null,
      })
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })
  const undo = useMutation({
    mutationFn: async (id: string): Promise<'approved' | 'confirmed'> => {
      if (!supabase) {
        const b = sampleRow(id)
        if (b) {
          b.status = 'confirmed'
          b.history = [...b.history, sampleStep('confirmed', b.startsAt)]
        }
        return 'confirmed'
      }
      const { data, error } = await supabase.rpc('undo_no_show', { p_appointment_id: id })
      if (error) throw apiError(error)
      return (data as { status: 'approved' | 'confirmed' }).status
    },
    onSuccess: refresh,
  })
  return { outcome, undo }
}

/** The person's bookings from `from` to `to` (Kigali days), plus everything still to answer. */
export function useMyBookings(userId?: string | null) {
  const from = isoDate(addDays(-30))
  const to = isoDate(addDays(21))
  return useQuery({
    queryKey: ['appointments', 'mine', userId ?? 'me', from, to],
    refetchInterval: 30_000,
    queryFn: async (): Promise<MyBookings> => {
      if (!supabase) {
        // by time, as my_bookings gives them (a moved or new booking takes its place)
        const s = sampleStore()
        const rows = s.rows.map((b) => ({ ...b }))
        return { ...s, rows: rows.sort((a, b) => a.startsAt.localeCompare(b.startsAt)) }
      }
      const { data, error } = await supabase.rpc('my_bookings', {
        p_from: from,
        p_to: to,
        p_user: userId ?? null,
      })
      if (error) {
        if (isMissingFunction(error))
          return { userId: userId ?? '', name: null, slotMinutes: 30, rows: [], missing: true }
        throw apiError(error)
      }
      const d = data as MyBookings
      return {
        ...d,
        slotMinutes: Number(d.slotMinutes) || 30,
        rows: (d.rows ?? []).map(withLeftUnseen),
      }
    },
  })
}

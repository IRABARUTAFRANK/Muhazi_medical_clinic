import { useQuery } from '@tanstack/react-query'
import { isoDate } from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import { apiError, isMissingFunction } from './errors'
import { withLeftUnseen } from './booking-status'

/**
 * The bookings made with the signed-in person (`my_bookings`, 0099): every booking still
 * waiting for their answer, and the others from 30 days back to 3 weeks ahead, each with its
 * history. The manager may read a colleague's (`userId`). Sample mode shows example bookings.
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
}

export interface MyBooking {
  id: string
  status: MyBookingStatus
  startsAt: string
  endsAt: string | null
  reason: string | null
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
    ],
  }
}

/** The person's bookings from `from` to `to` (Kigali days), plus everything still to answer. */
export function useMyBookings(userId?: string | null) {
  const from = isoDate(addDays(-30))
  const to = isoDate(addDays(21))
  return useQuery({
    queryKey: ['appointments', 'mine', userId ?? 'me', from, to],
    refetchInterval: 30_000,
    queryFn: async (): Promise<MyBookings> => {
      if (!supabase) return sampleBookings()
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

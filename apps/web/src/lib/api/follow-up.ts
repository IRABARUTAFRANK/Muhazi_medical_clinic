import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isoDate } from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { apiError, isMissingFunction } from './errors'
import { sampleNextAppointment } from './patients'

/**
 * Bookings made by the people who treat patients (0125): a doctor, a nurse, a sonographer (or
 * reception, or the manager) books the patient with themselves or a colleague, at a free time of
 * that person's calendar, from the visit, the patient file or My bookings. Live: `free_slots`,
 * `book_follow_up`, `patient_bookings`. Sample mode: a sample calendar and sample bookings.
 */

export type SlotState = 'free' | 'taken' | 'past'
export interface Slot {
  at: string
  /** "09:30", Kigali time. */
  time: string
  state: SlotState
}
export interface FreeSlots {
  userId: string
  name: string | null
  day: string
  /** The person keeps working hours: only their free slots can be chosen. */
  hasHours: boolean
  dayOff: boolean
  slotMinutes: number
  slots: Slot[]
  /** Without working hours: the times already booked that day. */
  booked: string[]
}

export type PatientBookingStatus =
  | 'approved'
  | 'confirmed'
  | 'arrived'
  | 'in_progress'
  | 'completed'
  | 'no_show'
  | 'cancelled'
  | 'declined'
export interface PatientBooking {
  id: string
  status: PatientBookingStatus
  startsAt: string
  endsAt: string | null
  reason: string | null
  note: string | null
  source: string | null
  category: string | null
  cancelReason: string | null
  withUserId: string | null
  with: string | null
  withRole: string | null
  title: string | null
  bookedBy: string | null
  bookedAt: string | null
  acceptedBy: string | null
  acceptedAt: string | null
  /** The visit the booking was made from (a follow-up). */
  fromEncounter: string | null
  fromReference: string | null
  /** The visit opened when the patient came. */
  encounterId: string | null
  mine: boolean
  upcoming: boolean
}

export interface FollowUpInput {
  patientId: string
  patientName: string
  withUserId: string
  withName: string
  startsAt: string
  reason?: string | null
  note?: string | null
  encounterId?: string | null
}
export interface FollowUpResult {
  id: string
  status: 'approved' | 'confirmed'
  startsAt: string
  with: string | null
  self: boolean
}

// ---------------------------------------------------------------- sample mode
const pad = (n: number) => String(n).padStart(2, '0')
/** Sample calendar: Monday to Saturday, 08:00–12:30 and 14:00–17:00 (the break in between). */
function sampleSlots(userId: string, day: string): FreeSlots {
  const d = new Date(`${day}T00:00:00`)
  const off = d.getDay() === 0
  const slots: Slot[] = []
  const taken = new Set(
    [...sampleBookings.values()]
      .flat()
      .filter(
        (b) =>
          b.withUserId === userId &&
          ['approved', 'confirmed'].includes(b.status) &&
          isoDate(new Date(b.startsAt)) === day,
      )
      .map((b) => {
        const s = new Date(b.startsAt)
        return `${pad(s.getHours())}:${pad(s.getMinutes())}`
      }),
  )
  if (!off)
    for (const [a, b] of [
      [8 * 60, 12 * 60 + 30],
      [14 * 60, 17 * 60],
    ] as const)
      for (let m = a; m + 30 <= b; m += 30) {
        const at = new Date(d)
        at.setHours(Math.floor(m / 60), m % 60, 0, 0)
        const time = `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
        // a few times of the day already booked (the same every time the day is shown)
        const busy = taken.has(time) || (d.getDate() * 7 + m / 30) % 5 === 0
        slots.push({
          at: at.toISOString(),
          time,
          state: at.getTime() < Date.now() ? 'past' : busy ? 'taken' : 'free',
        })
      }
  return {
    userId,
    name: null,
    day,
    hasHours: true,
    dayOff: off,
    slotMinutes: 30,
    slots,
    booked: [],
  }
}

const daysFromNow = (n: number, h: number, m = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}
const sampleBookings = new Map<string, PatientBooking[]>()
function sampleFor(patientId: string): PatientBooking[] {
  let list = sampleBookings.get(patientId)
  if (!list) {
    const me = useSession.getState().user
    const row = (p: Partial<PatientBooking> & Pick<PatientBooking, 'id' | 'startsAt'>) => ({
      status: 'confirmed' as const,
      endsAt: null,
      reason: null,
      note: null,
      source: 'clinician',
      category: null,
      cancelReason: null,
      withUserId: 'u-doc',
      with: 'Dr. Mukamana Béatrice',
      withRole: 'doctor',
      title: 'Dr.',
      bookedBy: 'Dr. Mukamana Béatrice',
      bookedAt: daysFromNow(-14, 10, 20),
      acceptedBy: 'Dr. Mukamana Béatrice',
      acceptedAt: daysFromNow(-14, 10, 20),
      fromEncounter: null,
      fromReference: null,
      encounterId: null,
      mine: me?.id === 'u-doc',
      upcoming: false,
      ...p,
    })
    list = [
      row({
        id: `${patientId}-b1`,
        startsAt: daysFromNow(6, 9, 30),
        reason: 'Follow-up: Hypertension',
        note: 'Bring the blood pressure booklet',
        fromReference: 'V-2026-000118',
        fromEncounter: 'e-old',
        upcoming: true,
      }),
      row({
        id: `${patientId}-b2`,
        startsAt: daysFromNow(-14, 10, 0),
        status: 'completed',
        reason: 'Follow-up: Malaria',
        source: 'reception',
        bookedBy: 'Uwimana Josiane',
        encounterId: 'e-done',
      }),
      row({
        id: `${patientId}-b3`,
        startsAt: daysFromNow(-40, 15, 0),
        status: 'no_show',
        reason: 'Results of the scan',
        source: 'online',
        with: 'Habimana Eric',
        withRole: 'sonographer',
        title: null,
        bookedBy: 'Uwimana Josiane',
        acceptedBy: 'Habimana Eric',
      }),
    ]
    sampleBookings.set(patientId, list)
  }
  return list
}

// ---------------------------------------------------------------- queries
/** The times of one day in a person's calendar (free, taken, past). */
export function useFreeSlots(userId: string | null, day: string | null) {
  return useQuery({
    queryKey: ['appointments', 'slots', userId, day],
    enabled: !!userId && !!day,
    staleTime: 15_000,
    queryFn: async (): Promise<FreeSlots> => {
      if (!supabase) return sampleSlots(userId!, day!)
      const { data, error } = await supabase.rpc('free_slots', { p_user: userId, p_day: day })
      if (error) throw apiError(error)
      const d = data as FreeSlots
      return {
        ...d,
        slotMinutes: Number(d.slotMinutes) || 30,
        slots: d.slots ?? [],
        booked: d.booked ?? [],
      }
    },
  })
}

/** The patient's bookings for the file: upcoming and past. `missing`: a database before 0125. */
export function usePatientBookings(patientId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['appointments', 'patient', patientId],
    enabled: !!patientId && enabled,
    queryFn: async (): Promise<{ rows: PatientBooking[]; missing: boolean }> => {
      if (!supabase) return { rows: [...sampleFor(patientId!)], missing: false }
      const { data, error } = await supabase.rpc('patient_bookings', { p_patient: patientId })
      if (error) {
        if (isMissingFunction(error)) return { rows: [], missing: true }
        throw apiError(error)
      }
      return { rows: (data ?? []) as PatientBooking[], missing: false }
    },
  })
}

/** Book the patient with someone at a time (confirmed at once for oneself). */
export function useBookFollowUp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (i: FollowUpInput): Promise<FollowUpResult> => {
      if (!supabase) {
        const me = useSession.getState().user
        const self = me?.id === i.withUserId
        const id = `fu-${Date.now()}`
        const status = self ? 'confirmed' : 'approved'
        sampleFor(i.patientId).unshift({
          id,
          status,
          startsAt: i.startsAt,
          endsAt: null,
          reason: i.reason?.trim() || null,
          note: i.note?.trim() || null,
          source: 'clinician',
          category: null,
          cancelReason: null,
          withUserId: i.withUserId,
          with: i.withName,
          withRole: null,
          title: null,
          bookedBy: me?.name ?? null,
          bookedAt: new Date().toISOString(),
          acceptedBy: self ? (me?.name ?? null) : null,
          acceptedAt: self ? new Date().toISOString() : null,
          fromEncounter: i.encounterId ?? null,
          fromReference: null,
          encounterId: null,
          mine: self,
          upcoming: true,
        })
        if (i.encounterId)
          sampleNextAppointment.set(i.encounterId, {
            id,
            at: i.startsAt,
            status,
            with: i.withName,
            title: null,
            reason: i.reason?.trim() || null,
            fromThisVisit: true,
          })
        return { id, status, startsAt: i.startsAt, with: i.withName, self }
      }
      const { data, error } = await supabase.rpc('book_follow_up', {
        p_patient: i.patientId,
        p_practitioner_user: i.withUserId,
        p_starts_at: i.startsAt,
        p_reason: i.reason?.trim() || null,
        p_note: i.note?.trim() || null,
        p_encounter: i.encounterId ?? null,
      })
      if (error) throw apiError(error)
      return data as FollowUpResult
    },
    onSuccess: (_r, i) => {
      // the patient file, My bookings, reception's day and the menu counts follow
      void qc.invalidateQueries({ queryKey: ['appointments'] })
      void qc.invalidateQueries({ queryKey: ['home'] })
      void qc.invalidateQueries({ queryKey: ['nav-counts'] })
      if (i.encounterId) void qc.invalidateQueries({ queryKey: ['visit', i.encounterId] })
    },
  })
}

export interface ChangeBookingInput {
  id: string
  /** The patient's file: its Bookings list is kept in step (sample mode). */
  patientId?: string | null
  /** Null: the time stays. */
  startsAt: string | null
  /** Null: the same person. */
  withUserId: string | null
  withName?: string | null
  reason: string | null
  note: string | null
  /** Why the time or the person changed (needed then). */
  why: string | null
}
export interface ChangeBookingResult {
  id: string
  status: 'approved' | 'confirmed'
  startsAt: string
  moved: boolean
  with: string | null
}

/** Change a booking (0125 change_booking): its time, its person, its reason and note. */
export function useChangeBooking() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (i: ChangeBookingInput): Promise<ChangeBookingResult> => {
      if (!supabase) {
        const me = useSession.getState().user
        const row = i.patientId
          ? sampleFor(i.patientId).find((b) => b.id === i.id)
          : [...sampleBookings.values()].flat().find((b) => b.id === i.id)
        const moved =
          (!!i.startsAt && i.startsAt !== row?.startsAt) ||
          (!!i.withUserId && i.withUserId !== row?.withUserId)
        if (moved && (i.why?.trim().length ?? 0) < 3)
          throw apiError({ code: '22023', message: 'say why the booking is moved' })
        const other = !!i.withUserId && i.withUserId !== row?.withUserId
        const status =
          other && i.withUserId !== me?.id ? 'approved' : (row?.status as 'approved') || 'confirmed'
        if (row)
          Object.assign(row, {
            startsAt: i.startsAt ?? row.startsAt,
            withUserId: i.withUserId ?? row.withUserId,
            with: other ? (i.withName ?? row.with) : row.with,
            reason: i.reason ?? row.reason,
            note: i.note ?? row.note,
            status,
          })
        return {
          id: i.id,
          status: status === 'approved' ? 'approved' : 'confirmed',
          startsAt: i.startsAt ?? row?.startsAt ?? new Date().toISOString(),
          moved,
          with: row?.with ?? null,
        }
      }
      const { data, error } = await supabase.rpc('change_booking', {
        p_id: i.id,
        p_starts_at: i.startsAt,
        p_practitioner_user: i.withUserId,
        p_reason: i.reason,
        p_note: i.note,
        p_why: i.why?.trim() || null,
      })
      if (error) throw apiError(error)
      return data as ChangeBookingResult
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['appointments'] })
      void qc.invalidateQueries({ queryKey: ['home'] })
      void qc.invalidateQueries({ queryKey: ['nav-counts'] })
      void qc.invalidateQueries({ queryKey: ['visit'] })
    },
  })
}

/** The bookings that can still be changed (0125): not once the patient came or it ended. */
export const changeable = (status: string) => status === 'approved' || status === 'confirmed'

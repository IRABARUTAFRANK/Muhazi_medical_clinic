import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Station } from '@/lib/api/visits'
import { useSession } from '@/store/session'
import { sampleMayHandOver, sampleVisitHandover, type VisitHandover } from './handover'
import { apiError } from './errors'

/**
 * Who works on a patient, calling the next patient and asking for help (migration 0055).
 * A patient belongs to the desk, department or colleague they were sent to; others see them in
 * the clinic but read only. A doctor calls the next patient from reception, the nurses or one
 * colleague; a clinician asks a colleague (or every doctor) for help on a patient they hold.
 */

export interface VisitAccess {
  canWork: boolean
  /** Reception may send on a patient nobody holds yet. */
  canRoute: boolean
  /** Who holds the patient now: "Dr. X", "Paediatrics · Consultation", "Laboratory"… */
  holder: string | null
  /** I am helping on this patient (a colleague asked and I accepted). */
  helping: boolean
  help: {
    callId: string
    status: 'open' | 'accepted'
    asker: string
    helper: string | null
    mine: boolean
    helperIsMe: boolean
    note: string | null
  }[]
  /** 0088: I have the patient at a treating desk and may hand them over (absent before 0088). */
  canHandOver?: boolean
  /** 0088: the handover waiting for an answer on this visit, if any. */
  handover?: VisitHandover | null
}

export interface StaffCall {
  id: string
  kind: 'next' | 'help'
  target: 'reception' | 'nurse' | 'person' | 'doctors'
  station: Station | null
  note: string | null
  status: 'open' | 'answered' | 'accepted' | 'declined' | 'cancelled' | 'done'
  at: string
  fromId: string
  fromName: string
  toName: string | null
  answeredName: string | null
  answeredAt: string | null
  encounterId: string | null
  patientName: string | null
  ticket: string | null
}

export interface MyCalls {
  /** Calls for me to answer: next-patient calls to my desk or to me, help requests. */
  incoming: StaffCall[]
  /** My own calls and requests (waiting, answered in the last half hour, help accepted). */
  mine: StaffCall[]
  /** Patients I help on. */
  helping: StaffCall[]
}

const sampleAt = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const sampleCalls = (role: string): MyCalls => ({
  incoming:
    role === 'receptionist' || role === 'nurse'
      ? [
          {
            id: 'call-1',
            kind: 'next',
            target: role === 'nurse' ? 'nurse' : 'reception',
            station: 'consultation',
            note: 'Room 2 is free',
            status: 'open',
            at: sampleAt(2),
            fromId: 'u-d1',
            fromName: 'Dr. Habimana Eric',
            toName: null,
            answeredName: null,
            answeredAt: null,
            encounterId: null,
            patientName: null,
            ticket: null,
          },
        ]
      : role === 'doctor'
        ? [
            {
              id: 'call-2',
              kind: 'help',
              target: 'doctors',
              station: null,
              note: 'Skin rash for 3 weeks, what do you think?',
              status: 'open',
              at: sampleAt(4),
              fromId: 'u-d2',
              fromName: 'Muganga Amenyo',
              toName: null,
              answeredName: null,
              answeredAt: null,
              encounterId: 'e-9',
              patientName: 'Mukamana Alice',
              ticket: 'A-012',
            },
          ]
        : [],
  mine: [],
  helping: [],
})

export function useMyCalls(role: string) {
  return useQuery({
    queryKey: ['calls'],
    refetchInterval: 10_000,
    queryFn: async (): Promise<MyCalls> => {
      if (!supabase) return sampleCalls(role)
      const { data, error } = await supabase.rpc('my_calls')
      if (error) throw apiError(error)
      return (data as MyCalls | null) ?? { incoming: [], mine: [], helping: [] }
    },
  })
}

export function useVisitAccess(encounterId: string) {
  return useQuery({
    queryKey: ['access', encounterId],
    refetchInterval: 20_000,
    queryFn: async (): Promise<VisitAccess> => {
      if (!supabase) {
        const handover = sampleVisitHandover(encounterId)
        const user = useSession.getState().user
        return {
          // a patient handed over to me is mine only once I take them
          canWork: !handover?.forMe,
          canRoute: !handover?.forMe,
          holder: handover?.forMe ? handover.fromName : null,
          helping: false,
          help: [],
          // a doctor or nurse of a treating desk, with no handover waiting on the visit
          canHandOver: sampleMayHandOver(user) && !handover,
          handover,
        }
      }
      const { data, error } = await supabase.rpc('visit_access', { p_encounter_id: encounterId })
      if (error) throw apiError(error)
      return data as VisitAccess
    },
  })
}

export function useCallActions() {
  const qc = useQueryClient()
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['calls'] })
    void qc.invalidateQueries({ queryKey: ['access'] })
    void qc.invalidateQueries({ queryKey: ['queue'] })
    void qc.invalidateQueries({ queryKey: ['routing'] })
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    if (!supabase) return null
    const { data, error } = await supabase.rpc(fn, args)
    if (error) throw apiError(error)
    return data as unknown
  }
  return {
    callNext: useMutation({
      mutationFn: (i: {
        station: Station
        target: 'reception' | 'nurse' | 'person'
        toUser?: string | null
        note?: string
      }) =>
        rpc('call_next', {
          p_station: i.station,
          p_target: i.target,
          p_to_user: i.toUser ?? null,
          p_note: i.note?.trim() || null,
        }),
      onSuccess: done,
    }),
    answer: useMutation({
      mutationFn: (i: { callId: string; queueId: string }) =>
        rpc('answer_call', { p_call_id: i.callId, p_queue_id: i.queueId }),
      onSuccess: done,
    }),
    cancel: useMutation({
      mutationFn: (callId: string) => rpc('cancel_call', { p_call_id: callId }),
      onSuccess: done,
    }),
    askHelp: useMutation({
      mutationFn: (i: { encounterId: string; toUser?: string | null; note?: string }) =>
        rpc('ask_help', {
          p_encounter_id: i.encounterId,
          p_to_user: i.toUser ?? null,
          p_note: i.note?.trim() || null,
        }),
      onSuccess: done,
    }),
    respond: useMutation({
      mutationFn: (i: { callId: string; accept: boolean }) =>
        rpc('respond_help', { p_call_id: i.callId, p_accept: i.accept }),
      onSuccess: done,
    }),
  }
}

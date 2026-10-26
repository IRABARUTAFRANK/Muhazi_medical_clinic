import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { isMissingFunction, sampleRefusal, throwIf } from './errors'
import type { Station } from './visits'

/**
 * Handing one patient over to a colleague (migration 0088; "Cover for me" is retired).
 *
 * The clinician who has the patient at a treating desk (took them, or they were sent to them by
 * name) picks a colleague who works at the same desk and writes why and what is still to do. The
 * colleague is told and answers: TAKE (the patient becomes theirs; the sender loses the patient)
 * or DECLINE with a reason (nothing moves; the sender is told why). Until the answer the patient
 * stays with the sender, who keeps working and may CANCEL. A handover still waiting LAPSES by
 * itself when the patient leaves the sender (sent on, finished).
 *
 * Live: handover_colleagues, handover_patient, take_handover, decline_handover, cancel_handover,
 * my_handovers; visit_access().canHandOver / .handover; queue_board.handover_*; the track
 * (visit_journey.handovers). Refusals carry a hint the app translates (ApiError.kind):
 * handover_not_holder, handover_not_colleague, handover_note, handover_reason, handover_pending,
 * handover_not_yours, handover_gone (and not_permitted when the manager switched clinical work off).
 * Before 0088 (PGRST202): no handovers (`available: false`); acting refuses with the database's words.
 */

export type HandoverStatus = 'pending' | 'taken' | 'declined' | 'cancelled' | 'lapsed'

export interface Handover {
  id: string
  status: HandoverStatus
  encounterId: string
  queueId: string
  /** Where the patient is: consultation, dental, theatre, nursing, beds. */
  station: Station
  service: string | null
  patientId: string
  /** "Surname Given names". */
  name: string
  fileNumber: string
  ticket: string
  fromId: string
  fromName: string
  toId: string
  toName: string
  /** Why, and what is still to do (written by the sender). */
  note: string
  at: string
  answeredAt: string | null
  /** Who answered (the colleague; the sender or the manager for a cancel; null when it lapsed). */
  answeredBy: string | null
  /** Why the colleague declined. */
  reason: string | null
}

export interface MyHandovers {
  /** Patients handed over to me, waiting for my Take or Decline (oldest first). */
  incoming: Handover[]
  /** My handovers still waiting, and those answered in the last 12 hours (newest first). */
  outgoing: Handover[]
  /** False when the database is older than 0088. */
  available: boolean
}

/** A colleague the patient may be handed over to (same desk, active, may treat). */
export interface HandoverColleague {
  id: string
  name: string
  role: string
  station: string | null
  specialty: string | null
  /** Patients they have now (taken, not finished). */
  patients: number
}

/** The handover waiting on a visit, as visit_access returns it. */
export interface VisitHandover extends Handover {
  /** I handed the patient over (I may cancel). */
  mine: boolean
  /** The patient was handed over to me (I may take or decline). */
  forMe: boolean
}

// ---------------------------------------------------------------- sample mode
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const SAMPLE_COLLEAGUES: HandoverColleague[] = [
  {
    id: 'u-doc2',
    name: 'Dr. Uwase Aline',
    role: 'doctor',
    station: 'Consultation 2',
    specialty: null,
    patients: 2,
  },
  {
    id: 'u-doc3',
    name: 'Dr. Kamanzi Olivier',
    role: 'doctor',
    station: 'Consultation 3',
    specialty: null,
    patients: 0,
  },
]
/** The sample handovers (every sample user reads them from their own side): Dr. Uwase hands
 *  Ingabire Diane (row 3 of the doctor's sample queue) over to Dr. Mukamana. */
let sample: Handover[] = [
  {
    id: 'ho-1',
    status: 'pending',
    encounterId: 'e-consultation-3',
    queueId: 'q-consultation-3',
    station: 'consultation',
    service: 'consultation',
    patientId: 'p-consultation-3',
    name: 'Ingabire Diane',
    fileNumber: 'MMC-000133',
    ticket: 'A-015',
    fromId: 'u-doc2',
    fromName: 'Dr. Uwase Aline',
    toId: 'u-doc',
    toName: 'Dr. Mukamana Béatrice',
    note: 'Called to theatre. Malaria test done (negative); please review the urine test and decide on treatment.',
    at: minutesAgo(6),
    answeredAt: null,
    answeredBy: null,
    reason: null,
  },
]
/** The signed-in sample user. */
const sampleMe = () => {
  const u = useSession.getState().user
  return { id: u?.id ?? '', name: u?.name ?? '', role: u?.role ?? '' }
}
/** Who sees a waiting handover on a visit: the two colleagues, those who read clinical records
 *  (doctors, nurses) and the manager; not reception, the cashier or the laboratory. */
const sampleSeesHandover = (h: Handover) => {
  const me = sampleMe()
  return h.fromId === me.id || h.toId === me.id || ['doctor', 'nurse', 'manager'].includes(me.role)
}
/** Sample mode: may this person hand a patient over (a doctor or nurse of a treating desk)? */
export function sampleMayHandOver(user: { role: string; station?: string } | null): boolean {
  return (
    !!user &&
    (user.role === 'doctor' || user.role === 'nurse') &&
    /^(consultation|dental|theatre|surgery|circ|nursing|beds|family|fp|hiv)/i.test(
      user.station ?? '',
    )
  )
}

/** The sample queue of every desk ('all') shows the consultation rows. */
const norm = (id: string) => id.replace(/^([eqp])-all-/, '$1-consultation-')

/** Sample mode: the handover waiting on this queue entry, if any (for the queue badge). */
export function sampleHandoverOnQueue(queueId: string): Handover | undefined {
  return sample.find(
    (h) =>
      h.queueId === norm(queueId) &&
      (h.status === 'pending' || h.status === 'taken') &&
      sampleSeesHandover(h),
  )
}

/** Sample mode: the handover waiting on a visit, as the signed-in sample user sees it (none for
 *  reception, the cashier or the laboratory). */
export function sampleVisitHandover(encounterId: string): VisitHandover | null {
  const me = sampleMe()
  const h = sample.find((x) => x.encounterId === norm(encounterId) && x.status === 'pending')
  return h && sampleSeesHandover(h)
    ? { ...h, mine: h.fromId === me.id, forMe: h.toId === me.id }
    : null
}

/** Sample mode: the handovers of a visit for its track (as visit_journey.handovers). */
export function sampleJourneyHandovers(encounterId: string) {
  const me = sampleMe()
  const clinical = ['doctor', 'nurse', 'manager'].includes(me.role)
  return sample
    .filter((h) => h.encounterId === norm(encounterId))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((h) => {
      const sees = clinical || h.fromId === me.id || h.toId === me.id
      return {
        id: h.id,
        station: h.station as string,
        at: h.at,
        from: h.fromName,
        to: h.toName,
        note: sees ? h.note : '',
        status: h.status,
        answeredAt: h.answeredAt,
        answeredBy: h.answeredBy,
        reason: sees ? h.reason : null,
      }
    })
}

const answer = (id: string, patch: Partial<Handover>) => {
  const h = sample.find((x) => x.id === id)
  if (!h) throw sampleRefusal('notFound', 'P0002')
  if (h.status !== 'pending') throw sampleRefusal('handoverGone', '23505')
  const done = { ...h, ...patch, answeredAt: new Date().toISOString() }
  sample = sample.map((x) => (x.id === id ? done : x))
}

// ---------------------------------------------------------------- reading
const KEY = ['handovers'] as const

/** My handovers (incoming to answer, outgoing waiting or answered today), refreshed every 15 s. */
export function useMyHandovers() {
  return useQuery({
    queryKey: KEY,
    refetchInterval: 15_000,
    queryFn: async (): Promise<MyHandovers> => {
      if (!supabase) {
        const me = sampleMe().id
        const today = Date.now() - 12 * 3_600_000
        return {
          incoming: sample
            .filter((h) => h.toId === me && h.status === 'pending')
            .sort((a, b) => a.at.localeCompare(b.at)),
          outgoing: sample
            .filter(
              (h) =>
                h.fromId === me &&
                (h.status === 'pending' || Date.parse(h.answeredAt ?? h.at) > today),
            )
            .sort((a, b) => b.at.localeCompare(a.at)),
          available: true,
        }
      }
      const { data, error } = await supabase.rpc('my_handovers')
      if (error && isMissingFunction(error)) return { incoming: [], outgoing: [], available: false }
      throwIf(error)
      const d = data as Omit<MyHandovers, 'available'> | null
      return { incoming: d?.incoming ?? [], outgoing: d?.outgoing ?? [], available: true }
    },
  })
}

/**
 * The colleagues this patient may be handed over to (only for the clinician who has the patient;
 * load it when the dialog opens). Empty on an older database.
 */
export function useHandoverColleagues(encounterId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['handover-colleagues', encounterId],
    enabled: enabled && !!encounterId,
    queryFn: async (): Promise<HandoverColleague[]> => {
      if (!supabase) return SAMPLE_COLLEAGUES
      const { data, error } = await supabase.rpc('handover_colleagues', {
        p_encounter_id: encounterId,
      })
      if (error && isMissingFunction(error)) return []
      throwIf(error)
      return (data as HandoverColleague[] | null) ?? []
    },
  })
}

// ---------------------------------------------------------------- acting
export function useHandoverActions() {
  const qc = useQueryClient()
  const done = () => {
    void qc.invalidateQueries({ queryKey: KEY })
    void qc.invalidateQueries({ queryKey: ['handover-colleagues'] })
    void qc.invalidateQueries({ queryKey: ['access'] })
    void qc.invalidateQueries({ queryKey: ['queue'] })
    void qc.invalidateQueries({ queryKey: ['visit'] })
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }
  return {
    /** Hand the patient over: returns the handover id. */
    handOver: useMutation({
      mutationFn: async (i: {
        encounterId: string
        toId: string
        note: string
        /** Sample mode only: the patient and the colleague as shown. */
        toName?: string
        patientName?: string
        ticket?: string
      }): Promise<string> => {
        const note = i.note.trim()
        if (!supabase) {
          if (note.length < 3) throw sampleRefusal('handoverNote', '22023')
          if (sample.some((h) => h.encounterId === norm(i.encounterId) && h.status === 'pending'))
            throw sampleRefusal('handoverPending', '23505')
          const me = sampleMe()
          if (i.toId === me.id) throw sampleRefusal('handoverNotColleague', '42501')
          const id = `ho-${Date.now()}`
          sample = [
            {
              id,
              status: 'pending',
              encounterId: norm(i.encounterId),
              queueId: norm(i.encounterId).replace(/^e-/, 'q-'),
              station: 'consultation',
              service: 'consultation',
              patientId: norm(i.encounterId).replace(/^e-/, 'p-'),
              name: i.patientName ?? 'Patient',
              fileNumber: '',
              ticket: i.ticket ?? '',
              fromId: me.id,
              fromName: me.name,
              toId: i.toId,
              toName: i.toName ?? SAMPLE_COLLEAGUES.find((c) => c.id === i.toId)?.name ?? '',
              note,
              at: new Date().toISOString(),
              answeredAt: null,
              answeredBy: null,
              reason: null,
            },
            ...sample,
          ]
          return id
        }
        const { data, error } = await supabase.rpc('handover_patient', {
          p_encounter_id: i.encounterId,
          p_to: i.toId,
          p_note: note,
        })
        throwIf(error)
        return data as string
      },
      onSuccess: done,
    }),
    /** Take the patient handed over to me: they become mine. */
    take: useMutation({
      mutationFn: async (
        id: string,
      ): Promise<{ encounterId: string; queueId: string; station: Station }> => {
        if (!supabase) {
          const h = sample.find((x) => x.id === id)
          if (h && h.toId !== sampleMe().id) throw sampleRefusal('handoverNotYours', '42501')
          answer(id, { status: 'taken', answeredBy: sampleMe().name })
          return {
            encounterId: h?.encounterId ?? '',
            queueId: h?.queueId ?? '',
            station: h?.station ?? 'consultation',
          }
        }
        const { data, error } = await supabase.rpc('take_handover', { p_id: id })
        throwIf(error)
        return data as { encounterId: string; queueId: string; station: Station }
      },
      onSuccess: done,
    }),
    /** Decline with a reason: the patient stays with the sender, who is told why. */
    decline: useMutation({
      mutationFn: async (i: { id: string; reason: string }) => {
        const reason = i.reason.trim()
        if (!supabase) {
          if (reason.length < 3) throw sampleRefusal('handoverReason', '22023')
          const h = sample.find((x) => x.id === i.id)
          if (h && h.toId !== sampleMe().id) throw sampleRefusal('handoverNotYours', '42501')
          answer(i.id, { status: 'declined', reason, answeredBy: sampleMe().name })
          return
        }
        const { error } = await supabase.rpc('decline_handover', { p_id: i.id, p_reason: reason })
        throwIf(error)
      },
      onSuccess: done,
    }),
    /** The sender (or the manager) withdraws a handover still waiting. */
    cancel: useMutation({
      mutationFn: async (id: string) => {
        if (!supabase) {
          const h = sample.find((x) => x.id === id)
          const me = sampleMe()
          if (h && h.fromId !== me.id && me.role !== 'manager')
            throw sampleRefusal('handoverNotYours', '42501')
          answer(id, { status: 'cancelled', answeredBy: me.name })
          return
        }
        const { error } = await supabase.rpc('cancel_handover', { p_id: id })
        throwIf(error)
      },
      onSuccess: done,
    }),
  }
}

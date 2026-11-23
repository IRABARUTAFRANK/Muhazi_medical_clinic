import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { apiError, isMissingFunction, NotReadyError } from './errors'
import { sampleBeds, useBedBoard, type BoardBed } from './desk-ops'

/**
 * 0197 · Patients kept in a bed (migration 20270216090000_beds_stay): the treating doctor gives a
 * free bed from the treatment plan (step 6), a nurse of the Nursing desk from her Beds panel, the
 * manager from "Patients in beds". One bed day is on the bill from the day the patient is given the
 * bed and one more for each new day while the stay is open (bed_days_catch_up, see
 * catchUpBedDays); moving, extending (the days expected) and ending the stay are here too.
 *
 * Before the migration: giving a bed falls back on admit_to_bed (the nights billed in advance, as
 * before); Move and the days left open wait for the update (NotReadyError); End is discharge_bed.
 */

/** A patient in a bed, as the screens show it (from the bed board). */
export interface BedStay {
  bed: BoardBed
  encounterId: string
  patient: string
  /** In a bed since (the first day of this visit in a bed). */
  since: string | null
  /** Days on the bill so far (at least 1). */
  days: number
  expectedDays: number | null
  reason: string | null
  doctor: string | null
  amount: number | null
  owed: number | null
}

/** Whole days between two calendar days (local), at least 0. */
const dayDiff = (from: Date, to: Date) => {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime()
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime()
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

/** The stay of an occupied bed; a database before 0197 counts the days from "since". */
export function stayOf(b: BoardBed): BedStay | null {
  if (b.state !== 'occupied' || !b.encounterId) return null
  const days =
    b.days != null ? Number(b.days) : b.since ? dayDiff(new Date(b.since), new Date()) + 1 : 1
  return {
    bed: b,
    encounterId: b.encounterId,
    patient: b.patient ?? '',
    since: b.since,
    days: Math.max(1, days),
    expectedDays: b.expectedDays ?? b.nights ?? null,
    reason: b.reason ?? null,
    doctor: b.doctor ?? b.givenBy ?? null,
    amount: b.amount == null ? null : Number(b.amount),
    owed: b.owed == null ? null : Number(b.owed),
  }
}

/** Every patient in a bed now, the free beds, and every bed (the board). */
export function useBedStays() {
  const q = useBedBoard()
  const beds = q.data ?? []
  const stays = beds.map(stayOf).filter((s): s is BedStay => s !== null)
  const free = beds.filter((b) => b.state === 'free')
  return { ...q, beds, stays, free }
}

/** The patient of this visit in a bed now, if any. */
export function useVisitBed(encounterId: string | null | undefined): BedStay | null {
  const { stays } = useBedStays()
  return (encounterId && stays.find((s) => s.encounterId === encounterId)) || null
}

/** One stay that ended, or still going, of "Who stayed" (report_bed_stays). */
export interface PastStay {
  encounterId: string
  patientId: string
  patient: string
  fileNumber: string | null
  beds: string
  since: string
  /** null: still in a bed. */
  until: string | null
  days: number
  amount: number
  givenBy: string | null
}

/** The visits with bed days in the period (from, to: ISO days). Empty before 0197. */
export function usePastStays(from: string, to: string) {
  return useQuery({
    queryKey: ['beds', 'stays', from, to],
    queryFn: async (): Promise<PastStay[]> => {
      if (!supabase)
        return [
          {
            encounterId: 'e-old-1',
            patientId: 'p-9',
            patient: 'Ingabire Diane',
            fileNumber: 'MMC-000140',
            beds: 'Bed 2',
            since: new Date(Date.now() - 6 * 86_400_000).toISOString(),
            until: new Date(Date.now() - 4 * 86_400_000).toISOString(),
            days: 3,
            amount: 45000,
            givenBy: 'Dr. Mukamana Béatrice',
          },
        ]
      const { data, error } = await supabase.rpc('report_bed_stays', { p_from: from, p_to: to })
      if (error) {
        if (isMissingFunction(error)) return []
        throw apiError(error)
      }
      return ((data as PastStay[]) ?? []).map((s) => ({
        ...s,
        days: Number(s.days),
        amount: Number(s.amount),
      }))
    },
  })
}

/** Sample mode: a refusal worded like the database's; the board as if the database answered. */
const sampleRefuse = (code: string, message: string) => apiError({ code, message, hint: null })
const sampleBed = (id: string) => sampleBeds.find((b) => b.id === id)
const sampleStay = (encounterId: string) =>
  sampleBeds.find((b) => b.state === 'occupied' && b.encounterId === encounterId)
const emptyBed = {
  state: 'cleaning' as const,
  encounterId: null,
  patient: null,
  since: null,
  nights: null,
  until: null,
  stayId: null,
  patientId: null,
  fileNumber: null,
  byDay: null,
  days: null,
  expectedDays: null,
  reason: null,
  givenBy: null,
  doctor: null,
  amount: null,
  owed: null,
}

/** What a stay carries from one bed to the next (sample mode). */
const STAY_KEYS = Object.keys(emptyBed).filter((k) => k !== 'state') as (keyof BoardBed)[]

export function useBedActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['beds'] })
    void qc.invalidateQueries({ queryKey: ['visit'] })
    void qc.invalidateQueries({ queryKey: ['nav-counts'] })
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }
  const call = async (fn: string, args: Record<string, unknown>) => {
    const { error } = await supabase!.rpc(fn, args)
    return error
  }

  /** Keep the patient of a visit in a free bed: days expected (null: not decided), why. */
  const keep = useMutation({
    mutationFn: async (i: {
      encounterId: string
      bedId: string
      days: number | null
      reason: string
      patient: string
    }) => {
      if (!supabase) {
        if (sampleStay(i.encounterId))
          throw sampleRefuse('23505', 'this patient is already in a bed')
        const b = sampleBed(i.bedId)
        if (!b || b.state !== 'free') throw sampleRefuse('P0002', 'this bed is not free')
        const who = useSession.getState().user?.name ?? null
        Object.assign(b, {
          state: 'occupied',
          encounterId: i.encounterId,
          patient: i.patient,
          since: new Date().toISOString(),
          nights: i.days,
          until: i.days ? new Date(Date.now() + i.days * 86_400_000).toISOString() : null,
          stayId: `s-${Date.now()}`,
          byDay: true,
          days: 1,
          expectedDays: i.days,
          reason: i.reason.trim() || null,
          givenBy: who,
          doctor: who,
          amount: b.nightlyPrice,
          owed: b.nightlyPrice,
        })
        return
      }
      const error = await call('keep_in_bed', {
        p_encounter_id: i.encounterId,
        p_bed_id: i.bedId,
        p_days: i.days,
        p_reason: i.reason.trim() || null,
      })
      if (!error) return
      if (!isMissingFunction(error)) throw apiError(error)
      // a database before 0197: the nurse's admission of before (nights billed in advance)
      const old = await call('admit_to_bed', {
        p_encounter_id: i.encounterId,
        p_bed_id: i.bedId,
        p_nights: i.days ?? 1,
        p_period_price: null,
      })
      if (old) throw apiError(old)
    },
    onSuccess: refresh,
  })

  /** To another free bed (today stays on the old bed). */
  const move = useMutation({
    mutationFn: async (i: { encounterId: string; bedId: string; reason?: string | null }) => {
      if (!supabase) {
        const from = sampleStay(i.encounterId)
        const to = sampleBed(i.bedId)
        if (!from) throw sampleRefuse('P0002', 'this patient is not in a bed')
        if (!to || to.state !== 'free') throw sampleRefuse('P0002', 'this bed is not free')
        const stay: Partial<BoardBed> = {}
        for (const k of STAY_KEYS) Object.assign(stay, { [k]: from[k] })
        Object.assign(to, stay, { state: 'occupied', reason: i.reason?.trim() || from.reason })
        Object.assign(from, emptyBed)
        return
      }
      const error = await call('move_to_bed', {
        p_encounter_id: i.encounterId,
        p_bed_id: i.bedId,
        p_reason: i.reason?.trim() || null,
      })
      if (!error) return
      if (isMissingFunction(error)) throw new NotReadyError()
      throw apiError(error)
    },
    onSuccess: refresh,
  })

  /** Extend (or shorten): the days expected for the whole stay; null: not decided. */
  const setDays = useMutation({
    mutationFn: async (i: { encounterId: string; bedId: string; days: number | null }) => {
      if (!supabase) {
        const b = sampleStay(i.encounterId)
        if (!b) throw sampleRefuse('P0002', 'this patient is not in a bed')
        Object.assign(b, {
          expectedDays: i.days,
          nights: i.days,
          until:
            i.days && b.since
              ? new Date(new Date(b.since).getTime() + i.days * 86_400_000).toISOString()
              : null,
        })
        return
      }
      const error = await call('set_bed_days', { p_encounter_id: i.encounterId, p_days: i.days })
      if (!error) return
      if (!isMissingFunction(error)) throw apiError(error)
      // before 0197: only more nights (billed in advance, as before)
      const bed = qc.getQueryData<BoardBed[]>(['beds'])?.find((b) => b.id === i.bedId)
      const more = (i.days ?? 0) - (bed?.nights ?? 0)
      if (more < 1) throw new NotReadyError()
      const old = await call('extend_bed_stay', {
        p_bed_id: i.bedId,
        p_nights: more,
        p_period_price: null,
      })
      if (old) throw apiError(old)
    },
    onSuccess: refresh,
  })

  /** End the stay: the bed goes to cleaning, no more days. */
  const end = useMutation({
    mutationFn: async (i: { encounterId: string; bedId: string }) => {
      if (!supabase) {
        const b = sampleStay(i.encounterId)
        if (!b) throw sampleRefuse('P0002', 'this patient is not in a bed')
        Object.assign(b, emptyBed)
        return
      }
      const error = await call('end_bed_stay', { p_encounter_id: i.encounterId, p_reason: null })
      if (!error) return
      if (!isMissingFunction(error)) throw apiError(error)
      const old = await call('discharge_bed', { p_bed_id: i.bedId })
      if (old) throw apiError(old)
    },
    onSuccess: refresh,
  })

  return { keep, move, setDays, end }
}

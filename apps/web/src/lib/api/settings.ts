import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CLINIC_HOURS,
  CLINIC_PROFILE,
  FEATURES,
  type ClinicHours,
  type ClinicProfile,
} from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import { apiError } from './errors'

/**
 * Clinic settings the manager edits: the `setting` rows `clinic.profile` and `clinic.hours`.
 * The public site reads the same rows through `public_clinic_info()`, so a change shows up
 * on the landing page immediately. Unknown keys in the stored JSON (licences, TIN) are kept.
 */
export type ProfileSetting = ClinicProfile & Record<string, unknown>

export interface ClinicSettings {
  profile: ProfileSetting
  hours: ClinicHours
}

const sample: ClinicSettings = {
  profile: { ...CLINIC_PROFILE },
  hours: structuredClone(CLINIC_HOURS),
}

const KEY = ['settings', 'clinic'] as const

export function useClinicSettings() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<ClinicSettings> => {
      if (!supabase) return structuredClone(sample)
      const { data, error } = await supabase
        .from('setting')
        .select('key, value')
        .in('key', ['clinic.profile', 'clinic.hours'])
      if (error) throw apiError(error)
      const rows = Object.fromEntries(
        (data as { key: string; value: unknown }[]).map((r) => [r.key, r.value]),
      )
      const profile = (rows['clinic.profile'] ?? {}) as Partial<ProfileSetting>
      const hours = (rows['clinic.hours'] ?? {}) as Partial<ClinicHours>
      return {
        profile: { ...CLINIC_PROFILE, ...profile },
        hours: hours.days
          ? { timezone: 'Africa/Kigali', ...hours, days: hours.days }
          : structuredClone(CLINIC_HOURS),
      }
    },
  })
}

export function useSaveClinicSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (next: ClinicSettings) => {
      if (!supabase) {
        sample.profile = { ...next.profile }
        sample.hours = structuredClone(next.hours)
        return
      }
      for (const [key, value] of [
        ['clinic.profile', next.profile],
        ['clinic.hours', next.hours],
      ] as const) {
        const { error } = await supabase.rpc('save_setting', { p_key: key, p_value: value })
        if (error) throw apiError(error)
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY })
      void qc.invalidateQueries({ queryKey: ['public'] })
    },
  })
}

// ---------------------------------------------------------------- sign-in session
/**
 * Hours WITHOUT ACTIVITY after which a signed-in tab signs out (setting `security.session`, 1 to
 * 12, 5 by default). Counted from the last click, key, touch or scroll in that tab; after it the
 * next sign-in needs a new e-mailed code.
 */
export const SESSION_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const
export const DEFAULT_SESSION_HOURS = 5
let sampleHours = DEFAULT_SESSION_HOURS
/** Sample mode (no database): the hours chosen in Settings. */
export const sampleSessionHours = () => sampleHours
const STAFF_KEY = ['settings', 'staff'] as const

export interface StaffSettings {
  sessionHours: number
  triageFirst: boolean
  /** The manager switched insurance on (setting insurance.enabled, 0115). */
  insuranceEnabled: boolean
  /** …and at least one insurer is active: the public site and the booking form show insurers. */
  insuranceActive: boolean
  /** 0125: a booking made for a colleague waits for their answer (true) or is confirmed at once. */
  colleagueAccept: boolean
  /** 0127: a doctor working on the patient's open visit sees the earlier visits in step 1
   *  (setting records.history_for_treating_doctor; default on). */
  historyForTreatingDoctor: boolean
}

/** Settings every signed-in staff member needs (no settings.read required). */
export function useStaffSettings() {
  return useQuery({
    queryKey: STAFF_KEY,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<StaffSettings> => {
      if (!supabase)
        return {
          sessionHours: sampleHours,
          triageFirst: sampleTriageFirst,
          insuranceEnabled: sampleInsurance,
          insuranceActive: sampleInsurance,
          colleagueAccept: sampleColleagueAccept,
          historyForTreatingDoctor: sampleHistoryForTreating,
        }
      const { data, error } = await supabase.rpc('staff_settings')
      if (error) throw apiError(error)
      const d = data as {
        session_hours?: number
        triage_first?: boolean
        insurance_enabled?: boolean
        insurance_active?: boolean
        colleague_accept?: boolean
        history_for_treating_doctor?: boolean
      } | null
      const h = Number(d?.session_hours)
      return {
        sessionHours: Number.isFinite(h) && h >= 1 && h <= 12 ? h : DEFAULT_SESSION_HOURS,
        triageFirst: d?.triage_first === true,
        insuranceEnabled: d?.insurance_enabled === true,
        insuranceActive: d?.insurance_active === true,
        // absent before 0125: the colleague is asked, as before
        colleagueAccept: d?.colleague_accept !== false,
        // absent before 0127: on, as the clinic's default
        historyForTreatingDoctor: d?.history_for_treating_doctor !== false,
      }
    },
  })
}

/** Is insurance switched on (the Who pays card, the insurer prices, the claims figures)? */
export function useInsuranceEnabled(): boolean {
  return useStaffSettings().data?.insuranceEnabled ?? false
}

let sampleInsurance: boolean = FEATURES.insurance
/** Manager: the clinic works with insurers (setting insurance.enabled). */
export function useSaveInsuranceSetting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!supabase) {
        sampleInsurance = enabled
        return
      }
      const { error } = await supabase.rpc('save_setting', {
        p_key: 'insurance.enabled',
        p_value: enabled,
      })
      if (error) throw apiError(error)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: STAFF_KEY })
      void qc.invalidateQueries({ queryKey: ['public'] })
    },
  })
}

let sampleColleagueAccept = true
/** Manager (0125): a booking a clinician makes for a colleague waits for the colleague's answer,
 *  or is confirmed at once (setting booking.colleague_accept). */
export function useSaveColleagueAccept() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (ask: boolean) => {
      if (!supabase) {
        sampleColleagueAccept = ask
        return
      }
      const { error } = await supabase.rpc('save_setting', {
        p_key: 'booking.colleague_accept',
        p_value: ask,
      })
      if (error) throw apiError(error)
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: STAFF_KEY }),
  })
}

let sampleHistoryForTreating = true
/** Manager (0127): the doctor treating the patient now sees the earlier visits in step 1 (each
 *  opening in the access log), or asks for them as before (setting records.history_for_treating_doctor). */
export function useSaveHistoryForTreatingDoctor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (on: boolean) => {
      if (!supabase) {
        sampleHistoryForTreating = on
        return
      }
      const { error } = await supabase.rpc('save_setting', {
        p_key: 'records.history_for_treating_doctor',
        p_value: on,
      })
      if (error) throw apiError(error)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: STAFF_KEY })
      void qc.invalidateQueries({ queryKey: ['visit'] })
    },
  })
}

let sampleTriageFirst = false
/** Patient flow: do new visits go to triage first, or straight to the chosen desk? */
export function useSaveFlowSetting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (triageFirst: boolean) => {
      if (!supabase) {
        sampleTriageFirst = triageFirst
        return
      }
      const { error } = await supabase.rpc('save_setting', {
        p_key: 'flow',
        p_value: { triage_first: triageFirst },
      })
      if (error) throw apiError(error)
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: STAFF_KEY }),
  })
}

/** Manager: after how many hours without activity a tab signs out. Open tabs follow it. */
export function useSaveSessionSetting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (hours: number) => {
      if (!supabase) {
        sampleHours = hours
        return
      }
      const { error } = await supabase.rpc('save_setting', {
        p_key: 'security.session',
        p_value: { hours },
      })
      if (error) throw apiError(error)
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: STAFF_KEY }),
  })
}

/** Manager: every browser asks for a new e-mailed code at its next sign-in. */
export function useRevokeAllDevices() {
  return useMutation({
    mutationFn: async (): Promise<number> => {
      if (!supabase) return 0
      const { data, error } = await supabase.rpc('revoke_trusted_devices', { p_all: true })
      if (error) throw apiError(error)
      return Number(data)
    },
  })
}

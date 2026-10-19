import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CLINIC_HOURS, CLINIC_PROFILE, type ClinicHours, type ClinicProfile } from '@mmc/shared'
import { supabase } from '@/lib/supabase'

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
      if (error) throw new Error(error.message)
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
        if (error) throw new Error(error.message)
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY })
      void qc.invalidateQueries({ queryKey: ['public'] })
    },
  })
}

// ---------------------------------------------------------------- screen lock
/** Minutes without input before a staff screen locks (setting `security.lock`). */
export const LOCK_CHOICES = [5, 10, 15, 30, 60, 120, 240] as const
let sampleIdle = 120
const STAFF_KEY = ['settings', 'staff'] as const

/** Settings every signed-in staff member needs (no settings.read required). */
export function useStaffSettings() {
  return useQuery({
    queryKey: STAFF_KEY,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<{ idleMinutes: number; trustDays: number }> => {
      if (!supabase) return { idleMinutes: sampleIdle, trustDays: sampleTrust }
      const { data, error } = await supabase.rpc('staff_settings')
      if (error) throw new Error(error.message)
      const d = data as { idle_minutes?: number; trust_days?: number } | null
      const m = Number(d?.idle_minutes)
      const td = Number(d?.trust_days)
      return {
        idleMinutes: Number.isFinite(m) && m > 0 ? m : 120,
        trustDays: Number.isFinite(td) && td >= 0 ? td : 30,
      }
    },
  })
}

export function useSaveLockSetting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (idleMinutes: number) => {
      if (!supabase) {
        sampleIdle = idleMinutes
        return
      }
      const { error } = await supabase.rpc('save_setting', {
        p_key: 'security.lock',
        p_value: { idle_minutes: idleMinutes },
      })
      if (error) throw new Error(error.message)
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: STAFF_KEY }),
  })
}

// ---------------------------------------------------------------- e-mailed sign-in code
/** Days a device stays trusted after a correct code; 0 = a code at every sign-in. */
export const TRUST_CHOICES = [0, 1, 7, 30, 90] as const
let sampleTrust = 30

export function useSaveTrustSetting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (trustDays: number) => {
      if (!supabase) {
        sampleTrust = trustDays
        return
      }
      const { error } = await supabase.rpc('save_setting', {
        p_key: 'security.otp',
        p_value: { trust_days: trustDays },
      })
      if (error) throw new Error(error.message)
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: STAFF_KEY }),
  })
}

/** Manager: every trusted device asks for the e-mailed code again at next sign-in. */
export function useRevokeAllDevices() {
  return useMutation({
    mutationFn: async (): Promise<number> => {
      if (!supabase) return 0
      const { data, error } = await supabase.rpc('revoke_trusted_devices', { p_all: true })
      if (error) throw new Error(error.message)
      return Number(data)
    },
  })
}

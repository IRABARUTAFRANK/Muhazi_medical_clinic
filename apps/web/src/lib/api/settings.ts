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

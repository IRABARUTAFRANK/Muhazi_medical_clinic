import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

/**
 * Supabase client for the browser (publishable key only; row-level security does
 * the gatekeeping). `null` when the env is not set, in which case every data
 * module falls back to the shared sample data so the app still runs.
 */
export const supabase: SupabaseClient | null =
  url && publishableKey
    ? createClient(url, publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: 'mmc.auth' },
      })
    : null

export const isLive = supabase !== null

export const STAFF_EMAIL_DOMAIN =
  (import.meta.env.VITE_STAFF_EMAIL_DOMAIN as string | undefined) ?? 'staff.muhaziclinic.rw'

/** Staff sign in with a username; Supabase Auth needs an email, so `j.uwimana` → `j.uwimana@<domain>`. */
export const staffEmail = (username: string): string => {
  const u = username.trim().toLowerCase()
  return u.includes('@') ? u : `${u}@${STAFF_EMAIL_DOMAIN}`
}

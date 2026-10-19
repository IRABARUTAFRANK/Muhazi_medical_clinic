import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

/**
 * Supabase client for the browser (publishable key only; row-level security does
 * the gatekeeping). `null` when the env is not set, in which case every data
 * module falls back to the shared sample data so the app still runs.
 */
/*
 * One sign-in per browser tab. Staff test several accounts side by side and share devices,
 * so a new tab must not silently reuse the account signed in elsewhere: the session lives in
 * sessionStorage (survives a reload, not a new tab) under a key unique to the tab, which also
 * keeps Supabase's cross-tab broadcast from signing other tabs in or out.
 */
const tabStorage: Storage | undefined = (() => {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : undefined
  } catch {
    return undefined
  }
})()
const tabId = (() => {
  try {
    let id = tabStorage?.getItem('mmc.tab')
    if (!id) {
      id = Math.random().toString(36).slice(2, 10)
      tabStorage?.setItem('mmc.tab', id)
    }
    return id
  } catch {
    return 'main'
  }
})()
try {
  // Sessions from before per-tab sign-in lived in localStorage: drop them.
  window.localStorage.removeItem('mmc.auth')
  window.localStorage.removeItem('mmc.session')
} catch {
  /* storage blocked */
}

export const supabase: SupabaseClient | null =
  url && publishableKey
    ? createClient(url, publishableKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          storageKey: `mmc.auth.${tabId}`,
          ...(tabStorage ? { storage: tabStorage } : {}),
        },
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

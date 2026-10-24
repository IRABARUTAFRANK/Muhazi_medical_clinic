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

/*
 * The database checks every staff request (migration 0081): a sign-in counts only once the
 * e-mailed code (or a browser key from it) approved it, and only while it is used. Otherwise
 * PostgREST answers 401 with code PT401 and a hint: 'code_required' (never approved), 'ended'
 * (signed out) or 'idle' (hours without activity). One handler (store/session.ts) then signs
 * the tab out and the login page explains why.
 */
export type SessionRefusal = 'code_required' | 'ended' | 'idle'
let refusalHandler: ((reason: SessionRefusal) => void) | null = null
/** Registers what happens when the database refuses this tab's sign-in (one handler). */
export function onSessionRefused(handler: (reason: SessionRefusal) => void) {
  refusalHandler = handler
}
/** The database (or the manage-staff function) refused this tab's sign-in. */
export function reportSessionRefused(reason: string | null | undefined) {
  refusalHandler?.(reason === 'idle' || reason === 'ended' ? reason : 'code_required')
}

/** fetch for the Supabase client: notices the refusals of the database (401, PT401). */
const gateFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init)
  if (res.status === 401 && refusalHandler) {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (target.includes('/rest/v1/')) {
      void res
        .clone()
        .json()
        .then((body: { code?: string; hint?: string } | null) => {
          if (body?.code === 'PT401') reportSessionRefused(body.hint)
        })
        .catch(() => undefined)
    }
  }
  return res
}

export const supabase: SupabaseClient | null =
  url && publishableKey
    ? createClient(url, publishableKey, {
        global: { fetch: gateFetch },
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          storageKey: `mmc.auth.${tabId}`,
          ...(tabStorage ? { storage: tabStorage } : {}),
        },
      })
    : null

export const isLive = supabase !== null

/*
 * Checks a PIN without touching this tab's sign-in (lock screen, change PIN). Signing in again
 * on the main client would replace the session approved by the e-mailed code with a PIN-only
 * one, which the database refuses. This separate client opens a short session with the PIN and
 * closes it at once; nothing of it is kept.
 */
let pinProbe: SupabaseClient | null = null
export async function pinIsRight(email: string, pin: string): Promise<boolean> {
  if (!url || !publishableKey) return false
  pinProbe ??= createClient(url, publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: 'mmc.pin-check',
    },
  })
  const { data, error } = await pinProbe.auth.signInWithPassword({ email, password: pin })
  if (error || !data.session) return false
  await pinProbe.auth.signOut({ scope: 'local' }).catch(() => undefined)
  return true
}

export const STAFF_EMAIL_DOMAIN =
  (import.meta.env.VITE_STAFF_EMAIL_DOMAIN as string | undefined) ?? 'staff.muhaziclinic.rw'

/** Staff sign in with a username; Supabase Auth needs an email, so `j.uwimana` → `j.uwimana@<domain>`. */
export const staffEmail = (username: string): string => {
  const u = username.trim().toLowerCase()
  return u.includes('@') ? u : `${u}@${STAFF_EMAIL_DOMAIN}`
}

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  describeStoredSession,
  setTraceTab,
  shortStack,
  startTrace,
  trace,
  tracePath,
  traceTail,
  TRACE_REPORT_BYTES,
} from '@/lib/sign-in-trace'

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

/** Where Supabase Auth keeps this tab's sign-in (in `tabStorage`). */
const authKey = `mmc.auth.${tabId}`
/*
 * The trace names each page `<tabId>/<pageId>`: a tab copied with the browser's "Duplicate tab"
 * gets a copy of sessionStorage, so the same tabId (and the same Supabase Auth storage key and
 * broadcast channel); the pageId tells the two pages apart.
 */
const pageId = Math.random().toString(36).slice(2, 6)
setTraceTab(`${tabId}/${pageId}`)
startTrace()

/**
 * Whether this tab still holds a stored sign-in (null when storage cannot be read). A SIGNED_OUT
 * this page caused always comes after the stored sign-in was removed, so a SIGNED_OUT seen while
 * one is still stored came from another page sharing this tab's key (a duplicated tab).
 */
export const tabHasSession = (): boolean | null => {
  try {
    return tabStorage ? tabStorage.getItem(authKey) != null : null
  } catch {
    return null
  }
}

/*
 * Observation only (nothing changes): another page answering for this tabId means this page is
 * a duplicate of it (or it of this one). Noted in the trace, both pages.
 */
try {
  if (typeof BroadcastChannel !== 'undefined') {
    const claims = new BroadcastChannel('mmc.tab-claim')
    claims.onmessage = (e: MessageEvent<{ kind?: string; tab?: string; page?: string }>) => {
      const m = e.data
      if (!m || m.tab !== tabId || m.page === pageId) return
      if (m.kind === 'claim') {
        trace('tab.duplicate', { other: m.page, by: 'claim' })
        claims.postMessage({ kind: 'taken', tab: tabId, page: pageId })
      } else if (m.kind === 'taken') {
        trace('tab.duplicate', { other: m.page, by: 'answer' })
      }
    }
    claims.postMessage({ kind: 'claim', tab: tabId, page: pageId })
  }
} catch {
  /* no BroadcastChannel: nothing to observe */
}

/*
 * The storage given to Supabase Auth: the tab's sessionStorage, with every write and removal of
 * the tab's sign-in noted in the sign-in trace (which session, and which code did it). Nothing
 * else changes.
 */
const authStorage = tabStorage
  ? {
      getItem: (k: string) => tabStorage.getItem(k),
      setItem: (k: string, v: string) => {
        if (k === authKey) trace('storage.set', { ...describeStoredSession(v), by: shortStack(3) })
        tabStorage.setItem(k, v)
      },
      removeItem: (k: string) => {
        if (k === authKey) {
          const had = tabStorage.getItem(k)
          trace('storage.remove', {
            had: had != null,
            sid: describeStoredSession(had)?.sid,
            by: shortStack(3),
          })
        }
        tabStorage.removeItem(k)
      },
    }
  : undefined

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

/** The database calls of the sign-in and sign-out, noted in the sign-in trace (status only). */
const TRACED_RPC =
  /\/rpc\/(record_sign_in|use_trusted_device|trust_this_device|extend_this_device|revoke_this_device|end_session|touch_session|session_status|staff_login_email|my_must_change_pin|mark_pin_changed)\b/

/** Which request this is, for the trace: Supabase Auth, the sign-in function, sign-in calls. */
function traceTarget(target: string): string | null {
  try {
    const u = new URL(target)
    if (u.pathname.includes('/auth/v1/') || u.pathname.includes('/functions/v1/')) {
      // grant_type / scope say which kind of call it was; nothing else of the address is kept
      const kind = u.searchParams.get('grant_type') ?? u.searchParams.get('scope')
      return u.pathname.replace(/^.*?\/(auth|functions)\/v1\//, '$1/') + (kind ? `?${kind}` : '')
    }
    const rpc = TRACED_RPC.exec(u.pathname)
    return rpc ? `rpc/${rpc[1]}` : null
  } catch {
    return null
  }
}

/**
 * fetch for the Supabase client: notices the refusals of the database (401, PT401), and notes
 * the sign-in requests (Supabase Auth, the sign-in function, sign-in calls) in the trace.
 */
const gateFetch: typeof fetch = async (input, init) => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const traced = traceTarget(target)
  const started = Date.now()
  let res: Response
  try {
    res = await fetch(input, init)
  } catch (e) {
    if (traced) trace('net.fail', { call: traced, ms: Date.now() - started, error: String(e) })
    throw e
  }
  if (traced) trace('net', { call: traced, status: res.status, ms: Date.now() - started })
  if (res.status === 401 && target.includes('/rest/v1/')) {
    void res
      .clone()
      .json()
      .then((body: { code?: string; hint?: string } | null) => {
        if (body?.code !== 'PT401') return
        trace('gate.refused', { hint: body.hint, call: traced ?? new URL(target).pathname })
        reportSessionRefused(body.hint)
      })
      .catch(() => undefined)
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
          storageKey: authKey,
          ...(authStorage ? { storage: authStorage } : {}),
        },
      })
    : null

/** This tab's stored access token, read without Supabase Auth (null when there is none). */
function storedAccessToken(): { token: string; exp: number } | null {
  try {
    const v = JSON.parse(tabStorage?.getItem(authKey) ?? 'null') as {
      access_token?: unknown
      expires_at?: unknown
    } | null
    return typeof v?.access_token === 'string'
      ? { token: v.access_token, exp: typeof v.expires_at === 'number' ? v.expires_at : 0 }
      : null
  } catch {
    return null
  }
}

/**
 * Signs this tab out of Supabase Auth (scope local: this sign-in only).
 *
 * Supabase Auth (2.118) works without a lock: `auth.signOut()` first asks the server to end the
 * session and only THEN removes whatever session is stored at that moment. A sign-out that is
 * still waiting on a slow network (the app stops waiting after a few seconds, see
 * store/session.ts) can therefore finish later and remove the NEW session of the sign-in that
 * followed: the tab signs out by itself a moment after the e-mailed code, while the server
 * still shows that new sign-in approved and open. So the tab's sign-in is forgotten here first,
 * at once (Supabase Auth then finds nothing to end and only announces SIGNED_OUT), and the
 * server is told afterwards with the token read before; that request touches nothing stored.
 */
export async function signOutAuth(why: string): Promise<void> {
  if (!supabase) return
  const stored = storedAccessToken()
  trace('auth.signOut', { why, had: stored != null })
  if (!tabStorage) {
    await supabase.auth.signOut({ scope: 'local' })
    return
  }
  try {
    authStorage?.removeItem(authKey)
  } catch {
    /* storage blocked: Supabase Auth removes it below */
  }
  await supabase.auth.signOut({ scope: 'local' })
  if (stored) {
    const { error } = await supabase.auth.admin
      .signOut(stored.token, 'local')
      .catch((e: unknown) => ({ error: e as Error }))
    trace('auth.signOut.server', {
      why,
      ok: !error,
      error: error ? String(error.message) : undefined,
    })
  }
}

/*
 * The trace sent to the server when a tab loses its signed-in person without the person
 * choosing it (report_client_event, migration 20261124120000; read by the manager only). Sent
 * straight with fetch, outside Supabase Auth: the sign-in may already be gone. With this tab's
 * access token when it is still stored and valid (the server then knows who), otherwise as a
 * visitor. Kept in localStorage until the server took it, and sent again at the next page load
 * (the tab usually leaves for the login page right away).
 */
const REPORT_KEY = 'mmc.signin-report'
let lastReportAt = 0

async function sendReport(body: string): Promise<boolean> {
  if (!url || !publishableKey) return false
  const key = publishableKey
  const post = (bearer: string | null, keepalive: boolean) =>
    fetch(`${url}/rest/v1/rpc/report_client_event`, {
      method: 'POST',
      keepalive,
      headers: {
        apikey: key,
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body,
    })
  let anonBearer: string | null = null
  let userBearer: string | null = null
  try {
    anonBearer = key.startsWith('sb_') ? null : key
    const stored = storedAccessToken()
    userBearer = stored && stored.exp * 1000 > Date.now() + 30_000 ? stored.token : null
  } catch {
    /* as a visitor */
  }
  const attempt = async (bearer: string | null) => {
    try {
      return await post(bearer, true)
    } catch {
      // some browsers refuse keepalive with this request: plain fetch
      return await post(bearer, false)
    }
  }
  try {
    let res = await attempt(userBearer ?? anonBearer)
    // the token was refused (ended, expired): as a visitor
    if (res.status === 401 && userBearer) res = await attempt(anonBearer)
    trace('report.sent', { status: res.status })
    return res.ok
  } catch (e) {
    trace('report.failed', { error: String(e) })
    return false
  }
}

/**
 * Sends the sign-in trace to the server (at most once a minute per tab). Resolves when the
 * server answered, or after `waitMs` at the latest. Never throws and never rejects: the sign-in
 * and sign-out around it must go on whatever happens here.
 */
export function reportClientEvent(
  kind: string,
  detail: Record<string, unknown>,
  waitMs = 1500,
): Promise<void> {
  try {
    if (!url || !publishableKey) return Promise.resolve()
    if (Date.now() - lastReportAt < 60_000) {
      trace('report.skipped', { kind })
      return Promise.resolve()
    }
    lastReportAt = Date.now()
    trace('report.send', { kind })
    const base = {
      ...detail,
      tab: tabId,
      page: pageId,
      stored: tabHasSession(),
      path: tracePath(),
      clientAt: new Date().toISOString(),
      report: Math.random().toString(36).slice(2, 10),
    }
    // The server refuses more than 8 KB (as it stores it): room is kept for its spacing.
    const room = TRACE_REPORT_BYTES - 1200 - new TextEncoder().encode(JSON.stringify(base)).length
    const body = JSON.stringify({ p_kind: kind, p_detail: { ...base, trace: traceTail(room) } })
    try {
      localStorage.setItem(REPORT_KEY, body)
    } catch {
      /* storage blocked: sent once */
    }
    const sent = sendReport(body)
      .then((ok) => {
        if (!ok) return
        try {
          if (localStorage.getItem(REPORT_KEY) === body) localStorage.removeItem(REPORT_KEY)
        } catch {
          /* ignore */
        }
      })
      .catch(() => undefined)
    return Promise.race([sent, new Promise<void>((r) => window.setTimeout(r, waitMs))])
  } catch (e) {
    trace('report.error', { kind, error: String(e) })
    return Promise.resolve()
  }
}

// A report the last page could not finish sending goes now.
if (typeof window !== 'undefined' && url && publishableKey) {
  try {
    const left = localStorage.getItem(REPORT_KEY)
    if (left) {
      localStorage.removeItem(REPORT_KEY)
      trace('report.resend')
      void sendReport(left).catch(() => false)
    }
  } catch {
    /* ignore */
  }
}

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

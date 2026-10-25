import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import {
  findStaffByStaffId,
  findStaffByUsername,
  normalizeStaffId,
  STAFF_ID_RE,
  type Role,
  type StaffUser,
} from '@mmc/shared'
import { sampleSessionHours } from '@/lib/api/settings'
import {
  onSessionRefused,
  pinIsRight,
  reportClientEvent,
  signOutAuth,
  staffEmail,
  supabase,
  tabHasSession,
} from '@/lib/supabase'
import { describeSession, isoTime, shortStack, trace } from '@/lib/sign-in-trace'
import { queryClient } from '@/lib/query-client'

const HOME_ROLES: readonly string[] = [
  'receptionist',
  'nurse',
  'doctor',
  'cashier',
  'lab_tech',
  'pharmacist',
  'manager',
]

/** Shape returned by the `record_sign_in()` database function. */
export interface ProfileJson {
  id: string
  username: string
  full_name: string
  role: string
  station: string | null
  dashboard: 'manager' | 'head' | null
  head_of: string | null
  must_change_pin: boolean
  staff_id: string | null
  email: string | null
}

export const toStaffUser = (p: ProfileJson): StaffUser => ({
  id: p.id,
  username: p.username,
  name: p.full_name,
  // Lab technicians and sonographers share the laboratory dashboard (lab vs imaging tests);
  // pharmacists have the pharmacy dashboard.
  role: HOME_ROLES.includes(p.role)
    ? (p.role as Role)
    : p.role === 'sonographer'
      ? 'lab_tech'
      : 'doctor',
  station: p.station ?? undefined,
  dashboard: p.dashboard ?? undefined,
  headOf: p.head_of ?? undefined,
  mustChangePin: p.must_change_pin,
  staffId: p.staff_id ?? undefined,
  email: p.email ?? undefined,
  dbRole: p.role,
})

export type SignInResult =
  | { ok: true; step: 'otp'; email: string }
  /** First sign-in with the temporary PIN: choose a new PIN first, then the e-mailed code. */
  | { ok: true; step: 'new-pin' }
  | { ok: true; step: 'done'; user: StaffUser }
  | { ok: false; reason: 'invalid' | 'inactive' | 'otp' | 'error' }
export type VerifyResult =
  | { ok: true; user: StaffUser }
  /** `notApproved`: the code was right but the database did not approve the sign-in (0081). */
  | { ok: false; reason: 'invalid' | 'inactive' | 'expired' | 'error' | 'notApproved' }

/** Sign-in in progress: the PIN was accepted, the e-mail code is still pending. Kept for this tab
 *  only, so a reload does not lose the code step; the PIN itself is never stored. */
export interface PendingSignIn {
  staffId: string
  username: string
  email: string
  /** Kept in memory only, so "send a new code" can repeat the PIN-gated request. */
  pin?: string
  /** Sample mode only: the user that will be signed in once a code is typed. */
  sampleUser?: StaffUser
  /** Signed in with the temporary PIN: a new PIN must be chosen before the code is sent. */
  needsNewPin?: boolean
}

type RequestOutcome =
  | { ok: true; email: string }
  | { ok: false; reason: 'invalid' | 'inactive' | 'otp' | 'error' | 'unavailable' }

/**
 * Why a tab stopped being signed in. The login page explains it (see `readSignOutNote`):
 * the person chose to sign out, the tab was not used for the set number of hours, 5 wrong PINs
 * on the locked screen, the account was deactivated, the sign-in ended elsewhere, or the
 * database did not approve this sign-in (`security`: sign in again with the e-mailed code).
 * `switched` (another staff ID typed on this tab) leaves no message.
 */
export type SignOutReason =
  'signedOut' | 'idle' | 'wrongPins' | 'inactive' | 'ended' | 'security' | 'switched'

/*
 * The sign-in session (migration 20261120090000). A tab stays signed in as long as it is used.
 * After N hours WITHOUT ACTIVITY in that tab (no pointer, key, touch, scroll or wheel; setting
 * `security.session`, 5 by default) it signs out completely, and the next sign-in needs a new
 * e-mailed code. The last activity is kept with the tab (sessionStorage): a reload, or a tab the
 * browser put to sleep, simply continues within the limit and signs out at once after it.
 * There is no automatic PIN lock any more; "Lock the screen now" stays, and time on a locked
 * screen counts as time without activity.
 */
const HOUR_MS = 3_600_000
const DEFAULT_SESSION_HOURS = 5
export const clampHours = (h: number) =>
  Number.isFinite(h) && h >= 1 && h <= 12 ? Math.round(h) : DEFAULT_SESSION_HOURS
/** Activity is written at most this often (pointer moves fire constantly). */
const TOUCH_EVERY_MS = 20_000
/** While the person is active, this browser's key is extended on the server at most this often. */
const EXTEND_EVERY_MS = 5 * 60_000
/** The warning shows this long before the sign-out for inactivity. */
export const IDLE_WARNING_MS = 10 * 60_000

/*
 * This browser while the person is active. After a correct e-mailed code the browser keeps a
 * random key per username (localStorage: shared by the tabs of this browser); the database keeps
 * only its fingerprint, valid for N hours and extended while the person keeps working. Another
 * tab of this browser then signs in with staff ID, username and PIN, without a new code. Once
 * nobody used it for N hours, or after any sign-out, the key is gone on both sides and the
 * code is needed again. The browser also notes the last activity under that key, so a key left
 * behind is never used after N hours even by an older database.
 */
const TRUST_PREFIX = 'mmc.trust.'
const SEEN_PREFIX = 'mmc.trust-seen.'
const trustKey = (username: string) => TRUST_PREFIX + username
const readTrust = (username: string): string | null => {
  try {
    return localStorage.getItem(trustKey(username))
  } catch {
    return null
  }
}
interface TrustSeen {
  /** Last activity of this person in this browser (ms). */
  at: number
  hours: number
}
const readTrustSeen = (username: string): TrustSeen | null => {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_PREFIX + username) ?? 'null') as {
      at?: number
      hours?: number
    } | null
    if (!v || typeof v.at !== 'number') return null
    return { at: v.at, hours: clampHours(Number(v.hours)) }
  } catch {
    return null
  }
}
/** Remembers the key and the last activity (or forgets both with `token = null`). */
const writeTrust = (username: string, token: string | null, seen?: TrustSeen) => {
  try {
    if (token && seen) {
      localStorage.setItem(trustKey(username), token)
      localStorage.setItem(SEEN_PREFIX + username, JSON.stringify(seen))
    } else {
      localStorage.removeItem(trustKey(username))
      localStorage.removeItem(SEEN_PREFIX + username)
    }
  } catch {
    /* storage blocked: other tabs simply ask for a code */
  }
}
/** Activity in a signed-in tab: the browser's key stays usable for N hours from now. */
const markTrustSeen = (username: string, hours: number) => {
  try {
    if (localStorage.getItem(trustKey(username))) {
      localStorage.setItem(SEEN_PREFIX + username, JSON.stringify({ at: Date.now(), hours }))
    }
  } catch {
    /* ignore */
  }
}
const newTrustToken = () => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/*
 * The tabs of this browser tell each other when a person signs out, locks or unlocks the
 * screen, so a sign-out (menu, 5 wrong PINs, deactivation) or "Lock the screen now" reaches
 * every open tab of the SAME person here. Tabs with another account are left alone, so each tab
 * still signs in on its own. The hours without activity stay per tab: an idle tab signing out
 * does not end a tab that is still in use.
 */
type TabMessage =
  | { kind: 'signedOut'; username: string; reason: SignOutReason }
  | { kind: 'locked' | 'unlocked'; username: string }
const tabChannel: BroadcastChannel | null = (() => {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('mmc.session')
  } catch {
    return null
  }
})()
const tellOtherTabs = (m: TabMessage) => {
  try {
    tabChannel?.postMessage(m)
  } catch {
    /* no channel: the other tabs follow their own rules */
  }
}
/** Sign-outs that end the person's other tabs in this browser too. */
const SHARED_SIGN_OUTS: readonly SignOutReason[] = ['signedOut', 'wrongPins', 'inactive']

/** How Supabase Auth opened a session that came from the e-mail (code or link), never the PIN. */
const CODE_METHODS: readonly string[] = ['otp', 'magiclink', 'email/signup', 'invite', 'recovery']
/** True when the session's access token says it was opened by the e-mailed code or link. */
function openedByCode(accessToken: string | undefined): boolean {
  try {
    const part = accessToken?.split('.')[1]
    if (!part) return false
    const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as {
      amr?: { method?: string }[]
    }
    return (
      Array.isArray(claims.amr) && claims.amr.some((a) => CODE_METHODS.includes(a?.method ?? ''))
    )
  } catch {
    return false
  }
}

/** A server call that must not hold up a sign-out when the network is gone. */
async function withTimeout<T>(p: PromiseLike<T>, ms = 6000): Promise<T | null> {
  let timer = 0
  try {
    return await Promise.race([
      Promise.resolve(p),
      new Promise<null>((resolve) => {
        timer = window.setTimeout(() => resolve(null), ms)
      }),
    ])
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

/** Hours without activity before a tab signs out (`staff_settings().session_hours`; 5 when unknown). */
async function sessionHoursSetting(): Promise<number> {
  if (!supabase) return clampHours(sampleSessionHours())
  const res = await withTimeout(supabase.rpc('staff_settings'))
  const h = Number((res?.data as { session_hours?: number } | null)?.session_hours)
  return clampHours(h)
}

/** When this tab last extended the browser's key on the server (ms). */
let lastExtendAt = 0
/** When this tab last told the database that the person is active (touch_session, ms). */
let lastServerTouchAt = 0

/** True when the error says the database does not have this function yet (older database). */
const missingFunction = (error: { code?: string } | null | undefined) => error?.code === 'PGRST202'

/**
 * The person is active: the database counts the hours without activity from now (0081), at most
 * every 5 minutes, or at once (`now`) after the PIN or when the warning before the sign-out is
 * answered. Independent of the browser key. If the database says this sign-in no longer works,
 * the tab signs out (only on its verdict, never on a network fault or an older database).
 */
async function touchServer(now = false): Promise<void> {
  if (!supabase || (!now && Date.now() - lastServerTouchAt < EXTEND_EVERY_MS)) return
  lastServerTouchAt = Date.now()
  const res = await withTimeout(supabase.rpc('touch_session'))
  if (!res || res.error || res.data !== false) return
  const status = await withTimeout(supabase.rpc('session_status'))
  const st = status?.data as { ok?: boolean; reason?: string } | null | undefined
  if (!status?.error && st?.ok === false) {
    refuseTab(st.reason === 'idle' ? 'idle' : st.reason === 'ended' ? 'ended' : 'security')
  }
}

/** Ends this tab's sign-in in the database (every sign-out, before Supabase Auth). */
async function endServerSession(reason: string): Promise<void> {
  if (!supabase) return
  await withTimeout(supabase.rpc('end_session', { p_reason: reason }), 4000)
}

/**
 * Right after the e-mailed code (or the sign-in link): this browser gets a new key, valid on the
 * server for N hours and extended while the person is active. Always created: there is no
 * "trust this device" choice any more, since the key ends with any sign-out or N idle hours.
 */
async function trustThisBrowser(username: string, hours: number): Promise<void> {
  const token = newTrustToken()
  const res = await withTimeout(
    supabase!.rpc('trust_this_device', { p_token: token, p_label: deviceLabel() }),
  )
  const until = !res?.error && typeof res?.data === 'string' ? Date.parse(res.data) : NaN
  if (Number.isFinite(until) && until > Date.now()) {
    writeTrust(username, token, { at: Date.now(), hours })
    lastExtendAt = Date.now()
  } else {
    writeTrust(username, null)
  }
}

/**
 * The person is active: the browser's key lasts N hours from now (at most every 5 minutes).
 * A key the server no longer knows (revoked by the manager, or expired) is forgotten here too.
 * Errors, and older databases without `extend_this_device`, are ignored.
 */
async function extendTrust(username: string): Promise<void> {
  if (!supabase || Date.now() - lastExtendAt < EXTEND_EVERY_MS) return
  const token = readTrust(username)
  if (!token) return
  lastExtendAt = Date.now()
  const res = await withTimeout(supabase.rpc('extend_this_device', { p_token: token }))
  if (res && !res.error && res.data == null && readTrust(username) === token) {
    writeTrust(username, null)
  }
}

/** Ends this browser's key on the server (every sign-out). Never throws. */
async function revokeDevice(token: string): Promise<void> {
  if (!supabase) return
  const res = await withTimeout(supabase.rpc('revoke_this_device', { p_token: token }))
  // Older database without revoke_this_device: end all of this person's trusted browsers.
  if (missingFunction(res?.error)) await withTimeout(supabase.rpc('revoke_trusted_devices'))
}

/**
 * Another tab of a browser where this person signed in with the code and kept working: check
 * the PIN with Supabase Auth, then the browser key with the database (valid only while the
 * person was active in the last N hours; never extended by this check). Returns the signed-in
 * profile, or null to fall back to the e-mailed code.
 */
async function signInTrusted(
  staffId: string,
  username: string,
  pin: string,
): Promise<{ profile: ProfileJson } | { reason: 'invalid' | 'inactive' } | null> {
  const token = readTrust(username)
  if (!token) return null
  const seen = readTrustSeen(username)
  // A key without activity noted (kept from before the session rule), or not used for N hours.
  if (!seen || Date.now() - seen.at >= seen.hours * HOUR_MS) {
    trace('signInTrusted.keyTooOld')
    writeTrust(username, null)
    return null
  }
  const { data: email } = await supabase!.rpc('staff_login_email', {
    p_staff_id: staffId,
    p_username: username,
  })
  if (!email) return { reason: 'invalid' }
  const { error } = await supabase!.auth.signInWithPassword({ email, password: pin })
  if (error) {
    trace('signInTrusted.pin', { ok: false, error: error.message })
    return { reason: /banned/i.test(error.message) ? 'inactive' : 'invalid' }
  }
  const { data: until, error: trustError } = await supabase!.rpc('use_trusted_device', {
    p_token: token,
  })
  // The key's end on the server; `true` from an older database means "the key is valid".
  const valid =
    !trustError && (until === true || (typeof until === 'string' && Date.parse(until) > Date.now()))
  trace('signInTrusted.key', { valid, error: trustError?.code })
  if (!valid) {
    // Ended, revoked or unknown: forget the key, ask for a code.
    writeTrust(username, null)
    await signOutAuth('trusted key refused')
    return null
  }
  const { data: profile, error: rpcError } = await supabase!.rpc('record_sign_in', {
    p_device: deviceLabel(),
  })
  trace('signInTrusted.recordSignIn', { ok: !rpcError && !!profile, error: rpcError?.code })
  if (rpcError || !profile) {
    await signOutAuth('trusted record_sign_in failed')
    return { reason: /deactivated/i.test(rpcError?.message ?? '') ? 'inactive' : 'invalid' }
  }
  return { profile: profile as ProfileJson }
}

/**
 * Preferred path: the `staff-otp` Edge Function checks the PIN on the server, records the
 * request and asks Supabase Auth to send the code (the `send-auth-email` hook refuses codes
 * that were not preceded by a PIN check). Returns `unavailable` when the function is not
 * deployed, so the caller can fall back to the client-side flow.
 */
async function requestCodeViaFunction(
  staffId: string,
  username: string,
  pin: string,
): Promise<RequestOutcome> {
  const { data, error } = await supabase!.functions.invoke('staff-otp', {
    body: { action: 'request', staff_id: staffId, username, pin },
  })
  if (error) {
    const ctx = (error as { context?: Response }).context
    if (!ctx || typeof ctx.status !== 'number') return { ok: false, reason: 'unavailable' }
    if (ctx.status === 404) return { ok: false, reason: 'unavailable' }
    const payload = (await ctx.json().catch(() => null)) as { error?: string } | null
    switch (payload?.error) {
      case 'invalid':
        return { ok: false, reason: 'invalid' }
      case 'inactive':
        return { ok: false, reason: 'inactive' }
      case 'too_many':
      case 'otp_send_failed':
        return { ok: false, reason: 'otp' }
      default:
        return { ok: false, reason: ctx.status >= 500 ? 'error' : 'invalid' }
    }
  }
  const body = data as { ok?: boolean; email?: string } | null
  if (!body?.ok || !body.email) return { ok: false, reason: 'error' }
  return { ok: true, email: body.email }
}

/** Fallback when `staff-otp` is not deployed: PIN check and code request from the browser. */
async function requestCodeDirect(
  staffId: string,
  username: string,
  pin: string,
): Promise<RequestOutcome> {
  const { data: email, error: lookupError } = await supabase!.rpc('staff_login_email', {
    p_staff_id: staffId,
    p_username: username,
  })
  if (lookupError) return { ok: false, reason: 'error' }
  if (!email) return { ok: false, reason: 'invalid' }
  const { error } = await supabase!.auth.signInWithPassword({ email, password: pin })
  if (error) {
    return { ok: false, reason: /banned/i.test(error.message) ? 'inactive' : 'invalid' }
  }
  // PIN accepted. The session only counts once the e-mailed code is verified: until then
  // the app holds no user, and the code exchange replaces this session.
  const { error: otpError } = await supabase!.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  })
  if (otpError) {
    await signOutAuth('code request failed')
    return { ok: false, reason: 'otp' }
  }
  return { ok: true, email }
}

/**
 * First sign-in after the manager created the account (or reset the PIN): the temporary PIN is
 * accepted, and the person chooses their own PIN before the e-mailed code approves the sign-in.
 * Returns the e-mail when the account still has its temporary PIN; null otherwise (normal path).
 */
async function checkTemporaryPin(
  staffId: string,
  username: string,
  pin: string,
): Promise<{ email: string } | { reason: 'invalid' | 'inactive' | 'error' } | null> {
  const { data: email } = await supabase!.rpc('staff_login_email', {
    p_staff_id: staffId,
    p_username: username,
  })
  if (!email) return { reason: 'invalid' }
  const { data: auth, error } = await supabase!.auth.signInWithPassword({ email, password: pin })
  trace('signIn.pin', { ok: !error && !!auth.user, error: error?.message })
  // Wrong PIN or blocked account: let the usual path answer, so the server keeps counting
  // failed attempts and gives the same messages as before.
  if (error || !auth.user) return null
  // Asked through a function: this PIN-only session may not read the profiles table (0081).
  let { data: temporary, error: askError } = await supabase!.rpc('my_must_change_pin')
  if (missingFunction(askError)) {
    // Older database (before 0081): the profile itself still answers.
    const { data: me, error: readError } = await supabase!
      .from('profiles')
      .select('must_change_pin')
      .eq('id', auth.user.id)
      .maybeSingle()
    temporary = me?.must_change_pin === true
    askError = readError
  }
  trace('signIn.temporaryPin', { temporary: temporary === true, error: askError?.code })
  if (askError) {
    // Unknown: never treat it as "not a temporary PIN"; the person simply tries again.
    await signOutAuth('temporary PIN check failed')
    return { reason: 'error' }
  }
  if (temporary === true) return { email: email as string }
  // Not a temporary PIN: drop this session, the usual same-browser / e-mailed-code path follows.
  await signOutAuth('PIN checked')
  return null
}

interface SessionState {
  user: StaffUser | null
  /** Locked by the person ("Lock the screen now"): the session stays, the PIN opens it. */
  locked: boolean
  /** Last activity in this tab (ms): pointer, key, touch, scroll or wheel. */
  lastActiveAt: number | null
  /** Hours without activity after which this tab signs out (setting `security.session`). */
  sessionHours: number
  /** Wrong PINs on the lock screen since the last unlock (5 = signed out). */
  unlockFailures: number
  pending: PendingSignIn | null
  /** Step 1 (landing page): is this an active staff ID? */
  checkStaffId: (staffId: string) => Promise<boolean>
  /** Step 2 (login page): staff ID + username + PIN. On success a one-time code is e-mailed. */
  signIn: (staffId: string, username: string, pin: string) => Promise<SignInResult>
  /** First sign-in only: the person's own PIN, then the e-mailed code is sent. */
  setFirstPin: (next: string) => Promise<'ok' | 'same' | 'otp' | 'error'>
  /** Step 3: the six-digit code from the e-mail. Starts the session. */
  verifyOtp: (code: string) => Promise<VerifyResult>
  resendOtp: () => Promise<boolean>
  cancelSignIn: () => void
  /** Activity in this tab keeps the sign-in going (written at most every 20 seconds). */
  touch: () => void
  /** The manager's setting, as read by an open tab. */
  setSessionHours: (hours: number) => void
  lock: () => void
  unlock: (pin: string) => Promise<boolean>
  /** Replace the PIN (verifies the current one first). */
  changePin: (current: string, next: string) => Promise<boolean>
  /** Signs this tab out and ends this browser's key: the next sign-in needs a new code. */
  signOut: (reason?: SignOutReason) => Promise<void>
}

const deviceLabel = (): string | null =>
  typeof navigator === 'undefined' ? null : navigator.userAgent.slice(0, 120)

/** E-mail Supabase Auth knows for this user (legacy accounts: username@staff domain). */
const authEmail = (user: StaffUser): string => user.email ?? staffEmail(user.username)

/** Masks "josiane.uwimana@gmail.com" → "jo•••••@gmail.com" for the code screen. */
export const maskEmail = (email: string): string => {
  const [local = '', domain = ''] = email.split('@')
  const shown = local.slice(0, 2)
  return `${shown}${'•'.repeat(Math.max(3, local.length - 2))}@${domain}`
}

/** Wrong PINs allowed on the lock screen before the tab signs out. */
export const MAX_UNLOCK_FAILURES = 5

/** When this tab signs out if nobody uses it (ms; 0 when no activity was ever noted). */
export const idleDeadline = (s: Pick<SessionState, 'lastActiveAt' | 'sessionHours'>): number =>
  s.lastActiveAt == null ? 0 : s.lastActiveAt + clampHours(s.sessionHours) * HOUR_MS

/** True when this tab holds a user who has not used it for the set number of hours. */
export const sessionOver = (
  s: Pick<SessionState, 'user' | 'lastActiveAt' | 'sessionHours'>,
): boolean => !!s.user && Date.now() >= idleDeadline(s)

/** Where to sign in again: the login page for this staff ID, or the landing page. */
export const signInAgainPath = (staffId?: string | null): string =>
  staffId && STAFF_ID_RE.test(staffId) ? `/login?staff=${encodeURIComponent(staffId)}` : '/#signin'

/*
 * The message for the login page, kept with the tab (sessionStorage) so it survives the
 * navigation that follows a sign-out.
 */
const NOTE_KEY = 'mmc.signed-out'
export interface SignOutNote {
  reason: Exclude<SignOutReason, 'switched'>
  /** Hours without activity that sign a tab out (for the message). */
  hours: number
  /** Last activity in the tab (ms). */
  lastActiveAt: number | null
  at: number
}
function writeNote(note: SignOutNote) {
  try {
    sessionStorage.setItem(NOTE_KEY, JSON.stringify(note))
  } catch {
    /* storage blocked: the login page simply shows no reason */
  }
}
/** The last sign-out of this tab (within 12 hours), for the login page. */
export function readSignOutNote(): SignOutNote | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(NOTE_KEY) ?? 'null') as SignOutNote | null
    if (!v?.reason || !v.at || Date.now() - v.at > 12 * HOUR_MS) return null
    return { ...v, hours: clampHours(Number(v.hours)) }
  } catch {
    return null
  }
}
export function clearSignOutNote() {
  try {
    sessionStorage.removeItem(NOTE_KEY)
  } catch {
    /* ignore */
  }
}

/** Values that open a session on this tab: the sign-in itself is the first activity. */
const opened = (user: StaffUser, hours: number) => {
  // The approval itself counts as activity in the database.
  lastServerTouchAt = Date.now()
  return {
    user,
    locked: false,
    pending: null,
    unlockFailures: 0,
    lastActiveAt: Date.now(),
    sessionHours: clampHours(hours),
  }
}

export const useSession = create<SessionState>()(
  persist(
    (set, get) => ({
      user: null,
      locked: false,
      lastActiveAt: null,
      sessionHours: DEFAULT_SESSION_HOURS,
      unlockFailures: 0,
      pending: null,

      checkStaffId: async (staffId) => {
        const id = normalizeStaffId(staffId)
        if (!supabase) return findStaffByStaffId(id) !== undefined
        if (!get().user) await dropUnapprovedSession()
        const { data, error } = await supabase.rpc('public_staff_check', { p_staff_id: id })
        if (error) throw new Error(error.message)
        return data === true
      },

      signIn: async (staffId, username, pin) => {
        const id = normalizeStaffId(staffId)
        const name = username.trim().toLowerCase()
        clearSignOutNote()
        // A sign-in typed on this page is never the e-mailed link: the PIN sessions below
        // must not be taken for one.
        arrivedByMagicLink = false
        if (!supabase) {
          const user = findStaffByUsername(name)
          if (!user || user.staffId !== id) return { ok: false, reason: 'invalid' }
          const email = user.email ?? staffEmail(name)
          set({ pending: { staffId: id, username: name, email, sampleUser: user } })
          return { ok: true, step: 'otp', email }
        }
        trace('signIn.start', { staffId: id, username: name })
        // A PIN session left by an earlier try is never approved: the checks below go without it.
        await dropUnapprovedSession()
        const first = await checkTemporaryPin(id, name, pin)
        if (first && 'reason' in first) {
          trace('signIn.done', { ok: false, reason: first.reason })
          return { ok: false, reason: first.reason }
        }
        if (first) {
          set({
            pending: { staffId: id, username: name, email: first.email, pin, needsNewPin: true },
          })
          rememberExpected(name)
          trace('signIn.done', { ok: true, step: 'new-pin' })
          return { ok: true, step: 'new-pin' }
        }
        const trusted = await signInTrusted(id, name, pin)
        if (trusted && 'profile' in trusted) {
          const user = toStaffUser(trusted.profile)
          const hours = await sessionHoursSetting()
          queryClient.clear()
          set(opened(user, hours))
          markTrustSeen(user.username, hours)
          trace('signIn.done', { ok: true, step: 'done (browser key)' })
          return { ok: true, step: 'done', user }
        }
        if (trusted && 'reason' in trusted) {
          trace('signIn.done', { ok: false, reason: trusted.reason })
          return { ok: false, reason: trusted.reason }
        }
        let outcome = await requestCodeViaFunction(id, name, pin)
        trace('signIn.codeRequest', {
          via: 'function',
          ok: outcome.ok,
          ...(outcome.ok ? {} : { reason: outcome.reason }),
        })
        if (!outcome.ok && outcome.reason === 'unavailable') {
          outcome = await requestCodeDirect(id, name, pin)
          trace('signIn.codeRequest', {
            via: 'direct',
            ok: outcome.ok,
            ...(outcome.ok ? {} : { reason: outcome.reason }),
          })
        }
        if (!outcome.ok) {
          trace('signIn.done', { ok: false, reason: outcome.reason })
          return { ok: false, reason: outcome.reason === 'unavailable' ? 'error' : outcome.reason }
        }
        set({ pending: { staffId: id, username: name, email: outcome.email, pin } })
        rememberExpected(name)
        trace('signIn.done', { ok: true, step: 'otp' })
        return { ok: true, step: 'otp', email: outcome.email }
      },

      setFirstPin: async (next) => {
        const pending = get().pending
        if (!pending?.needsNewPin || !supabase) return 'error'
        if (next === pending.pin) return 'same'
        trace('setFirstPin.start')
        const { error } = await supabase.auth.updateUser({ password: next })
        if (error) {
          trace('setFirstPin.done', { ok: false, step: 'updateUser', error: error.message })
          return /same|different/i.test(error.message) ? 'same' : 'error'
        }
        const { error: markError } = await supabase.rpc('mark_pin_changed')
        if (markError) {
          trace('setFirstPin.done', { ok: false, step: 'mark_pin_changed', error: markError.code })
          return 'error'
        }
        // The new PIN is set; the e-mailed code now approves this first sign-in.
        let outcome = await requestCodeViaFunction(pending.staffId, pending.username, next)
        if (!outcome.ok && outcome.reason === 'unavailable') {
          const { error: otpError } = await supabase.auth.signInWithOtp({
            email: pending.email,
            options: { shouldCreateUser: false },
          })
          outcome = otpError ? { ok: false, reason: 'otp' } : { ok: true, email: pending.email }
        }
        set({ pending: { ...pending, pin: next, needsNewPin: false } })
        trace('setFirstPin.done', { ok: true, codeSent: outcome.ok })
        return outcome.ok ? 'ok' : 'otp'
      },

      verifyOtp: async (code) => {
        const pending = get().pending
        if (!pending) {
          trace('verifyOtp.noPending')
          return { ok: false, reason: 'expired' }
        }
        const token = code.replace(/\D/g, '')
        if (!supabase) {
          if (token.length !== 6 || !pending.sampleUser) return { ok: false, reason: 'invalid' }
          queryClient.clear()
          set(opened(pending.sampleUser, sampleSessionHours()))
          return { ok: true, user: pending.sampleUser }
        }
        trace('verifyOtp.start', { username: pending.username })
        const { data: verified, error } = await supabase.auth.verifyOtp({
          email: pending.email,
          token,
          type: 'email',
        })
        trace('verifyOtp.code', {
          ok: !error,
          error: error?.message,
          session: describeSession(verified?.session),
        })
        if (error) {
          return { ok: false, reason: /expired/i.test(error.message) ? 'expired' : 'invalid' }
        }
        // Stamps last sign-in, writes the login audit event, refuses deactivated profiles.
        const { data: profile, error: rpcError } = await supabase.rpc('record_sign_in', {
          p_device: deviceLabel(),
        })
        trace('verifyOtp.recordSignIn', {
          ok: !rpcError && !!profile,
          error: rpcError?.code,
          hint: rpcError?.hint,
          message: rpcError?.message,
        })
        if (rpcError || !profile) {
          // The code was right but the sign-in did not open here: the server may still have
          // approved it (an answer lost on the way). Support gets the trace.
          void reportClientEvent('verify_failed_after_code', {
            username: pending.username,
            staffId: pending.staffId,
            error: rpcError?.code ?? 'no profile',
            hint: rpcError?.hint,
          })
          await signOutAuth('record_sign_in failed')
          set({ pending: null })
          return {
            ok: false,
            reason: /deactivated/i.test(rpcError?.message ?? '')
              ? 'inactive'
              : rpcError?.code === 'PT401'
                ? 'notApproved'
                : 'error',
          }
        }
        const user = toStaffUser(profile as ProfileJson)
        const hours = await sessionHoursSetting()
        await trustThisBrowser(user.username, hours)
        queryClient.clear()
        set(opened(user, hours))
        trace('verifyOtp.done', { ok: true, hours, browserKey: readTrust(user.username) != null })
        return { ok: true, user }
      },

      resendOtp: async () => {
        const pending = get().pending
        if (!pending) return false
        if (!supabase) return true
        // Same PIN-gated request as the first code (the hook drops codes without a PIN check).
        if (pending.pin) {
          let outcome = await requestCodeViaFunction(pending.staffId, pending.username, pending.pin)
          if (!outcome.ok && outcome.reason === 'unavailable') {
            const { error } = await supabase.auth.signInWithOtp({
              email: pending.email,
              options: { shouldCreateUser: false },
            })
            outcome = error ? { ok: false, reason: 'otp' } : { ok: true, email: pending.email }
          }
          return outcome.ok
        }
        const { error } = await supabase.auth.signInWithOtp({
          email: pending.email,
          options: { shouldCreateUser: false },
        })
        return !error
      },

      cancelSignIn: () => {
        trace('cancelSignIn', { pending: get().pending != null })
        if (supabase && get().pending) void signOutAuth('sign-in cancelled')
        set({ pending: null })
      },

      touch: () => {
        const s = get()
        // A locked screen is not activity: the hours keep counting until the PIN opens it.
        if (!s.user || s.locked) return
        // Past the limit, activity no longer saves the sign-in (a tab waking up after hours).
        if (sessionOver(s)) return checkIdle()
        const now = Date.now()
        // Answering the warning before the sign-out: the database hears it at once.
        if (idleDeadline(s) - now <= IDLE_WARNING_MS) void touchServer(true)
        else void touchServer()
        if (s.lastActiveAt != null && now - s.lastActiveAt < TOUCH_EVERY_MS) return
        set({ lastActiveAt: now })
        markTrustSeen(s.user.username, s.sessionHours)
        void extendTrust(s.user.username)
      },

      setSessionHours: (hours) => {
        const h = clampHours(hours)
        if (h !== get().sessionHours) set({ sessionHours: h })
      },

      lock: () => {
        const user = get().user
        if (!user || sessionOver(get())) return
        set({ locked: true })
        // The person's other tabs in this browser lock too.
        tellOtherTabs({ kind: 'locked', username: user.username })
      },

      unlock: async (pin) => {
        const user = get().user
        if (!user) return false
        if (sessionOver(get())) {
          // Left locked for the hours without activity: no PIN opens it any more.
          await get().signOut('idle')
          window.location.replace(signInAgainPath(user.staffId))
          return false
        }
        if (!supabase) {
          set({ locked: false, unlockFailures: 0 })
          tellOtherTabs({ kind: 'unlocked', username: user.username })
          get().touch()
          return true
        }
        // The PIN is checked aside: this tab keeps the sign-in approved by the e-mailed code.
        if (!(await pinIsRight(authEmail(user), pin))) {
          // A PIN cannot be guessed at a locked screen: after 5 wrong tries the tab signs out
          // and the full sign-in (with a new e-mailed code) is needed. The server keeps the
          // count too (the manager sees it; sign-in counts it).
          const { data: recent } = await supabase.rpc('record_wrong_pin', {
            p_where: 'lock screen',
          })
          const failures = Math.max(get().unlockFailures + 1, Number(recent ?? 0))
          set({ unlockFailures: failures })
          if (failures >= MAX_UNLOCK_FAILURES) {
            await get().signOut('wrongPins')
            window.location.replace(signInAgainPath(user.staffId))
          }
          return false
        }
        set({ locked: false, unlockFailures: 0 })
        // The right PIN opens the person's other locked tabs in this browser too.
        tellOtherTabs({ kind: 'unlocked', username: user.username })
        // The right PIN is activity: the hours count again from now (the database too).
        get().touch()
        void touchServer(true)
        return true
      },

      changePin: async (current, next) => {
        const user = get().user
        if (!user) return false
        if (!supabase) {
          set({ user: { ...user, mustChangePin: false } })
          return true
        }
        // The current PIN is checked aside; the new one is set on this tab's own sign-in, the
        // one the e-mailed code approved (Supabase Auth ends the person's other sign-ins).
        if (!(await pinIsRight(authEmail(user), current))) return false
        const { error } = await supabase.auth.updateUser({ password: next })
        if (error) return false
        await supabase.rpc('mark_pin_changed')
        set({ user: { ...user, mustChangePin: false } })
        return true
      },

      signOut: async (reason = 'signedOut') => {
        // This tab, and (for a sign-out by the person, 5 wrong PINs or a deactivated account)
        // the same person's other tabs in this browser. Other devices are not touched. The app
        // forgets the user first, so nothing more is shown or recorded under their name.
        const username = get().user?.username
        trace('signOut', { reason, user: username, by: shortStack(3) })
        const token = forgetTab(reason, get, set, 'signOut')
        if (username && SHARED_SIGN_OUTS.includes(reason)) {
          tellOtherTabs({ kind: 'signedOut', username, reason })
        }
        if (supabase) {
          // This browser's key ends too: the next sign-in asks for a new e-mailed code.
          if (token) await revokeDevice(token)
          // ... and this sign-in, in the database: a copied access token no longer works.
          await endServerSession(reason)
          await withTimeout(signOutAuth(`signOut ${reason}`))
        }
      },
    }),
    {
      name: 'mmc.session',
      // Per tab, like the Supabase session (see lib/supabase.ts).
      storage: createJSONStorage(() => sessionStorage),
      // Version 1: the inactivity rule. A tab saved before it may hold an automatic lock (idle
      // or reload lock, now removed): it opens without the PIN screen, within the hours.
      version: 1,
      migrate: (persisted, version) => {
        const s = (persisted ?? {}) as Partial<SessionState>
        return version < 1 ? { ...s, locked: false, unlockFailures: 0 } : s
      },
      // A manual lock goes with the tab: a reload, a duplicated tab or a reopened tab must not
      // remove the lock screen. The last activity goes with it too.
      partialize: (s) => ({
        user: s.user,
        locked: s.locked,
        lastActiveAt: s.lastActiveAt,
        sessionHours: s.sessionHours,
        unlockFailures: s.unlockFailures,
        // the code step survives a reload; the PIN and the sample user stay in memory only
        pending: s.pending
          ? {
              staffId: s.pending.staffId,
              username: s.pending.username,
              email: s.pending.email,
              needsNewPin: s.pending.needsNewPin,
            }
          : null,
      }),
      // A tab the browser put to sleep and reloaded simply continues within the hours, with no
      // PIN screen. One that was not used for longer signs out at once.
      onRehydrateStorage: () => (state) => {
        if (!state || !sessionOver(state)) return
        const staffId = state.user?.staffId
        const onApp = typeof window !== 'undefined' && window.location.pathname.startsWith('/app')
        void state.signOut(state.lastActiveAt == null ? 'ended' : 'idle').then(() => {
          if (onApp) window.location.replace(signInAgainPath(staffId))
        })
      },
    },
  ),
)

/**
 * Forgets the signed-in person on this tab at once (store, cached data, this browser's key)
 * and leaves the reason for the login page. Returns the browser key, for the server. Takes the
 * store's get/set: it also runs while the store is being created (a reloaded tab).
 */
function forgetTab(
  reason: SignOutReason,
  get: () => SessionState,
  set: (p: Partial<SessionState>) => void,
  caller: string,
): string | null {
  const { user, lastActiveAt, sessionHours } = get()
  trace('forgetTab', { reason, caller, user: user?.username, pending: get().pending != null })
  if (!user) {
    set({ locked: false, pending: null, unlockFailures: 0 })
    return null
  }
  const token = readTrust(user.username)
  writeTrust(user.username, null)
  if (reason !== 'switched') {
    writeNote({ reason, hours: clampHours(sessionHours), lastActiveAt, at: Date.now() })
  }
  set({
    user: null,
    locked: false,
    pending: null,
    unlockFailures: 0,
    lastActiveAt: null,
  })
  queryClient.clear()
  return token
}

/**
 * The sign-in e-mail can carry a link instead of a code (Supabase's default template, which
 * the free plan only lets us change once a custom SMTP provider is set). Opening that link
 * lands here with `#access_token…&type=magiclink`: supabase-js turns it into a session, and we
 * finish the sign-in exactly as after a code (record_sign_in, this browser's key, then the
 * staff area).
 */
/*
 * Which account the person just typed on the login page. The sign-in link opens in a new tab
 * (no in-memory state), so it is kept in localStorage for 15 minutes. If the link belongs to a
 * different account — several staff e-mails read in one inbox — the sign-in is refused instead
 * of silently opening someone else's dashboard.
 */
const EXPECTED_KEY = 'mmc.expected-sign-in'
export const MISMATCH_KEY = 'mmc.sign-in-mismatch'
function rememberExpected(username: string) {
  try {
    localStorage.setItem(EXPECTED_KEY, JSON.stringify({ username, at: Date.now() }))
  } catch {
    /* storage blocked: the link still works, without the check */
  }
}
function expectedUsername(): string | null {
  try {
    const v = JSON.parse(localStorage.getItem(EXPECTED_KEY) ?? 'null') as {
      username?: string
      at?: number
    } | null
    if (!v?.username || !v.at || Date.now() - v.at > 15 * 60_000) return null
    return v.username
  } catch {
    return null
  }
}

/*
 * Only the session carried by the link in the address counts: the address must hold the link's
 * own token, and it is used once. A PIN sign-in typed afterwards on this tab (also a SIGNED_IN
 * event) is never taken for the link; its access token must say it came from the e-mail too.
 */
let arrivedByMagicLink =
  typeof window !== 'undefined' &&
  /(^#|&)access_token=/.test(window.location.hash) &&
  /(^#|&)type=magiclink(&|$)/.test(window.location.hash)

// Keep the store honest with Supabase Auth: a session that ended elsewhere ends here too.
const sb = supabase
if (sb) {
  sb.auth.onAuthStateChange((event, session) => {
    const s = useSession.getState()
    trace('auth.event', {
      event,
      session: describeSession(session),
      user: s.user?.username,
      pending: s.pending != null,
      // true on a SIGNED_OUT: it came from another page sharing this tab's key (see tabHasSession)
      stored: tabHasSession(),
    })
    if (event === 'SIGNED_OUT') {
      const user = s.user
      // Our own sign-out forgets the user first; a user still here was signed out elsewhere
      // (another tab, the manager): back to the sign-in, not a blank page. This browser's key
      // is forgotten too (the server can no longer be asked; the key ends there after N hours).
      if (user) {
        // Nobody chose this sign-out: support gets the trace (see lib/sign-in-trace.ts).
        const sent = reportClientEvent('signed_out_unexpected', {
          username: user.username,
          staffId: user.staffId,
          userId: user.id,
          lastActiveAt: isoTime(s.lastActiveAt),
        })
        forgetTab('ended', useSession.getState, useSession.setState, 'auth SIGNED_OUT')
        if (window.location.pathname.startsWith('/app')) {
          // the report goes first (at most a moment): the page is about to be left
          void sent.finally(() => window.location.assign(signInAgainPath(user.staffId)))
        }
      }
    }
    if (event === 'INITIAL_SESSION' && !session && s.user) {
      void reportClientEvent('initial_session_missing', {
        username: s.user.username,
        staffId: s.user.staffId,
        userId: s.user.id,
        lastActiveAt: isoTime(s.lastActiveAt),
      })
      forgetTab('ended', useSession.getState, useSession.setState, 'auth INITIAL_SESSION empty')
    }
    if (event === 'SIGNED_IN' && session && arrivedByMagicLink && !useSession.getState().user) {
      arrivedByMagicLink = false
      if (!openedByCode(session.access_token)) {
        // Not the e-mailed link (a PIN session): it never opens the staff area by itself.
        void signOutAuth('link session not from the e-mail')
        return
      }
      void (async () => {
        const { data: profile, error } = await sb.rpc('record_sign_in', {
          p_device: deviceLabel(),
        })
        trace('link.recordSignIn', { ok: !error && !!profile, error: error?.code })
        if (error || !profile) {
          await signOutAuth('link record_sign_in failed')
          return
        }
        const expected = expectedUsername()
        const got = (profile as ProfileJson).username
        try {
          localStorage.removeItem(EXPECTED_KEY)
        } catch {
          /* ignore */
        }
        if (expected && expected !== got) {
          trace('link.wrongAccount')
          await endServerSession('wrong account')
          await signOutAuth('link for another account')
          try {
            localStorage.setItem(MISMATCH_KEY, JSON.stringify({ expected, got }))
          } catch {
            /* ignore */
          }
          window.location.replace('/login')
          return
        }
        // The link counts as the e-mailed code: it starts a session like the code does.
        const user = toStaffUser(profile as ProfileJson)
        const hours = await sessionHoursSetting()
        await trustThisBrowser(user.username, hours)
        clearSignOutNote()
        queryClient.clear()
        useSession.setState(opened(user, hours))
        window.location.replace('/app')
      })()
    }
  })
}

/*
 * The sign-out after N hours without activity: checked every 15 seconds, and at once when the
 * person comes back to the tab (the browser slows or stops timers in hidden tabs). The tab
 * signs out, this browser's key ends, and the login page explains why.
 */
let ending = false
function checkIdle() {
  const s = useSession.getState()
  if (ending || !sessionOver(s)) return
  ending = true
  trace('checkIdle.over', {
    lastActiveAt: isoTime(s.lastActiveAt),
    hours: s.sessionHours,
  })
  const staffId = s.user?.staffId
  void s.signOut(s.lastActiveAt == null ? 'ended' : 'idle').finally(() => {
    ending = false
    if (window.location.pathname.startsWith('/app')) {
      window.location.replace(signInAgainPath(staffId))
    }
  })
}

/*
 * The database refused this tab's sign-in (0081): never approved by the e-mailed code (for
 * instance every sign-in open when the rule went live), signed out, or hours without activity
 * counted by the server. The tab signs out and the login page says why. While nobody is signed
 * in on the tab (or the code step is still pending) the screens handle the answer themselves.
 */
function refuseTab(reason: Extract<SignOutReason, 'idle' | 'ended' | 'security'>) {
  const s = useSession.getState()
  trace('refuseTab', { reason, user: s.user?.username, pending: s.pending != null, ending })
  if (ending || !s.user || s.pending) return
  ending = true
  const staffId = s.user.staffId
  void s.signOut(reason).finally(() => {
    ending = false
    if (window.location.pathname.startsWith('/app')) {
      window.location.replace(signInAgainPath(staffId))
    }
  })
}
onSessionRefused((hint) =>
  refuseTab(hint === 'idle' ? 'idle' : hint === 'ended' ? 'ended' : 'security'),
)

/**
 * Before a new sign-in on a tab where nobody is signed in: a PIN session left by an earlier try
 * (never approved by the database) is closed, so the next checks go out as a visitor.
 */
async function dropUnapprovedSession(): Promise<void> {
  if (!supabase || useSession.getState().user) return
  const { data } = await supabase.auth.getSession()
  if (data.session) await withTimeout(signOutAuth('unapproved session left'))
}

/** What counts as activity in a tab. Scroll does not bubble: listened to in the capture phase. */
const ACTIVITY_EVENTS = [
  'pointerdown',
  'pointermove',
  'keydown',
  'touchstart',
  'wheel',
  'scroll',
] as const

/*
 * What another tab of this browser said about the same person: signed out (this tab signs out
 * too, the key was already ended there), locked (this tab locks) or unlocked with the PIN (this
 * tab opens again, within the hours without activity).
 */
tabChannel?.addEventListener('message', (e: MessageEvent<TabMessage | null>) => {
  const m = e.data
  const s = useSession.getState()
  if (!m || typeof m !== 'object' || !s.user || s.user.username !== m.username) return
  if (m.kind === 'locked') {
    if (!s.locked && !sessionOver(s)) useSession.setState({ locked: true })
    return
  }
  if (m.kind === 'unlocked') {
    if (s.locked && !sessionOver(s)) useSession.setState({ locked: false, unlockFailures: 0 })
    return
  }
  if (m.kind !== 'signedOut') return
  const staffId = s.user.staffId
  trace('tabs.signedOut', { reason: m.reason })
  forgetTab(
    SHARED_SIGN_OUTS.includes(m.reason) ? m.reason : 'ended',
    useSession.getState,
    useSession.setState,
    'another tab signed out',
  )
  void (async () => {
    if (supabase) {
      await endServerSession('another tab')
      await withTimeout(signOutAuth('another tab signed out'))
    }
    if (window.location.pathname.startsWith('/app')) {
      window.location.replace(signInAgainPath(staffId))
    }
  })()
})

if (typeof window !== 'undefined') {
  const onActivity = () => useSession.getState().touch()
  for (const ev of ACTIVITY_EVENTS) {
    window.addEventListener(ev, onActivity, { passive: true, capture: true })
  }
  window.setInterval(checkIdle, 15_000)
  window.addEventListener('focus', checkIdle)
  window.addEventListener('pageshow', checkIdle)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkIdle()
  })
}

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import {
  findStaffByStaffId,
  findStaffByUsername,
  normalizeStaffId,
  type Role,
  type StaffUser,
} from '@mmc/shared'
import { staffEmail, supabase } from '@/lib/supabase'
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
  | { ok: false; reason: 'invalid' | 'inactive' | 'expired' | 'error' }

/** Sign-in in progress: the PIN was accepted, the e-mail code is still pending. Never persisted. */
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

/*
 * Trusted devices (migration 0025). After a correct e-mailed code the browser may keep a random
 * key per username (localStorage: shared by the tabs of this browser, gone with "clear data").
 * The database stores only its fingerprint; the manager decides how long it is trusted.
 */
const TRUST_PREFIX = 'mmc.trust.'
const trustKey = (username: string) => TRUST_PREFIX + username
const readTrust = (username: string): string | null => {
  try {
    return localStorage.getItem(trustKey(username))
  } catch {
    return null
  }
}
const writeTrust = (username: string, token: string | null) => {
  try {
    if (token) localStorage.setItem(trustKey(username), token)
    else localStorage.removeItem(trustKey(username))
  } catch {
    /* storage blocked: the device is simply not remembered */
  }
}
const newTrustToken = () => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * A trusted device: check the PIN with Supabase Auth, then the device key with the database.
 * Returns the signed-in profile, or null to fall back to the e-mailed code.
 */
async function signInTrusted(
  staffId: string,
  username: string,
  pin: string,
): Promise<{ profile: ProfileJson } | { reason: 'invalid' | 'inactive' } | null> {
  const token = readTrust(username)
  if (!token) return null
  const { data: email } = await supabase!.rpc('staff_login_email', {
    p_staff_id: staffId,
    p_username: username,
  })
  if (!email) return { reason: 'invalid' }
  const { error } = await supabase!.auth.signInWithPassword({ email, password: pin })
  if (error) return { reason: /banned/i.test(error.message) ? 'inactive' : 'invalid' }
  const { data: trusted } = await supabase!.rpc('use_trusted_device', { p_token: token })
  if (!trusted) {
    // Expired, revoked or switched off by the manager: forget the key, ask for a code.
    writeTrust(username, null)
    await supabase!.auth.signOut({ scope: 'local' })
    return null
  }
  const { data: profile, error: rpcError } = await supabase!.rpc('record_sign_in', {
    p_device: deviceLabel(),
  })
  if (rpcError || !profile) {
    await supabase!.auth.signOut({ scope: 'local' })
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
    await supabase!.auth.signOut({ scope: 'local' })
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
): Promise<{ email: string } | { reason: 'invalid' | 'inactive' } | null> {
  const { data: email } = await supabase!.rpc('staff_login_email', {
    p_staff_id: staffId,
    p_username: username,
  })
  if (!email) return { reason: 'invalid' }
  const { data: auth, error } = await supabase!.auth.signInWithPassword({ email, password: pin })
  // Wrong PIN or blocked account: let the usual path answer, so the server keeps counting
  // failed attempts and gives the same messages as before.
  if (error || !auth.user) return null
  const { data: me } = await supabase!
    .from('profiles')
    .select('must_change_pin')
    .eq('id', auth.user.id)
    .maybeSingle()
  if (me?.must_change_pin) return { email: email as string }
  // Not a temporary PIN: drop this session, the usual trusted-device / e-mailed-code path follows.
  await supabase!.auth.signOut({ scope: 'local' })
  return null
}

interface SessionState {
  user: StaffUser | null
  /** Idle lock: the session stays valid but the screen asks for the PIN again. */
  locked: boolean
  /** Last time the person used this tab (kept with the tab: a reload after a pause locks). */
  lastActiveAt: number | null
  /** Activity seen (the idle timer calls it, at most every few seconds). */
  touch: () => void
  /** Wrong PINs on the lock screen since the last unlock (5 = signed out). */
  unlockFailures: number
  pending: PendingSignIn | null
  /** Step 1 (landing page): is this an active staff ID? */
  checkStaffId: (staffId: string) => Promise<boolean>
  /** Step 2 (login page): staff ID + username + PIN. On success a one-time code is e-mailed. */
  signIn: (staffId: string, username: string, pin: string) => Promise<SignInResult>
  /** First sign-in only: the person's own PIN, then the e-mailed code is sent. */
  setFirstPin: (next: string) => Promise<'ok' | 'same' | 'otp' | 'error'>
  /** Step 3: the six-digit code from the e-mail. */
  verifyOtp: (code: string, trustDevice?: boolean) => Promise<VerifyResult>
  resendOtp: () => Promise<boolean>
  cancelSignIn: () => void
  lock: () => void
  unlock: (pin: string) => Promise<boolean>
  /** Replace the PIN (verifies the current one first). */
  changePin: (current: string, next: string) => Promise<boolean>
  signOut: () => Promise<void>
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

/** A tab reloaded within this time of the last activity stays open; later it asks for the PIN. */
const RELOAD_GRACE_MS = 60_000
/** Wrong PINs allowed on the lock screen before the tab signs out. */
const MAX_UNLOCK_FAILURES = 5

export const useSession = create<SessionState>()(
  persist(
    (set, get) => ({
      user: null,
      locked: false,
      lastActiveAt: null,
      unlockFailures: 0,
      pending: null,

      touch: () => set({ lastActiveAt: Date.now() }),

      checkStaffId: async (staffId) => {
        const id = normalizeStaffId(staffId)
        if (!supabase) return findStaffByStaffId(id) !== undefined
        const { data, error } = await supabase.rpc('public_staff_check', { p_staff_id: id })
        if (error) throw new Error(error.message)
        return data === true
      },

      signIn: async (staffId, username, pin) => {
        const id = normalizeStaffId(staffId)
        const name = username.trim().toLowerCase()
        if (!supabase) {
          const user = findStaffByUsername(name)
          if (!user || user.staffId !== id) return { ok: false, reason: 'invalid' }
          const email = user.email ?? staffEmail(name)
          set({ pending: { staffId: id, username: name, email, sampleUser: user } })
          return { ok: true, step: 'otp', email }
        }
        const first = await checkTemporaryPin(id, name, pin)
        if (first && 'reason' in first) return { ok: false, reason: first.reason }
        if (first) {
          set({
            pending: { staffId: id, username: name, email: first.email, pin, needsNewPin: true },
          })
          rememberExpected(name)
          return { ok: true, step: 'new-pin' }
        }
        const trusted = await signInTrusted(id, name, pin)
        if (trusted && 'profile' in trusted) {
          const user = toStaffUser(trusted.profile)
          queryClient.clear()
          set({ user, locked: false, pending: null, lastActiveAt: Date.now() })
          return { ok: true, step: 'done', user }
        }
        if (trusted && 'reason' in trusted) return { ok: false, reason: trusted.reason }
        let outcome = await requestCodeViaFunction(id, name, pin)
        if (!outcome.ok && outcome.reason === 'unavailable') {
          outcome = await requestCodeDirect(id, name, pin)
        }
        if (!outcome.ok) {
          return { ok: false, reason: outcome.reason === 'unavailable' ? 'error' : outcome.reason }
        }
        set({ pending: { staffId: id, username: name, email: outcome.email, pin } })
        rememberExpected(name)
        return { ok: true, step: 'otp', email: outcome.email }
      },

      setFirstPin: async (next) => {
        const pending = get().pending
        if (!pending?.needsNewPin || !supabase) return 'error'
        if (next === pending.pin) return 'same'
        const { error } = await supabase.auth.updateUser({ password: next })
        if (error) return /same|different/i.test(error.message) ? 'same' : 'error'
        await supabase.rpc('mark_pin_changed')
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
        return outcome.ok ? 'ok' : 'otp'
      },

      verifyOtp: async (code, trustDevice = false) => {
        const pending = get().pending
        if (!pending) return { ok: false, reason: 'expired' }
        const token = code.replace(/\D/g, '')
        if (!supabase) {
          if (token.length !== 6 || !pending.sampleUser) return { ok: false, reason: 'invalid' }
          queryClient.clear()
          set({ user: pending.sampleUser, locked: false, pending: null, lastActiveAt: Date.now() })
          return { ok: true, user: pending.sampleUser }
        }
        const { error } = await supabase.auth.verifyOtp({
          email: pending.email,
          token,
          type: 'email',
        })
        if (error) {
          return { ok: false, reason: /expired/i.test(error.message) ? 'expired' : 'invalid' }
        }
        // Stamps last sign-in, writes the login audit event, refuses deactivated profiles.
        const { data: profile, error: rpcError } = await supabase.rpc('record_sign_in', {
          p_device: deviceLabel(),
        })
        if (rpcError || !profile) {
          await supabase.auth.signOut({ scope: 'local' })
          set({ pending: null })
          return {
            ok: false,
            reason: /deactivated/i.test(rpcError?.message ?? '') ? 'inactive' : 'error',
          }
        }
        const user = toStaffUser(profile as ProfileJson)
        if (trustDevice) {
          const token = newTrustToken()
          const { data: until } = await supabase.rpc('trust_this_device', {
            p_token: token,
            p_label: deviceLabel(),
          })
          writeTrust(user.username, until ? token : null)
        }
        queryClient.clear()
        set({ user, locked: false, pending: null, lastActiveAt: Date.now() })
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
        if (supabase && get().pending) void supabase.auth.signOut({ scope: 'local' })
        set({ pending: null })
      },

      lock: () => {
        if (get().user) set({ locked: true })
      },

      unlock: async (pin) => {
        const user = get().user
        if (!user) return false
        if (!supabase) {
          set({ locked: false })
          return true
        }
        const { error } = await supabase.auth.signInWithPassword({
          email: authEmail(user),
          password: pin,
        })
        if (error) {
          // A PIN cannot be guessed at a locked screen: after 5 wrong tries the tab signs out
          // and the full sign-in (with the e-mailed code) is needed.
          const failures = get().unlockFailures + 1
          set({ unlockFailures: failures })
          if (failures >= MAX_UNLOCK_FAILURES) await get().signOut()
          return false
        }
        set({ locked: false, lastActiveAt: Date.now(), unlockFailures: 0 })
        return true
      },

      changePin: async (current, next) => {
        const user = get().user
        if (!user) return false
        if (!supabase) {
          set({ user: { ...user, mustChangePin: false } })
          return true
        }
        const { error: verify } = await supabase.auth.signInWithPassword({
          email: authEmail(user),
          password: current,
        })
        if (verify) return false
        const { error } = await supabase.auth.updateUser({ password: next })
        if (error) return false
        await supabase.rpc('mark_pin_changed')
        set({ user: { ...user, mustChangePin: false } })
        return true
      },

      signOut: async () => {
        // This tab only: the same person may be signed in on another device or tab.
        if (supabase) await supabase.auth.signOut({ scope: 'local' })
        queryClient.clear()
        set({ user: null, locked: false, pending: null, unlockFailures: 0 })
      },
    }),
    {
      name: 'mmc.session',
      // Per tab, like the Supabase session (see lib/supabase.ts).
      storage: createJSONStorage(() => sessionStorage),
      // The lock state goes with the tab: a reload, a duplicated tab or a reopened tab must not
      // remove the lock screen.
      partialize: (s) => ({
        user: s.user,
        locked: s.locked,
        lastActiveAt: s.lastActiveAt,
        unlockFailures: s.unlockFailures,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state?.user || !supabase) return
        const idle = !state.lastActiveAt || Date.now() - state.lastActiveAt > RELOAD_GRACE_MS
        if (state.locked || idle) state.lock()
      },
    },
  ),
)

/**
 * The sign-in e-mail can carry a link instead of a code (Supabase's default template, which
 * the free plan only lets us change once a custom SMTP provider is set). Opening that link
 * lands here with `#access_token…&type=magiclink`: supabase-js turns it into a session, and we
 * finish the sign-in exactly as after a code (record_sign_in, then the staff area).
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

const arrivedByMagicLink =
  typeof window !== 'undefined' && /type=magiclink/.test(window.location.hash)

// Keep the store honest with Supabase Auth: a session that ended elsewhere ends here too.
const sb = supabase
if (sb) {
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      queryClient.clear()
      useSession.setState({ user: null, locked: false })
    }
    if (event === 'INITIAL_SESSION' && !session && useSession.getState().user) {
      queryClient.clear()
      useSession.setState({ user: null, locked: false })
    }
    if (event === 'SIGNED_IN' && session && arrivedByMagicLink && !useSession.getState().user) {
      void (async () => {
        const { data: profile, error } = await sb.rpc('record_sign_in', {
          p_device: deviceLabel(),
        })
        if (error || !profile) {
          await sb.auth.signOut({ scope: 'local' })
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
          await sb.auth.signOut({ scope: 'local' })
          try {
            localStorage.setItem(MISMATCH_KEY, JSON.stringify({ expected, got }))
          } catch {
            /* ignore */
          }
          window.location.replace('/login')
          return
        }
        queryClient.clear()
        useSession.setState({
          user: toStaffUser(profile as ProfileJson),
          locked: false,
          pending: null,
          lastActiveAt: Date.now(),
          unlockFailures: 0,
        })
        window.location.replace('/app')
      })()
    }
  })
}

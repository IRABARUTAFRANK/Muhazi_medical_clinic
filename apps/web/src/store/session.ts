import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { findStaffById, findStaffByUsername, type Role, type StaffUser } from '@mmc/shared'
import { staffEmail, supabase } from '@/lib/supabase'

const HOME_ROLES: readonly string[] = ['receptionist', 'nurse', 'doctor', 'cashier', 'manager']

/** Shape returned by the `record_sign_in()` database function. */
interface ProfileJson {
  id: string
  username: string
  full_name: string
  role: string
  station: string | null
  dashboard: 'manager' | 'head' | null
  head_of: string | null
  must_change_pin: boolean
}

const toStaffUser = (p: ProfileJson): StaffUser => ({
  id: p.id,
  username: p.username,
  name: p.full_name,
  // Roles without a designed home yet (lab, pharmacy, sonographer) use the doctor home for now.
  role: HOME_ROLES.includes(p.role) ? (p.role as Role) : 'doctor',
  station: p.station ?? undefined,
  dashboard: p.dashboard ?? undefined,
  headOf: p.head_of ?? undefined,
  mustChangePin: p.must_change_pin,
})

export type SignInResult =
  { ok: true; user: StaffUser } | { ok: false; reason: 'invalid' | 'inactive' | 'error' }

interface SessionState {
  user: StaffUser | null
  /** Idle lock: the session stays valid but the screen asks for the PIN again. */
  locked: boolean
  /** Username + PIN. Live: Supabase Auth + `record_sign_in()`; sample: any PIN for a known username. */
  signIn: (username: string, pin: string) => Promise<SignInResult>
  lock: () => void
  unlock: (pin: string) => Promise<boolean>
  /** Replace the PIN (verifies the current one first). */
  changePin: (current: string, next: string) => Promise<boolean>
  /** One-tap switch on shared devices. In live mode it signs out (the next user types their PIN). */
  switchTo: (userId: string) => Promise<'switched' | 'signed-out'>
  signOut: () => Promise<void>
}

const deviceLabel = (): string | null =>
  typeof navigator === 'undefined' ? null : navigator.userAgent.slice(0, 120)

export const useSession = create<SessionState>()(
  persist(
    (set, get) => ({
      user: null,
      locked: false,

      signIn: async (username, pin) => {
        if (!supabase) {
          const user = findStaffByUsername(username) ?? null
          if (!user) return { ok: false, reason: 'invalid' }
          set({ user, locked: false })
          return { ok: true, user }
        }
        const { data, error } = await supabase.auth.signInWithPassword({
          email: staffEmail(username),
          password: pin,
        })
        if (error || !data.user) {
          return {
            ok: false,
            reason: /banned/i.test(error?.message ?? '') ? 'inactive' : 'invalid',
          }
        }
        // Stamps last sign-in, writes the login audit event, refuses deactivated profiles.
        const { data: profile, error: rpcError } = await supabase.rpc('record_sign_in', {
          p_device: deviceLabel(),
        })
        if (rpcError || !profile) {
          await supabase.auth.signOut()
          return {
            ok: false,
            reason: /deactivated/i.test(rpcError?.message ?? '') ? 'inactive' : 'error',
          }
        }
        const user = toStaffUser(profile as ProfileJson)
        set({ user, locked: false })
        return { ok: true, user }
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
          email: staffEmail(user.username),
          password: pin,
        })
        if (error) return false
        set({ locked: false })
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
          email: staffEmail(user.username),
          password: current,
        })
        if (verify) return false
        const { error } = await supabase.auth.updateUser({ password: next })
        if (error) return false
        await supabase.rpc('mark_pin_changed')
        set({ user: { ...user, mustChangePin: false } })
        return true
      },

      switchTo: async (userId) => {
        if (supabase) {
          await supabase.auth.signOut()
          set({ user: null, locked: false })
          return 'signed-out'
        }
        const user = findStaffById(userId)
        if (user) set({ user, locked: false })
        return 'switched'
      },

      signOut: async () => {
        if (supabase) await supabase.auth.signOut()
        set({ user: null, locked: false })
      },
    }),
    { name: 'mmc.session', partialize: (s) => ({ user: s.user }) },
  ),
)

// Keep the store honest with Supabase Auth: a session that ended elsewhere ends here too.
if (supabase) {
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') useSession.setState({ user: null, locked: false })
    if (event === 'INITIAL_SESSION' && !session && useSession.getState().user) {
      useSession.setState({ user: null, locked: false })
    }
  })
}

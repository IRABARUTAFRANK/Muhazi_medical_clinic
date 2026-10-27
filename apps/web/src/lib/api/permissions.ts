import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { StaffUser } from '@mmc/shared'
import { queryClient } from '@/lib/query-client'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import type { DbRole } from './staff'
import { apiError } from './errors'

/**
 * Who may do what (Settings → Who may do what): the main features the manager switches on or off
 * for each role, with exceptions for one employee. The database decides (has_perm); the app
 * hides what the person may not do. Live: permission_matrix, set_role_permission,
 * set_staff_permission, my_permissions (migration 0054).
 */
export const MANAGED_FEATURES = [
  'payment.take',
  'visit.start',
  'vitals.write',
  'charge.write',
  'clinical.write',
  'orders.write',
  'appointment.approve',
  'stock.write',
  'records.approve',
] as const
export type Feature = (typeof MANAGED_FEATURES)[number]

/** Roles shown in the table (the manager always keeps everything). */
export const MATRIX_ROLES: DbRole[] = [
  'receptionist',
  'nurse',
  'doctor',
  'cashier',
  'lab_tech',
  'sonographer',
  'pharmacist',
]

/** The clinic's defaults (also used before the database knows these settings). */
const DEFAULTS: Record<Feature, string[]> = {
  'payment.take': ['cashier', 'receptionist'],
  'visit.start': ['receptionist', 'nurse', 'doctor', 'manager'],
  'vitals.write': ['receptionist', 'nurse', 'doctor', 'manager'],
  'charge.write': ['nurse', 'doctor', 'sonographer', 'lab_tech', 'pharmacist', 'manager'],
  'clinical.write': ['nurse', 'doctor', 'manager'],
  'orders.write': ['doctor', 'sonographer', 'lab_tech', 'manager'],
  // booking requests are reception's work; the manager oversees them (0068)
  'appointment.approve': ['receptionist'],
  'stock.write': ['lab_tech', 'pharmacist', 'manager'],
  // answering record-access requests is the manager's alone until they give the right (0095)
  'records.approve': ['manager'],
}
const defaultsFor = (role: string) => MANAGED_FEATURES.filter((f) => DEFAULTS[f].includes(role))

/** Does the person's role have this feature by default? (The "switched off for you" notes.) */
export const roleHasByDefault = (role: string, f: Feature): boolean => DEFAULTS[f].includes(role)

/** The i18n id of a feature in the "not allowed" notes (perms.blocked.what.*). */
export const FEATURE_KEY: Record<Feature, string> = {
  'payment.take': 'paymentTake',
  'visit.start': 'visitStart',
  'vitals.write': 'vitalsWrite',
  'charge.write': 'chargeWrite',
  'clinical.write': 'clinicalWrite',
  'orders.write': 'ordersWrite',
  'appointment.approve': 'appointmentApprove',
  'stock.write': 'stockWrite',
  'records.approve': 'recordsApprove',
}

export interface PermissionException {
  profileId: string
  name: string
  role: string
  permission: Feature
  allowed: boolean
  at: string
}
export interface PermissionMatrix {
  roles: Record<string, Feature[]>
  exceptions: PermissionException[]
}

// ---------------------------------------------------------------- sample mode (no Supabase)
// The defaults, changed by the sample Settings page. Kept in this browser (localStorage) so a
// second tab signed in as someone else follows the switches as a live tab follows the database.
const SAMPLE_KEY = 'mmc.sample.permissions'
const sampleRoles: Record<string, Feature[]> = Object.fromEntries(
  MATRIX_ROLES.map((r) => [r, defaultsFor(r)]),
)
const sampleExceptions: PermissionException[] = []
function loadSample() {
  try {
    const raw = window.localStorage.getItem(SAMPLE_KEY)
    if (!raw) return
    const j = JSON.parse(raw) as Partial<PermissionMatrix>
    for (const [r, list] of Object.entries(j.roles ?? {}))
      sampleRoles[r] = list.filter((f) => (MANAGED_FEATURES as readonly string[]).includes(f))
    sampleExceptions.splice(0, sampleExceptions.length, ...(j.exceptions ?? []))
  } catch {
    // no storage (a private window): the switches of this tab only
  }
}
function saveSample() {
  try {
    window.localStorage.setItem(
      SAMPLE_KEY,
      JSON.stringify({ roles: sampleRoles, exceptions: sampleExceptions }),
    )
  } catch {
    // no storage: kept in this tab only
  }
}

/** Sample mode: what one person may do (their exception first, else their role's switch). */
export function samplePermsOf(userId: string, role: string): Set<Feature> {
  loadSample()
  const base = new Set(role === 'manager' ? defaultsFor('manager') : (sampleRoles[role] ?? []))
  for (const e of sampleExceptions.filter((x) => x.profileId === userId)) {
    if (e.allowed) base.add(e.permission)
    else base.delete(e.permission)
  }
  return base
}

// ---------------------------------------------------------------- what I may do (one source)
type Who = Pick<StaffUser, 'id' | 'role' | 'dbRole'>
/** The database role (a sonographer is 'lab_tech' in the UI, not in the switches). */
const roleOf = (user: Who) => user.dbRole ?? user.role
const mineKey = (userId: string) => ['permissions', 'mine', userId] as const

async function readMine(user: Who): Promise<Set<Feature>> {
  if (!supabase) return samplePermsOf(user.id, roleOf(user))
  const { data, error } = await supabase.rpc('my_permissions')
  // before migration 0054: the defaults of the role
  if (error) return new Set(defaultsFor(roleOf(user)))
  return new Set(
    ((data ?? []) as string[]).filter((f): f is Feature =>
      (MANAGED_FEATURES as readonly string[]).includes(f),
    ),
  )
}

const sameSet = (a: Set<Feature>, b: Set<Feature>) =>
  a.size === b.size && [...a].every((f) => b.has(f))

/**
 * Reads the switches; when they changed (the manager switched one), the desks are read again
 * (reception, triage, the treating desks and the worklists follow some switches) and the signed-in
 * user is renewed, so every open screen draws its menu and home blocks again.
 */
async function fetchMine(user: Who): Promise<Set<Feature>> {
  const before = queryClient.getQueryData<Set<Feature>>(mineKey(user.id))
  const now = await readMine(user)
  const was = before ?? new Set(defaultsFor(roleOf(user)))
  if (!sameSet(was, now)) {
    if (before) void queryClient.invalidateQueries({ queryKey: ['desks', 'mine', user.id] })
    window.setTimeout(() => {
      const u = useSession.getState().user
      if (u && u.id === user.id) useSession.setState({ user: { ...u } })
    }, 0)
  }
  return now
}

const mineOptions = (user: Who) => ({
  queryKey: mineKey(user.id),
  queryFn: () => fetchMine(user),
})

/**
 * What the signed-in person may do among the managed features. Read again every minute and when
 * the tab comes back to the front, so a switch the manager changes reaches an open tab without
 * signing out (the staff area keeps one of these mounted: usePermissionsRefresh).
 */
export function useMyPermissions(user: StaffUser) {
  return useQuery({
    ...mineOptions(user),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })
}

/** Keeps the signed-in person's switches fresh while the staff area is open (routes/app). */
export function usePermissionsRefresh() {
  const user = useSession((s) => s.user)
  useQuery({
    ...mineOptions(user ?? { id: '', role: 'cashier' }),
    enabled: !!user,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })
}

/**
 * The person's switches read during render (menus, the desk rules), from the query cache: the
 * first time it is asked for, it is fetched (fetchMine then redraws the menus if they differ).
 * Until the first answer: the defaults of the role.
 */
export function permsNow(user: Who): Set<Feature> {
  queueMicrotask(() => {
    void queryClient.prefetchQuery({ ...mineOptions(user), staleTime: 30_000 })
  })
  return (
    queryClient.getQueryData<Set<Feature>>(mineKey(user.id)) ?? new Set(defaultsFor(roleOf(user)))
  )
}

/** The switches, waiting for the database the first time (a page guard after a reload). */
export async function permsReady(user: Who): Promise<Set<Feature>> {
  try {
    return await queryClient.ensureQueryData({ ...mineOptions(user), staleTime: 30_000 })
  } catch {
    return new Set(defaultsFor(roleOf(user)))
  }
}

/** can('payment.take'): true while loading if the role has it by default (no flicker). */
export function useCan(user: StaffUser) {
  const { data } = useMyPermissions(user)
  // while loading: the defaults of the person's database role (a sonographer is not a lab tech)
  return (f: Feature) => (data ? data.has(f) : DEFAULTS[f].includes(roleOf(user)))
}

/**
 * switchedOff('vitals.write'): the person's role normally does this, but the manager has not
 * allowed it now (for the role or for them). The screens then say so instead of staying silent.
 */
export function useSwitchedOff(user: StaffUser) {
  const can = useCan(user)
  return (f: Feature) => !can(f) && user.role !== 'manager' && roleHasByDefault(roleOf(user), f)
}

export function usePermissionMatrix() {
  return useQuery({
    queryKey: ['permissions', 'matrix'],
    queryFn: async (): Promise<PermissionMatrix> => {
      if (!supabase) {
        loadSample()
        return { roles: { ...sampleRoles }, exceptions: [...sampleExceptions] }
      }
      const { data, error } = await supabase.rpc('permission_matrix')
      if (error) throw apiError(error)
      const m = (data ?? {}) as Partial<PermissionMatrix>
      return { roles: m.roles ?? {}, exceptions: m.exceptions ?? [] }
    },
  })
}

export function usePermissionActions() {
  const qc = useQueryClient()
  // the switches of everyone (this tab too) and the desks that follow some of them
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['permissions'] })
    await qc.invalidateQueries({ queryKey: ['desks'] })
  }
  const setRole = useMutation({
    mutationFn: async (i: { role: DbRole; permission: Feature; allowed: boolean }) => {
      if (!supabase) {
        loadSample()
        const list = new Set(sampleRoles[i.role] ?? [])
        if (i.allowed) list.add(i.permission)
        else list.delete(i.permission)
        sampleRoles[i.role] = [...list]
        saveSample()
        return
      }
      const { error } = await supabase.rpc('set_role_permission', {
        p_role: i.role,
        p_permission: i.permission,
        p_allowed: i.allowed,
      })
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })
  /** allowed: true / false = an exception; null = as their role. */
  const setStaff = useMutation({
    mutationFn: async (i: {
      profileId: string
      name: string
      role: string
      permission: Feature
      allowed: boolean | null
    }) => {
      if (!supabase) {
        loadSample()
        const k = sampleExceptions.findIndex(
          (e) => e.profileId === i.profileId && e.permission === i.permission,
        )
        if (k >= 0) sampleExceptions.splice(k, 1)
        if (i.allowed !== null)
          sampleExceptions.push({
            profileId: i.profileId,
            name: i.name,
            role: i.role,
            permission: i.permission,
            allowed: i.allowed,
            at: new Date().toISOString(),
          })
        saveSample()
        return
      }
      const { error } = await supabase.rpc('set_staff_permission', {
        p_profile_id: i.profileId,
        p_permission: i.permission,
        p_allowed: i.allowed,
      })
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })
  return { setRole, setStaff }
}

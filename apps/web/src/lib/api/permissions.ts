import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { StaffUser } from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import type { DbRole } from './staff'

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
}
const defaultsFor = (role: string) => MANAGED_FEATURES.filter((f) => DEFAULTS[f].includes(role))

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

// sample mode: the defaults, changed in memory
const sampleRoles: Record<string, Feature[]> = Object.fromEntries(
  MATRIX_ROLES.map((r) => [r, defaultsFor(r)]),
)
const sampleExceptions: PermissionException[] = []

/** What the signed-in person may do among the managed features. */
export function useMyPermissions(user: StaffUser) {
  return useQuery({
    queryKey: ['permissions', 'mine', user.id],
    staleTime: 60_000,
    queryFn: async (): Promise<Set<Feature>> => {
      if (!supabase) {
        const own = sampleExceptions.filter((e) => e.profileId === user.id)
        const base = new Set(
          user.role === 'manager' ? defaultsFor('manager') : (sampleRoles[user.role] ?? []),
        )
        for (const e of own) {
          if (e.allowed) base.add(e.permission)
          else base.delete(e.permission)
        }
        return base
      }
      const { data, error } = await supabase.rpc('my_permissions')
      // before migration 0054: the defaults of the role
      if (error) return new Set(defaultsFor(user.role))
      return new Set((data ?? []) as Feature[])
    },
  })
}

/** can('payment.take'): true while loading if the role has it by default (no flicker). */
export function useCan(user: StaffUser) {
  const { data } = useMyPermissions(user)
  // while loading: the defaults of the person's database role (a sonographer is not a lab tech)
  return (f: Feature) => (data ? data.has(f) : DEFAULTS[f].includes(user.dbRole ?? user.role))
}

export function usePermissionMatrix() {
  return useQuery({
    queryKey: ['permissions', 'matrix'],
    queryFn: async (): Promise<PermissionMatrix> => {
      if (!supabase) return { roles: { ...sampleRoles }, exceptions: [...sampleExceptions] }
      const { data, error } = await supabase.rpc('permission_matrix')
      if (error) throw new Error(error.message)
      const m = (data ?? {}) as Partial<PermissionMatrix>
      return { roles: m.roles ?? {}, exceptions: m.exceptions ?? [] }
    },
  })
}

export function usePermissionActions() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['permissions'] })
  const setRole = useMutation({
    mutationFn: async (i: { role: DbRole; permission: Feature; allowed: boolean }) => {
      if (!supabase) {
        const list = new Set(sampleRoles[i.role] ?? [])
        if (i.allowed) list.add(i.permission)
        else list.delete(i.permission)
        sampleRoles[i.role] = [...list]
        return
      }
      const { error } = await supabase.rpc('set_role_permission', {
        p_role: i.role,
        p_permission: i.permission,
        p_allowed: i.allowed,
      })
      if (error) throw new Error(error.message)
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
        return
      }
      const { error } = await supabase.rpc('set_staff_permission', {
        p_profile_id: i.profileId,
        p_permission: i.permission,
        p_allowed: i.allowed,
      })
      if (error) throw new Error(error.message)
    },
    onSuccess: refresh,
  })
  return { setRole, setStaff }
}

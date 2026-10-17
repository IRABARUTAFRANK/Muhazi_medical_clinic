import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { STAFF } from '@mmc/shared'
import { supabase } from '@/lib/supabase'

/** All roles the database knows (doc §1.4); the UI has designed homes for five of them. */
export const DB_ROLES = [
  'receptionist',
  'cashier',
  'nurse',
  'doctor',
  'sonographer',
  'lab_tech',
  'pharmacist',
  'manager',
] as const
export type DbRole = (typeof DB_ROLES)[number]
export type DashboardRight = 'manager' | 'head' | null
export type DbLang = 'kin' | 'en' | 'fr'

export interface Employee {
  id: string
  /** MMC-S-0001, assigned by the database. */
  staffId: string | null
  email: string | null
  username: string
  fullName: string
  role: DbRole
  station: string | null
  dashboard: DashboardRight
  headOf: string | null
  language: DbLang
  phone: string | null
  active: boolean
  mustChangePin: boolean
  lastSignInAt: string | null
  createdAt: string
}

export interface NewEmployee {
  username: string
  fullName: string
  role: DbRole
  pin: string
  /** Where the sign-in code is sent. */
  email: string
  station?: string
  dashboard?: DashboardRight
  headOf?: string
  language?: DbLang
  phone?: string
}

export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/
export const PIN_RE = /^[0-9]{6}$/
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** Six random digits from the browser's CSPRNG. */
export function generatePin(): string {
  const bytes = new Uint32Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => String(b % 10)).join('')
}

/** "Uwimana Josiane" → "j.uwimana" (first initial of the given name + surname). */
export function suggestUsername(fullName: string): string {
  const parts = fullName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^dr\.?\s+/, '')
    .split(/\s+/)
    .filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]!.replace(/[^a-z0-9]/g, '')
  const [surname, ...given] = parts
  return `${given[0]!.charAt(0)}.${surname}`.replace(/[^a-z0-9._-]/g, '')
}

// ---------------------------------------------------------------- sample mode (no Supabase)
const sampleEmployees: Employee[] = STAFF.map((u, i) => ({
  id: u.id,
  staffId: u.staffId ?? null,
  email: u.email ?? null,
  username: u.username,
  fullName: u.name,
  role: u.role,
  station: u.station ?? null,
  dashboard: u.dashboard ?? null,
  headOf: u.headOf ?? null,
  language: 'kin',
  phone: null,
  active: true,
  mustChangePin: i === 3,
  lastSignInAt: i < 4 ? new Date(2026, 9, 15, 7 + i, 12).toISOString() : null,
  createdAt: new Date(2026, 8, 1).toISOString(),
}))

// ---------------------------------------------------------------- queries
const KEY = ['staff', 'employees'] as const

interface DirectoryRow {
  id: string
  staff_id: string | null
  email: string | null
  username: string
  full_name: string
  role: DbRole
  station: string | null
  dashboard: DashboardRight
  head_of: string | null
  language: DbLang
  phone: string | null
  active: boolean
  must_change_pin: boolean
  last_sign_in_at: string | null
  created_at: string
}

export function useEmployees() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<Employee[]> => {
      if (!supabase) return [...sampleEmployees]
      const { data, error } = await supabase.from('staff_directory').select('*').order('full_name')
      if (error) throw new Error(error.message)
      return (data as DirectoryRow[]).map((r) => ({
        id: r.id,
        staffId: r.staff_id,
        email: r.email,
        username: r.username,
        fullName: r.full_name,
        role: r.role,
        station: r.station,
        dashboard: r.dashboard,
        headOf: r.head_of,
        language: r.language,
        phone: r.phone,
        active: r.active,
        mustChangePin: r.must_change_pin,
        lastSignInAt: r.last_sign_in_at,
        createdAt: r.created_at,
      }))
    },
  })
}

async function callManageStaff<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase!.functions.invoke('manage-staff', { body })
  if (error) {
    // supabase-js wraps non-2xx responses; surface the function's message when present
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.json === 'function') {
      const payload = (await ctx.json().catch(() => null)) as { error?: string } | null
      if (payload?.error) throw new Error(payload.error)
    }
    throw new Error(error.message)
  }
  if (data && typeof data === 'object' && 'error' in data)
    throw new Error(String((data as { error: unknown }).error))
  return data as T
}

/** Manager actions. Live: Edge Function `manage-staff` (service role); sample: in-memory list. */
export function useStaffActions() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: KEY })

  const create = useMutation({
    mutationFn: async (
      input: NewEmployee,
    ): Promise<{ id: string; username: string; staff_id: string | null }> => {
      if (!USERNAME_RE.test(input.username)) throw new Error('username')
      if (!PIN_RE.test(input.pin)) throw new Error('pin')
      if (!EMAIL_RE.test(input.email)) throw new Error('email')
      if (!supabase) {
        if (sampleEmployees.some((e) => e.username === input.username))
          throw new Error('username taken')
        const id = `u-${Math.random().toString(36).slice(2, 8)}`
        const staffId = `MMC-S-${String(sampleEmployees.length + 1).padStart(4, '0')}`
        sampleEmployees.push({
          id,
          staffId,
          email: input.email,
          username: input.username,
          fullName: input.fullName,
          role: input.role,
          station: input.station ?? null,
          dashboard: input.dashboard ?? null,
          headOf: input.headOf ?? null,
          language: input.language ?? 'kin',
          phone: input.phone ?? null,
          active: true,
          mustChangePin: true,
          lastSignInAt: null,
          createdAt: new Date().toISOString(),
        })
        return { id, username: input.username, staff_id: staffId }
      }
      return callManageStaff({
        action: 'create',
        username: input.username,
        full_name: input.fullName,
        role: input.role,
        pin: input.pin,
        email: input.email,
        station: input.station ?? null,
        dashboard: input.dashboard ?? null,
        head_of: input.headOf ?? null,
        language: input.language ?? 'kin',
        phone: input.phone ?? null,
      })
    },
    onSuccess: refresh,
  })

  const resetPin = useMutation({
    mutationFn: async ({ id, pin }: { id: string; pin: string }) => {
      if (!PIN_RE.test(pin)) throw new Error('pin')
      if (!supabase) {
        const e = sampleEmployees.find((x) => x.id === id)
        if (e) e.mustChangePin = true
        return
      }
      await callManageStaff({ action: 'reset_pin', user_id: id, pin })
    },
    onSuccess: refresh,
  })

  const setActive = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      if (!supabase) {
        const e = sampleEmployees.find((x) => x.id === id)
        if (e) e.active = active
        return
      }
      await callManageStaff({ action: 'set_active', user_id: id, active })
    },
    onSuccess: refresh,
  })

  const setEmail = useMutation({
    mutationFn: async ({ id, email }: { id: string; email: string }) => {
      if (!EMAIL_RE.test(email)) throw new Error('email')
      if (!supabase) {
        const e = sampleEmployees.find((x) => x.id === id)
        if (e) e.email = email
        return
      }
      await callManageStaff({ action: 'set_email', user_id: id, email })
    },
    onSuccess: refresh,
  })

  return { create, resetPin, setActive, setEmail }
}

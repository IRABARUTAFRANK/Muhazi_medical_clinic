import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { STAFF } from '@mmc/shared'
import { isLive, supabase } from '@/lib/supabase'

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
export const POSITIONS = ['member', 'assistant', 'head'] as const
export type Position = (typeof POSITIONS)[number]

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
  /** Main department (the first of `departments`). */
  departmentId: string | null
  departmentName: string | null
  position: Position
  /** Every department of the employee with the position held there, main first. */
  departments: Membership[]
  /** Specialty or title shown with the role ("Minor surgery", "Midwife"). */
  specialty: string | null
  /** The temporary PIN the manager handed over, until the employee replaces it (managers only). */
  tempPin?: string | null
}

/** One department of an employee and the position held there (head of one, member of another). */
export interface Membership {
  departmentId: string
  departmentName: string
  position: Position
}

/** The position an employee holds in one department ('member' when not in it). */
export const positionIn = (e: Pick<Employee, 'departments'>, departmentId: string): Position =>
  e.departments.find((m) => m.departmentId === departmentId)?.position ?? 'member'

export interface Department {
  id: string
  name: string
  description: string | null
  roles: DbRole[]
}

/** What the manager fills in for an employee (new or edited). */
export interface EmployeeInput {
  fullName: string
  username: string
  email: string
  role: DbRole
  /** Every department with the position held there; the first is the main one. */
  departments: { departmentId: string; position: Position }[]
  station?: string
  language?: DbLang
  phone?: string
  specialty?: string
}

export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/
export const PIN_RE = /^[0-9]{6}$/
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

const rand = (n: number) => {
  const b = new Uint32Array(1)
  crypto.getRandomValues(b)
  return b[0]! % n
}

/** Six random digits from the browser's CSPRNG. */
export function generatePin(): string {
  return Array.from({ length: 6 }, () => String(rand(10))).join('')
}

const words = (fullName: string) =>
  fullName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^dr\.?\s+/, '')
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean)

/**
 * A username that still reads like the person's name but does not follow one fixed rule,
 * so it cannot be guessed from the name alone: the name parts, their order, how much of each
 * is kept, the separator and a two-digit number all vary. "John Doe" may give john.d42,
 * doej17, jo.doe58, doe_john09 or jdoe.73. Avoids names already in `taken`.
 */
export function suggestUsername(fullName: string, taken: ReadonlySet<string> = new Set()): string {
  const w = words(fullName)
  if (w.length === 0) return ''
  const a = w[0]!
  const b = w[1] ?? w[0]!
  const patterns: ((x: string, y: string) => string)[] = [
    (x, y) => `${x}.${y.charAt(0)}`,
    (x, y) => `${y}${x.charAt(0)}`,
    (x, y) => `${x.slice(0, 2)}.${y}`,
    (x, y) => `${y}_${x}`,
    (x, y) => `${x.charAt(0)}${y}.`,
    (x, y) => `${x.slice(0, 3)}${y.slice(0, 3)}`,
    (x, y) => `${y.slice(0, 4)}.${x.charAt(0)}`,
    (x, y) => `${x}-${y.slice(0, 2)}`,
  ]
  for (let attempt = 0; attempt < 40; attempt++) {
    const [x, y] = rand(2) ? [a, b] : [b, a]
    const base = patterns[rand(patterns.length)]!(x, y).slice(0, 26)
    const u = `${base}${String(rand(100)).padStart(2, '0')}`.replace(/\.\./g, '.')
    if (USERNAME_RE.test(u) && !taken.has(u)) return u
  }
  return `${a.slice(0, 20)}${String(rand(10000)).padStart(4, '0')}`
}

// ---------------------------------------------------------------- sample mode (no Supabase)
const sampleDepartments: Department[] = []
const sampleEmployees: Employee[] = STAFF.map((u, i) => ({
  id: u.id,
  specialty: u.role === 'doctor' ? 'General practitioner' : null,
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
  tempPin: i === 3 ? '482915' : null,
  lastSignInAt: i < 4 ? new Date(2026, 9, 15, 7 + i, 12).toISOString() : null,
  createdAt: new Date(2026, 8, 1).toISOString(),
  departmentId: null,
  departmentName: null,
  position: 'member',
  departments: [],
}))

// ---------------------------------------------------------------- queries
const KEY = ['staff', 'employees'] as const
const DEPT_KEY = ['staff', 'departments'] as const

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
  department_id: string | null
  department_name: string | null
  position: Position | null
  specialty?: string | null
  departments?: { id: string; name: string; position: Position }[] | null
}

export function useEmployees() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<Employee[]> => {
      if (!supabase) return [...sampleEmployees]
      const { data, error } = await supabase.from('staff_directory').select('*').order('full_name')
      if (error) throw new Error(error.message)
      // Managers can read the temporary PINs not yet replaced (empty for everyone else).
      const { data: temps } = await supabase.from('staff_temp_pin').select('user_id, pin')
      const tempOf = new Map(
        (temps ?? []).map((x: { user_id: string; pin: string }) => [x.user_id, x.pin]),
      )
      return (data as DirectoryRow[]).map((r) => ({
        tempPin: tempOf.get(r.id) ?? null,
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
        departmentId: r.department_id,
        departmentName: r.department_name,
        position: r.position ?? 'member',
        specialty: r.specialty ?? null,
        // Before migration 0051 only the main department exists.
        departments: r.departments
          ? r.departments.map((m) => ({
              departmentId: m.id,
              departmentName: m.name,
              position: m.position,
            }))
          : r.department_id
            ? [
                {
                  departmentId: r.department_id,
                  departmentName: r.department_name ?? '',
                  position: r.position ?? 'member',
                },
              ]
            : [],
      }))
    },
  })
}

export function useDepartments() {
  return useQuery({
    queryKey: DEPT_KEY,
    queryFn: async (): Promise<Department[]> => {
      if (!supabase) return [...sampleDepartments]
      const { data, error } = await supabase
        .from('department')
        .select('id, name, description, roles')
        .order('sort_order')
        .order('name')
      if (error) throw new Error(error.message)
      return (data as Department[]).map((d) => ({ ...d, roles: d.roles ?? [] }))
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

/** E-mails the signed-in manager a one-time code that confirms the next change. */
export async function sendConfirmCode(): Promise<{ to: string }> {
  if (!isLive) return { to: 'sample@example.com' }
  return callManageStaff<{ to: string }>({ action: 'send_code' })
}

const toBody = (e: EmployeeInput) => ({
  full_name: e.fullName.trim(),
  username: e.username.trim().toLowerCase(),
  email: e.email.trim().toLowerCase(),
  role: e.role,
  // main department (older function) and every department with its position
  department_id: e.departments[0]?.departmentId ?? null,
  position: e.departments[0]?.position ?? 'member',
  departments: e.departments.map((m) => ({ department_id: m.departmentId, position: m.position })),
  station: e.station?.trim() || null,
  language: e.language ?? 'kin',
  phone: e.phone?.trim() || null,
  specialty: e.specialty?.trim() || null,
})

/**
 * Manager actions. Live: Edge Function `manage-staff` (service role), every one confirmed with
 * a code e-mailed to the manager (`sendConfirmCode`, then `confirmCode`), checked on the server.
 * Sample mode: in-memory list, any six digits pass.
 */
const sampleMembers = (input: EmployeeInput): Membership[] =>
  input.departments.map((m) => ({
    ...m,
    departmentName: sampleDepartments.find((d) => d.id === m.departmentId)?.name ?? '',
  }))

export function useStaffActions() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['staff'] })
  const sampleCheck = (pin: string) => {
    if (!/^[0-9]{6,10}$/.test(pin)) throw new Error('confirm_code_wrong')
  }

  const create = useMutation({
    mutationFn: async ({
      input,
      pin,
      confirmCode,
    }: {
      input: EmployeeInput
      pin: string
      confirmCode: string
    }): Promise<{ id: string; username: string; staff_id: string | null }> => {
      if (!USERNAME_RE.test(input.username)) throw new Error('username')
      if (!PIN_RE.test(pin)) throw new Error('pin')
      if (!EMAIL_RE.test(input.email)) throw new Error('email')
      if (!supabase) {
        sampleCheck(confirmCode)
        if (sampleEmployees.some((e) => e.username === input.username))
          throw new Error('username taken')
        const id = `u-${Math.random().toString(36).slice(2, 8)}`
        const staffId = `MMC-S-${String(sampleEmployees.length + 1).padStart(4, '0')}`
        const members = sampleMembers(input)
        const head = members.find((m) => m.position === 'head')
        sampleEmployees.push({
          id,
          staffId,
          specialty: input.specialty?.trim() || null,
          email: input.email,
          username: input.username,
          fullName: input.fullName,
          role: input.role,
          station: input.station ?? null,
          dashboard: input.role === 'manager' ? 'manager' : head ? 'head' : null,
          headOf: head?.departmentName ?? null,
          language: input.language ?? 'kin',
          phone: input.phone ?? null,
          active: true,
          mustChangePin: true,
          lastSignInAt: null,
          createdAt: new Date().toISOString(),
          departmentId: members[0]?.departmentId ?? null,
          departmentName: members[0]?.departmentName ?? null,
          position: members[0]?.position ?? 'member',
          departments: members,
          tempPin: pin,
        })
        return { id, username: input.username, staff_id: staffId }
      }
      return callManageStaff({ action: 'create', ...toBody(input), pin, confirm_code: confirmCode })
    },
    onSuccess: refresh,
  })

  const update = useMutation({
    mutationFn: async ({
      id,
      input,
      confirmCode,
    }: {
      id: string
      input: EmployeeInput
      confirmCode: string
    }) => {
      if (!USERNAME_RE.test(input.username)) throw new Error('username')
      if (!EMAIL_RE.test(input.email)) throw new Error('email')
      if (!supabase) {
        sampleCheck(confirmCode)
        const e = sampleEmployees.find((x) => x.id === id)
        const members = sampleMembers(input)
        if (e)
          Object.assign(e, {
            fullName: input.fullName,
            username: input.username,
            email: input.email,
            role: input.role,
            departmentId: members[0]?.departmentId ?? null,
            departmentName: members[0]?.departmentName ?? null,
            position: members[0]?.position ?? 'member',
            departments: members,
            specialty: input.specialty?.trim() || null,
            station: input.station ?? null,
            language: input.language ?? 'kin',
            phone: input.phone ?? null,
          })
        return
      }
      await callManageStaff({
        action: 'update',
        user_id: id,
        ...toBody(input),
        confirm_code: confirmCode,
      })
    },
    onSuccess: refresh,
  })

  // No e-mailed code for a reset: the PIN is temporary and must be replaced at the next sign-in.
  const resetPin = useMutation({
    mutationFn: async ({ id, pin }: { id: string; pin: string }) => {
      if (!PIN_RE.test(pin)) throw new Error('pin')
      if (!supabase) {
        const e = sampleEmployees.find((x) => x.id === id)
        if (e) Object.assign(e, { mustChangePin: true, tempPin: pin })
        return
      }
      await callManageStaff({ action: 'reset_pin', user_id: id, pin })
    },
    onSuccess: refresh,
  })

  const setActive = useMutation({
    mutationFn: async ({
      id,
      active,
      confirmCode,
    }: {
      id: string
      active: boolean
      confirmCode: string
    }) => {
      if (!supabase) {
        sampleCheck(confirmCode)
        const e = sampleEmployees.find((x) => x.id === id)
        if (e) e.active = active
        return
      }
      await callManageStaff({
        action: 'set_active',
        user_id: id,
        active,
        confirm_code: confirmCode,
      })
    },
    onSuccess: refresh,
  })

  return { create, update, resetPin, setActive }
}

/** Manager: departments (name, description, which roles belong). */
export function useDepartmentActions() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['staff'] })
  const save = useMutation({
    mutationFn: async (d: { id?: string; name: string; description: string; roles: DbRole[] }) => {
      if (!supabase) {
        const existing = d.id ? sampleDepartments.find((x) => x.id === d.id) : undefined
        if (existing)
          Object.assign(existing, { name: d.name, description: d.description, roles: d.roles })
        else
          sampleDepartments.push({
            id: `d-${Math.random().toString(36).slice(2, 8)}`,
            name: d.name,
            description: d.description || null,
            roles: d.roles,
          })
        return
      }
      const { error } = await supabase.rpc('upsert_department', {
        p_id: d.id ?? null,
        p_name: d.name,
        p_description: d.description,
        p_roles: d.roles,
      })
      if (error) throw new Error(error.message)
    },
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: async (id: string) => {
      if (!supabase) {
        const i = sampleDepartments.findIndex((x) => x.id === id)
        if (i >= 0) sampleDepartments.splice(i, 1)
        return
      }
      const { error } = await supabase.rpc('delete_department', { p_id: id })
      if (error) throw new Error(error.message)
    },
    onSuccess: refresh,
  })
  return { save, remove }
}

/** The signed-in employee's departments (empty = none: they see every treatment). */
export function useMyDepartments(userId: string) {
  return useQuery({
    queryKey: ['my-departments', userId],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<{ id: string; name: string; position?: string | null }[]> => {
      if (!supabase) return []
      const { data, error } = await supabase.rpc('my_placement')
      if (error) throw new Error(error.message)
      const d = (data ?? {}) as {
        departmentId?: string | null
        department?: string | null
        position?: string | null
        departments?: { id: string; name: string; position?: string | null }[]
      }
      if (d.departments)
        return d.departments.map((x) => ({ id: x.id, name: x.name, position: x.position ?? null }))
      return d.departmentId
        ? [{ id: d.departmentId, name: d.department ?? '', position: d.position ?? null }]
        : []
    },
  })
}

/** The departments this person leads (head or assistant): where a non-manager may write. */
export function useLeadDepartments(user: { id: string }) {
  const { data = [] } = useMyDepartments(user.id)
  return data.filter((d) => d.position === 'head' || d.position === 'assistant')
}

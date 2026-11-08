import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { STAFF } from '@mmc/shared'
import i18n from '@/i18n'
import { isLive, reportSessionRefused, supabase } from '@/lib/supabase'
import { apiError } from './errors'

/** All roles the database knows (doc §1.4); the UI has designed homes for five of them. 0128: the
 *  role is the PROFESSION; 'manager' stays for accounts of a database before 0128 only (the clinic
 *  manager is a flag, Employee.isManager). */
export const DB_ROLES = [
  'receptionist',
  'cashier',
  'nurse',
  'midwife',
  'doctor',
  'sonographer',
  'lab_tech',
  'pharmacist',
  'administrator',
  'manager',
] as const
export type DbRole = (typeof DB_ROLES)[number]
/** The professions offered in the employee form and the departments (0128): every role but the
 *  old 'manager'. */
export const PROFESSIONS: readonly Exclude<DbRole, 'manager'>[] = DB_ROLES.filter(
  (r): r is Exclude<DbRole, 'manager'> => r !== 'manager',
)
export type Profession = Exclude<DbRole, 'manager'>
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
  /** When the account was deactivated (null while active). */
  deactivatedAt: string | null
  /** Main department (the first of `departments`). */
  departmentId: string | null
  departmentName: string | null
  position: Position
  /** Every department of the employee with the position held there, main first. */
  departments: Membership[]
  /** Specialty or title shown with the role ("Minor surgery", "Midwife"). */
  specialty: string | null
  /** Professional council registration number, printed on prescriptions (0084; null before). */
  registrationNo: string | null
  /** The council that registered the person (RMDC, NCNM, NPC, RAHPC…). */
  registrationBody: string | null
  /** 0126: marked a doctor by the manager (sees patient records; the role 'doctor' is one anyway). */
  isDoctor?: boolean
  /** 0128: also the clinic manager (the role 'manager' of a database before 0128 counts too). */
  isManager: boolean
  /** The desks the person may use now (0085: the role's ceiling and their departments). Null
   *  before 0085 and in sample mode: compute them with desksFor (lib/api/desks). */
  desks?: string[] | null
  /** The desks kept on day one by the rule of before, until the manager places the person in a
   *  department giving them (0085; null before and in sample mode). */
  keptDesks?: string[] | null
  /** The temporary PIN the manager handed over, until the employee replaces it (managers only). */
  tempPin?: string | null
}

/** One department of an employee and the position held there (head of one, member of another). */
export interface Membership {
  departmentId: string
  departmentName: string
  position: Position
  /** 0128: the department's services this person does there ("Does here"); null before 0128
   *  (then: all the department's services). */
  services: string[] | null
  /** 0141: appointed the doctor of this department by the manager. */
  doctorHere?: boolean
}

/** What the person does in a department now: the ticked services the department still gives
 *  (all of them before 0128). */
export const doesIn = (
  m: Pick<Membership, 'services'>,
  d: Pick<Department, 'services'>,
): string[] =>
  m.services === null ? [...d.services] : d.services.filter((s) => m.services!.includes(s))

/** May this profession (and the manager flag) be placed in the department? A department with no
 *  profession ticked takes every one; one that still lists 'manager' (before 0128) takes the clinic
 *  managers. */
export const takesProfession = (
  d: Pick<Department, 'roles'>,
  role: DbRole,
  isManager = false,
): boolean =>
  d.roles.length === 0 || d.roles.includes(role) || (isManager && d.roles.includes('manager'))

/** The position an employee holds in one department ('member' when not in it). */
export const positionIn = (e: Pick<Employee, 'departments'>, departmentId: string): Position =>
  e.departments.find((m) => m.departmentId === departmentId)?.position ?? 'member'

export interface Department {
  id: string
  name: string
  description: string | null
  roles: DbRole[]
  /** The clinic's services given here (and 'triage'): its people take the patients sent there. */
  services: string[]
}

/** What the manager fills in for an employee (new or edited). */
export interface EmployeeInput {
  fullName: string
  username: string
  email: string
  role: DbRole
  /** 0128: "also the clinic manager". */
  isManager?: boolean
  /** Every department with the position held there and what the person does there (0128); the
   *  first is the main one. */
  departments: {
    departmentId: string
    position: Position
    services?: string[]
    /** 0141: "Works as the doctor here" (saved after the employee, by the manager). */
    doctorHere?: boolean
  }[]
  station?: string
  language?: DbLang
  phone?: string
  specialty?: string
  /** Professional registration number; left out (undefined) = unchanged, '' = cleared. */
  registrationNo?: string
  /** The council (RMDC, NCNM, NPC, RAHPC…); left out = unchanged, '' = cleared. */
  registrationBody?: string
}

/** The professional councils of Rwanda (suggestions for the employee form). */
export const REGISTRATION_BODIES = ['RMDC', 'NCNM', 'NPC', 'RAHPC'] as const

/** "RMDC 2017/0458": the council and the number as a document prints them (null when none). */
export const registrationText = (
  p: { registrationNo?: string | null; registrationBody?: string | null } | null | undefined,
): string | null => {
  const no = p?.registrationNo?.trim()
  if (!no) return null
  const body = p?.registrationBody?.trim()
  return body && !no.toUpperCase().startsWith(body.toUpperCase()) ? `${body} ${no}` : no
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
/** 0128: one sample department giving two services: the dentist (its head) does dental only, the
 *  general doctor and the doctor-manager consultation only ("Does here"). */
const sampleDepartments: Department[] = [
  {
    id: 'd-dental',
    name: 'Dental',
    description: 'Dental care and general consultations',
    roles: ['doctor', 'nurse'],
    services: ['consultation', 'dental'],
  },
]
/** The sample placements (0128): who does what in the Dental department. */
const SAMPLE_PLACEMENTS: Record<string, { position: Position; services: string[] }> = {
  'u-head': { position: 'head', services: ['dental'] },
  'u-doc': { position: 'member', services: ['consultation'] },
  'u-mgr': { position: 'member', services: ['consultation'] },
}
/** Sample registrations by role (realistic council numbers). */
const SAMPLE_REGISTRATION: Partial<Record<DbRole, [string, string]>> = {
  doctor: ['RMDC', '2017/0458'],
  nurse: ['NCNM', '2019/1123'],
  pharmacist: ['NPC', '2020/0311'],
  lab_tech: ['RAHPC', '2018/0790'],
  sonographer: ['RAHPC', '2021/0154'],
}
const sampleEmployees: Employee[] = STAFF.map((u, i) => {
  // 0128: the profession (the sample manager is a doctor), and the manager flag
  const role = (u.dbRole ?? u.role) as DbRole
  const placed = SAMPLE_PLACEMENTS[u.id]
  const members: Membership[] = placed
    ? [
        {
          departmentId: 'd-dental',
          departmentName: 'Dental',
          position: placed.position,
          services: placed.services,
        },
      ]
    : []
  return {
    id: u.id,
    specialty: role === 'doctor' ? (u.id === 'u-head' ? 'Dentist' : 'General practitioner') : null,
    registrationBody: SAMPLE_REGISTRATION[role]?.[0] ?? null,
    registrationNo: SAMPLE_REGISTRATION[role]?.[1] ?? null,
    isDoctor: !!u.isDoctor || role === 'doctor',
    isManager: !!u.isManager,
    staffId: u.staffId ?? null,
    email: u.email ?? null,
    username: u.username,
    fullName: u.name,
    role,
    station: u.station ?? null,
    dashboard: u.dashboard ?? null,
    headOf: u.headOf ?? null,
    language: 'kin',
    phone: null,
    active: true,
    mustChangePin: i === 3,
    tempPin: i === 3 ? '482915' : null,
    lastSignInAt: i < 4 ? new Date(2026, 9, 15, 7 + i, 12).toISOString() : null,
    deactivatedAt: null,
    createdAt: new Date(2026, 8, 1).toISOString(),
    departmentId: members[0]?.departmentId ?? null,
    departmentName: members[0]?.departmentName ?? null,
    position: members[0]?.position ?? 'member',
    departments: members,
  }
})
/** Sample mode: the departments and the employees as saved in memory (read by lib/api/desks). */
export const sampleStaffData = (): {
  departments: readonly Department[]
  employees: readonly Employee[]
} => ({ departments: sampleDepartments, employees: sampleEmployees })

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
  deactivated_at?: string | null
  department_id: string | null
  department_name: string | null
  position: Position | null
  specialty?: string | null
  departments?:
    | {
        id: string
        name: string
        position: Position
        services?: string[] | null
        doctorHere?: boolean | null
      }[]
    | null
  /** 0084 (absent before). */
  registration_no?: string | null
  registration_body?: string | null
  /** 0126 (absent before). */
  is_doctor?: boolean | null
  /** 0128 (absent before). */
  is_manager?: boolean | null
  /** 0085 (absent before). */
  desks?: string[] | null
  kept_desks?: string[] | null
}

export function useEmployees() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<Employee[]> => {
      if (!supabase) return [...sampleEmployees]
      const { data, error } = await supabase.from('staff_directory').select('*').order('full_name')
      if (error) throw apiError(error)
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
        deactivatedAt: r.deactivated_at ?? null,
        departmentId: r.department_id,
        departmentName: r.department_name,
        position: r.position ?? 'member',
        specialty: r.specialty ?? null,
        registrationNo: r.registration_no ?? null,
        registrationBody: r.registration_body ?? null,
        isDoctor: r.is_doctor ?? false,
        // 0128: the flag; before it, the role 'manager'
        isManager: typeof r.is_manager === 'boolean' ? r.is_manager : r.role === 'manager',
        desks: r.desks ?? null,
        keptDesks: r.kept_desks ?? null,
        // Before migration 0051 only the main department exists.
        departments: r.departments
          ? r.departments.map((m) => ({
              departmentId: m.id,
              departmentName: m.name,
              position: m.position,
              services: Array.isArray(m.services) ? m.services : null,
              doctorHere: m.doctorHere === true,
            }))
          : r.department_id
            ? [
                {
                  departmentId: r.department_id,
                  departmentName: r.department_name ?? '',
                  position: r.position ?? 'member',
                  services: null,
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
      const read = (cols: string) =>
        supabase!.from('department').select(cols).order('sort_order').order('name')
      let { data, error } = await read('id, name, description, roles, services')
      // before migration 0071 departments have no services
      if (error) ({ data, error } = await read('id, name, description, roles'))
      if (error) throw apiError(error)
      return (data as unknown as Department[]).map((d) => ({
        ...d,
        roles: d.roles ?? [],
        services: d.services ?? [],
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
      const payload = (await ctx.json().catch(() => null)) as {
        error?: string
        reason?: string
      } | null
      // The sign-in is not approved by the database (0081): the tab signs out and the login
      // page explains it, instead of showing the function's English message.
      if (ctx.status === 401 && payload?.reason) {
        reportSessionRefused(payload.reason)
        throw new Error(i18n.t('login.ended.security'))
      }
      if (payload?.error) throw new Error(payload.error)
    }
    throw apiError(error)
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
  // 0128: "also the clinic manager" (left out: unchanged)
  ...(e.isManager !== undefined && { is_manager: e.isManager }),
  // main department (older function) and every department with its position and what the person
  // does there (0128)
  department_id: e.departments[0]?.departmentId ?? null,
  position: e.departments[0]?.position ?? 'member',
  departments: e.departments.map((m) => ({
    department_id: m.departmentId,
    position: m.position,
    ...(m.services && { services: m.services }),
  })),
  station: e.station?.trim() || null,
  language: e.language ?? 'kin',
  phone: e.phone?.trim() || null,
  specialty: e.specialty?.trim() || null,
  // left out when the form does not carry them: the function keeps what is saved
  ...(e.registrationNo !== undefined && { registration_no: e.registrationNo.trim() || null }),
  ...(e.registrationBody !== undefined && {
    registration_body: e.registrationBody.trim() || null,
  }),
})

/**
 * Manager actions. Live: Edge Function `manage-staff` (service role), every one confirmed with
 * a code e-mailed to the manager (`sendConfirmCode`, then `confirmCode`), checked on the server.
 * Sample mode: in-memory list, any six digits pass.
 */
const sampleMembers = (input: EmployeeInput): Membership[] =>
  input.departments.map((m) => ({
    departmentId: m.departmentId,
    position: m.position,
    departmentName: sampleDepartments.find((d) => d.id === m.departmentId)?.name ?? '',
    services:
      m.services ?? sampleDepartments.find((d) => d.id === m.departmentId)?.services ?? null,
  }))

export function useStaffActions() {
  const qc = useQueryClient()
  const refresh = () => {
    // the documents read the person's own registration (useMyCredentials)
    void qc.invalidateQueries({ queryKey: ['my-credentials'] })
    return qc.invalidateQueries({ queryKey: ['staff'] })
  }
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
          registrationNo: input.registrationNo?.trim() || null,
          registrationBody: input.registrationBody?.trim() || null,
          email: input.email,
          username: input.username,
          fullName: input.fullName,
          role: input.role,
          isManager: !!input.isManager,
          isDoctor: input.role === 'doctor',
          station: input.station ?? null,
          dashboard: input.isManager ? 'manager' : head ? 'head' : null,
          headOf: head?.departmentName ?? null,
          language: input.language ?? 'kin',
          phone: input.phone ?? null,
          active: true,
          mustChangePin: true,
          lastSignInAt: null,
          createdAt: new Date().toISOString(),
          deactivatedAt: null,
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

  /** 0141: the manager appoints (or stops) the doctor of a department. */
  const setDoctorHere = useMutation({
    mutationFn: async ({
      profileId,
      departmentId,
      on,
    }: {
      profileId: string
      departmentId: string
      on: boolean
    }) => {
      if (!supabase) {
        const e = sampleEmployees.find((x) => x.id === profileId)
        const m = e?.departments.find((x) => x.departmentId === departmentId)
        if (!e || !m) throw new Error('not_found')
        m.doctorHere = on
        e.isDoctor = e.role === 'doctor' || e.departments.some((x) => x.doctorHere)
        return
      }
      const { error } = await supabase.rpc('set_staff_doctor_here', {
        p_profile_id: profileId,
        p_department_id: departmentId,
        p_on: on,
      })
      if (error) throw apiError(error)
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
            ...(input.isManager !== undefined && {
              isManager: input.isManager,
              dashboard: input.isManager
                ? 'manager'
                : members.some((m) => m.position === 'head')
                  ? 'head'
                  : null,
            }),
            isDoctor: input.role === 'doctor' || !!e.isDoctor,
            departmentId: members[0]?.departmentId ?? null,
            departmentName: members[0]?.departmentName ?? null,
            position: members[0]?.position ?? 'member',
            departments: members,
            specialty: input.specialty?.trim() || null,
            ...(input.registrationNo !== undefined && {
              registrationNo: input.registrationNo.trim() || null,
            }),
            ...(input.registrationBody !== undefined && {
              registrationBody: input.registrationBody.trim() || null,
            }),
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

  /**
   * Delete for good: the sign-in goes, the username and e-mail become free; the person's name
   * stays on the clinic's records (migration 0076).
   */
  const remove = useMutation({
    mutationFn: async ({ id, confirmCode }: { id: string; confirmCode: string }) => {
      if (!supabase) {
        sampleCheck(confirmCode)
        const i = sampleEmployees.findIndex((x) => x.id === id)
        if (i >= 0) sampleEmployees.splice(i, 1)
        return
      }
      await callManageStaff({ action: 'delete', user_id: id, confirm_code: confirmCode })
    },
    onSuccess: refresh,
  })

  return { create, update, resetPin, setActive, remove, setDoctorHere }
}

/**
 * The managers' reminder: accounts deactivated for a month or more become a notice, once (the
 * database keeps track). Asked once per page opening.
 */
export function useDeactivationReminders(enabled: boolean) {
  const asked = useRef(false)
  const qc = useQueryClient()
  useEffect(() => {
    if (!enabled || asked.current || !supabase) return
    asked.current = true
    void supabase.rpc('deactivation_reminders').then(({ data }) => {
      if (Number(data) > 0) void qc.invalidateQueries({ queryKey: ['notifications'] })
    })
  }, [enabled, qc])
}

/** Manager: departments (name, description, which roles belong). */
export function useDepartmentActions() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['staff'] })
  const save = useMutation({
    mutationFn: async (d: {
      id?: string
      name: string
      description: string
      roles: DbRole[]
      services: string[]
    }) => {
      if (!supabase) {
        const existing = d.id ? sampleDepartments.find((x) => x.id === d.id) : undefined
        // 0129: a service the department starts giving is ticked for nobody; the manager ticks it
        // person by person (Does here)
        if (existing)
          Object.assign(existing, {
            name: d.name,
            description: d.description,
            roles: d.roles,
            services: d.services,
          })
        else
          sampleDepartments.push({
            id: `d-${Math.random().toString(36).slice(2, 8)}`,
            name: d.name,
            description: d.description || null,
            roles: d.roles,
            services: d.services,
          })
        return
      }
      const args = {
        p_id: d.id ?? null,
        p_name: d.name,
        p_description: d.description,
        p_roles: d.roles,
      }
      let { error } = await supabase.rpc('upsert_department', { ...args, p_services: d.services })
      // before migration 0071 the department has no services
      if (error && /function|schema cache/i.test(error.message))
        ({ error } = await supabase.rpc('upsert_department', args))
      if (error) throw apiError(error)
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
      if (error) throw apiError(error)
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
      if (error) throw apiError(error)
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

/** What deleting someone would touch right now (migration 0078), for the delete panel. */
export interface RetirePreview {
  /** Notices and messages addressed to them: deleted with the account. */
  notices: number
  /** Appointments booked with their calendar from today on: they stay booked, to be moved. */
  upcomingAppointments: number
  /** Patients waiting for them, taken by them or coming back to them. */
  waitingPatients: number
  openTasks: number
}

/** The counts for the delete panel; null when the database does not have them yet (before 0078). */
export function useRetirePreview(profileId: string | null) {
  return useQuery({
    queryKey: ['staff', 'retire-preview', profileId],
    enabled: !!profileId,
    queryFn: async (): Promise<RetirePreview | null> => {
      if (!supabase)
        return { notices: 4, upcomingAppointments: 2, waitingPatients: 1, openTasks: 0 }
      const { data, error } = await supabase.rpc('retire_staff_preview', {
        p_profile_id: profileId,
      })
      if (error) {
        if (/function|schema cache/i.test(error.message)) return null
        throw apiError(error)
      }
      const d = (data ?? {}) as Partial<RetirePreview>
      return {
        notices: Number(d.notices ?? 0),
        upcomingAppointments: Number(d.upcomingAppointments ?? 0),
        waitingPatients: Number(d.waitingPatients ?? 0),
        openTasks: Number(d.openTasks ?? 0),
      }
    },
  })
}

/** What a document prints about the signed-in person (prescriber, author, dispenser). */
export interface MyCredentials {
  specialty: string | null
  registrationNo: string | null
  registrationBody: string | null
}

/**
 * The signed-in person's specialty and professional registration (0084, `my_placement`), for the
 * documents they sign. Before 0084 the registration is null (the document prints a ruled blank).
 */
export function useMyCredentials(userId: string) {
  return useQuery({
    queryKey: ['my-credentials', userId],
    staleTime: 5 * 60_000,
    enabled: !!userId,
    queryFn: async (): Promise<MyCredentials> => {
      if (!supabase) {
        const e = sampleEmployees.find((x) => x.id === userId)
        return {
          specialty: e?.specialty ?? null,
          registrationNo: e?.registrationNo ?? null,
          registrationBody: e?.registrationBody ?? null,
        }
      }
      const { data, error } = await supabase.rpc('my_placement')
      if (error) throw apiError(error)
      const d = (data ?? {}) as {
        specialty?: string | null
        registrationNo?: string | null
        registrationBody?: string | null
      }
      return {
        specialty: d.specialty ?? null,
        registrationNo: d.registrationNo ?? null,
        registrationBody: d.registrationBody ?? null,
      }
    },
  })
}

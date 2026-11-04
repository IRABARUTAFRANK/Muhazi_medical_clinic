import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { STAFF } from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { apiError } from './errors'
import { sampleStaffData } from './staff'

/**
 * The employee's profile (0125), like the patient's file: identity, role, departments, desks,
 * council registration, contact and personnel details (emergency contact, address, birth date,
 * national ID, date hired, contract), access (rights, exceptions, trusted browsers, sign-ins),
 * documents and, for the manager only, private dated notes. The manager reads anyone's (each
 * look is logged) and writes the personnel details; an employee reads their own. Live:
 * `staff_profile`, `save_staff_profile`, `add_staff_note`, `remove_staff_note`.
 */

export const CONTRACT_TYPES = ['permanent', 'contract', 'intern', 'volunteer'] as const
export type ContractType = (typeof CONTRACT_TYPES)[number]
export const NOTE_KINDS = ['note', 'warning', 'training', 'leave', 'praise'] as const
export type NoteKind = (typeof NOTE_KINDS)[number]
/** The rights the manager switches per person (Settings › Who may do what). */
export const MANAGED_PERMISSIONS = [
  'payment.take',
  'visit.start',
  'vitals.write',
  'charge.write',
  'clinical.write',
  'orders.write',
  'appointment.approve',
  'stock.write',
  'records.approve',
  'stock.sell_walkin',
] as const

export interface StaffHr {
  emergencyName: string | null
  emergencyPhone: string | null
  address: string | null
  birthDate: string | null
  sex: 'female' | 'male' | null
  nationalId: string | null
  hiredOn: string | null
  contractType: ContractType | null
  contractEnd: string | null
  registrationExpiresOn: string | null
  updatedAt: string | null
  updatedBy: string | null
}
export interface StaffPermission {
  key: string
  allowed: boolean
  /** The role gives it (without an exception). */
  byRole: boolean
  /** The manager set it for this person (an exception). */
  exception: boolean
  setAt: string | null
  setBy: string | null
}
export interface StaffNote {
  id: string
  kind: NoteKind
  body: string
  notedOn: string
  at: string
  by: string | null
}
export interface StaffProfile {
  id: string
  fullName: string
  username: string
  staffId: string | null
  role: string
  specialty: string | null
  station: string | null
  dashboard: string | null
  email: string | null
  phone: string | null
  language: string | null
  active: boolean
  deactivatedAt: string | null
  createdAt: string
  createdBy: string | null
  lastSignInAt: string | null
  mustChangePin: boolean
  pinChangedAt: string | null
  registrationNo: string | null
  registrationBody: string | null
  /** 0126: a doctor sees patient records: the role 'doctor', or marked by the manager. */
  isDoctor?: boolean
  /** 0126: marked a doctor by the manager (set_staff_doctor; kept for the rows marked before 0128). */
  doctorMarked?: boolean
  /** 0128: also the clinic manager. */
  isManager?: boolean
  /** Each department, the position, what the person does there (services, 0128) among what it
   *  gives. */
  departments: {
    id: string
    name: string
    position: 'member' | 'assistant' | 'head'
    services?: string[] | null
    gives?: string[] | null
  }[]
  desks: string[]
  hr: StaffHr
  access: {
    permissions: StaffPermission[]
    trustedDevices: number
    signIns: { at: string; ok: boolean; reason: string | null }[]
    failedSignIns30: number
  }
  documents: { count: number; expired: number; expiring: number }
  /** The manager only (null for the employee). */
  notes: StaffNote[] | null
  removedNotes: number | null
  canEdit: boolean
  self: boolean
  /** A database before 0125: the profile is built from the Employees list. */
  missing?: boolean
}

export interface StaffHrInput {
  phone: string
  emergencyName: string
  emergencyPhone: string
  address: string
  birthDate: string
  sex: '' | 'female' | 'male'
  nationalId: string
  hiredOn: string
  contractType: '' | ContractType
  contractEnd: string
  registrationExpiresOn: string
}

// ---------------------------------------------------------------- sample mode
const ago = (days: number, h = 9) => {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(h, 12, 0, 0)
  return d.toISOString()
}
const ymd = (years: number, m: number, d: number) => {
  const x = new Date()
  return `${x.getFullYear() + years}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
const sampleHr = new Map<string, StaffHr>()
const sampleNotes = new Map<string, StaffNote[]>()
const samplePhones = new Map<string, string | null>()
/** 0126: the doctor marks set in this tab (0128: the sample manager is a doctor by profession). */
const sampleDoctorMarks = new Map<string, { on: boolean; no: string | null; body: string | null }>()

function sampleProfile(id: string): StaffProfile {
  const me = useSession.getState().user
  const manager = me?.role === 'manager'
  if (!manager && id !== me?.id)
    throw apiError({
      code: '42501',
      message: 'not allowed: an employee sees only their own profile',
    })
  const s = STAFF.find((x) => x.id === id)
  const e = sampleStaffData().employees.find((x) => x.id === id)
  const name = s?.name ?? e?.fullName ?? 'Employee'
  const role = s?.dbRole ?? s?.role ?? e?.role ?? 'nurse'
  const doctor = role === 'doctor'
  const mark = sampleDoctorMarks.get(id)
  const hr =
    sampleHr.get(id) ??
    ({
      emergencyName: 'Mukamana Jeanne (sister)',
      emergencyPhone: '0788 551 204',
      address: 'Kayonza, Mukarange, Bwiza',
      birthDate: '1989-04-17',
      sex: role === 'nurse' || name.includes('Béatrice') ? 'female' : 'male',
      nationalId: '1 1989 7 0012345 0 21',
      hiredOn: '2023-02-01',
      contractType: doctor ? 'contract' : 'permanent',
      contractEnd: doctor ? ymd(1, 1, 31) : null,
      registrationExpiresOn: doctor ? ymd(0, 12, 31) : null,
      updatedAt: ago(20),
      updatedBy: 'Mugabo Théogène',
    } satisfies StaffHr)
  if (!sampleNotes.has(id))
    sampleNotes.set(id, [
      {
        id: `${id}-n1`,
        kind: 'training',
        body: 'Completed the IMCI refresher (3 days) at Rwinkwavu hospital.',
        notedOn: ago(30).slice(0, 10),
        at: ago(30),
        by: 'Mugabo Théogène',
      },
      {
        id: `${id}-n2`,
        kind: 'leave',
        body: 'Annual leave from 2 to 13 December approved.',
        notedOn: ago(12).slice(0, 10),
        at: ago(12),
        by: 'Mugabo Théogène',
      },
    ])
  const roleRights: Record<string, string[]> = {
    doctor: ['visit.start', 'vitals.write', 'charge.write', 'clinical.write', 'orders.write'],
    nurse: ['visit.start', 'vitals.write', 'charge.write', 'clinical.write'],
    receptionist: ['payment.take', 'visit.start', 'vitals.write', 'appointment.approve'],
    cashier: ['payment.take'],
    manager: [...MANAGED_PERMISSIONS],
  }
  const rights = roleRights[role] ?? []
  return {
    id,
    fullName: name,
    username: s?.username ?? e?.username ?? 'staff',
    staffId: s?.staffId ?? e?.staffId ?? null,
    role,
    specialty:
      e?.specialty ?? (doctor ? 'General practitioner' : mark?.on ? 'General doctor' : null),
    station: s?.station ?? null,
    dashboard: s?.dashboard ?? null,
    email: s?.email ?? e?.email ?? null,
    phone: samplePhones.has(id) ? (samplePhones.get(id) ?? null) : '0788 300 112',
    language: 'kin',
    active: true,
    deactivatedAt: null,
    createdAt: '2023-02-01T08:00:00.000Z',
    createdBy: 'Mugabo Théogène',
    lastSignInAt: ago(0, 7),
    mustChangePin: false,
    pinChangedAt: ago(90),
    registrationNo:
      mark?.no ?? (doctor ? 'RMDC/A/2019/0457' : role === 'nurse' ? 'NCNM/RN/2018/1120' : null),
    registrationBody: mark?.body ?? (doctor ? 'RMDC' : role === 'nurse' ? 'NCNM' : null),
    isDoctor: doctor || !!mark?.on,
    doctorMarked: !!mark?.on,
    isManager: !!(e?.isManager ?? s?.isManager),
    // 0128: the sample departments with what the person does there
    departments: e?.departments.length
      ? e.departments.map((m) => {
          const gives =
            sampleStaffData().departments.find((d) => d.id === m.departmentId)?.services ?? []
          return {
            id: m.departmentId,
            name: m.departmentName,
            position: m.position,
            services: m.services ?? gives,
            gives,
          }
        })
      : doctor
        ? [{ id: 'd-opd', name: 'Outpatient consultation', position: 'member' }]
        : role === 'nurse'
          ? [{ id: 'd-nur', name: 'Nursing', position: 'head' }]
          : [],
    desks: doctor ? ['consultation'] : role === 'nurse' ? ['triage', 'nursing'] : [],
    hr,
    access: {
      permissions: MANAGED_PERMISSIONS.map((k) => {
        const exception = doctor && k === 'appointment.approve'
        return {
          key: k,
          allowed: rights.includes(k) || exception,
          byRole: rights.includes(k),
          exception,
          setAt: exception ? ago(40) : null,
          setBy: exception ? 'Mugabo Théogène' : null,
        }
      }),
      trustedDevices: 2,
      signIns: [0, 1, 1, 2, 3, 5, 6].map((d, i) => ({
        at: ago(d, 7 + (i % 3)),
        ok: i !== 2,
        reason: i === 2 ? 'wrong PIN (1 of 5)' : null,
      })),
      failedSignIns30: 1,
    },
    documents: { count: 4, expired: 0, expiring: doctor ? 1 : 0 },
    notes: manager ? [...(sampleNotes.get(id) ?? [])] : null,
    removedNotes: manager ? 0 : null,
    canEdit: manager,
    self: id === me?.id,
  }
}

// ---------------------------------------------------------------- queries
const KEY = ['staff', 'profile'] as const

export function useStaffProfile(id: string | null) {
  return useQuery({
    queryKey: [...KEY, id],
    enabled: !!id,
    queryFn: async (): Promise<StaffProfile> => {
      if (!supabase) return sampleProfile(id!)
      const { data, error } = await supabase.rpc('staff_profile', { p_profile: id })
      if (error) throw apiError(error)
      return data as StaffProfile
    },
  })
}

const blank = (v: string) => v.trim() || null

export function useStaffProfileActions(id: string) {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [...KEY, id] })
    void qc.invalidateQueries({ queryKey: ['staff', 'employees'] })
  }
  const save = useMutation({
    mutationFn: async (i: StaffHrInput) => {
      if (!supabase) {
        if (i.contractEnd && i.hiredOn && i.contractEnd < i.hiredOn)
          throw apiError({ code: '22023', message: 'the contract ends before the date hired' })
        samplePhones.set(id, blank(i.phone))
        sampleHr.set(id, {
          emergencyName: blank(i.emergencyName),
          emergencyPhone: blank(i.emergencyPhone),
          address: blank(i.address),
          birthDate: i.birthDate || null,
          sex: i.sex || null,
          nationalId: blank(i.nationalId),
          hiredOn: i.hiredOn || null,
          contractType: i.contractType || null,
          contractEnd: i.contractEnd || null,
          registrationExpiresOn: i.registrationExpiresOn || null,
          updatedAt: new Date().toISOString(),
          updatedBy: useSession.getState().user?.name ?? null,
        })
        return
      }
      const { error } = await supabase.rpc('save_staff_profile', {
        p_profile: id,
        p_phone: blank(i.phone),
        p_emergency_name: blank(i.emergencyName),
        p_emergency_phone: blank(i.emergencyPhone),
        p_address: blank(i.address),
        p_birth_date: i.birthDate || null,
        p_sex: i.sex || null,
        p_national_id: blank(i.nationalId),
        p_hired_on: i.hiredOn || null,
        p_contract_type: i.contractType || null,
        p_contract_end: i.contractEnd || null,
        p_registration_expires_on: i.registrationExpiresOn || null,
      })
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })
  const addNote = useMutation({
    mutationFn: async (i: { kind: NoteKind; body: string; notedOn: string }) => {
      if (!supabase) {
        if (i.body.trim().length < 3) throw apiError({ code: '22023', message: 'write the note' })
        const list = sampleNotes.get(id) ?? []
        list.unshift({
          id: `${id}-n${Date.now()}`,
          kind: i.kind,
          body: i.body.trim(),
          notedOn: i.notedOn || new Date().toISOString().slice(0, 10),
          at: new Date().toISOString(),
          by: useSession.getState().user?.name ?? null,
        })
        sampleNotes.set(id, list)
        return
      }
      const { error } = await supabase.rpc('add_staff_note', {
        p_profile: id,
        p_kind: i.kind,
        p_body: i.body.trim(),
        p_noted_on: i.notedOn || null,
      })
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })
  const removeNote = useMutation({
    mutationFn: async (i: { id: string; reason: string }) => {
      if (!supabase) {
        sampleNotes.set(
          id,
          (sampleNotes.get(id) ?? []).filter((n) => n.id !== i.id),
        )
        return
      }
      const { error } = await supabase.rpc('remove_staff_note', {
        p_id: i.id,
        p_reason: i.reason,
      })
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })
  // 0126: the manager marks the employee (or himself) a doctor, with the registration number
  const setDoctor = useMutation({
    mutationFn: async (i: { on: boolean; registrationNo: string; registrationBody: string }) => {
      const no = i.registrationNo.trim()
      if (!supabase) {
        if (useSession.getState().user?.role !== 'manager')
          throw apiError({
            code: '42501',
            hint: 'not_manager',
            message: 'not allowed: the manager marks who is a doctor',
          })
        if (i.on && no.length < 3)
          throw apiError({
            code: '22023',
            hint: 'registration_needed',
            message: 'the registration number is needed to mark a doctor',
          })
        const old = sampleDoctorMarks.get(id)
        sampleDoctorMarks.set(id, {
          on: i.on,
          no: i.on ? no : (old?.no ?? null),
          body: i.on ? i.registrationBody.trim() || old?.body || null : (old?.body ?? null),
        })
        const me = useSession.getState().user
        if (me?.id === id) useSession.setState({ user: { ...me, isDoctor: i.on } })
        return
      }
      const { error } = await supabase.rpc('set_staff_doctor', {
        p_profile: id,
        p_on: i.on,
        p_registration_no: no || null,
        p_registration_body: i.registrationBody.trim() || null,
      })
      if (error) throw apiError(error)
    },
    onSuccess: () => {
      refresh()
      // the manager marking himself: the menu and the screens follow at once
      void qc.invalidateQueries({ queryKey: ['session-profile'] })
    },
  })
  return { save, addNote, removeNote, setDoctor }
}

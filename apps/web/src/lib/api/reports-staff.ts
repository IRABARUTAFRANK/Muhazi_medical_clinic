import { kigaliToday } from '@/lib/clock'
import type { ReportContext, ReportFilterValues } from '@/lib/reports/defs/types'
import { toStaffActivity, type ActivityKind } from './analytics'
import { sampleAccess, sampleStaffActivity } from './analytics-sample'
import { chosen, reportCall, reportRpc, selected } from './reports-options'

/**
 * The staff reports' rows: report_employees (migration 0111) and staff_activity (0086). The
 * manager sees every employee and column (or one department's people); a head or assistant head
 * the people of their departments, without phone, e-mail and username (the database leaves them
 * empty). Sample mode: the clinic of the analytics sample.
 */

// ------------------------------------------------------------------ employees

export interface EmployeeDepartment {
  id: string
  name: string
  /** head, assistant or member */
  position: string
}

export interface EmployeeRow {
  id: string
  staffId: string | null
  fullName: string
  /** The manager only. */
  username: string | null
  role: string
  specialty: string | null
  departments: EmployeeDepartment[]
  /** The desks the person's departments (and exceptions) give. */
  desks: string[]
  /** The manager only. */
  phone: string | null
  /** The manager only. */
  email: string | null
  registrationNo: string | null
  registrationBody: string | null
  active: boolean
  deactivatedAt: string | null
  createdAt: string | null
  lastSignInAt: string | null
  mustChangePin: boolean
}

export const EMPLOYEE_ROLES = [
  'receptionist',
  'nurse',
  'doctor',
  'sonographer',
  'lab_tech',
  'pharmacist',
  'cashier',
  'manager',
] as const

export async function loadEmployees(
  f: ReportFilterValues,
  ctx: ReportContext,
): Promise<EmployeeRow[]> {
  const department = selected(f, 'department')
  const rows = ctx.sample
    ? sampleEmployees(ctx).filter(
        (e) => !department || e.departments.some((d) => d.id === department),
      )
    : (await reportRpc<EmployeeRow>('report_employees', { p_department: department })).rows.map(
        (e) => ({
          ...e,
          departments: Array.isArray(e.departments) ? e.departments : [],
          desks: Array.isArray(e.desks) ? e.desks : [],
          active: !!e.active,
          mustChangePin: !!e.mustChangePin,
        }),
      )
  const roles = chosen(f, 'role')
  const status = selected(f, 'status')
  return rows.filter(
    (e) =>
      (!roles.length || roles.includes(e.role)) &&
      (!status || (status === 'active' ? e.active : !e.active)),
  )
}

// ------------------------------------------------------------------ activity

/** One person's work in the period (staff_activity's people), counts by kind flattened. */
export interface ActivityRow {
  id: string
  name: string
  role: string
  staffId: string | null
  departments: string
  active: boolean
  lastSignIn: string | null
  /** Records written (every kind but patients seen and money). */
  records: number
  /** Money collected: the manager only (null for heads). */
  amount: number | null
  counts: Partial<Record<ActivityKind, number>>
}

export async function loadActivity(
  f: ReportFilterValues,
  ctx: ReportContext,
): Promise<ActivityRow[]> {
  const department = selected(f, 'department')
  const period = { from: f.period.from, to: f.period.to }
  const a = ctx.sample
    ? await sampleStaffActivity(period, department)
    : toStaffActivity(
        await reportCall('staff_activity', {
          p_from: period.from,
          p_to: period.to,
          p_department: department,
        }),
      )
  const roles = chosen(f, 'role')
  return a.people
    .filter((p) => !roles.length || roles.includes(p.role))
    .map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      staffId: p.staffId,
      departments: p.departments.map((d) => d.name).join(', '),
      active: p.active,
      lastSignIn: p.lastSignIn,
      records: p.records,
      amount: a.manager ? (p.amount ?? 0) : null,
      counts: p.counts as Partial<Record<ActivityKind, number>>,
    }))
}

// ------------------------------------------------------------------ sample employees

const DEPARTMENTS: Record<string, string> = {
  'dep-opd': 'Outpatient (OPD)',
  'dep-dental': 'Dental',
  'dep-lab': 'Laboratory and imaging',
  'dep-theatre': 'Minor surgery',
  'dep-pharmacy': 'Pharmacy',
}
const dep = (id: string, position = 'member'): EmployeeDepartment => ({
  id,
  name: DEPARTMENTS[id] ?? id,
  position,
})
interface SampleEmployee {
  id: string
  staffId: string
  fullName: string
  role: string
  departments: EmployeeDepartment[]
  desks: string[]
  since: string
  reg?: [string, string]
  specialty?: string
  leftOn?: string
}
const SAMPLE_EMPLOYEES: SampleEmployee[] = [
  {
    id: 'u-rec',
    staffId: 'MMC-S-0001',
    fullName: 'Uwimana Josiane',
    role: 'receptionist',
    departments: [dep('dep-opd')],
    desks: ['reception'],
    since: '2026-01-05',
  },
  {
    id: 'p-rec2',
    staffId: 'MMC-S-0007',
    fullName: 'Ingabire Diane',
    role: 'receptionist',
    departments: [dep('dep-opd')],
    desks: ['reception'],
    since: '2026-02-02',
  },
  {
    id: 'u-nur',
    staffId: 'MMC-S-0002',
    fullName: 'Nyirahabimana Chantal',
    role: 'nurse',
    departments: [dep('dep-opd', 'assistant')],
    desks: ['triage', 'nursing', 'fp', 'hiv'],
    since: '2026-01-05',
    reg: ['A0457', 'NCNM'],
  },
  {
    id: 'p-nur2',
    staffId: 'MMC-S-0008',
    fullName: 'Habimana Eric',
    role: 'nurse',
    departments: [dep('dep-opd'), dep('dep-theatre')],
    desks: ['triage', 'nursing', 'surgery', 'circ'],
    since: '2026-02-16',
    reg: ['A0912', 'NCNM'],
  },
  {
    id: 'u-doc',
    staffId: 'MMC-S-0003',
    fullName: 'Dr. Mukamana Béatrice',
    role: 'doctor',
    departments: [dep('dep-opd', 'head')],
    desks: ['consultation'],
    since: '2026-01-05',
    reg: ['RMDC/1184', 'RMDC'],
    specialty: 'General practice',
  },
  {
    id: 'p-doc2',
    staffId: 'MMC-S-0009',
    fullName: 'Dr. Niyonsenga Patrick',
    role: 'doctor',
    departments: [dep('dep-opd'), dep('dep-theatre', 'head')],
    desks: ['consultation', 'surgery'],
    since: '2026-03-02',
    reg: ['RMDC/2071', 'RMDC'],
    specialty: 'Minor surgery',
  },
  {
    id: 'u-head',
    staffId: 'MMC-S-0006',
    fullName: 'Dr. Ndayisaba Félix',
    role: 'doctor',
    departments: [dep('dep-dental', 'head')],
    desks: ['dental'],
    since: '2026-01-05',
    reg: ['RMDC/0933', 'RMDC'],
    specialty: 'Dentistry',
  },
  {
    id: 'p-den2',
    staffId: 'MMC-S-0010',
    fullName: 'Mukeshimana Sandrine',
    role: 'nurse',
    departments: [dep('dep-dental')],
    desks: ['dental'],
    since: '2026-04-13',
    reg: ['A1288', 'NCNM'],
  },
  {
    id: 'p-lab',
    staffId: 'MMC-S-0011',
    fullName: 'Uwase Clarisse',
    role: 'lab_tech',
    departments: [dep('dep-lab', 'head')],
    desks: ['laboratory'],
    since: '2026-01-05',
    reg: ['AHPC/0517', 'RAHPC'],
  },
  {
    id: 'p-lab2',
    staffId: 'MMC-S-0012',
    fullName: 'Kayitare Jean',
    role: 'lab_tech',
    departments: [dep('dep-lab')],
    desks: ['laboratory'],
    since: '2026-02-02',
    reg: ['AHPC/0644', 'RAHPC'],
    leftOn: '2026-09-15',
  },
  {
    id: 'p-sono',
    staffId: 'MMC-S-0013',
    fullName: 'Mutesi Ange',
    role: 'sonographer',
    departments: [dep('dep-lab')],
    desks: ['ultrasound'],
    since: '2026-05-04',
    reg: ['AHPC/0781', 'RAHPC'],
  },
  {
    id: 'p-pha',
    staffId: 'MMC-S-0014',
    fullName: 'Mutoni Aline',
    role: 'pharmacist',
    departments: [dep('dep-pharmacy', 'head')],
    desks: ['pharmacy'],
    since: '2026-01-05',
    reg: ['NPC/0362', 'NPC'],
  },
  {
    id: 'u-cash',
    staffId: 'MMC-S-0004',
    fullName: 'Mugisha Samuel',
    role: 'cashier',
    departments: [],
    desks: [],
    since: '2026-01-05',
  },
  {
    id: 'p-cash2',
    staffId: 'MMC-S-0015',
    fullName: 'Iradukunda Grace',
    role: 'cashier',
    departments: [],
    desks: [],
    since: '2026-03-16',
  },
  {
    id: 'u-mgr',
    staffId: 'MMC-S-0005',
    fullName: 'Mugabo Théogène',
    role: 'manager',
    departments: [],
    desks: [],
    since: '2026-01-05',
  },
]

const shiftDay = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

function sampleEmployees(ctx: ReportContext): EmployeeRow[] {
  const heads = ctx.isManager ? null : sampleAccess(ctx.user).departments.map((d) => d.id)
  const manager = ctx.isManager
  return SAMPLE_EMPLOYEES.filter(
    (e) => !heads || e.departments.some((d) => heads.includes(d.id)),
  ).map((e, i) => {
    // "Dr. Mukamana Béatrice" → b.mukamana
    const [surname = '', given = ''] = e.fullName.replace(/^Dr\. /, '').split(' ')
    const handle = `${given.charAt(0)}.${surname}`
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
    return {
      id: e.id,
      staffId: e.staffId,
      fullName: e.fullName,
      username: manager ? handle : null,
      role: e.role,
      specialty: e.specialty ?? null,
      departments: e.departments,
      desks: e.desks,
      phone: manager ? `078${String(3_456_000 + i * 7_919).slice(0, 7)}` : null,
      email: manager ? `${handle}@example.com` : null,
      registrationNo: e.reg?.[0] ?? null,
      registrationBody: e.reg?.[1] ?? null,
      active: !e.leftOn,
      deactivatedAt: e.leftOn ? `${e.leftOn}T08:00:00+02:00` : null,
      createdAt: `${e.since}T08:00:00+02:00`,
      // at the start of a working day: today, yesterday or the day before
      lastSignInAt: e.leftOn
        ? `${e.leftOn}T07:42:00+02:00`
        : `${shiftDay(kigaliToday(), -(i % 3))}T07:${String(10 + ((i * 7) % 45)).padStart(2, '0')}:00+02:00`,
      mustChangePin: e.id === 'p-cash2',
    }
  })
}

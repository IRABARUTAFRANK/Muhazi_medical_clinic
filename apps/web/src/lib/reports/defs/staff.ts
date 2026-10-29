import i18n from '@/i18n'
import { MONEY_KINDS, WORK_KINDS, type ActivityKind } from '@/lib/api/analytics'
import { keyOptions, reportFilterOptions, toOptions } from '@/lib/api/reports-options'
import {
  EMPLOYEE_ROLES,
  loadActivity,
  loadEmployees,
  type ActivityRow,
  type EmployeeRow,
} from '@/lib/api/reports-staff'
import type {
  AnyReportDef,
  ReportColumnDef,
  ReportContext,
  ReportDef,
  ReportFilterDef,
} from './types'

/**
 * The staff reports: the employees (migration 0111, report_employees) and who did what in the
 * period (0086, staff_activity). The manager sees everyone, phone and e-mail included, and the
 * money handled; a head or assistant head the people of their departments, without phone,
 * e-mail, username or money. The database leaves those out again.
 */

const t = (key: string, o?: Record<string, unknown>) => i18n.t(key, o)
const K = 'staffReports'

const roleLabel = (role: string) => t(`staff.roles.${role}`, { defaultValue: role })
const managerOnly = (ctx: ReportContext) => ctx.isManager
const departmentsLabel = (e: EmployeeRow) =>
  e.departments
    .map((d) =>
      d.position === 'head' || d.position === 'assistant'
        ? `${d.name} (${t(`${K}.position.${d.position}`)})`
        : d.name,
    )
    .join(', ')
const departmentFilter: ReportFilterDef = {
  key: 'department',
  label: `${K}.filters.department`,
  kind: 'select',
  loadOptions: async (ctx) => toOptions((await reportFilterOptions(ctx)).departments),
}
const roleFilter: ReportFilterDef = {
  key: 'role',
  label: `${K}.filters.role`,
  kind: 'multi',
  options: keyOptions('staff.roles', EMPLOYEE_ROLES),
}

// ------------------------------------------------------------------ employees

const employees: ReportDef<EmployeeRow> = {
  id: 'staff.employees',
  group: 'staff',
  title: `${K}.employees.title`,
  description: `${K}.employees.description`,
  code: 'EMP',
  load: loadEmployees,
  allowed: (ctx) => ctx.isManager || ctx.isHead,
  filters: [
    departmentFilter,
    roleFilter,
    {
      key: 'status',
      label: `${K}.filters.status`,
      kind: 'select',
      options: keyOptions(`${K}.status`, ['active', 'inactive']),
      default: 'active',
    },
  ],
  columns: [
    {
      key: 'staffId',
      label: `${K}.cols.staffId`,
      default: true,
      value: (r) => r.staffId,
      nowrap: true,
    },
    { key: 'fullName', label: `${K}.cols.name`, default: true, value: (r) => r.fullName },
    { key: 'role', label: `${K}.cols.role`, default: true, value: (r) => roleLabel(r.role) },
    {
      key: 'departments',
      label: `${K}.cols.departments`,
      default: true,
      value: departmentsLabel,
      width: '24%',
    },
    {
      key: 'desks',
      label: `${K}.cols.desks`,
      value: (r) => r.desks.map((d) => t(`desks.names.${d}`, { defaultValue: d })).join(', '),
    },
    { key: 'specialty', label: `${K}.cols.specialty`, value: (r) => r.specialty },
    {
      key: 'registrationNo',
      label: `${K}.cols.registrationNo`,
      value: (r) => r.registrationNo,
      nowrap: true,
    },
    {
      key: 'registrationBody',
      label: `${K}.cols.registrationBody`,
      value: (r) => r.registrationBody,
    },
    {
      key: 'phone',
      label: `${K}.cols.phone`,
      default: true,
      value: (r) => r.phone,
      nowrap: true,
      allowed: managerOnly,
    },
    { key: 'email', label: `${K}.cols.email`, value: (r) => r.email, allowed: managerOnly },
    {
      key: 'username',
      label: `${K}.cols.username`,
      value: (r) => r.username,
      nowrap: true,
      allowed: managerOnly,
    },
    {
      key: 'active',
      label: `${K}.cols.active`,
      kind: 'yesno',
      default: true,
      total: 'count',
      value: (r) => r.active || null,
    },
    {
      key: 'createdAt',
      label: `${K}.cols.since`,
      kind: 'date',
      value: (r) => r.createdAt,
      nowrap: true,
    },
    {
      key: 'deactivatedAt',
      label: `${K}.cols.deactivatedAt`,
      kind: 'date',
      value: (r) => r.deactivatedAt,
      nowrap: true,
    },
    {
      key: 'lastSignInAt',
      label: `${K}.cols.lastSignIn`,
      kind: 'datetime',
      default: true,
      value: (r) => r.lastSignInAt,
      nowrap: true,
    },
    {
      key: 'mustChangePin',
      label: `${K}.cols.mustChangePin`,
      kind: 'yesno',
      value: (r) => r.mustChangePin,
    },
  ],
  figures: (rows) => [
    { label: `${K}.figures.employees`, value: rows.length },
    { label: `${K}.figures.active`, value: rows.filter((r) => r.active).length },
    { label: `${K}.figures.inactive`, value: rows.filter((r) => !r.active).length },
    {
      label: `${K}.figures.departments`,
      value: new Set(rows.flatMap((r) => r.departments.map((d) => d.id))).size,
    },
  ],
  groups: [
    {
      key: 'role',
      label: `${K}.groups.role`,
      value: (r) => roleLabel(r.role),
      order: (r) => (EMPLOYEE_ROLES as readonly string[]).indexOf(r.role),
    },
    {
      key: 'department',
      label: `${K}.groups.department`,
      // the person's first department (their main one comes first)
      value: (r) => r.departments[0]?.name ?? t(`${K}.noDepartment`),
      order: (r) => (r.departments[0] ? `1${r.departments[0].name}` : '2'),
    },
    {
      key: 'active',
      label: `${K}.groups.active`,
      value: (r) => t(`${K}.status.${r.active ? 'active' : 'inactive'}`),
      order: (r) => (r.active ? 0 : 1),
    },
  ],
  defaultSort: { key: 'fullName', dir: 'asc' },
  notes: [`${K}.employees.note1`, `${K}.employees.note2`],
  wide: true,
  countLabel: `${K}.count.employees`,
}

// ------------------------------------------------------------------ who did what

const DEFAULT_KINDS: ActivityKind[] = [
  'patientsSeen',
  'registered',
  'vitals',
  'diagnoses',
  'prescriptions',
  'results',
]
const kindColumns: ReportColumnDef<ActivityRow>[] = [
  ...WORK_KINDS.map((k): ReportColumnDef<ActivityRow> => ({
    key: k,
    label: `analytics.kinds.${k}`,
    kind: 'number',
    default: DEFAULT_KINDS.includes(k),
    total: 'sum',
    value: (r) => r.counts[k] ?? 0,
  })),
  ...MONEY_KINDS.map((k): ReportColumnDef<ActivityRow> => ({
    key: k,
    label: `analytics.kinds.${k}`,
    kind: 'number',
    default: k === 'payments',
    total: 'sum',
    value: (r) => r.counts[k] ?? 0,
    allowed: managerOnly,
  })),
]

const activity: ReportDef<ActivityRow> = {
  id: 'staff.activity',
  group: 'staff',
  title: `${K}.activity.title`,
  description: `${K}.activity.description`,
  code: 'ACT',
  load: loadActivity,
  allowed: (ctx) => ctx.isManager || ctx.isHead,
  filters: [
    { key: 'period', label: 'report.period', kind: 'period', default: 'month' },
    departmentFilter,
    roleFilter,
  ],
  columns: [
    { key: 'name', label: `${K}.cols.name`, default: true, value: (r) => r.name },
    { key: 'staffId', label: `${K}.cols.staffId`, value: (r) => r.staffId, nowrap: true },
    { key: 'role', label: `${K}.cols.role`, default: true, value: (r) => roleLabel(r.role) },
    { key: 'departments', label: `${K}.cols.departments`, value: (r) => r.departments },
    {
      key: 'records',
      label: `${K}.cols.records`,
      kind: 'number',
      default: true,
      total: 'sum',
      value: (r) => r.records,
    },
    ...kindColumns,
    {
      key: 'amount',
      label: `${K}.cols.collected`,
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.amount,
      allowed: managerOnly,
    },
    { key: 'active', label: `${K}.cols.active`, kind: 'yesno', value: (r) => r.active },
    {
      key: 'lastSignIn',
      label: `${K}.cols.lastSignIn`,
      kind: 'datetime',
      value: (r) => r.lastSignIn,
      nowrap: true,
    },
  ],
  figures: (rows) => {
    const worked = rows.filter((r) => r.records > 0 || (r.counts.patientsSeen ?? 0) > 0)
    const money = rows.some((r) => r.amount != null)
    return [
      { label: `${K}.figures.people`, value: rows.length },
      { label: `${K}.figures.worked`, value: worked.length },
      { label: `${K}.figures.records`, value: rows.reduce((s, r) => s + r.records, 0) },
      ...(money
        ? [
            {
              label: `${K}.figures.collected`,
              value: rows.reduce((s, r) => s + (r.amount ?? 0), 0),
              unit: 'RWF',
            },
          ]
        : []),
    ]
  },
  groups: [
    {
      key: 'role',
      label: `${K}.groups.role`,
      value: (r) => roleLabel(r.role),
      order: (r) => (EMPLOYEE_ROLES as readonly string[]).indexOf(r.role),
    },
    {
      key: 'department',
      label: `${K}.groups.department`,
      value: (r) => r.departments.split(', ')[0] || t(`${K}.noDepartment`),
    },
  ],
  defaultSort: { key: 'records', dir: 'desc' },
  notes: [`${K}.activity.note1`, `${K}.activity.note2`, `${K}.activity.note3`],
  wide: true,
  countLabel: `${K}.count.people`,
}

/** The staff reports, in the order the report centre lists them. */
export const STAFF_REPORTS: AnyReportDef[] = [employees, activity]

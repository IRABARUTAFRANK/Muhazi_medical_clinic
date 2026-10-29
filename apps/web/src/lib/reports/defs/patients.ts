import i18n from '@/i18n'
import type { PatientFieldDef } from '@/lib/api/patients'
import {
  fetchPatientFieldDefs,
  fetchPatientReportOptions,
  fetchPatientsVisited,
  fetchRegistrations,
  fetchVisitsReport,
  type PatientReportFilters,
  type RegistrationRow,
  type VisitedPatientRow,
  type VisitReportRow,
} from '@/lib/api/reports-patients'
import { docDate } from '@/lib/doc-style'
import type {
  AnyReportDef,
  ReportColumnDef,
  ReportContext,
  ReportDef,
  ReportFilterDef,
  ReportFilterValues,
  ReportOption,
  ReportRunInfo,
} from './types'

/**
 * The patients reports (0110): who visited in a period (one row per patient), the visits (one
 * row per visit) and the files created. The manager sees the whole clinic, a head their
 * department's visits; reception the registrations only (identity). The database checks again,
 * masks the national ID for everyone but the manager, gives a diagnosis only for a visit the
 * reader may see and logs each opening of a past visit.
 */

const t = (key: string, vars?: Record<string, unknown>) => i18n.t(key, vars ?? {}) as string
/** A word that may have no translation (a station, a service): the key's last part. */
const word = (key: string, fallback: string) => {
  const v = t(key)
  return v === key ? fallback : v
}
const sexWord = (s: string | null | undefined) => (s ? word(`register.sexes.${s}`, s) : '')
const deskWord = (s: string) => word(`register.stations.${s}`, s)
const serviceWord = (s: string) =>
  word(`prices.groups.${s}`, s.charAt(0).toUpperCase() + s.slice(1))

const AGE_BANDS = ['u5', '5-14', '15-24', '25-49', '50-64', '65+'] as const
const bandWord = (b: string | null | undefined) => (b ? t(`reports.pat.age.${b}`) : '')
const bandOrder = (b: string | null | undefined) => {
  const i = AGE_BANDS.indexOf((b ?? '') as (typeof AGE_BANDS)[number])
  return i < 0 ? 99 : i
}
const STATUSES = ['open', 'finished', 'left_unseen'] as const
const statusWord = (s: string) => t(`reports.pat.status.${s}`)
const triageWord = (s: string | null) => (s ? word(`triage.levels.${s}`, s) : '')

// ---------------------------------------------------------------- who runs them

const visitsReader = (ctx: ReportContext) => ctx.isManager || ctx.isHead
const registrationsReader = (ctx: ReportContext) =>
  ctx.isManager || ctx.isHead || ctx.user.role === 'receptionist'
const manager = (ctx: ReportContext) => ctx.isManager

// ---------------------------------------------------------------- filters

const options =
  (pick: (o: Awaited<ReturnType<typeof fetchPatientReportOptions>>) => ReportOption[]) =>
  async (): Promise<ReportOption[]> =>
    pick(await fetchPatientReportOptions())

const F = {
  period: { key: 'period', label: 'report.period', kind: 'period', default: 'month' },
  department: {
    key: 'department',
    label: 'reports.pat.f.department',
    kind: 'select',
    loadOptions: options((o) => o.departments.map((d) => ({ value: d.id, label: d.name }))),
  },
  desk: {
    key: 'desk',
    label: 'reports.pat.f.desk',
    kind: 'select',
    options: [
      'reception',
      'triage',
      'consultation',
      'dental',
      'laboratory',
      'ultrasound',
      'theatre',
      'nursing',
      'beds',
      'pharmacy',
      'cashier',
    ].map((s) => ({ value: s, label: `register.stations.${s}`, labelIsKey: true })),
  },
  doctor: {
    key: 'doctor',
    label: 'reports.pat.f.doctor',
    kind: 'select',
    loadOptions: options((o) => o.doctors.map((d) => ({ value: d.id, label: d.name }))),
  },
  service: {
    key: 'service',
    label: 'reports.pat.f.service',
    kind: 'select',
    loadOptions: options((o) => o.services.map((s) => ({ value: s, label: serviceWord(s) }))),
  },
  insurer: {
    key: 'insurer',
    label: 'reports.pat.f.insurer',
    kind: 'select',
    loadOptions: options((o) => o.insurers.map((d) => ({ value: d.id, label: d.name }))),
  },
  sex: {
    key: 'sex',
    label: 'reports.pat.f.sex',
    kind: 'select',
    options: ['female', 'male', 'other'].map((s) => ({
      value: s,
      label: `register.sexes.${s}`,
      labelIsKey: true,
    })),
  },
  ageBand: {
    key: 'ageBand',
    label: 'reports.pat.f.ageBand',
    kind: 'select',
    options: AGE_BANDS.map((b) => ({ value: b, label: `reports.pat.age.${b}`, labelIsKey: true })),
  },
  kind: {
    key: 'kind',
    label: 'reports.pat.f.kind',
    kind: 'select',
    options: [
      { value: 'new', label: 'reports.pat.new', labelIsKey: true },
      { value: 'returning', label: 'reports.pat.returning', labelIsKey: true },
    ],
  },
  district: {
    key: 'district',
    label: 'reports.pat.f.district',
    kind: 'select',
    loadOptions: options((o) => o.districts.map((d) => ({ value: d, label: d }))),
  },
  status: {
    key: 'status',
    label: 'reports.pat.f.status',
    kind: 'select',
    options: STATUSES.map((s) => ({
      value: s,
      label: `reports.pat.status.${s}`,
      labelIsKey: true,
    })),
  },
  search: {
    key: 'search',
    label: 'reports.pat.f.search',
    kind: 'text',
    placeholder: 'reports.pat.f.searchHint',
  },
  registeredBy: {
    key: 'registeredBy',
    label: 'reports.pat.f.registeredBy',
    kind: 'select',
    loadOptions: options((o) => o.registrars.map((d) => ({ value: d.id, label: d.name }))),
  },
  missingOnly: { key: 'missingOnly', label: 'reports.pat.f.missingOnly', kind: 'toggle' },
} satisfies Record<string, ReportFilterDef>

/** The filters the database functions take, from the values of the page. */
function filtersOf(f: ReportFilterValues): PatientReportFilters {
  const s = (k: string) => (typeof f[k] === 'string' ? (f[k] as string).trim() : '')
  return {
    department: s('department'),
    desk: s('desk'),
    doctor: s('doctor'),
    service: s('service'),
    insurer: s('insurer'),
    sex: s('sex'),
    ageBand: s('ageBand'),
    kind: s('kind') as PatientReportFilters['kind'],
    district: s('district'),
    search: s('search'),
    status: s('status'),
    registeredBy: s('registeredBy'),
    missingOnly: f.missingOnly === true,
  }
}

// ---------------------------------------------------------------- the clinic's own fields

let fieldDefs: { at: number; defs: Promise<PatientFieldDef[]> } | null = null
/** The patient file's own fields, read at most once a minute. */
function clinicFields(): Promise<PatientFieldDef[]> {
  if (!fieldDefs || Date.now() - fieldDefs.at > 60_000) {
    const defs = fetchPatientFieldDefs()
    fieldDefs = { at: Date.now(), defs }
    defs.catch(() => {
      fieldDefs = null
    })
  }
  return fieldDefs.defs
}
const EXTRA = 'extra.'
const extraValue = (v: unknown, type: PatientFieldDef['type']) =>
  v == null || v === ''
    ? null
    : type === 'yesno'
      ? v === true || v === 'true' || v === 'yes'
      : type === 'number' && !Number.isNaN(Number(v))
        ? Number(v)
        : String(v)

/** One column per field of the patient file; the private ones are sensitive. */
async function extraColumns(): Promise<ReportColumnDef<VisitedPatientRow>[]> {
  const defs = await clinicFields()
  return defs
    .filter((d) => d.key)
    .map((d) => ({
      key: `${EXTRA}${d.key}`,
      label: d.label || d.key,
      plainLabel: true,
      kind:
        d.type === 'yesno'
          ? 'yesno'
          : d.type === 'number'
            ? 'number'
            : d.type === 'date'
              ? 'date'
              : 'text',
      sensitive: !!d.private,
      value: (r: VisitedPatientRow) => extraValue(r.extra[d.key] ?? r.extra[d.label], d.type),
    }))
}

/** Read the private data only when one of its columns is shown. */
async function wantsClinical(run: ReportRunInfo | undefined): Promise<boolean> {
  const cols = run?.columns ?? []
  if (cols.includes('diagnoses') || cols.includes('diagnosis')) return true
  const extras = cols.filter((k) => k.startsWith(EXTRA)).map((k) => k.slice(EXTRA.length))
  if (!extras.length) return false
  const defs = await clinicFields().catch(() => [])
  return defs.some((d) => d.private && extras.includes(d.key))
}

// ---------------------------------------------------------------- shared columns

const list = (xs: string[] | null | undefined, w: (s: string) => string = (s) => s) =>
  xs && xs.length ? xs.map(w).join(', ') : null
const notes = ['reports.pat.notes.ids', 'reports.pat.notes.private']

// ---------------------------------------------------------------- A patients who visited

const visited: ReportDef<VisitedPatientRow> = {
  id: 'patients.visited',
  group: 'patients',
  title: 'reports.pat.visited.title',
  description: 'reports.pat.visited.description',
  code: 'PAT',
  countLabel: 'reports.pat.count.patients',
  allowed: visitsReader,
  filters: [
    F.period,
    F.department,
    F.desk,
    F.doctor,
    F.service,
    F.insurer,
    F.sex,
    F.ageBand,
    F.kind,
    F.district,
    F.search,
  ],
  columns: [
    {
      key: 'fileNo',
      label: 'reports.pat.c.fileNo',
      default: true,
      total: 'count',
      nowrap: true,
      value: (r) => r.fileNumber,
    },
    { key: 'surname', label: 'reports.pat.c.surname', default: true, value: (r) => r.surname },
    {
      key: 'givenNames',
      label: 'reports.pat.c.givenNames',
      default: true,
      value: (r) => r.givenNames,
    },
    { key: 'sex', label: 'reports.pat.c.sex', default: true, value: (r) => sexWord(r.sex) },
    {
      key: 'age',
      label: 'reports.pat.c.age',
      kind: 'number',
      default: true,
      total: 'avg',
      value: (r) => r.age,
    },
    { key: 'ageBand', label: 'reports.pat.c.ageBand', value: (r) => bandWord(r.ageBand) },
    { key: 'birthDate', label: 'reports.pat.c.birthDate', kind: 'date', value: (r) => r.birthDate },
    {
      key: 'phone',
      label: 'reports.pat.c.phone',
      default: true,
      nowrap: true,
      value: (r) => r.phone,
    },
    { key: 'phone2', label: 'reports.pat.c.phone2', nowrap: true, value: (r) => r.phone2 },
    {
      key: 'nationalId',
      label: 'reports.pat.c.nationalId',
      nowrap: true,
      value: (r) => r.nationalId,
    },
    { key: 'district', label: 'reports.pat.c.district', default: true, value: (r) => r.district },
    { key: 'sector', label: 'reports.pat.c.sector', value: (r) => r.sector },
    { key: 'cell', label: 'reports.pat.c.cell', value: (r) => r.cell },
    { key: 'village', label: 'reports.pat.c.village', value: (r) => r.village },
    { key: 'insurer', label: 'reports.pat.c.insurer', default: true, value: (r) => r.insurer },
    {
      key: 'firstVisit',
      label: 'reports.pat.c.firstVisit',
      kind: 'date',
      value: (r) => r.firstVisit,
    },
    {
      key: 'lastVisit',
      label: 'reports.pat.c.lastVisit',
      kind: 'date',
      default: true,
      value: (r) => r.lastVisit,
    },
    {
      key: 'visits',
      label: 'reports.pat.c.visits',
      kind: 'number',
      default: true,
      total: 'sum',
      value: (r) => r.visits,
    },
    { key: 'departments', label: 'reports.pat.c.departments', value: (r) => list(r.departments) },
    { key: 'desks', label: 'reports.pat.c.desks', value: (r) => list(r.desks, deskWord) },
    { key: 'doctors', label: 'reports.pat.c.doctors', value: (r) => list(r.doctors) },
    {
      key: 'newReturning',
      label: 'reports.pat.c.newReturning',
      value: (r) => (r.isNew ? t('reports.pat.new') : t('reports.pat.returning')),
    },
    {
      key: 'isNew',
      label: 'reports.pat.c.isNew',
      kind: 'yesno',
      total: 'count',
      value: (r) => r.isNew,
    },
    {
      key: 'diagnoses',
      label: 'reports.pat.c.diagnoses',
      sensitive: true,
      value: (r) => list(r.diagnoses),
    },
  ],
  extraColumns: async () => (await extraColumns()) as ReportColumnDef<VisitedPatientRow>[],
  fetchColumns: ['diagnoses'],
  load: async (f, ctx, run) =>
    fetchPatientsVisited(
      f.period.from,
      f.period.to,
      filtersOf(f),
      await wantsClinical(run),
      ctx.isManager,
    ),
  figures: (rows) => {
    const visits = rows.reduce((s, r) => s + r.visits, 0)
    const fresh = rows.filter((r) => r.isNew).length
    return [
      { label: 'reports.pat.fig.patients', value: rows.length },
      { label: 'reports.pat.fig.visits', value: visits },
      { label: 'reports.pat.fig.new', value: fresh },
      { label: 'reports.pat.fig.returning', value: rows.length - fresh },
    ]
  },
  groups: [
    {
      key: 'sex',
      label: 'reports.pat.g.sex',
      heading: 'reports.pat.c.sex',
      value: (r) => sexWord(r.sex),
    },
    {
      key: 'ageBand',
      label: 'reports.pat.g.ageBand',
      heading: 'reports.pat.c.ageBand',
      value: (r) => bandWord(r.ageBand),
      order: (r) => bandOrder(r.ageBand),
    },
    {
      key: 'insurer',
      label: 'reports.pat.g.insurer',
      heading: 'reports.pat.c.insurer',
      value: (r) => r.insurer ?? t('reports.pat.noInsurer'),
    },
    {
      key: 'district',
      label: 'reports.pat.g.district',
      heading: 'reports.pat.c.district',
      value: (r) => r.district ?? '',
    },
    {
      key: 'department',
      label: 'reports.pat.g.department',
      heading: 'reports.pat.c.department',
      value: (r) => list(r.departments) ?? '',
    },
    {
      key: 'doctor',
      label: 'reports.pat.g.doctor',
      heading: 'reports.pat.c.doctor',
      value: (r) => list(r.doctors) ?? '',
    },
    {
      key: 'kind',
      label: 'reports.pat.g.kind',
      heading: 'reports.pat.c.newReturning',
      value: (r) => (r.isNew ? t('reports.pat.new') : t('reports.pat.returning')),
    },
  ],
  defaultSort: { key: 'surname', dir: 'asc' },
  notes: ['reports.pat.notes.visited', ...notes],
}

// ---------------------------------------------------------------- B visits

const day = (iso: string) => iso.slice(0, 10)
const visits: ReportDef<VisitReportRow> = {
  id: 'patients.visits',
  group: 'patients',
  title: 'reports.pat.visits.title',
  description: 'reports.pat.visits.description',
  code: 'VIS',
  countLabel: 'reports.pat.count.visits',
  allowed: visitsReader,
  filters: [
    F.period,
    F.department,
    F.desk,
    F.doctor,
    F.service,
    F.insurer,
    F.status,
    F.sex,
    F.ageBand,
    F.kind,
    F.district,
    F.search,
  ],
  columns: [
    {
      key: 'reference',
      label: 'reports.pat.c.visitNo',
      default: true,
      total: 'count',
      nowrap: true,
      value: (r) => r.reference,
    },
    { key: 'at', label: 'reports.pat.c.when', kind: 'datetime', default: true, value: (r) => r.at },
    { key: 'patient', label: 'reports.pat.c.patient', default: true, value: (r) => r.patient },
    {
      key: 'fileNo',
      label: 'reports.pat.c.fileNo',
      default: true,
      nowrap: true,
      value: (r) => r.fileNumber,
    },
    { key: 'age', label: 'reports.pat.c.age', kind: 'number', default: true, value: (r) => r.age },
    { key: 'sex', label: 'reports.pat.c.sex', default: true, value: (r) => sexWord(r.sex) },
    {
      key: 'type',
      label: 'reports.pat.c.type',
      value: (r) => (r.service ? serviceWord(r.service) : r.type),
    },
    {
      key: 'route',
      label: 'reports.pat.c.route',
      value: (r) => (r.route.length ? r.route.map(deskWord).join(' → ') : null),
    },
    { key: 'department', label: 'reports.pat.c.department', value: (r) => r.department },
    { key: 'doctor', label: 'reports.pat.c.doctor', default: true, value: (r) => r.doctor },
    { key: 'triage', label: 'reports.pat.c.triage', value: (r) => triageWord(r.triage) },
    {
      key: 'diagnosis',
      label: 'reports.pat.c.diagnosis',
      sensitive: true,
      value: (r) => r.diagnosis,
    },
    {
      key: 'status',
      label: 'reports.pat.c.status',
      default: true,
      value: (r) => statusWord(r.status),
    },
    { key: 'insurer', label: 'reports.pat.c.insurer', default: true, value: (r) => r.insurer },
    { key: 'district', label: 'reports.pat.c.district', value: (r) => r.district },
    {
      key: 'isNew',
      label: 'reports.pat.c.isNew',
      kind: 'yesno',
      total: 'count',
      value: (r) => r.isNew,
    },
    {
      key: 'billed',
      label: 'reports.pat.c.billed',
      kind: 'money',
      default: true,
      total: 'sum',
      allowed: manager,
      value: (r) => r.billed,
    },
    {
      key: 'insurerShare',
      label: 'reports.pat.c.insurerShare',
      kind: 'money',
      total: 'sum',
      allowed: manager,
      value: (r) => r.insurerShare,
    },
    {
      key: 'patientShare',
      label: 'reports.pat.c.patientShare',
      kind: 'money',
      total: 'sum',
      allowed: manager,
      value: (r) => r.patientShare,
    },
    {
      key: 'paid',
      label: 'reports.pat.c.paid',
      kind: 'money',
      default: true,
      total: 'sum',
      allowed: manager,
      value: (r) => r.paid,
    },
    {
      key: 'balance',
      label: 'reports.pat.c.balance',
      kind: 'money',
      default: true,
      total: 'sum',
      allowed: manager,
      value: (r) => r.balance,
    },
  ],
  fetchColumns: ['diagnosis'],
  load: async (f, ctx, run) =>
    fetchVisitsReport(
      f.period.from,
      f.period.to,
      filtersOf(f),
      await wantsClinical(run),
      ctx.isManager,
    ),
  figures: (rows) => {
    const n = (s: string) => rows.filter((r) => r.status === s).length
    const money = rows.some((r) => r.billed != null)
    return [
      { label: 'reports.pat.fig.visits', value: rows.length },
      { label: 'reports.pat.fig.patients', value: new Set(rows.map((r) => r.patientId)).size },
      { label: 'reports.pat.fig.finished', value: n('finished') },
      { label: 'reports.pat.fig.leftUnseen', value: n('left_unseen') },
      ...(money
        ? [
            {
              label: 'reports.pat.fig.billed',
              value: rows.reduce((s, r) => s + (r.billed ?? 0), 0),
              unit: 'RWF',
            },
            {
              label: 'reports.pat.fig.balance',
              value: rows.reduce((s, r) => s + (r.balance ?? 0), 0),
              unit: 'RWF',
            },
          ]
        : [{ label: 'reports.pat.fig.open', value: n('open') }]),
    ]
  },
  groups: [
    {
      key: 'day',
      label: 'reports.pat.g.day',
      heading: 'reports.pat.c.day',
      value: (r) => docDate(day(r.at)),
      order: (r) => day(r.at),
    },
    {
      key: 'department',
      label: 'reports.pat.g.department',
      heading: 'reports.pat.c.department',
      value: (r) => r.department ?? '',
    },
    {
      key: 'doctor',
      label: 'reports.pat.g.doctor',
      heading: 'reports.pat.c.doctor',
      value: (r) => r.doctor ?? '',
    },
    {
      key: 'status',
      label: 'reports.pat.g.status',
      heading: 'reports.pat.c.status',
      value: (r) => statusWord(r.status),
      order: (r) => STATUSES.indexOf(r.status as (typeof STATUSES)[number]),
    },
    {
      key: 'insurer',
      label: 'reports.pat.g.insurer',
      heading: 'reports.pat.c.insurer',
      value: (r) => r.insurer ?? t('reports.pat.noInsurer'),
    },
    {
      key: 'sex',
      label: 'reports.pat.g.sex',
      heading: 'reports.pat.c.sex',
      value: (r) => sexWord(r.sex),
    },
    {
      key: 'ageBand',
      label: 'reports.pat.g.ageBand',
      heading: 'reports.pat.c.ageBand',
      value: (r) => bandWord(r.ageBand),
      order: (r) => bandOrder(r.ageBand),
    },
  ],
  defaultSort: { key: 'at', dir: 'asc' },
  notes: ['reports.pat.notes.visits', ...notes, 'reports.pat.notes.money'],
}

// ---------------------------------------------------------------- C new registrations

/** The missing fields in words (files.missing.*; the clinic's own fields by their label). */
async function withMissingWords(rows: RegistrationRow[]) {
  const defs = rows.some((r) => r.missing.some((k) => k.startsWith('extra:')))
    ? await clinicFields().catch(() => [])
    : []
  return rows.map((r) => ({
    ...r,
    missingText: r.missing.length
      ? r.missing
          .map((k) =>
            k.startsWith('extra:')
              ? (defs.find((d) => d.key === k.slice(6))?.label ?? k.slice(6))
              : word(`files.missing.${k}`, k),
          )
          .join(', ')
      : null,
  }))
}
type RegistrationLine = RegistrationRow & { missingText: string | null }

const registrations: ReportDef<RegistrationLine> = {
  id: 'patients.registrations',
  group: 'patients',
  title: 'reports.pat.registrations.title',
  description: 'reports.pat.registrations.description',
  code: 'REG',
  countLabel: 'reports.pat.count.files',
  allowed: registrationsReader,
  filters: [F.period, F.registeredBy, F.sex, F.missingOnly, F.search],
  columns: [
    {
      key: 'fileNo',
      label: 'reports.pat.c.fileNo',
      default: true,
      total: 'count',
      nowrap: true,
      value: (r) => r.fileNumber,
    },
    { key: 'surname', label: 'reports.pat.c.surname', default: true, value: (r) => r.surname },
    {
      key: 'givenNames',
      label: 'reports.pat.c.givenNames',
      default: true,
      value: (r) => r.givenNames,
    },
    { key: 'sex', label: 'reports.pat.c.sex', default: true, value: (r) => sexWord(r.sex) },
    { key: 'age', label: 'reports.pat.c.age', kind: 'number', default: true, value: (r) => r.age },
    { key: 'birthDate', label: 'reports.pat.c.birthDate', kind: 'date', value: (r) => r.birthDate },
    {
      key: 'phone',
      label: 'reports.pat.c.phone',
      default: true,
      nowrap: true,
      value: (r) => r.phone,
    },
    {
      key: 'address',
      label: 'reports.pat.c.address',
      default: true,
      value: (r) => [r.village, r.cell, r.sector, r.district].filter(Boolean).join(', ') || null,
    },
    { key: 'district', label: 'reports.pat.c.district', value: (r) => r.district },
    { key: 'sector', label: 'reports.pat.c.sector', value: (r) => r.sector },
    {
      key: 'hasId',
      label: 'reports.pat.c.hasId',
      kind: 'yesno',
      default: true,
      total: 'count',
      value: (r) => r.hasId,
    },
    {
      key: 'registeredBy',
      label: 'reports.pat.c.registeredBy',
      default: true,
      value: (r) => r.registeredBy,
    },
    {
      key: 'registeredAt',
      label: 'reports.pat.c.registeredAt',
      kind: 'datetime',
      default: true,
      value: (r) => r.registeredAt,
    },
    { key: 'missing', label: 'reports.pat.c.missing', default: true, value: (r) => r.missingText },
    {
      key: 'missingCount',
      label: 'reports.pat.c.missingCount',
      kind: 'number',
      total: 'sum',
      value: (r) => r.missing.length,
    },
  ],
  load: async (f) =>
    withMissingWords(await fetchRegistrations(f.period.from, f.period.to, filtersOf(f))),
  figures: (rows) => {
    const incomplete = rows.filter((r) => r.missing.length > 0).length
    return [
      { label: 'reports.pat.fig.files', value: rows.length },
      { label: 'reports.pat.fig.complete', value: rows.length - incomplete },
      { label: 'reports.pat.fig.incomplete', value: incomplete },
      { label: 'reports.pat.fig.noId', value: rows.filter((r) => !r.hasId).length },
    ]
  },
  groups: [
    {
      key: 'registeredBy',
      label: 'reports.pat.g.registeredBy',
      heading: 'reports.pat.c.registeredBy',
      value: (r) => r.registeredBy ?? '',
    },
    {
      key: 'day',
      label: 'reports.pat.g.day',
      heading: 'reports.pat.c.day',
      value: (r) => docDate(r.registeredAt),
      order: (r) => r.registeredAt.slice(0, 10),
    },
    {
      key: 'sex',
      label: 'reports.pat.g.sex',
      heading: 'reports.pat.c.sex',
      value: (r) => sexWord(r.sex),
    },
    {
      key: 'district',
      label: 'reports.pat.g.district',
      heading: 'reports.pat.c.district',
      value: (r) => r.district ?? '',
    },
    {
      key: 'complete',
      label: 'reports.pat.g.complete',
      heading: 'reports.pat.c.complete',
      value: (r) => (r.missing.length ? t('reports.pat.incomplete') : t('reports.pat.complete')),
    },
  ],
  defaultSort: { key: 'registeredAt', dir: 'asc' },
  notes: ['reports.pat.notes.registrations'],
}

/** The patients reports, in the order the side list shows them. */
export const PATIENTS_REPORTS: AnyReportDef[] = [visited, visits, registrations]

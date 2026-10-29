import i18n from '@/i18n'
import { keyOptions, matches, searchText, selected, switchedOn } from '@/lib/api/reports-options'
import {
  BOOKING_STATUSES,
  clinicalOptions,
  loadBookings,
  loadDiagnoses,
  loadPatientsSeen,
  loadPrescriptions,
  loadTests,
  loadVitals,
  OUTCOMES,
  RX_STATUSES,
  TEST_STATUSES,
  type BookingRow,
  type BookingSource,
  type BookingStatus,
  type DiagnosisRow,
  type Outcome,
  type PatientSeenRow,
  type PrescriptionRow,
  type RxStatus,
  type Sex,
  type Supply,
  type TestRow,
  type TestStatus,
  type VitalFlag,
  type VitalsRow,
} from '@/lib/api/reports-clinical'
import { packsOf, w } from './stock'
import type {
  AnyReportDef,
  ReportColumnDef,
  ReportContext,
  ReportFigureDef,
  ReportFilterDef,
  ReportFilterValues,
  ReportGroupDef,
} from './types'

/**
 * The clinical reports (migration 0112): patients seen, diagnoses (ICD-10), prescriptions, tests
 * and exams, vital signs, bookings and arrivals. Each shows what its reader may see on the screens
 * (0088): the manager everything, a head their departments' visits, a clinician their own work;
 * the diagnoses, results and measurements are clinical columns (offered to clinical readers only).
 */

const C = 'reports.clinical'

// ---------------------------------------------------------------- who reads what

/** Reads clinical reports beyond their own work: the manager and the heads. */
const wide = (ctx: ReportContext) => ctx.isManager || ctx.isHead
/** A clinician, the manager or a head. */
const clinicalReader = (ctx: ReportContext) => wide(ctx) || ctx.clinical

// ---------------------------------------------------------------- words of the cells

const sexWord = (s: Sex | null | undefined) =>
  s === 'female'
    ? w(`${C}.sex.female`, 'Female')
    : s === 'male'
      ? w(`${C}.sex.male`, 'Male')
      : w(`${C}.sex.unknown`, 'Not known')
const AGE_BANDS: [number, number, string, string][] = [
  [0, 4, 'age0to4', '0–4 years'],
  [5, 14, 'age5to14', '5–14 years'],
  [15, 24, 'age15to24', '15–24 years'],
  [25, 49, 'age25to49', '25–49 years'],
  [50, 200, 'age50plus', '50 years and over'],
]
const bandOf = (age: number | null) =>
  age == null ? -1 : AGE_BANDS.findIndex(([lo, hi]) => age >= lo && age <= hi)
const bandWord = (age: number | null) => {
  const b = AGE_BANDS[bandOf(age)]
  return b ? w(`${C}.band.${b[2]}`, b[3]) : w(`${C}.band.unknown`, 'Age not known')
}
const deskWord = (d: string | null) =>
  d ? String(i18n.t(`${C}.desk.${d}`, { defaultValue: d })) : w(`${C}.desk.none`, 'Diagnosis only')
const dayOf = (iso: string | null) => (iso ? iso.slice(0, 10) : '')
const sum = <R>(rows: R[], f: (r: R) => number | null | undefined) =>
  rows.reduce((s, r) => s + (Number(f(r)) || 0), 0)
const fig = (label: string, value: number, unit?: string): ReportFigureDef => ({
  label: `${C}.fig.${label}`,
  value,
  unit,
})
const one = <T extends string>(
  f: ReportFilterValues,
  key: string,
  list: readonly T[],
): T | null => {
  const v = selected(f, key)
  return v && (list as readonly string[]).includes(v) ? (v as T) : null
}
const search = <R>(
  rows: R[],
  f: ReportFilterValues,
  fields: (r: R) => (string | null | undefined)[],
) => {
  const q = searchText(f)
  return q ? rows.filter((r) => matches(q, ...fields(r))) : rows
}

// ---------------------------------------------------------------- shared filters and columns

const periodFilter = (d: 'today' | 'week' | 'month' = 'month'): ReportFilterDef => ({
  key: 'period',
  label: `${C}.f.period`,
  kind: 'period',
  default: d,
})
const personFilter = (
  key: string,
  label: string,
  allowed: (ctx: ReportContext) => boolean,
): ReportFilterDef => ({
  key,
  label,
  kind: 'select',
  allowed,
  loadOptions: async (ctx) =>
    (await clinicalOptions(ctx)).clinicians.map((c) => ({ value: c.id, label: c.name })),
})
const departmentFilter: ReportFilterDef = {
  key: 'department',
  label: `${C}.f.department`,
  kind: 'select',
  allowed: wide,
  loadOptions: async (ctx) =>
    (await clinicalOptions(ctx)).departments.map((d) => ({ value: d.id, label: d.name })),
}
const searchFilter: ReportFilterDef = {
  key: 'search',
  label: `${C}.f.search`,
  kind: 'text',
  placeholder: `${C}.f.searchHint`,
}
function patientColumns<
  R extends { patient: string | null; fileNo: string | null },
>(): ReportColumnDef<R>[] {
  return [
    { key: 'patient', label: `${C}.col.patient`, default: true, value: (r) => r.patient },
    {
      key: 'fileNo',
      label: `${C}.col.fileNo`,
      nowrap: true,
      default: true,
      value: (r) => r.fileNo,
    },
  ]
}
const dayGroup = <R>(at: (r: R) => string | null): ReportGroupDef<R> => ({
  key: 'day',
  label: `${C}.g.day`,
  heading: `${C}.col.day`,
  value: (r) => dayOf(at(r)),
  order: (r) => dayOf(at(r)),
})

// ---------------------------------------------------------------- 10 · patients seen

const outcomeWord = (o: Outcome) =>
  w(
    `${C}.outcome.${o}`,
    {
      finished: 'Finished',
      referred: 'Referred on',
      left: 'Left before the end',
      open: 'Still in the clinic',
    }[o],
  )

const patientsSeen: AnyReportDef = {
  id: 'clinical.patientsSeen',
  group: 'clinical',
  title: `${C}.seen.title`,
  description: `${C}.seen.description`,
  code: 'PTS',
  allowed: clinicalReader,
  filters: [
    periodFilter('month'),
    personFilter('clinician', `${C}.f.clinician`, wide),
    departmentFilter,
    {
      key: 'outcome',
      label: `${C}.f.outcome`,
      kind: 'select',
      options: keyOptions(`${C}.outcome`, OUTCOMES),
    },
    searchFilter,
  ],
  columns: [
    {
      key: 'visitAt',
      label: `${C}.col.visitAt`,
      kind: 'datetime',
      default: true,
      value: (r: PatientSeenRow) => r.visitAt,
    },
    { key: 'reference', label: `${C}.col.reference`, nowrap: true, value: (r) => r.reference },
    ...patientColumns<PatientSeenRow>(),
    { key: 'age', label: `${C}.col.age`, kind: 'number', default: true, value: (r) => r.age },
    { key: 'sex', label: `${C}.col.sex`, default: true, value: (r) => sexWord(r.sex) },
    { key: 'clinician', label: `${C}.col.clinician`, value: (r) => r.clinician },
    { key: 'desk', label: `${C}.col.desk`, value: (r) => deskWord(r.desk) },
    { key: 'department', label: `${C}.col.department`, value: (r) => r.department },
    {
      key: 'diagnosis',
      label: `${C}.col.diagnosis`,
      sensitive: true,
      default: true,
      value: (r) => r.diagnosis,
    },
    {
      key: 'prescriptions',
      label: `${C}.col.prescriptions`,
      kind: 'number',
      total: 'sum',
      default: true,
      value: (r) => r.prescriptions,
    },
    {
      key: 'tests',
      label: `${C}.col.tests`,
      kind: 'number',
      total: 'sum',
      default: true,
      value: (r) => r.tests,
    },
    {
      key: 'outcome',
      label: `${C}.col.outcome`,
      default: true,
      value: (r) => outcomeWord(r.outcome),
    },
  ],
  async load(f, ctx) {
    let rows = await loadPatientsSeen(
      {
        period: f.period,
        clinician: selected(f, 'clinician'),
        department: selected(f, 'department'),
      },
      ctx,
    )
    const o = one(f, 'outcome', OUTCOMES)
    if (o) rows = rows.filter((r) => r.outcome === o)
    return search(rows, f, (r) => [r.patient, r.fileNo, r.reference, r.clinician])
  },
  figures: (rows: PatientSeenRow[]) => [
    fig('visits', new Set(rows.map((r) => r.encounterId)).size),
    fig('patients', new Set(rows.map((r) => r.patientId)).size),
    fig(
      'prescriptions',
      sum(rows, (r) => r.prescriptions),
    ),
    fig(
      'tests',
      sum(rows, (r) => r.tests),
    ),
  ],
  groups: [
    {
      key: 'clinician',
      label: `${C}.g.clinician`,
      heading: `${C}.col.clinician`,
      value: (r: PatientSeenRow) => r.clinician,
    },
    {
      key: 'outcome',
      label: `${C}.g.outcome`,
      heading: `${C}.col.outcome`,
      value: (r: PatientSeenRow) => outcomeWord(r.outcome),
    },
    {
      key: 'desk',
      label: `${C}.g.desk`,
      heading: `${C}.col.desk`,
      value: (r: PatientSeenRow) => deskWord(r.desk),
    },
    {
      key: 'sex',
      label: `${C}.g.sex`,
      heading: `${C}.col.sex`,
      value: (r: PatientSeenRow) => sexWord(r.sex),
    },
    {
      key: 'ageBand',
      label: `${C}.g.ageBand`,
      heading: `${C}.col.ageBand`,
      value: (r: PatientSeenRow) => bandWord(r.age),
      order: (r: PatientSeenRow) => bandOf(r.age),
    },
    dayGroup<PatientSeenRow>((r) => r.visitAt),
  ],
  defaultSort: { key: 'visitAt', dir: 'desc' },
  countLabel: `${C}.count.seen`,
  notes: [`${C}.seen.note1`, `${C}.seen.note2`, `${C}.seen.note3`],
  wide: true,
}

// ---------------------------------------------------------------- 11 · diagnoses

const diagnoses: AnyReportDef = {
  id: 'clinical.diagnoses',
  group: 'clinical',
  title: `${C}.dx.title`,
  description: `${C}.dx.description`,
  code: 'DX',
  allowed: (ctx) => wide(ctx) || ctx.user.role === 'doctor' || ctx.user.dbRole === 'doctor',
  filters: [
    periodFilter('month'),
    departmentFilter,
    personFilter('doctor', `${C}.f.doctor`, wide),
    searchFilter,
  ],
  columns: [
    {
      key: 'code',
      label: `${C}.col.icd10`,
      nowrap: true,
      default: true,
      value: (r: DiagnosisRow) => r.code,
    },
    { key: 'diagnosis', label: `${C}.col.diagnosis`, default: true, value: (r) => r.diagnosis },
    {
      key: 'cases',
      label: `${C}.col.cases`,
      kind: 'number',
      total: 'sum',
      default: true,
      value: (r) => r.cases,
    },
    {
      key: 'newCases',
      label: `${C}.col.newCases`,
      kind: 'number',
      total: 'sum',
      default: true,
      value: (r) => r.newCases,
    },
    {
      key: 'followUp',
      label: `${C}.col.followUp`,
      kind: 'number',
      total: 'sum',
      default: true,
      value: (r) => r.followUp,
    },
    {
      key: 'female',
      label: `${C}.col.female`,
      kind: 'number',
      total: 'sum',
      default: true,
      value: (r) => r.female,
    },
    {
      key: 'male',
      label: `${C}.col.male`,
      kind: 'number',
      total: 'sum',
      default: true,
      value: (r) => r.male,
    },
    {
      key: 'patients',
      label: `${C}.col.patients`,
      kind: 'number',
      total: 'sum',
      value: (r) => r.patients,
    },
    {
      key: 'primary',
      label: `${C}.col.primary`,
      kind: 'number',
      total: 'sum',
      value: (r) => r.primary,
    },
    ...AGE_BANDS.map(([, , key]): ReportColumnDef<DiagnosisRow> => ({
      key,
      label: `${C}.band.${key}`,
      kind: 'number',
      total: 'sum',
      value: (r) => r[key as keyof DiagnosisRow] as number,
    })),
    {
      key: 'ageUnknown',
      label: `${C}.band.unknown`,
      kind: 'number',
      total: 'sum',
      value: (r) => r.ageUnknown,
    },
  ],
  async load(f, ctx) {
    const rows = await loadDiagnoses(
      { period: f.period, department: selected(f, 'department'), doctor: selected(f, 'doctor') },
      ctx,
    )
    return search(rows, f, (r) => [r.code, r.diagnosis])
  },
  figures: (rows: DiagnosisRow[]) => [
    fig('diagnoses', rows.length),
    fig(
      'cases',
      sum(rows, (r) => r.cases),
    ),
    fig(
      'newCases',
      sum(rows, (r) => r.newCases),
    ),
    fig(
      'followUp',
      sum(rows, (r) => r.followUp),
    ),
  ],
  groups: [
    {
      key: 'chapter',
      label: `${C}.g.chapter`,
      heading: `${C}.col.chapter`,
      value: (r: DiagnosisRow) => (r.code ? r.code.charAt(0) : w(`${C}.noCode`, 'No ICD-10 code')),
    },
  ],
  defaultSort: { key: 'cases', dir: 'desc' },
  countLabel: `${C}.count.diagnoses`,
  notes: [`${C}.dx.note1`, `${C}.dx.note2`, `${C}.dx.note3`],
  wide: true,
}

// ---------------------------------------------------------------- 12 · prescriptions

const supplyWord = (s: Supply) =>
  w(
    `${C}.supply.${s}`,
    { pharmacy: 'Clinic pharmacy', room: 'Given here', outside: 'Bought outside' }[s],
  )
const rxStatusWord = (s: RxStatus) =>
  w(
    `${C}.rx.${s}`,
    {
      given: 'Given',
      part: 'Part given',
      waiting: 'Waiting',
      not_given: 'Not given (none in the pharmacy)',
      outside: 'To buy outside',
      cancelled: 'Cancelled',
    }[s],
  )

const prescriptions: AnyReportDef = {
  id: 'clinical.prescriptions',
  group: 'clinical',
  title: `${C}.rx.title`,
  description: `${C}.rx.description`,
  code: 'RX',
  allowed: (ctx) => clinicalReader(ctx) || ctx.canDesk('pharmacy'),
  filters: [
    periodFilter('month'),
    {
      key: 'supply',
      label: `${C}.f.supply`,
      kind: 'select',
      options: keyOptions(`${C}.supply`, ['pharmacy', 'room', 'outside']),
    },
    {
      key: 'status',
      label: `${C}.f.status`,
      kind: 'select',
      options: keyOptions(`${C}.rx`, RX_STATUSES),
    },
    personFilter('prescriber', `${C}.f.prescriber`, (ctx) => wide(ctx) || ctx.canDesk('pharmacy')),
    searchFilter,
  ],
  columns: [
    {
      key: 'at',
      label: `${C}.col.prescribedAt`,
      kind: 'datetime',
      default: true,
      value: (r: PrescriptionRow) => r.at,
    },
    ...patientColumns<PrescriptionRow>().map((c) =>
      c.key === 'fileNo' ? { ...c, default: false } : c,
    ),
    { key: 'medicine', label: `${C}.col.medicine`, default: true, value: (r) => r.medicine },
    {
      key: 'quantity',
      label: `${C}.col.quantity`,
      kind: 'number',
      default: true,
      value: (r) => r.quantity,
    },
    { key: 'packs', label: `${C}.col.packs`, value: (r) => packsOf(r, r.quantity) },
    { key: 'given', label: `${C}.col.given`, kind: 'number', value: (r) => r.given },
    { key: 'supply', label: `${C}.col.supply`, default: true, value: (r) => supplyWord(r.supply) },
    {
      key: 'status',
      label: `${C}.col.status`,
      default: true,
      value: (r) => rxStatusWord(r.status),
    },
    { key: 'prescriber', label: `${C}.col.prescriber`, default: true, value: (r) => r.prescriber },
    { key: 'dose', label: `${C}.col.dose`, sensitive: true, value: (r) => r.dose },
    { key: 'reason', label: `${C}.col.reason`, value: (r) => r.reason },
  ],
  async load(f, ctx) {
    let rows = await loadPrescriptions(
      {
        period: f.period,
        supply: one(f, 'supply', ['pharmacy', 'room', 'outside'] as const),
        prescriber: selected(f, 'prescriber'),
      },
      ctx,
    )
    const s = one(f, 'status', RX_STATUSES)
    if (s) rows = rows.filter((r) => r.status === s)
    return search(rows, f, (r) => [r.medicine, r.code, r.patient, r.fileNo])
  },
  figures: (rows: PrescriptionRow[]) => [
    fig('lines', rows.length),
    fig('patients', new Set(rows.map((r) => r.patientId)).size),
    fig('given', rows.filter((r) => r.status === 'given').length),
    fig('outside', rows.filter((r) => r.supply === 'outside').length),
  ],
  groups: [
    {
      key: 'medicine',
      label: `${C}.g.medicine`,
      heading: `${C}.col.medicine`,
      value: (r: PrescriptionRow) => r.medicine,
    },
    {
      key: 'prescriber',
      label: `${C}.g.prescriber`,
      heading: `${C}.col.prescriber`,
      value: (r: PrescriptionRow) => r.prescriber ?? '',
    },
    {
      key: 'supply',
      label: `${C}.g.supply`,
      heading: `${C}.col.supply`,
      value: (r: PrescriptionRow) => supplyWord(r.supply),
    },
    {
      key: 'status',
      label: `${C}.g.status`,
      heading: `${C}.col.status`,
      value: (r: PrescriptionRow) => rxStatusWord(r.status),
    },
  ],
  defaultSort: { key: 'at', dir: 'desc' },
  countLabel: `${C}.count.lines`,
  notes: [`${C}.rx.note1`, `${C}.rx.note2`],
  wide: true,
}

// ---------------------------------------------------------------- 13 · tests and exams

const testName = (r: TestRow) => {
  const lang = i18n.language
  return (lang === 'rw' ? r.testRw : lang === 'fr' ? r.testFr : null) || r.test
}
const testStatusWord = (s: TestStatus) =>
  w(
    `${C}.test.${s}`,
    {
      ordered: 'Asked',
      collected: 'Sample taken',
      in_process: 'In progress',
      resulted: 'Result written',
      verified: 'Validated',
      cancelled: 'Not done',
    }[s],
  )
const labDesk = (ctx: ReportContext) => ctx.canDesk('laboratory') || ctx.canDesk('ultrasound')

const tests: AnyReportDef = {
  id: 'lab.tests',
  group: 'lab',
  title: `${C}.tests.title`,
  description: `${C}.tests.description`,
  code: 'TST',
  allowed: (ctx) => clinicalReader(ctx) || labDesk(ctx),
  filters: [
    periodFilter('week'),
    {
      key: 'desk',
      label: `${C}.f.desk`,
      kind: 'select',
      options: keyOptions(`${C}.desk`, ['laboratory', 'ultrasound']),
    },
    {
      key: 'status',
      label: `${C}.f.status`,
      kind: 'select',
      options: keyOptions(`${C}.test`, TEST_STATUSES),
    },
    personFilter('requester', `${C}.f.requester`, (ctx) => wide(ctx) || labDesk(ctx)),
    searchFilter,
  ],
  columns: [
    {
      key: 'at',
      label: `${C}.col.askedAt`,
      kind: 'datetime',
      default: true,
      value: (r: TestRow) => r.at,
    },
    { key: 'test', label: `${C}.col.test`, default: true, value: (r) => testName(r) },
    { key: 'desk', label: `${C}.col.desk`, value: (r) => deskWord(r.desk) },
    ...patientColumns<TestRow>().map((c) => (c.key === 'fileNo' ? { ...c, default: false } : c)),
    { key: 'requester', label: `${C}.col.requester`, default: true, value: (r) => r.requester },
    {
      key: 'urgent',
      label: `${C}.col.urgent`,
      kind: 'yesno',
      total: 'count',
      value: (r) => r.urgent,
    },
    {
      key: 'status',
      label: `${C}.col.status`,
      default: true,
      value: (r) => testStatusWord(r.status),
    },
    { key: 'sampleId', label: `${C}.col.sampleId`, nowrap: true, value: (r) => r.sampleId },
    { key: 'sampleAt', label: `${C}.col.sampleAt`, kind: 'datetime', value: (r) => r.sampleAt },
    { key: 'resultAt', label: `${C}.col.resultAt`, kind: 'datetime', value: (r) => r.resultAt },
    {
      key: 'verifiedAt',
      label: `${C}.col.verifiedAt`,
      kind: 'datetime',
      default: true,
      value: (r) => r.verifiedAt,
    },
    {
      key: 'turnaround',
      label: `${C}.col.turnaround`,
      kind: 'number',
      total: 'avg',
      default: true,
      value: (r) => r.turnaround,
    },
    { key: 'resultBy', label: `${C}.col.resultBy`, value: (r) => r.resultBy },
    {
      key: 'result',
      label: `${C}.col.result`,
      sensitive: true,
      default: true,
      value: (r) => r.result,
    },
  ],
  async load(f, ctx) {
    const rows = await loadTests(
      {
        period: f.period,
        desk: selected(f, 'desk'),
        status: one(f, 'status', TEST_STATUSES),
        requester: selected(f, 'requester'),
      },
      ctx,
    )
    return search(rows, f, (r) => [r.test, r.testFr, r.testRw, r.patient, r.fileNo, r.sampleId])
  },
  figures: (rows: TestRow[]) => {
    const done = rows.filter((r) => r.turnaround != null)
    return [
      fig('tests', rows.length),
      fig('done', rows.filter((r) => r.status === 'verified' || r.status === 'resulted').length),
      fig('urgent', rows.filter((r) => r.urgent).length),
      fig(
        'turnaround',
        done.length ? Math.round(sum(done, (r) => r.turnaround) / done.length) : 0,
        `${C}.unit.min`,
      ),
    ]
  },
  groups: [
    {
      key: 'test',
      label: `${C}.g.test`,
      heading: `${C}.col.test`,
      value: (r: TestRow) => testName(r),
    },
    {
      key: 'requester',
      label: `${C}.g.requester`,
      heading: `${C}.col.requester`,
      value: (r: TestRow) => r.requester ?? '',
    },
    {
      key: 'status',
      label: `${C}.g.status`,
      heading: `${C}.col.status`,
      value: (r: TestRow) => testStatusWord(r.status),
      order: (r: TestRow) => TEST_STATUSES.indexOf(r.status),
    },
    {
      key: 'desk',
      label: `${C}.g.desk`,
      heading: `${C}.col.desk`,
      value: (r: TestRow) => deskWord(r.desk),
    },
  ],
  defaultSort: { key: 'at', dir: 'desc' },
  countLabel: `${C}.count.tests`,
  notes: [`${C}.tests.note1`, `${C}.tests.note2`, `${C}.tests.note3`],
  wide: true,
}

// ---------------------------------------------------------------- 14 · vital signs

const flagWord = (f: VitalFlag) =>
  w(
    `${C}.flag.${f}`,
    {
      temp_high: 'Fever',
      temp_low: 'Low temperature',
      spo2_low: 'Low oxygen',
      bp_high: 'High blood pressure',
      bp_low: 'Low blood pressure',
      pulse_high: 'Fast pulse',
      pulse_low: 'Slow pulse',
      resp_high: 'Fast breathing',
      resp_low: 'Slow breathing',
    }[f],
  )
const vital = (r: VitalsRow, code: string) =>
  r.values?.[code] != null ? Number(r.values[code]) : null

const vitals: AnyReportDef = {
  id: 'clinical.vitals',
  group: 'clinical',
  title: `${C}.vitals.title`,
  description: `${C}.vitals.description`,
  code: 'VIT',
  allowed: (ctx) => clinicalReader(ctx) || ctx.can('vitals.write'),
  filters: [
    periodFilter('week'),
    personFilter('taker', `${C}.f.taker`, wide),
    {
      key: 'abnormalOnly',
      label: `${C}.f.abnormalOnly`,
      kind: 'toggle',
      allowed: (ctx) => ctx.clinical,
    },
    searchFilter,
  ],
  columns: [
    {
      key: 'at',
      label: `${C}.col.measuredAt`,
      kind: 'datetime',
      default: true,
      value: (r: VitalsRow) => r.at,
    },
    ...patientColumns<VitalsRow>().map((c) => (c.key === 'fileNo' ? { ...c, default: false } : c)),
    { key: 'age', label: `${C}.col.age`, kind: 'number', value: (r) => r.age },
    { key: 'measuredBy', label: `${C}.col.measuredBy`, default: true, value: (r) => r.measuredBy },
    { key: 'enteredBy', label: `${C}.col.enteredBy`, default: true, value: (r) => r.enteredBy },
    {
      key: 'onBehalf',
      label: `${C}.col.onBehalf`,
      kind: 'yesno',
      total: 'count',
      value: (r) => r.onBehalf,
    },
    {
      key: 'count',
      label: `${C}.col.measurements`,
      kind: 'number',
      total: 'sum',
      default: true,
      value: (r) => r.count,
    },
    {
      key: 'abnormal',
      label: `${C}.col.abnormal`,
      kind: 'number',
      total: 'sum',
      sensitive: true,
      default: true,
      value: (r) => r.flags?.length ?? 0,
    },
    {
      key: 'flags',
      label: `${C}.col.flags`,
      sensitive: true,
      default: true,
      value: (r) => (r.flags ?? []).map(flagWord).join(', '),
    },
    {
      key: 'bp',
      label: `${C}.col.bp`,
      sensitive: true,
      nowrap: true,
      value: (r) =>
        vital(r, 'bp_sys') != null ? `${vital(r, 'bp_sys')}/${vital(r, 'bp_dia') ?? '–'}` : null,
    },
    {
      key: 'pulse',
      label: `${C}.col.pulse`,
      kind: 'number',
      sensitive: true,
      value: (r) => vital(r, 'pulse'),
    },
    {
      key: 'temp',
      label: `${C}.col.temp`,
      kind: 'number',
      sensitive: true,
      value: (r) => vital(r, 'temp'),
    },
    {
      key: 'spo2',
      label: `${C}.col.spo2`,
      kind: 'number',
      sensitive: true,
      value: (r) => vital(r, 'spo2'),
    },
    {
      key: 'weight',
      label: `${C}.col.weight`,
      kind: 'number',
      sensitive: true,
      value: (r) => vital(r, 'weight'),
    },
  ],
  async load(f, ctx) {
    let rows = await loadVitals({ period: f.period, taker: selected(f, 'taker') }, ctx)
    if (ctx.clinical && switchedOn(f, 'abnormalOnly')) rows = rows.filter((r) => r.flags?.length)
    return search(rows, f, (r) => [r.patient, r.fileNo, r.measuredBy, r.enteredBy])
  },
  figures: (rows: VitalsRow[]) => [
    fig('sets', rows.length),
    fig(
      'measurements',
      sum(rows, (r) => r.count),
    ),
    fig('onBehalf', rows.filter((r) => r.onBehalf).length),
    fig('patients', new Set(rows.map((r) => r.patientId)).size),
  ],
  groups: [
    {
      key: 'measuredBy',
      label: `${C}.g.measuredBy`,
      heading: `${C}.col.measuredBy`,
      value: (r: VitalsRow) => r.measuredBy ?? '',
    },
    {
      key: 'enteredBy',
      label: `${C}.g.enteredBy`,
      heading: `${C}.col.enteredBy`,
      value: (r: VitalsRow) => r.enteredBy ?? '',
    },
    dayGroup<VitalsRow>((r) => r.at),
  ],
  defaultSort: { key: 'at', dir: 'desc' },
  countLabel: `${C}.count.sets`,
  notes: [`${C}.vitals.note1`, `${C}.vitals.note2`],
  wide: true,
}

// ---------------------------------------------------------------- 15 · bookings and arrivals

const bookingWord = (s: BookingStatus) =>
  w(
    `${C}.booking.${s}`,
    {
      requested: 'Requested',
      approved: 'Approved',
      confirmed: 'Confirmed',
      arrived: 'Arrived',
      with_clinician: 'With the clinician',
      seen: 'Seen',
      left_unseen: 'Left before being seen',
      no_show: 'Did not come',
      cancelled: 'Cancelled',
      declined: 'Declined',
    }[s],
  )
const sourceWord = (s: BookingSource) =>
  w(`${C}.source.${s}`, { online: 'Website', reception: 'Reception', phone: 'Phone' }[s])
const serviceWord = (s: string | null) =>
  s ? String(i18n.t(`categories.${s}`, { defaultValue: s })) : null
const SEEN: readonly BookingStatus[] = ['arrived', 'with_clinician', 'seen', 'left_unseen']

const bookings: AnyReportDef = {
  id: 'reception.bookings',
  group: 'reception',
  title: `${C}.bookings.title`,
  description: `${C}.bookings.description`,
  code: 'BKG',
  allowed: (ctx) =>
    ctx.isManager ||
    ctx.canDesk('reception') ||
    ['doctor', 'nurse', 'sonographer'].includes(ctx.user.dbRole ?? ctx.user.role),
  filters: [
    periodFilter('week'),
    {
      key: 'status',
      label: `${C}.f.status`,
      kind: 'select',
      options: keyOptions(`${C}.booking`, BOOKING_STATUSES),
    },
    {
      key: 'practitioner',
      label: `${C}.f.practitioner`,
      kind: 'select',
      allowed: (ctx) => ctx.isManager || ctx.canDesk('reception'),
      loadOptions: async (ctx) =>
        (await clinicalOptions(ctx)).practitioners.map((p) => ({ value: p.id, label: p.name })),
    },
    {
      key: 'source',
      label: `${C}.f.source`,
      kind: 'select',
      options: keyOptions(`${C}.source`, ['online', 'reception', 'phone']),
    },
    searchFilter,
  ],
  columns: [
    {
      key: 'at',
      label: `${C}.col.bookedFor`,
      kind: 'datetime',
      default: true,
      value: (r: BookingRow) => r.at,
    },
    ...patientColumns<BookingRow>().map((c) => (c.key === 'fileNo' ? { ...c, default: false } : c)),
    { key: 'phone', label: `${C}.col.phone`, nowrap: true, default: true, value: (r) => r.phone },
    { key: 'bookedWith', label: `${C}.col.bookedWith`, default: true, value: (r) => r.bookedWith },
    {
      key: 'service',
      label: `${C}.col.service`,
      default: true,
      value: (r) => serviceWord(r.service),
    },
    { key: 'status', label: `${C}.col.status`, default: true, value: (r) => bookingWord(r.status) },
    { key: 'source', label: `${C}.col.source`, default: true, value: (r) => sourceWord(r.source) },
    { key: 'arrivedAt', label: `${C}.col.arrivedAt`, kind: 'time', value: (r) => r.arrivedAt },
    { key: 'createdAt', label: `${C}.col.bookedOn`, kind: 'datetime', value: (r) => r.createdAt },
    { key: 'reference', label: `${C}.col.reference`, nowrap: true, value: (r) => r.reference },
    { key: 'reason', label: `${C}.col.reason`, sensitive: true, value: (r) => r.reason },
    { key: 'cancelReason', label: `${C}.col.cancelReason`, value: (r) => r.cancelReason },
  ],
  async load(f, ctx) {
    const rows = await loadBookings(
      {
        period: f.period,
        status: one(f, 'status', BOOKING_STATUSES),
        practitioner: selected(f, 'practitioner'),
        source: one(f, 'source', ['online', 'reception', 'phone'] as const),
      },
      ctx,
    )
    return search(rows, f, (r) => [r.patient, r.fileNo, r.phone, r.reference, r.bookedWith])
  },
  figures: (rows: BookingRow[]) => [
    fig('bookings', rows.length),
    fig('arrived', rows.filter((r) => SEEN.includes(r.status)).length),
    fig('seen', rows.filter((r) => r.status === 'seen').length),
    fig('noShow', rows.filter((r) => r.status === 'no_show').length),
  ],
  groups: [
    {
      key: 'status',
      label: `${C}.g.status`,
      heading: `${C}.col.status`,
      value: (r: BookingRow) => bookingWord(r.status),
      order: (r: BookingRow) => BOOKING_STATUSES.indexOf(r.status),
    },
    {
      key: 'bookedWith',
      label: `${C}.g.practitioner`,
      heading: `${C}.col.bookedWith`,
      value: (r: BookingRow) => r.bookedWith ?? '',
    },
    {
      key: 'source',
      label: `${C}.g.source`,
      heading: `${C}.col.source`,
      value: (r: BookingRow) => sourceWord(r.source),
    },
    dayGroup<BookingRow>((r) => r.at),
  ],
  defaultSort: { key: 'at', dir: 'asc' },
  countLabel: `${C}.count.bookings`,
  notes: [`${C}.bookings.note1`, `${C}.bookings.note2`],
  wide: true,
}

/** The clinical reports (report centre). */
export const CLINICAL_REPORTS: AnyReportDef[] = [
  patientsSeen,
  diagnoses,
  prescriptions,
  tests,
  vitals,
  bookings,
]

import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { availableColumns, buildModel, defaultChoices } from '@/lib/reports/run'
import { CLINICAL_REPORTS } from './clinical'
import type { AnyReportDef, ReportContext, ReportFilterValues } from './types'

function ctxOf(o: {
  id: string
  role: string
  manager?: boolean
  head?: boolean
  desks?: string[]
  can?: string[]
  clinical?: boolean
}): ReportContext {
  return {
    user: { id: o.id, username: 'x', name: 'Sample', role: o.role as never },
    isManager: !!o.manager,
    isHead: !!o.head,
    can: (f) => (o.can ?? []).includes(f),
    canDesk: (d) => (o.desks ?? []).includes(d),
    holdsStore: false,
    clinical: !!o.clinical,
    sample: true,
  }
}
const MANAGER = ctxOf({ id: 'u-mgr', role: 'manager', manager: true, clinical: true })
const DOCTOR = ctxOf({ id: 'u-doc', role: 'doctor', desks: ['consultation'], clinical: true })
const HEAD = ctxOf({ id: 'u-head', role: 'doctor', head: true, desks: ['dental'], clinical: true })
const LAB = ctxOf({ id: 'u-lab', role: 'lab_tech', desks: ['laboratory'] })
const NURSE = ctxOf({
  id: 'u-nur',
  role: 'nurse',
  desks: ['nursing', 'triage'],
  can: ['vitals.write'],
  clinical: true,
})
const RECEPTION = ctxOf({
  id: 'u-rec',
  role: 'receptionist',
  desks: ['reception'],
  can: ['vitals.write'],
})
const PHARMACY = ctxOf({ id: 'p-pha', role: 'pharmacist', desks: ['pharmacy'] })
const CASHIER = ctxOf({ id: 'u-cash', role: 'cashier', desks: ['cashier'] })

function filtersOf(def: AnyReportDef, extra: Record<string, unknown> = {}): ReportFilterValues {
  const to = new Date().toISOString().slice(0, 10)
  const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10)
  const values: Record<string, unknown> = {
    period: { range: 'month', from, to, label: `${from} – ${to}` },
  }
  for (const f of def.filters) {
    if (f.kind === 'period') continue
    values[f.key] = f.default ?? (f.kind === 'toggle' ? false : f.kind === 'multi' ? [] : '')
  }
  return { ...values, ...extra } as ReportFilterValues
}
async function run(def: AnyReportDef, ctx: ReportContext, extra: Record<string, unknown> = {}) {
  const rows = await def.load(filtersOf(def, extra), ctx)
  const columns = availableColumns(def.columns, ctx)
  const model = buildModel({
    def,
    rows,
    columns,
    choices: defaultChoices(def, columns),
    t: i18n.t.bind(i18n) as never,
  })
  return { rows, columns, model }
}
const def = (id: string) => CLINICAL_REPORTS.find((d) => d.id === id)!

describe('clinical reports', () => {
  it('who may run what', () => {
    const ids = (ctx: ReportContext) =>
      CLINICAL_REPORTS.filter((d) => d.allowed(ctx)).map((d) => d.id)
    expect(ids(MANAGER)).toHaveLength(6)
    expect(ids(DOCTOR)).toEqual([
      'clinical.patientsSeen',
      'clinical.diagnoses',
      'clinical.prescriptions',
      'lab.tests',
      'clinical.vitals',
      'reception.bookings',
    ])
    expect(ids(LAB)).toEqual(['lab.tests'])
    expect(ids(PHARMACY)).toEqual(['clinical.prescriptions'])
    expect(ids(RECEPTION)).toEqual(['clinical.vitals', 'reception.bookings'])
    expect(ids(CASHIER)).toEqual([])
  })

  it('patients seen: a doctor her own, a head their department, the manager everyone', async () => {
    const own = await run(def('clinical.patientsSeen'), DOCTOR)
    expect(own.rows.length).toBeGreaterThan(0)
    expect(own.rows.every((r) => r.clinicianId === 'u-doc')).toBe(true)
    const head = await run(def('clinical.patientsSeen'), HEAD)
    expect(head.rows.every((r) => r.clinicianId === 'u-head')).toBe(true)
    const all = await run(def('clinical.patientsSeen'), MANAGER)
    expect(new Set(all.rows.map((r) => r.clinicianId)).size).toBeGreaterThan(2)
    const one = await run(def('clinical.patientsSeen'), MANAGER, { clinician: 'p-doc2' })
    expect(one.rows.every((r) => r.clinicianId === 'p-doc2')).toBe(true)
    // the diagnosis is a clinical column: offered to clinical readers only
    expect(own.columns.some((c) => c.key === 'diagnosis')).toBe(true)
    const visits = own.model.columns.map((c) => c.key)
    expect(visits).toContain('outcome')
  })

  it('diagnoses: new + follow-up = cases = women + men, the age bands add up', async () => {
    const { rows, model } = await run(def('clinical.diagnoses'), MANAGER)
    for (const r of rows) {
      expect(r.newCases + r.followUp).toBe(r.cases)
      expect(r.female + r.male + r.otherSex).toBe(r.cases)
      expect(r.age0to4 + r.age5to14 + r.age15to24 + r.age25to49 + r.age50plus + r.ageUnknown).toBe(
        r.cases,
      )
    }
    const cases = model.columns.findIndex((c) => c.key === 'cases')
    expect(model.totals[cases]).toBe(rows.reduce((s, r) => s + r.cases, 0))
  })

  it('tests: the laboratory desk sees its tests without the result column; turnaround averaged', async () => {
    const lab = await run(def('lab.tests'), LAB, { desk: 'laboratory' })
    expect(lab.rows.length).toBeGreaterThan(0)
    expect(lab.rows.every((r) => r.desk === 'laboratory')).toBe(true)
    expect(lab.columns.some((c) => c.key === 'result')).toBe(false)
    const mgr = await run(def('lab.tests'), MANAGER)
    const tat = mgr.model.columns.findIndex((c) => c.key === 'turnaround')
    const done = mgr.rows.filter((r) => r.turnaround != null)
    // the engine gives the average to one decimal
    expect(mgr.model.totals[tat]).toBeCloseTo(
      done.reduce((s, r) => s + r.turnaround, 0) / done.length,
      0,
    )
  })

  it('vital signs: the nurse her sets, reception the sets she typed, flags only for clinical readers', async () => {
    const nurse = await run(def('clinical.vitals'), NURSE)
    expect(nurse.rows.every((r) => r.measuredById === 'u-nur')).toBe(true)
    const rec = await run(def('clinical.vitals'), RECEPTION)
    expect(rec.rows.every((r) => r.enteredById === 'u-rec')).toBe(true)
    expect(rec.columns.some((c) => c.key === 'flags' || c.key === 'temp')).toBe(false)
    const fever = await run(def('clinical.vitals'), NURSE, { abnormalOnly: true })
    expect(fever.rows.every((r) => r.flags.length > 0)).toBe(true)
  })

  it('bookings: reception sees every practitioner, a doctor her own', async () => {
    const rec = await run(def('reception.bookings'), RECEPTION, {
      period: {
        range: 'custom',
        from: new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10),
        to: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
        label: '',
      },
    })
    expect(new Set(rec.rows.map((r) => r.practitionerId)).size).toBeGreaterThan(1)
    const doc = await run(def('reception.bookings'), DOCTOR)
    expect(doc.rows.every((r) => r.practitionerId === 'pr-u-doc')).toBe(true)
  })

  it('prescriptions: a doctor her own, the pharmacy every prescriber', async () => {
    const doc = await run(def('clinical.prescriptions'), DOCTOR)
    expect(doc.rows.every((r) => r.prescriberId === 'u-doc')).toBe(true)
    const ph = await run(def('clinical.prescriptions'), PHARMACY)
    expect(new Set(ph.rows.map((r) => r.prescriberId)).size).toBeGreaterThan(1)
    expect(ph.columns.some((c) => c.key === 'dose')).toBe(false)
    const outside = await run(def('clinical.prescriptions'), MANAGER, { supply: 'outside' })
    expect(outside.rows.every((r) => r.supply === 'outside' && r.status === 'outside')).toBe(true)
  })
})

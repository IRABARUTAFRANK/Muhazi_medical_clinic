import { resources } from '@mmc/shared/i18n'
import { describe, expect, it } from 'vitest'
import { ALL_REPORTS, reportsFor } from './catalog'
import type { ReportContext } from './defs/types'
import { ALL_SHEETS, sheetsFor, signsPrescriptions } from './sheets'

/** The words of a key ("reports.clinical.dx.title") in one language; undefined when missing. */
const wordAt = (lang: 'en' | 'fr' | 'rw', key: string): string | undefined => {
  let at: unknown = resources[lang].translation
  for (const part of key.split('.')) at = (at as Record<string, unknown> | undefined)?.[part]
  return typeof at === 'string' ? at : undefined
}

/** Who reads which groups of reports (0182): by role, the head of a department a little more. */

function ctxOf(o: {
  id: string
  role: string
  manager?: boolean
  head?: boolean
  desks?: string[]
  can?: string[]
  clinical?: boolean
  store?: boolean
}): ReportContext {
  return {
    user: { id: o.id, username: 'x', name: 'Sample', role: o.role as never },
    isManager: !!o.manager,
    isHead: !!o.head,
    can: (f) => (o.can ?? []).includes(f),
    canDesk: (d) => (o.desks ?? []).includes(d),
    holdsStore: !!o.store,
    clinical: !!o.clinical,
    sample: true,
  }
}
const groupsOf = (ctx: ReportContext) => [...new Set(reportsFor(ctx).map((r) => r.group))].sort()
const idsOf = (ctx: ReportContext) => reportsFor(ctx).map((r) => r.id)

const MANAGER = ctxOf({ id: 'u-mgr', role: 'manager', manager: true, clinical: true })
const DOCTOR = ctxOf({ id: 'u-doc', role: 'doctor', desks: ['consultation'], clinical: true })
const DOCTOR_HEAD = ctxOf({
  id: 'u-head',
  role: 'doctor',
  head: true,
  desks: ['dental'],
  clinical: true,
})
const NURSE = ctxOf({
  id: 'u-nur',
  role: 'nurse',
  desks: ['nursing', 'triage'],
  can: ['vitals.write'],
})
const LAB = ctxOf({ id: 'u-lab', role: 'lab_tech', desks: ['laboratory'] })
const RECEPTION = ctxOf({
  id: 'u-rec',
  role: 'receptionist',
  desks: ['reception'],
  can: ['vitals.write'],
})
const PHARMACY = ctxOf({ id: 'p-pha', role: 'pharmacist', desks: ['pharmacy'] })
const CASHIER = ctxOf({
  id: 'u-cash',
  role: 'cashier',
  desks: ['cashier'],
  can: ['billing.read', 'payment.take'],
})
const FINANCE_HEAD = ctxOf({
  id: 'u-fin',
  role: 'cashier',
  head: true,
  desks: ['cashier'],
  can: ['billing.read', 'payment.take'],
})

describe('who reads which reports (0182)', () => {
  it('the manager: every group', () => {
    expect(groupsOf(MANAGER)).toEqual([
      'clinical',
      'finance',
      'lab',
      'patients',
      'pharmacy',
      'reception',
      'staff',
      'stock',
    ])
  })

  it('a doctor: the patients and their care — never the money, the stock or the staff', () => {
    expect(groupsOf(DOCTOR)).toEqual(['clinical', 'lab', 'patients', 'reception'])
    expect(idsOf(DOCTOR)).toContain('patients.visits')
    expect(idsOf(DOCTOR)).toContain('patients.registrations')
    expect(idsOf(DOCTOR)).not.toContain('finance.revenue')
    // the head of a treating department adds their department's people and services
    expect(groupsOf(DOCTOR_HEAD)).toEqual([
      'clinical',
      'finance',
      'lab',
      'patients',
      'reception',
      'staff',
    ])
    expect(idsOf(DOCTOR_HEAD).filter((id) => id.startsWith('finance.'))).toEqual([
      'finance.services',
    ])
  })

  it('the cashier (the accountant): the money only, even as the head of the finance desk', () => {
    expect(groupsOf(CASHIER)).toEqual(['finance', 'pharmacy'])
    expect(idsOf(CASHIER).filter((id) => id.startsWith('pharmacy.'))).toEqual([
      'pharmacy.walkInSales',
    ])
    expect(idsOf(CASHIER)).toContain('finance.payroll')
    // the head of the finance desk: + their people; no patients, no clinical, no laboratory
    expect(groupsOf(FINANCE_HEAD)).toEqual(['finance', 'pharmacy', 'staff'])
  })

  it('reception, the nurses, the laboratory, the pharmacy: their own work', () => {
    expect(idsOf(RECEPTION)).toEqual([
      'patients.registrations',
      'clinical.vitals',
      'reception.bookings',
    ])
    expect(idsOf(NURSE)).toEqual(['clinical.vitals', 'reception.bookings'])
    expect(idsOf(LAB)).toEqual(['lab.tests'])
    expect(groupsOf(PHARMACY)).toEqual(['clinical', 'finance', 'pharmacy', 'stock'])
    expect(idsOf(PHARMACY).filter((id) => id.startsWith('clinical.'))).toEqual([
      'clinical.prescriptions',
    ])
  })
})

describe('the sheets to write by hand (0197)', () => {
  const sheetsOf = (ctx: ReportContext) => sheetsFor(ctx).map((s) => s.id)

  it('the blank prescription: the doctors and the manager, with no patient to choose', () => {
    expect(sheetsOf(DOCTOR)).toEqual(['sheets.blankRx'])
    expect(sheetsOf(DOCTOR_HEAD)).toEqual(['sheets.blankRx'])
    expect(sheetsOf(MANAGER)).toEqual(['sheets.blankRx'])
    // a nurse works at the treating desks too: she does not prescribe, no sheet
    const NURSE_CONSULTATION = ctxOf({ id: 'u-nc', role: 'nurse', desks: ['consultation'] })
    for (const other of [
      NURSE,
      NURSE_CONSULTATION,
      LAB,
      RECEPTION,
      PHARMACY,
      CASHIER,
      FINANCE_HEAD,
    ])
      expect(sheetsOf(other)).toEqual([])
  })

  it('the prescriber is printed for someone who prescribes, left to write for the others', () => {
    expect(signsPrescriptions(DOCTOR)).toBe(true)
    expect(signsPrescriptions(DOCTOR_HEAD)).toBe(true)
    // a manager who is not a doctor prints the sheets for the doctors
    expect(signsPrescriptions(ctxOf({ id: 'u-adm', role: 'manager', manager: true }))).toBe(false)
  })

  it('a sheet is never taken for a report, and has its words in the three languages', () => {
    const reportIds = new Set(ALL_REPORTS.map((r) => r.id))
    for (const s of ALL_SHEETS) {
      expect(reportIds.has(s.id)).toBe(false)
      for (const lang of ['en', 'fr', 'rw'] as const)
        for (const key of [s.title, s.description]) expect(wordAt(lang, key)).toBeTruthy()
    }
  })
})

describe('no disease code in what people read (0197)', () => {
  it('the words files never say ICD-10 (CIM-10), in the three languages', () => {
    for (const lang of ['en', 'fr', 'rw'] as const)
      expect(JSON.stringify(resources[lang])).not.toMatch(/\bICD\b|ICD-?10|\bCIM\b|CIM-?10/i)
  })

  it('the diagnoses report: named in plain words, no code column, no grouping by code', () => {
    const dx = ALL_REPORTS.find((r) => r.id === 'clinical.diagnoses')!
    expect(wordAt('en', dx.title)).toBe('Diagnoses')
    expect(wordAt('fr', dx.title)).toBe('Diagnostics')
    expect(wordAt('rw', dx.title)).toBe('Indwara zagaragaye')
    expect(dx.columns.map((c) => c.key)).not.toContain('code')
    expect(dx.columns[0]!.key).toBe('diagnosis')
    expect((dx.groups ?? []).map((g) => g.key)).not.toContain('chapter')
  })

  it('every report: each title, column, grouping and note has its words, none about a code', () => {
    for (const r of ALL_REPORTS) {
      const keys = [
        r.title,
        r.description,
        ...r.columns.filter((c) => !c.plainLabel).map((c) => c.label),
        ...(r.groups ?? []).flatMap((g) => [g.label, ...(g.heading ? [g.heading] : [])]),
        ...(r.notes ?? []),
      ]
      for (const key of keys) {
        const word = wordAt('en', key)
        expect(word, key).toBeTruthy()
        expect(word, key).not.toMatch(/ICD|disease code/i)
      }
    }
  })
})

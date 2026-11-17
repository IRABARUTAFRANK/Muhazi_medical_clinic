import { describe, expect, it } from 'vitest'
import { reportsFor } from './catalog'
import type { ReportContext } from './defs/types'

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

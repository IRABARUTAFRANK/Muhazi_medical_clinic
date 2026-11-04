import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { STAFF, findStaffByUsername } from '@mmc/shared'
import { homeRouteFor, navKeyForSection, professionLabel, roleLabel } from './roles'

/** Minimal t(): returns the key plus interpolated values, enough to assert shape. */
const t = ((key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${Object.values(opts).join(',')}` : key) as unknown as TFunction

// professionLabel names the profession with a default value: the fake t() shows it after a colon
describe('roleLabel', () => {
  it('adds the station only for doctors without a specialty', () => {
    expect(roleLabel(findStaffByUsername('b.mukamana')!, t)).toBe(
      'roles.withStation:roles.doctor,Consultation 1',
    )
    expect(roleLabel(findStaffByUsername('c.nyirahabimana')!, t)).toBe('roles.nurse')
  })
  it('prefers the specialty or title over the station, for every role', () => {
    const doctor = findStaffByUsername('b.mukamana')!
    // 0128: a specialty of the lists is translated; another one shows as typed
    expect(roleLabel(doctor, t, 'Dentist')).toBe(
      'roles.withStation:roles.doctor,specialties.dentist',
    )
    expect(roleLabel({ ...doctor, specialty: 'Surgeon' }, t)).toBe(
      'roles.withStation:roles.doctor,specialties.surgeon',
    )
    expect(roleLabel({ ...doctor, specialty: 'Minor surgery' }, t)).toBe(
      'roles.withStation:roles.doctor,Minor surgery',
    )
    expect(roleLabel(doctor, t, '  ')).toBe('roles.withStation:roles.doctor,Consultation 1')
    expect(roleLabel(findStaffByUsername('c.nyirahabimana')!, t, 'Midwife')).toBe(
      'roles.withStation:roles.nurse,specialties.midwife',
    )
  })
  it('0128: names the clinic manager by profession, then "Clinic manager"', () => {
    const mgr = findStaffByUsername('t.mugabo')!
    expect(roleLabel(mgr, t, 'General practitioner')).toBe(
      'staff.roles.doctor:doctor · specialties.generalPractitioner · roles.clinicManager',
    )
    expect(roleLabel(mgr, t)).toBe('staff.roles.doctor:doctor · roles.clinicManager')
    // an account the database has not moved yet
    expect(roleLabel({ ...mgr, dbRole: 'manager' }, t)).toBe('roles.clinicManager')
    expect(professionLabel({ role: 'administrator', isManager: true }, t)).toBe(
      'staff.roles.administrator:administrator · roles.clinicManager',
    )
    expect(professionLabel({ role: 'midwife', specialty: 'Midwife' }, t)).toBe(
      'staff.roles.midwife:midwife · specialties.midwife',
    )
  })
  it('names a sonographer as such, and does not repeat the role as the title', () => {
    const lab = findStaffByUsername('c.nyirahabimana')!
    const sono = { ...lab, role: 'lab_tech' as const, dbRole: 'sonographer' }
    expect(roleLabel(sono, t)).toBe('staff.roles.sonographer')
    expect(roleLabel(sono, t, 'Radiographer')).toBe(
      'roles.withStation:staff.roles.sonographer,Radiographer',
    )
    expect(roleLabel(sono, t, 'STAFF.ROLES.SONOGRAPHER')).toBe('staff.roles.sonographer')
  })
  it('labels heads of station by the station they lead', () => {
    expect(roleLabel(findStaffByUsername('f.ndayisaba')!, t)).toBe('roles.headOf:Dental')
    expect(roleLabel(findStaffByUsername('f.ndayisaba')!, t, 'Dentist')).toBe('roles.headOf:Dental')
  })
})

describe('homeRouteFor', () => {
  it('sends managers to the dashboard and everyone else to the home page', () => {
    for (const user of STAFF) {
      expect(homeRouteFor(user)).toBe(user.role === 'manager' ? '/app/dashboard' : '/app')
    }
  })
})

describe('navKeyForSection', () => {
  it('maps kebab-case URL sections to camelCase nav keys', () => {
    expect(navKeyForSection('direct-sales')).toBe('nav.directSales')
    expect(navKeyForSection('patients')).toBe('nav.patients')
  })
})

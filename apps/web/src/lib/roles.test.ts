import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { STAFF, findStaffByUsername } from '@mmc/shared'
import { homeRouteFor, navKeyForSection, roleLabel } from './roles'

/** Minimal t(): returns the key plus interpolated values, enough to assert shape. */
const t = ((key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${Object.values(opts).join(',')}` : key) as unknown as TFunction

describe('roleLabel', () => {
  it('adds the station only for doctors', () => {
    expect(roleLabel(findStaffByUsername('b.mukamana')!, t)).toBe(
      'roles.withStation:roles.doctor,Consultation 1',
    )
    expect(roleLabel(findStaffByUsername('c.nyirahabimana')!, t)).toBe('roles.nurse')
  })
  it('labels heads of station by the station they lead', () => {
    expect(roleLabel(findStaffByUsername('f.ndayisaba')!, t)).toBe('roles.headOf:Dental')
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

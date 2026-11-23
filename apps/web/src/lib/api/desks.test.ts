import { describe, expect, it } from 'vitest'
import { desksFor } from './desks'

/** 0197: a doctor registers patients and starts visits by profession (the database's desk_via). */
describe('desksFor: the reception desk', () => {
  const offered = ['reception', 'consultation']
  const on = new Set(['visit.start', 'clinical.write', 'vitals.write'])

  it('a doctor in no reception department has it by profession', () => {
    const r = desksFor({ role: 'doctor', services: [['consultation']], offered, perms: on })
    expect(r.desks).toContain('reception')
    expect(r.via.reception).toBe('role')
    expect(r.via.consultation).toBe('department')
  })

  it('a doctor in the reception department has it from the department', () => {
    const r = desksFor({ role: 'doctor', services: [['reception']], offered, perms: on })
    expect(r.via.reception).toBe('department')
  })

  it('"Start visits" switched off takes it away', () => {
    const r = desksFor({
      role: 'doctor',
      services: [['consultation']],
      offered,
      perms: new Set(['clinical.write']),
    })
    expect(r.desks).not.toContain('reception')
  })

  it('reception out of the doctors’ desks takes it away', () => {
    const r = desksFor({
      role: 'doctor',
      services: [['consultation']],
      ceiling: ['consultation'],
      offered,
      perms: on,
    })
    expect(r.desks).not.toContain('reception')
  })

  it('a nurse still follows her departments', () => {
    const out = desksFor({ role: 'nurse', services: [['nursing']], offered, perms: on })
    expect(out.desks).not.toContain('reception')
    const inside = desksFor({ role: 'nurse', services: [['reception']], offered, perms: on })
    expect(inside.via.reception).toBe('department')
    // no department gives reception: the role decides, as before
    const free = desksFor({ role: 'nurse', services: [], offered: ['consultation'], perms: on })
    expect(free.via.reception).toBe('role')
  })
})

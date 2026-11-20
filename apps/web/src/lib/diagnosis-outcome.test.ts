import { describe, expect, it } from 'vitest'
import { confirmedLink, dxKey, outcomeOf } from './diagnosis-outcome'

describe('what the doctor decided about a possible diagnosis (0192)', () => {
  // a possible diagnosis itself never points at another one
  const possible = { id: 'dd-1', differentialId: null }
  it('is confirmed when a standing definitive diagnosis points at it', () => {
    const all = [possible, { id: 'def-1', differentialId: 'dd-1', removedAt: null }]
    expect(outcomeOf(possible, all)).toBe('confirmed')
    expect(confirmedLink(possible, all)).toEqual(all[1])
  })
  it('is not decided again when that definitive diagnosis was removed', () => {
    const all = [possible, { differentialId: 'dd-1', removedAt: '2026-11-19T08:00:00Z' }]
    expect(outcomeOf(possible, all)).toBe('not_decided')
    expect(confirmedLink(possible, all)).toBeUndefined()
  })
  it('is not confirmed only when the doctor saved it unticked', () => {
    expect(outcomeOf({ id: 'dd-1', notConfirmedAt: '2026-11-19T08:00:00Z' }, [])).toBe(
      'not_confirmed',
    )
    expect(outcomeOf({ id: 'dd-1', notConfirmed: true }, [])).toBe('not_confirmed')
    expect(outcomeOf({ id: 'dd-1', notConfirmed: false }, [])).toBe('not_decided')
  })
  it('a link wins over an older mark (ticked later)', () => {
    expect(
      outcomeOf({ id: 'dd-1', notConfirmedAt: '2026-11-19T08:00:00Z' }, [
        { differentialId: 'dd-1' },
      ]),
    ).toBe('confirmed')
  })
  it('never decides from the words: the same words without a link stay not decided', () => {
    const all = [
      { id: 'dd-1', text: 'Malaria', differentialId: null },
      { id: 'def-1', text: 'Malaria', differentialId: null },
    ]
    expect(outcomeOf(all[0]!, all)).toBe('not_decided')
  })
  it('compares typed words as the database does: trimmed, single spaces, any case', () => {
    expect(dxKey('  Malaria   192 ')).toBe('malaria 192')
    expect(dxKey('Typhoid fever')).toBe(dxKey('typhoid  FEVER'))
  })
})

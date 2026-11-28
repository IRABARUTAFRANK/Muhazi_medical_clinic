import { describe, expect, it } from 'vitest'
import { expenseGroup } from './accounts'

describe('the groups of the expenses list (0214)', () => {
  it('Other expenses: what the Money tab counts as other expenses', () => {
    expect(expenseGroup({ kind: 'other', kindCode: null })).toBe('other')
    expect(expenseGroup({ kind: 'other', kindCode: 'other' })).toBe('other')
    expect(expenseGroup({ kind: 'other', kindCode: undefined })).toBe('other')
  })
  it('the salaries, the clinic’s share and the hand-overs go together', () => {
    expect(expenseGroup({ kind: 'salary', kindCode: 'salary' })).toBe('salaries')
    expect(expenseGroup({ kind: 'other', kindCode: 'statutory' })).toBe('salaries')
    expect(expenseGroup({ kind: 'other', kindCode: 'remittance' })).toBe('salaries')
  })
  it('the taxes apart', () => {
    expect(expenseGroup({ kind: 'tax', kindCode: 'tax' })).toBe('taxes')
  })
})

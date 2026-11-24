import { describe, expect, it } from 'vitest'
import type { NurseOrder } from './nurse-orders'
import { findDuplicate } from './task-record'

const now = Date.parse('2026-11-24T12:00:00Z')
const order = (o: Partial<NurseOrder>): NurseOrder =>
  ({
    id: 'o',
    encounterId: 'e',
    kind: 'drug',
    text: 'Paracetamol 500 mg',
    serviceId: null,
    itemId: 'para',
    status: 'open',
    doses: [],
    ...o,
  }) as NurseOrder

describe('the same medicine or act twice on a visit (0200)', () => {
  it('ordered by the doctor and still to do', () => {
    const d = findDuplicate([order({ id: 'a' })], { kind: 'drug', itemId: 'para' }, now)
    expect(d).toMatchObject({ kind: 'ordered', order: { id: 'a' } })
  })
  it('given in the last 12 hours, the latest time named; older or another medicine: nothing', () => {
    const given = order({
      id: 'b',
      status: 'done',
      doses: [
        { n: 1, given: true, at: '2026-11-24T02:00:00Z', by: 'A' },
        { n: 2, given: true, at: '2026-11-24T09:00:00Z', by: 'B' },
      ] as NurseOrder['doses'],
    })
    expect(findDuplicate([given], { kind: 'drug', itemId: 'para' }, now)).toMatchObject({
      kind: 'given',
      at: '2026-11-24T09:00:00Z',
      by: 'B',
    })
    const old = order({
      status: 'done',
      doses: [{ n: 1, given: true, at: '2026-11-23T20:00:00Z', by: 'A' }] as NurseOrder['doses'],
    })
    expect(findDuplicate([old], { kind: 'drug', itemId: 'para' }, now)).toBeNull()
    expect(findDuplicate([given], { kind: 'drug', itemId: 'amox' }, now)).toBeNull()
  })
  it('an act: the same treatment, or the same words when written', () => {
    const inj = order({ kind: 'act', itemId: null, serviceId: 'inj', text: 'Injection' })
    expect(findDuplicate([inj], { kind: 'act', serviceId: 'inj' }, now)?.kind).toBe('ordered')
    const typed = order({ kind: 'act', itemId: null, serviceId: null, text: 'Wound cleaning' })
    expect(findDuplicate([typed], { kind: 'act', text: ' wound CLEANING ' }, now)?.kind).toBe(
      'ordered',
    )
    expect(findDuplicate([typed], { kind: 'act', text: 'Dressing' }, now)).toBeNull()
  })
  it('a cancelled order is not a duplicate', () => {
    expect(
      findDuplicate([order({ status: 'cancelled' })], { kind: 'drug', itemId: 'para' }, now),
    ).toBeNull()
  })
})

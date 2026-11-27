import { describe, expect, it } from 'vitest'
import type { MyPrescription } from '@/lib/api/doctor'
import { groupByPatient, statesOf } from './rx-groups'

const line = (
  id: string,
  patientId: string,
  encounterId: string,
  at: string,
  state: MyPrescription['state'] = 'waiting',
): MyPrescription => ({
  id,
  encounterId,
  patientId,
  patient: `Patient ${patientId}`,
  fileNumber: `MMC-${patientId}`,
  item: `Medicine ${id}`,
  quantity: 1,
  dose: null,
  frequency: null,
  days: null,
  instructions: null,
  supply: 'pharmacy',
  at,
  state,
  stateFull: state,
  cancelled: false,
  givenAt: null,
  notGivenReason: null,
  cancelledAt: null,
  cancelReason: null,
  visitOpen: encounterId === 'e-open',
})

describe('prescriptions by patient (0209)', () => {
  const rows = [
    line('a1', 'p1', 'e-old', '2026-11-20T08:00:00Z', 'given'),
    line('b1', 'p2', 'e-b', '2026-11-26T09:00:00Z'),
    line('a2', 'p1', 'e-open', '2026-11-27T10:05:00Z'),
    line('a3', 'p1', 'e-open', '2026-11-27T10:00:00Z', 'not_given'),
    line('a4', 'p1', 'e-old', '2026-11-20T08:10:00Z', 'given'),
  ]
  const groups = groupByPatient(rows)

  it('one group per patient, the most recent first', () => {
    expect(groups.map((g) => g.patientId)).toEqual(['p1', 'p2'])
    expect(groups[0]!.medicines).toBe(4)
    expect(groups[0]!.last).toBe('2026-11-27T10:05:00Z')
  })

  it('one prescription per visit, newest first, its medicines in the order written', () => {
    const v = groups[0]!.visits
    expect(v.map((x) => x.encounterId)).toEqual(['e-open', 'e-old'])
    expect(v[0]!.lines.map((l) => l.id)).toEqual(['a3', 'a2'])
    expect(v[0]!.at).toBe('2026-11-27T10:00:00Z')
    expect(v[0]!.visitOpen).toBe(true)
    expect(v[1]!.visitOpen).toBe(false)
  })

  it('counts the medicines by state', () => {
    expect(statesOf(groups[0]!)).toEqual([
      { state: 'waiting', count: 1 },
      { state: 'given', count: 2 },
      { state: 'not_given', count: 1 },
    ])
  })

  it('an empty list gives no group', () => {
    expect(groupByPatient([])).toEqual([])
  })
})

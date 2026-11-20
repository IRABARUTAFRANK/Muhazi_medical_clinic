import { describe, expect, it } from 'vitest'
import { sixStepsOfVisit, type SixStepsSource } from './six-steps-report'

/** The words of the report do not matter here: the key is returned. */
const t = (key: string) => key

type Dx = SixStepsSource['diagnoses'][number]
const possible = (p: Partial<Dx> & Pick<Dx, 'id' | 'text'>): Dx => ({
  icd10: null,
  type: 'secondary',
  provisional: true,
  stage: 'differential',
  ...p,
})
const definitive = (p: Partial<Dx> & Pick<Dx, 'text'>): Dx => ({
  icd10: null,
  type: 'primary',
  provisional: false,
  stage: 'definitive',
  ...p,
})
const outcomes = (diagnoses: Dx[]) =>
  Object.fromEntries(
    (sixStepsOfVisit({ diagnoses }, t).differentials ?? []).map((d) => [d.text, d.outcome]),
  )

describe('step 3 of the medical report: what the doctor decided (0192)', () => {
  it('the same words typed in step 5 do not confirm a possible diagnosis', () => {
    expect(
      outcomes([
        possible({ id: 'dd-1', text: 'Typhoid', icd10: 'A01.0' }),
        definitive({ id: 'def-1', text: ' typhoid ', icd10: 'A01.0' }),
      ]),
    ).toEqual({ Typhoid: 'not_decided' })
  })
  it('a possible diagnosis ticked (a definitive one linked to it) is confirmed', () => {
    expect(
      outcomes([
        possible({ id: 'dd-1', text: 'Malaria' }),
        definitive({ id: 'def-1', text: 'Malaria', differentialId: 'dd-1' }),
      ]),
    ).toEqual({ Malaria: 'confirmed' })
  })
  it('its definitive diagnosis removed, it is not decided again', () => {
    expect(
      outcomes([
        possible({ id: 'dd-1', text: 'Malaria' }),
        definitive({
          id: 'def-1',
          text: 'Malaria',
          differentialId: 'dd-1',
          removedAt: '2026-11-19T09:00:00Z',
        }),
      ]),
    ).toEqual({ Malaria: 'not_decided' })
  })
  it('saved unticked, it is not confirmed (from the visit record or the patient file)', () => {
    expect(
      outcomes([
        possible({ id: 'dd-1', text: 'Typhoid', notConfirmedAt: '2026-11-19T09:00:00Z' }),
        possible({ id: 'dd-2', text: 'Viral fever', notConfirmed: true }),
        possible({ id: 'dd-3', text: 'Otitis' }),
      ]),
    ).toEqual({ Typhoid: 'not_confirmed', 'Viral fever': 'not_confirmed', Otitis: 'not_decided' })
  })
  it('step 5 lists the definitive diagnoses only, the main one first as written', () => {
    const steps = sixStepsOfVisit(
      {
        diagnoses: [
          possible({ id: 'dd-1', text: 'Malaria' }),
          definitive({ id: 'def-1', text: 'Malaria', differentialId: 'dd-1' }),
          definitive({ id: 'def-2', text: 'Urinary infection', type: 'secondary' }),
        ],
      },
      t,
    )
    expect(steps.diagnoses.map((d) => [d.text, d.primary])).toEqual([
      ['Malaria', true],
      ['Urinary infection', false],
    ])
  })
})

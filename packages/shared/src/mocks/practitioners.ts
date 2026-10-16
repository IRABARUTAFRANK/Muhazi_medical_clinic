import type { Practitioner } from '../types'
import { hoursFromRange } from '../hours'

const p = (
  code: string,
  name: string,
  title: string,
  cats: Practitioner['cats'],
  langs: string,
  workdays: number[],
  start: number,
  end: number,
  seed: number,
): Practitioner => ({
  id: code,
  code,
  name,
  title,
  cats,
  langs,
  hours: hoursFromRange(workdays, start, end),
  slotMinutes: 60,
  seed,
})

/** Sample practitioners; the database seed mirrors these codes and hours. */
export const PRACTITIONERS: readonly Practitioner[] = [
  p(
    'mb',
    'Dr. Mukamana Béatrice',
    'General practitioner',
    ['consultation'],
    'KIN · EN · FR',
    [1, 2, 3, 4, 5, 6],
    8,
    17,
    3,
  ),
  p(
    'hj',
    'Dr. Habyarimana Jean Claude',
    'General practitioner · minor surgery',
    ['consultation', 'surgery', 'circ'],
    'KIN · FR',
    [2, 3, 4, 5, 6, 0],
    9,
    18,
    7,
  ),
  p(
    'nf',
    'Dr. Ndayisaba Félix',
    'Dental officer',
    ['dental'],
    'KIN · EN · FR',
    [1, 2, 3, 4, 5],
    8,
    16,
    5,
  ),
  p('ua', 'Dr. Uwera Aline', 'Sonographer', ['ultrasound'], 'KIN · EN', [1, 3, 5, 6], 8, 15, 11),
  p(
    'ms',
    'Mukarugwiza Solange',
    'Midwife · family planning',
    ['fp', 'ultrasound'],
    'KIN · FR',
    [1, 2, 3, 4, 5, 6],
    8,
    17,
    2,
  ),
  p(
    'nc',
    'Nyirahabimana Chantal',
    'Nurse · vaccination & HIV testing',
    ['nursing', 'hiv'],
    'KIN · EN',
    [1, 2, 3, 4, 5, 6, 0],
    7,
    19,
    9,
  ),
]

/** The three cards previewed on the landing page in sample mode. */
export const FEATURED_PRACTITIONER_CODES: readonly string[] = ['mb', 'nf', 'ua']

export const findPractitioner = (code: string): Practitioner | undefined =>
  PRACTITIONERS.find((x) => x.code === code)

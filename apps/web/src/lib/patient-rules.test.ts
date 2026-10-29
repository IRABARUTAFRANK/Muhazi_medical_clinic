import { describe, expect, it } from 'vitest'
import {
  BUILTIN_DEFAULTS,
  cleanIdNumber,
  draftOf,
  draftPayload,
  draftProblem,
  emptyDraft,
  fileMissing,
  groupNationalId,
  idKindOf,
  nationalIdDigits,
  requiredMissing,
  withDefaults,
  type PatientDraft,
} from './patient-rules'

const draft = (patch: Partial<PatientDraft> = {}): PatientDraft => ({
  ...emptyDraft(),
  surname: 'Uwase',
  given_names: 'Claudine',
  sex: 'female',
  age_years: '30',
  ...patch,
})

describe('national ID', () => {
  it('keeps digits only and groups the 16 as on the card', () => {
    expect(nationalIdDigits('1 1990 8 0012345 0 12')).toBe('1199080012345012')
    expect(groupNationalId('1199080012345012')).toBe('1 1990 8 0012345 0 12')
    expect(groupNationalId('11990')).toBe('11990')
  })
  it('refuses anything but 16 digits, by ID type', () => {
    const states = withDefaults({})
    expect(draftProblem(draft({ national_id: '119908001234501' }), states)?.key).toBe(
      'patientFields.errors.nationalId',
    )
    expect(draftProblem(draft({ national_id: '1199080012345012' }), states)).toBeNull()
    // a passport keeps its own rule: 6 to 20 letters or digits
    expect(draftProblem(draft({ id_kind: 'passport', id_number: 'PA1' }), states)?.key).toBe(
      'patientFields.errors.idNumber',
    )
    expect(
      draftProblem(draft({ id_kind: 'passport', id_number: cleanIdNumber('pa 1234-567') }), states),
    ).toBeNull()
    expect(cleanIdNumber('pa 1234-567')).toBe('PA1234567')
  })
})

describe('the clinic’s fields', () => {
  it('starts from the file as it was (new fields hidden) and ignores unknown settings', () => {
    const s = withDefaults({ email: 'required', blood: 'required', phone_1: 'nonsense' })
    expect(s.email).toBe('required')
    expect(s.phone_1).toBe(BUILTIN_DEFAULTS.phone_1)
    expect(s.province).toBe('hidden')
    expect('blood' in s).toBe(false)
  })
  it('lists the required fields a draft lacks, the manager’s fields in their order', () => {
    const s = withDefaults({ national_id: 'required', phone_1: 'required', emergency: 'required' })
    const defs = [
      { key: 'religion', label: 'Religion', required: true },
      { key: 'kin', label: 'Next of kin' },
    ]
    const d = draft({ emergency_name: 'Mukamana' })
    const p = { ...draftPayload(d, s), birth_date: null }
    expect(requiredMissing(p as never, s, defs)).toEqual([
      'national_id',
      'phone',
      'emergency',
      'extra:religion',
    ])
    // a child under 16 needs no ID; a "no ID" reason counts as an answer
    expect(requiredMissing({ birth_date: '2020-01-01' }, s, []).includes('national_id')).toBe(false)
    expect(requiredMissing({ no_national_id: 'not_issued' }, s, [])).toEqual(['phone', 'emergency'])
  })
  it('the file still needs phone, ID and address unless hidden, then what is required', () => {
    const s = withDefaults({ sector: 'hidden', occupation: 'required' })
    expect(fileMissing({ birth_date: '1990-01-01' }, s, [])).toEqual([
      'phone',
      'national_id',
      'occupation',
    ])
  })
  it('sends a hidden field as nothing, so the file keeps it', () => {
    const s = withDefaults({ phone_2: 'hidden' })
    const p = draftPayload(draft({ phone_2: '0788', extra: { kin: ' ', church: 'ADEPR' } }), s)
    expect('phone_2' in p).toBe(false)
    expect(p.extra).toEqual({ church: 'ADEPR' })
    expect(p.age_years).toBe(30)
  })
  it('reads an older file: the no-ID reason, a label-keyed field', () => {
    const file = {
      surname: 'A',
      given_names: 'B',
      sex: 'male',
      no_national_id: 'foreigner',
      extra: { Religion: 'Catholic' },
    }
    expect(idKindOf(file)).toBe('foreigner')
    expect(draftOf(file, [{ key: 'religion', label: 'Religion' }]).extra).toEqual({
      religion: 'Catholic',
    })
  })
})

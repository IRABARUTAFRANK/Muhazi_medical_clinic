import { describe, expect, it } from 'vitest'
import {
  columnForInsurer,
  columnForPrivatePatients,
  columnPayers,
  payerMentions,
  type InsurerLike,
} from './price-list-payers'

const rama: InsurerLike = { id: 'r', code: 'RAMA', name: 'RSSB RAMA', type: 'rssb_rama' }
const mmi: InsurerLike = { id: 'm', code: 'MMI', name: 'MMI', type: 'mmi' }
const cbhi: InsurerLike = { id: 'c', code: 'CBHI', name: 'Mutuelle de Santé (CBHI)', type: 'cbhi' }
const britam: InsurerLike = { id: 'b', code: 'BRITAM', name: 'Britam', type: 'private' }

describe('who a price column is for', () => {
  it('reads the payers a column names', () => {
    expect(payerMentions('RAMA; MMI')).toEqual([
      { text: 'RAMA', group: 'scheme' },
      { text: 'MMI', group: 'scheme' },
    ])
    expect(payerMentions('RAMA, MMI, MIS/UR').map((m) => m.text)).toEqual(['RAMA', 'MMI', 'MIS/UR'])
    expect(payerMentions('Private Insurances')).toEqual([
      { text: 'Private Insurances', group: 'privateInsurers' },
    ])
    expect(payerMentions('Privates (Non insured)')).toEqual([
      { text: 'Privates Non insured', group: 'privatePatients' },
    ])
    expect(payerMentions('General Clinics *')).toEqual([])
    expect(payerMentions('PRIVATE INSURANCE AND NON INSURED RWANDANS').map((m) => m.group)).toEqual(
      ['privateInsurers', 'privatePatients'],
    )
  })

  it('reads a sheet and its title when the column says nothing', () => {
    const col = {
      key: 'rama_primary',
      label: 'RAMA · Primary Health Facility *',
      hint: 'RAMA — RWANDA HEALTH SERVICES TARIFF IN PRIVATE FACILITIES 2025-2027 FOR RAMA, MMI, MIS/UR',
    }
    expect(columnPayers(col).map((m) => m.text)).toEqual(['RAMA', 'MMI', 'MIS/UR'])
  })

  it('gives "RAMA; MMI" to both RAMA and MMI, "Private Insurances" to the private insurers, the non-insured column to private patients', () => {
    const cols = [
      { key: 'rama_mmi', label: 'RAMA; MMI' },
      { key: 'private_insurances', label: 'Private Insurances' },
      { key: 'privates_non_insured', label: 'Privates (Non insured)' },
    ]
    expect(columnForInsurer(cols, rama)).toBe('rama_mmi')
    expect(columnForInsurer(cols, mmi)).toBe('rama_mmi')
    expect(columnForInsurer(cols, britam)).toBe('private_insurances')
    expect(columnForInsurer(cols, cbhi)).toBe('')
    expect(columnForPrivatePatients(cols)).toBe('privates_non_insured')
  })

  it('reads the full MoH workbook: the sheet RAMA for RAMA and MMI, the sheet Private Insurances for private insurers and non-insured Rwandans', () => {
    const cols = [
      {
        key: 'rama_primary',
        label: 'RAMA · Primary Health Facility *',
        hint: 'RAMA — TARIFF IN PRIVATE FACILITIES FOR RAMA, MMI, MIS/UR',
      },
      {
        key: 'private_general',
        label: 'Private Insurances · General Clinics *',
        hint: 'Private Insurances — TARIFF IN PRIVATE FACILITIES FOR PRIVATE INSURANCE AND NON INSURED RWANDANS',
      },
    ]
    expect(columnForInsurer(cols, rama)).toBe('rama_primary')
    expect(columnForInsurer(cols, mmi)).toBe('rama_primary')
    expect(columnForInsurer(cols, britam)).toBe('private_general')
    expect(columnForPrivatePatients(cols)).toBe('private_general')
  })

  it('gives an RSSB list to RAMA and Mutuelle de santé only', () => {
    const cols = [{ key: 'new_price', label: 'NEW PRICE' }]
    expect(columnForInsurer(cols, rama, true)).toBe('new_price')
    expect(columnForInsurer(cols, cbhi, true)).toBe('new_price')
    expect(columnForInsurer(cols, mmi, true)).toBe('')
    expect(columnForInsurer(cols, britam, true)).toBe('')
  })
})

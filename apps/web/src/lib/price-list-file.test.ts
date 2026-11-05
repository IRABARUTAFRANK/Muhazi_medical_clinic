import { describe, expect, it } from 'vitest'
import {
  keyOf,
  mergeParts,
  monthIn,
  pdfToGrid,
  priceOf,
  readGrid,
  rereadPriceList,
  roleOfHeader,
  type Grid,
  type PdfItem,
} from './price-list-file'

const grid = (rows: unknown[][], name: string | null = 'Sheet1'): Grid => ({
  name,
  rows: rows.map((cells, i) => ({ n: i + 1, cells })),
})

describe('published price list reader', () => {
  it('names the columns of the MoH, RHIA and RSSB headers', () => {
    expect(roleOfHeader('RHIC')).toBe('code')
    expect(roleOfHeader('ICHI CODE')).toBe('code')
    expect(roleOfHeader('Procedure name')).toBe('name')
    expect(roleOfHeader('Speciality')).toBe('section')
    expect(roleOfHeader('EC Instructions& Guideline ')).toBe('note')
    expect(roleOfHeader('SELLING UNIT')).toBe('unit')
    expect(roleOfHeader('Pharmacological Group')).toBe('section')
    expect(roleOfHeader('NEW PRICE')).toBe('price')
    expect(roleOfHeader('SN')).toBe('number')
    expect(roleOfHeader('No Drug No/Group')).toBe('number')
    expect(roleOfHeader('RAMA; MMI')).toBeNull()
  })

  it('reads prices written as text, and a formula the file kept no value for', () => {
    expect(priceOf(72457.39)).toBe(72457.39)
    expect(priceOf('3,985')).toBe(3985)
    expect(priceOf('RWF 1 200')).toBe(1200)
    expect(priceOf({ sharedFormula: 'G322' })).toBe('=G322')
    expect(priceOf({ formula: 'A1*2', result: 14 })).toBe(14)
    expect(priceOf('n/a')).toBe('n/a')
    expect(priceOf('')).toBeNull()
  })

  it('finds a month in a title or a file name', () => {
    expect(monthIn('Final Tariff Tables - Private FEB2026.xlsx')).toBe('2026-02-01')
    expect(monthIn('EFFECTIVE FROM JUNE 2026')).toBe('2026-06-01')
    expect(monthIn('2025-2027')).toBeNull()
    const taken = new Set<string>()
    expect(keyOf('RAMA; MMI', taken)).toBe('rama_mmi')
    expect(keyOf('Privates (Non insured)', taken)).toBe('privates_non_insured')
    expect(keyOf('RAMA - MMI', taken)).toBe('rama_mmi_2')
  })

  it('reads a treatments tariff with several price columns under a title', () => {
    const title = 'RWANDA HEALTH SERVICES TARIFF IN PRIVATE FACILITIES 2025-2027'
    const p = readGrid(
      grid([
        [null, null, null, 'REPUBLIC OF RWANDA'],
        [title, title, title, title, title],
        ['RHIC', 'Speciality', 'ICHI CODE', 'Procedure name', 'RAMA; MMI', 'Private Insurances'],
        ['RHIC-DENT-001', 'Dentistry', 'KAE.JJ.AC', 'Apexification', 72457.39, 79343.03],
        ['RHIC-DENT-002', 'Dentistry', 'KAE.JJ.AC', 'Apexinogenesis', 72457.39, 79343.03],
        [
          'RLTC-SERO-062',
          'Immuno-Serology',
          '24116-6',
          'RUBELLA IGM/IGG',
          0,
          { sharedFormula: 'G322' },
        ],
      ]),
    )!
    expect(p.headerRow).toBe(3)
    expect(p.title).toBe(title)
    expect(p.kind).toBe('treatments')
    expect(p.columns).toEqual([
      { key: 'rama_mmi', label: 'RAMA; MMI' },
      { key: 'private_insurances', label: 'Private Insurances' },
    ])
    expect(p.roles.find((r) => r.label === 'ICHI CODE')?.role).toBe('altCode')
    expect(p.lines).toHaveLength(3)
    expect(p.lines[0]).toMatchObject({
      code: 'RHIC-DENT-001',
      name: 'Apexification',
      section: 'Dentistry',
      altCode: 'KAE.JJ.AC',
      prices: { rama_mmi: 72457.39, private_insurances: 79343.03 },
    })
    expect(p.lines[2]!.prices.private_insurances).toBe('=G322')
  })

  it('keeps the instructions column, skips a repeated header and keeps a legend as a note', () => {
    const header = [
      'RHIC',
      'Speciality',
      'Procedure name',
      'General Clinics *',
      'Polyclinic **',
      'EC Instructions& Guideline ',
    ]
    const p = readGrid(
      grid([
        header,
        [
          'RHIC-DENT-017',
          'Dentistry',
          'Extraction adult',
          22907,
          23782,
          'Both dental therapist and surgeon',
        ],
        ['RHIC-DENT-005', 'Dentistry', 'Core build up', 36738, 37723, 'NC'],
        header,
        ['RHIC-PHYS-001', 'Physiotherapy', 'Aerobic exercises', 14953, 15427, null],
        [null, null, 'NC: Not covered by Edencare unless special pre-auth guaranted'],
      ]),
    )!
    expect(p.lines.map((l) => l.code)).toEqual(['RHIC-DENT-017', 'RHIC-DENT-005', 'RHIC-PHYS-001'])
    expect(p.lines[1]!.note).toBe('NC')
    expect(p.columns.map((c) => c.key)).toEqual(['general_clinics', 'polyclinic'])
    expect(p.notes).toEqual(['NC: Not covered by Edencare unless special pre-auth guaranted'])
  })

  it('reads a medicine list: running number, two names, headings as sections', () => {
    const p = readGrid(
      grid([
        [null, null, 'RHIA REIMBURSABLE MEDICINES LIST JUNE 2026'],
        [
          'SN',
          'DRUG_CODE',
          'GENERIC DESCRIPTION',
          'DESIGNATION',
          'INSTRUCTIONS',
          'SELLING UNIT',
          'PRICE',
        ],
        ['A. ALIMENTARY TRACT AND METABOLISM '],
        ['A01 .STOMATOLOGICAL PREPARATIONS'],
        [1, 'A01AA01001', 'Sodium Fluoride ', 'ELMEX TUBE 50ml', 'DT', 'TUBE', 9345],
        [2, 'A01AA01002', 'Sodium Fluoride ', 'ELMEX TUBE 75ml', null, 'TUBE', 10280],
      ]),
    )!
    expect(p.kind).toBe('medicines')
    expect(p.from).toBe('2026-06-01')
    expect(p.columns).toEqual([{ key: 'price', label: 'PRICE' }])
    expect(p.lines[0]).toMatchObject({
      code: 'A01AA01001',
      name: 'Sodium Fluoride',
      detail: 'ELMEX TUBE 50ml',
      section: 'A01 .STOMATOLOGICAL PREPARATIONS',
      unit: 'TUBE',
      note: 'DT',
      prices: { price: 9345 },
    })
  })

  it('puts a PDF table back in rows: a price a little lower, a name on two lines, a section over rows', () => {
    const at = (y: number, x: number, text: string): PdfItem => ({ page: 1, x, y, w: 10, text })
    const items = [
      at(719, 88, 'PRICES LIST OF MEDICINES REIMBURSABLE BY RSSB'),
      at(698, 88, 'EFFECTIVE FROM JUNE 2026'),
      at(666, 53, 'No Drug No/Group'),
      at(666, 120, 'Pharmacological Group'),
      at(666, 222, 'ATC Code'),
      at(666, 278, 'Product Name'),
      at(666, 453, 'Selling Unit'),
      at(666, 515, 'NEW'),
      at(655, 516, 'PRICE'),
      at(644, 53, '1'),
      at(644, 88, '1'),
      at(644, 120, 'Anxiolytic Sedatives, Hypnotics and'),
      at(644, 222, 'N05AA01003'),
      at(644, 278, 'Chlorpromazine inj. 25mg/5ml'),
      at(644, 453, 'Ampoule'),
      at(638, 540, '126'),
      at(622, 53, '2'),
      at(622, 120, 'Antipsychotics'),
      at(622, 222, 'N05BA01003'),
      at(622, 278, 'Diazepam inj.'),
      at(622, 453, 'Ampoule'),
      at(616, 535, '3,985'),
      at(612, 278, '10 mg/2ml'),
      at(570, 120, 'Antiseptic Products'),
      at(570, 278, 'All Included in acts'),
    ]
    const g = pdfToGrid(items)!
    const p = readGrid(g)!
    expect(p.columns).toEqual([{ key: 'new_price', label: 'NEW PRICE' }])
    expect(p.from).toBe('2026-06-01')
    expect(p.title).toBe('PRICES LIST OF MEDICINES REIMBURSABLE BY RSSB')
    expect(p.lines).toHaveLength(2)
    expect(p.lines[0]).toMatchObject({
      code: 'N05AA01003',
      name: 'Chlorpromazine inj. 25mg/5ml',
      unit: 'Ampoule',
      section: 'Anxiolytic Sedatives, Hypnotics and Antipsychotics',
      prices: { new_price: 126 },
    })
    expect(p.lines[1]).toMatchObject({
      name: 'Diazepam inj. 10 mg/2ml',
      section: 'Anxiolytic Sedatives, Hypnotics and Antipsychotics',
      prices: { new_price: 3985 },
    })
    expect(p.notes).toEqual(['Antiseptic Products — All Included in acts'])
  })

  it('reads the file again with the columns corrected and from another row', () => {
    const g = grid([
      ['TARIFF OF EDEN CARE 2026'],
      ['Code', 'Name', 'Price', 'Old price', 'Remark'],
      ['E-01', 'Consultation', 5000, 4500, 'Covered'],
      ['E-02', 'Dressing', 3000, 2800, 'NC'],
    ])
    const first = readGrid(g)!
    expect(first.columns.map((c) => c.key)).toEqual(['price', 'old_price'])
    expect(first.layout.find((c) => c.label === 'Old price')?.role).toBe('price')
    const parsed = { ...first, format: 'xlsx' as const }
    // the old price is left out, the remark is the insurer's instruction
    const fixed = rereadPriceList(parsed, { headerRow: 2, roles: { 3: 'ignore', 4: 'note' } })!
    expect(fixed.columns).toEqual([{ key: 'price', label: 'Price' }])
    expect(fixed.lines[1]).toMatchObject({
      code: 'E-02',
      name: 'Dressing',
      note: 'NC',
      prices: { price: 3000 },
    })
    expect(fixed.layout.find((c) => c.label === 'Old price')?.role).toBe('ignore')
    // a list without codes: the name and the price are enough
    const noCode = rereadPriceList(parsed, { headerRow: 2, roles: { 0: 'ignore', 3: 'ignore' } })!
    expect(noCode.lines[0]).toMatchObject({
      code: '',
      name: 'Consultation',
      prices: { price: 5000 },
    })
    // a row that is not the header reads nothing
    expect(rereadPriceList(parsed, { headerRow: 99 })).toBeNull()
  })

  it('keeps every sheet when the columns of the first are corrected', () => {
    const sheet = (name: string, code: string) =>
      grid(
        [
          ['Code', 'Name', 'Price', 'Remark'],
          [code + '-1', 'Act one ' + name, 100, 'ok'],
          [code + '-2', 'Act two ' + name, 200, 'ok'],
        ],
        name,
      )
    const parts = [readGrid(sheet('A', 'A'))!, readGrid(sheet('B', 'B'))!]
    const merged = mergeParts(parts, 'xlsx')
    expect(merged.lines).toHaveLength(4)
    const fixed = rereadPriceList(merged, { headerRow: 1, roles: { 3: 'note' } })!
    expect(fixed.lines).toHaveLength(4)
    expect(fixed.lines[0]!.note).toBe('ok')
  })
})

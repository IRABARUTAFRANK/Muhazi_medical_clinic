import { describe, expect, it } from 'vitest'
import {
  buildPriceList,
  defaultChoices,
  evalFormula,
  foreignSheet,
  keyOf,
  leftOutReason,
  mergeParts,
  monthIn,
  pdfToGrid,
  priceOf,
  readGrid,
  rebuildPriceList,
  rereadPriceList,
  roleOfHeader,
  shiftFormula,
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
    // the polyclinics' price is left out: Muhazi is a general clinic
    expect(p.columns.map((c) => c.key)).toEqual(['general_clinics'])
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
    const parsed = mergeParts([first], 'xlsx')
    // the old price is left out, the remark is the insurer's instruction
    const fixed = rereadPriceList(parsed, { headerRow: 2, roles: { 3: 'ignore', 4: 'note' } })!
    expect(fixed.columns.map((c) => ({ key: c.key, label: c.label }))).toEqual([
      { key: 'price', label: 'Price' },
    ])
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
  it('leaves out the prices for foreigners, works out a shared formula and reports the sheet', () => {
    const p = readGrid(
      grid([
        [
          'RHIC',
          'Procedure name',
          'RAMA; MMI',
          'Private Insurances',
          'Privates (Non insured)',
          'East Africa',
          'Africans',
          'Rest of the World',
        ],
        ['RHIC-A-001', 'Act one', 100, 200, { formula: 'D2/2', result: 100 }, 200, 320, 640],
        ['RHIC-A-002', 'Act two', 300, 400, { sharedFormula: 'E2' }, 400, 640, 1280],
        ['Total'],
      ]),
    )!
    expect(p.columns.map((c) => c.label)).toEqual([
      'RAMA; MMI',
      'Private Insurances',
      'Privates (Non insured)',
    ])
    expect(p.layout.filter((c) => c.leftOut).map((c) => [c.label, c.leftOut])).toEqual([
      ['East Africa', 'foreign'],
      ['Africans', 'foreign'],
      ['Rest of the World', 'foreign'],
    ])
    expect(p.lines[1]!.prices).toEqual({
      rama_mmi: 300,
      private_insurances: 400,
      privates_non_insured: 200,
    })
    expect(p.sheets[0]).toMatchObject({ state: 'read', headerRow: 1, rows: 3, lines: 2 })
    expect(p.sheets[0]!.skipped).toEqual([{ row: 4, text: 'Total', why: 'note' }])
    // chosen by hand, a column for foreigners is read
    const back = rereadPriceList(mergeParts([p], 'xlsx'), { headerRow: 1, roles: { 5: 'price' } })!
    expect(back.columns.map((c) => c.label)).toContain('East Africa')
    expect(back.columns.map((c) => c.label)).not.toContain('Africans')
  })

  it('keeps the general clinics’ price and leaves out the other kinds of facility', () => {
    const p = readGrid(
      grid([
        ['RHIC', 'Procedure name', 'General Clinics *', 'Polyclinic **', 'Hospitals ***'],
        ['RHIC-DENT-001', 'Apexification', 79343, 83036, 88456],
      ]),
    )!
    expect(p.columns.map((c) => c.label)).toEqual(['General Clinics *'])
    expect(leftOutReason('Tertiary Health Facility', ['General Clinics'])).toBe('otherFacility')
    // a primary health facility is the level of a general clinic: the higher levels are left out
    expect(
      leftOutReason('Tertiary Health Facility', [
        'Primary Health Facility',
        'Tertiary Health Facility',
      ]),
    ).toBe('otherFacility')
    expect(
      leftOutReason('Primary Health Facility', [
        'Primary Health Facility',
        'Tertiary Health Facility',
      ]),
    ).toBeNull()
    expect(leftOutReason('Private Insurances', ['General Clinics'])).toBeNull()
    expect(leftOutReason('International insurers', [])).toBeNull()
    // no general clinics' column: nothing is left out
    const q = readGrid(
      grid([
        ['RHIC', 'Procedure name', 'Polyclinic', 'Hospitals'],
        ['RHIC-DENT-001', 'Apexification', 1, 2],
      ]),
    )!
    expect(q.columns).toHaveLength(2)
  })

  it('works out a formula the file kept no value for', () => {
    expect(shiftFormula('F322/2', 48, 0)).toBe('F370/2')
    expect(shiftFormula('$F$322*B1+ROUND(C1,0)', 2, 1)).toBe('$F$322*C3+ROUND(D3,0)')
    const cells = new Map<number, unknown[]>([
      [1, [10, 20, { formula: 'A1+B1' }]],
      [2, [null, 'x']],
    ])
    expect(evalFormula('=ROUND(C1*1.18, 0)', cells)).toBe(35)
    expect(evalFormula('=SUM(A1:B1)/2', cells)).toBe(15)
    expect(evalFormula('=A2+5', cells)).toBe(5)
    expect(evalFormula('=B2*2', cells)).toBeNull()
    expect(evalFormula('=Sheet2!A1', cells)).toBeNull()
    expect(evalFormula('=-(A1-B1)^2', cells)).toBe(100)
    expect(evalFormula('=50%*A1+2^3^2', cells)).toBe(69)
  })
  it('reads the full MoH tariff workbook: a sheet per payer joined by code, foreigners left out, a price of 0 is no price', () => {
    const title = (who: string) => [
      `RWANDA HEALTH SERVICES TARIFF IN PRIVATE FACILITIES 2025-2027 FOR ${who}`,
    ]
    const sheet = (name: string, who: string, head: string[], rows: unknown[][]) =>
      grid([title(who), [], ['RHIC', 'Speciality', 'Procedure name', ...head], ...rows], name)
    const rama = sheet(
      'RAMA',
      'RAMA, MMI, MIS/UR',
      [
        'Primary Health Facility *',
        'Secondarly Health Facility **',
        'Tertiary Health Facility ***',
      ],
      [
        ['RHIC-A-001', 'Anaesthesia', 'Bier block', 40115, 41746, 43620],
        ['RHIC-C-001', 'CT Surgery', 'Heart surgery', 0, 0, 900000],
      ],
    )
    const privates = sheet(
      'Private Insurances',
      'PRIVATE INSURANCE AND NON INSURED RWANDANS',
      ['General Clinics *', 'Polyclinic **', 'Hospitals ***'],
      [
        ['RHIC-A-001', 'Anaesthesia', 'Bier block', 43720, 45377, 47413],
        ['RHIC-C-001', 'CT Surgery', 'Heart surgery', 0, 0, 990000],
      ],
    )
    const eac = sheet(
      'East Africa',
      'CITIZENS FROM EAST AFRICA',
      ['General Clinics *', 'Polyclinic **', 'Hospitals ***'],
      [['RHIC-A-001', 'Anaesthesia', 'Bier block', 43720, 45377, 47413]],
    )
    expect(foreignSheet(eac)).toBe(true)
    expect(foreignSheet(rama)).toBe(false)
    expect(foreignSheet(privates)).toBe(false)
    const parts = [readGrid(rama)!, readGrid(privates)!]
    expect(parts[0]!.columns.map((c) => c.label)).toEqual(['Primary Health Facility *'])
    expect(parts[0]!.sheets[0]!.zeros).toBe(1)
    const p = mergeParts(parts, 'xlsx')
    expect(p.columns.map((c) => c.label)).toEqual([
      'RAMA · Primary Health Facility *',
      'Private Insurances · General Clinics *',
    ])
    expect(p.lines).toHaveLength(2)
    expect(p.lines[0]!.prices).toEqual({
      rama_primary_health_facility: 40115,
      private_insurances_general_clinics: 43720,
    })
    // not done at a general clinic: no price
    expect(p.lines[1]!.prices).toEqual({
      rama_primary_health_facility: null,
      private_insurances_general_clinics: null,
    })
    expect(p.sheets.map((s) => !!s.joined)).toEqual([false, true])
  })
  it('builds the list again from the choices made for each sheet', () => {
    const head = ['RHIC', 'Procedure name']
    const rama = grid(
      [
        ['TARIFF FOR RAMA, MMI'],
        [...head, 'Primary Health Facility *'],
        ['A-001', 'Act one', 100],
        ['A-002', 'Act two', 200],
      ],
      'RAMA',
    )
    const priv = grid(
      [
        ['TARIFF FOR PRIVATE INSURANCE'],
        [...head, 'General Clinics *', 'Hospitals ***'],
        ['A-001', 'Act one', 110, 150],
        ['A-002', 'Act two', 220, 300],
      ],
      'Private Insurances',
    )
    const eac = grid(
      [
        ['TARIFF FOR CITIZENS FROM EAST AFRICA'],
        [...head, 'General Clinics *'],
        ['A-001', 'Act one', 110],
      ],
      'East Africa',
    )
    const grids = [rama, priv, eac]
    const parsed = buildPriceList(grids, defaultChoices(grids, new Set()), 'xlsx', new Set())!
    expect(parsed.sheets.map((s) => [s.name, s.state, s.use])).toEqual([
      ['RAMA', 'read', true],
      ['Private Insurances', 'read', true],
      ['East Africa', 'foreign', false],
    ])
    expect(parsed.lines).toHaveLength(2)
    expect(parsed.sheets[2]!.layout.map((c) => c.label)).toContain('General Clinics *')
    // the second sheet's lines added instead of joined
    const added = rebuildPriceList(
      parsed,
      parsed.choices.map((c, i) => (i === 1 ? { ...c, join: 'add' as const } : c)),
    )!
    expect(added.lines).toHaveLength(4)
    // the first sheet left out
    const second = rebuildPriceList(
      parsed,
      parsed.choices.map((c, i) => (i === 0 ? { ...c, use: false } : c)),
    )!
    expect(second.columns.map((c) => c.label)).toEqual(['General Clinics *'])
    expect(second.sheets[0]!.state).toBe('off')
    // the foreigners' sheet read after all
    const all = rebuildPriceList(
      parsed,
      parsed.choices.map((c) => ({ ...c, use: true })),
    )!
    expect(all.sheets[2]!.state).toBe('read')
    // a column kept by hand on one sheet: the hospitals' price
    const kept = rereadPriceList(
      parsed,
      { headerRow: 2, roles: { 0: 'code', 1: 'name', 2: 'price', 3: 'price' } },
      1,
    )!
    expect(kept.columns.map((c) => c.label)).toContain('Private Insurances · Hospitals ***')
    // nothing left to read
    expect(
      rebuildPriceList(
        parsed,
        parsed.choices.map((c) => ({ ...c, use: false })),
      ),
    ).toBeNull()
  })
})

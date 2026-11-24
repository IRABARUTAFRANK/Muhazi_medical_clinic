import { describe, expect, it } from 'vitest'
import {
  convert,
  normUnit,
  partFigure,
  partModeBy,
  partModeOf,
  partPrice,
  pieceContentFromText,
  pieceContentOf,
  piecesForDose,
  proposePieces,
  rounderAmount,
  splitPieces,
  takeHomeCount,
  timesPerDay,
  type DoseItem,
  type ItemDose,
} from './dose'
import { fractionText } from './fraction'

const setDose = (d: Partial<ItemDose>): ItemDose => ({
  doseAmount: null,
  doseUnit: null,
  dosePer: null,
  dosePerUnit: null,
  contentAmount: null,
  contentUnit: null,
  partMode: null,
  partModeNow: null,
  partPriceRule: 'share',
  halfPrice: null,
  quarterPrice: null,
  measurePrice: null,
  doseSetAt: '2026-11-24T08:00:00Z',
  ...d,
})

const paracetamol: DoseItem = {
  name: 'Paracetamol',
  strength: '500 mg',
  form: 'tablet',
  unit: 'tab',
}
const amoxSyrup: DoseItem = {
  name: 'Amoxicillin',
  strength: '250 mg/5 ml',
  form: 'powder for oral suspension',
  unit: 'bottle',
  dose: setDose({
    doseAmount: 250,
    doseUnit: 'mg',
    dosePer: 5,
    dosePerUnit: 'ml',
    contentAmount: 100,
    contentUnit: 'ml',
    partModeNow: 'measure',
  }),
}
const insulin: DoseItem = {
  name: 'Insulin',
  strength: 'ACTRAPID INSULIN 100 UI/ml Injection 10ml',
  form: 'injection',
  unit: 'VIAL',
}

describe('units', () => {
  it('reads every spelling as one code', () => {
    expect(normUnit('MG')).toBe('mg')
    expect(normUnit('ui')).toBe('IU')
    expect(normUnit('µg')).toBe('mcg')
    expect(normUnit('tabs')).toBe('tablet')
    expect(normUnit('Puffs')).toBe('puff')
    expect(normUnit('scoop')).toBe('scoop')
    expect(normUnit('  ')).toBeNull()
  })
  it('converts inside a family only', () => {
    expect(convert(1, 'g', 'mg')).toBe(1000)
    expect(convert(250, 'mcg', 'mg')).toBe(0.25)
    expect(convert(0.5, 'l', 'ml')).toBe(500)
    expect(convert(2.4, 'MIU', 'IU')).toBe(2_400_000)
    expect(convert(1, 'mg', 'ml')).toBeNull()
    expect(convert(1, 'tablet', 'capsule')).toBeNull()
    expect(convert(2, 'tablet', 'tablet')).toBe(2)
  })
  it('says an amount in a rounder unit', () => {
    expect(rounderAmount(1000, 'mg')).toEqual({ amount: 1, unit: 'g' })
    expect(rounderAmount(500, 'mg')).toEqual({ amount: 500, unit: 'mg' })
    expect(rounderAmount(1500, 'mg')).toEqual({ amount: 1.5, unit: 'g' })
  })
})

describe('what one piece holds, read from the name', () => {
  it('reads exactly one strength', () => {
    const p = pieceContentFromText(paracetamol)
    expect(p.strength).toEqual({ amount: 500, unit: 'mg', per: null, perUnit: null })
    expect(p.piece).toBe('tablet')
    expect(p.source).toBe('name')
  })
  it('reads the same strength written twice as one (the list designation)', () => {
    const p = pieceContentFromText({
      name: 'Phloroglucinol 80mg',
      strength: 'SPASCOL 80mg tablet B/20',
      unit: 'TABLET',
    })
    expect(p.strength).toEqual({ amount: 80, unit: 'mg', per: null, perUnit: null })
    expect(p.content).toBeNull()
  })
  it('gives no strength for a combination', () => {
    expect(
      pieceContentFromText({ name: 'Metformin 500 mg + Sitagliptin 50 mg', unit: 'tab' }).strength,
    ).toBeNull()
    expect(
      pieceContentFromText({ name: 'Artemether-lumefantrine', strength: '20/120 mg' }).strength,
    ).toBeNull()
    expect(
      pieceContentFromText({ name: 'Amoxicillin/Clavulanate', strength: '500mg/125mg' }).strength,
    ).toBeNull()
  })
  it('reads a strength in a volume and the bottle', () => {
    const p = pieceContentFromText({
      name: 'Amoxicillin 250mg/5ml',
      strength: 'AMOXIL 250mg/5ml powder for oral suspension 100ml',
      unit: 'BOTTLE',
    })
    expect(p.strength).toEqual({ amount: 250, unit: 'mg', per: 5, perUnit: 'ml' })
    expect(p.content).toEqual({ amount: 100, unit: 'ml' })
    expect(p.piece).toBe('bottle')
  })
  it('reads insulin: units per ml and the vial', () => {
    const p = pieceContentFromText(insulin)
    expect(p.strength).toEqual({ amount: 100, unit: 'IU', per: 1, perUnit: 'ml' })
    expect(p.content).toEqual({ amount: 10, unit: 'ml' })
  })
  it('an ampoule of 4 mg/2 ml holds 2 ml; 25 mg/ml says nothing of the content', () => {
    const p = pieceContentFromText({ name: 'Ondansetron', strength: '4 mg/2 ml', unit: 'ampoule' })
    expect(p.strength).toEqual({ amount: 4, unit: 'mg', per: 2, perUnit: 'ml' })
    expect(p.content).toEqual({ amount: 2, unit: 'ml' })
    expect(
      pieceContentFromText({ name: 'Promethazine', strength: '25mg/ml', unit: 'ampoule' }).content,
    ).toBeNull()
  })
  it('reads a content alone: a bottle, a drip, an inhaler, a cream', () => {
    expect(
      pieceContentFromText({ name: 'Cough syrup', strength: '100 ml', unit: 'bottle' }),
    ).toMatchObject({
      strength: null,
      content: { amount: 100, unit: 'ml' },
    })
    expect(pieceContentFromText({ name: 'Ringer lactate 500 ml' }).content).toEqual({
      amount: 500,
      unit: 'ml',
    })
    const inhaler = pieceContentFromText({ name: 'Salbutamol 100 mcg/dose inhaler 200 doses' })
    expect(inhaler.strength).toEqual({ amount: 100, unit: 'mcg', per: 1, perUnit: 'puff' })
    expect(inhaler.content).toEqual({ amount: 200, unit: 'puff' })
    const cream = pieceContentFromText({ name: 'Fusidic acid cream 2% 15 g', unit: 'tube' })
    expect(cream.strength).toBeNull()
    expect(cream.content).toEqual({ amount: 15, unit: 'g' })
  })
  it('a vial of 1 g is a strength, not a content', () => {
    expect(pieceContentFromText({ name: 'Ceftriaxone 1 g', unit: 'vial' }).strength).toEqual({
      amount: 1,
      unit: 'g',
      per: null,
      perUnit: null,
    })
  })
  it('nothing to read: no proposal', () => {
    expect(pieceContentFromText({ name: 'Gauze', unit: 'piece' }).source).toBe('none')
  })
  it('what the manager set wins over the name', () => {
    const p = pieceContentOf({ ...paracetamol, dose: setDose({ doseAmount: 1, doseUnit: 'g' }) })
    expect(p.source).toBe('set')
    expect(p.strength).toEqual({ amount: 1, unit: 'g', per: null, perUnit: null })
    // nothing set (both cleared): the name is read again
    expect(pieceContentOf({ ...paracetamol, dose: setDose({}) }).source).toBe('name')
  })
})

describe('given in parts, by its form', () => {
  const by = (text: string, extra: Partial<Parameters<typeof partModeBy>[0]> = {}) =>
    partModeBy({ text, ...extra })
  it('plain tablets in halves; coated, slow-release, capsules whole', () => {
    expect(by('Paracetamol 500 mg tablet tab')).toBe('half')
    expect(by('Aspirin 75 mg gastro-resistant tablet')).toBe('whole')
    expect(by('Nifedipine 20 mg SR tablet')).toBe('whole')
    expect(by('Vitamin C effervescent tablet')).toBe('whole')
    expect(by('Amoxicillin 500 mg capsule cap')).toBe('whole')
  })
  it('a syrup by the ml only when its content is known', () => {
    expect(by('Amoxicillin 250 mg/5 ml syrup bottle')).toBe('whole')
    expect(
      by('Amoxicillin 250 mg/5 ml syrup bottle', { contentUnit: 'ml', contentAmount: 100 }),
    ).toBe('measure')
  })
  it('sold only by the whole box: whole, whatever is set', () => {
    expect(by('Paracetamol tablet', { saleMode: 'pack', packSize: 20, partMode: 'half' })).toBe(
      'whole',
    )
    expect(by('Paracetamol tablet', { partMode: 'quarter' })).toBe('quarter')
  })
  it("the database's answer first", () => {
    expect(partModeOf({ ...paracetamol, dose: setDose({ partModeNow: 'quarter' }) })).toBe(
      'quarter',
    )
    expect(partModeOf(paracetamol)).toBe('half')
  })
})

describe('the dose in pieces', () => {
  it('1 g of a 500 mg tablet = 2 tablets', () => {
    expect(proposePieces({ amount: 1, unit: 'g' }, paracetamol)).toMatchObject({
      kind: 'exact',
      whole: 2,
      part: 0,
      how: 'strength',
    })
  })
  it('250 mg of a 500 mg tablet = ½ with halves; nothing when given whole only', () => {
    expect(proposePieces({ amount: 250, unit: 'mg' }, paracetamol)).toMatchObject({
      kind: 'exact',
      whole: 0,
      part: 0.5,
    })
    const wholeOnly = { ...paracetamol, dose: setDose({ partModeNow: 'whole' }) }
    expect(proposePieces({ amount: 250, unit: 'mg' }, wholeOnly)).toMatchObject({
      kind: 'notExact',
      pieces: 0.5,
    })
  })
  it('500 mg of 250 mg in 5 ml = 10 ml = 0.1 bottle of 100 ml', () => {
    const p = proposePieces({ amount: 500, unit: 'mg' }, amoxSyrup)
    expect(p).toMatchObject({
      kind: 'exact',
      whole: 0,
      part: 0.1,
      partMl: 10,
      measure: { amount: 10, unit: 'ml' },
    })
  })
  it('5 ml of a 100 ml bottle = 0.05', () => {
    const p = piecesForDose({ amount: 5, unit: 'ml' }, pieceContentOf(amoxSyrup))
    expect(p).toEqual({ pieces: 0.05, how: 'volume', measure: { amount: 5, unit: 'ml' } })
    expect(proposePieces({ amount: 5, unit: 'ml' }, amoxSyrup)).toMatchObject({ partMl: 5 })
  })
  // review 0198: a bottle whose content does not divide evenly (60 ml, 150 ml) was "not exact"
  it('a 60 ml bottle: 5 ml and 500 mg of 250 mg in 5 ml (10 ml) are proposed', () => {
    const syrup60: DoseItem = {
      ...amoxSyrup,
      dose: setDose({ ...amoxSyrup.dose!, contentAmount: 60 }),
    }
    expect(proposePieces({ amount: 5, unit: 'ml' }, syrup60)).toMatchObject({
      kind: 'exact',
      whole: 0,
      partMl: 5,
    })
    expect(proposePieces({ amount: 500, unit: 'mg' }, syrup60)).toMatchObject({
      kind: 'exact',
      whole: 0,
      partMl: 10,
    })
    expect(proposePieces({ amount: 70, unit: 'ml' }, syrup60)).toMatchObject({
      kind: 'exact',
      whole: 1,
      partMl: 10,
    })
    expect(proposePieces({ amount: 3.3, unit: 'ml' }, syrup60)).toMatchObject({
      kind: 'notExact',
    })
    const syrup150: DoseItem = {
      ...amoxSyrup,
      dose: setDose({ ...amoxSyrup.dose!, contentAmount: 150 }),
    }
    expect(proposePieces({ amount: 5, unit: 'ml' }, syrup150)).toMatchObject({ partMl: 5 })
  })
  it('1 g of a 750 mg tablet: no proposal (1⅓ tablets)', () => {
    const p = proposePieces({ amount: 1, unit: 'g' }, { name: 'Metformin 750 mg', unit: 'tab' })
    expect(p).toMatchObject({ kind: 'notExact' })
    expect(p?.kind === 'notExact' && fractionText(p.pieces)).toBe('1⅓')
  })
  it('insulin: 10 IU of 100 IU/ml = 0.1 ml (0.01 of a 10 ml vial)', () => {
    const p = piecesForDose({ amount: 10, unit: 'IU' }, pieceContentOf(insulin))
    expect(p).toEqual({ pieces: 0.01, how: 'strength', measure: { amount: 0.1, unit: 'ml' } })
    // given whole only (an injection): never proposed as 0.01 of a vial
    expect(proposePieces({ amount: 10, unit: 'IU' }, insulin)).toMatchObject({ kind: 'notExact' })
  })
  it('counts in the piece word: 2 tablets = 2', () => {
    expect(proposePieces({ amount: 2, unit: 'tablets' }, paracetamol)).toMatchObject({
      kind: 'exact',
      whole: 2,
      how: 'count',
    })
    expect(proposePieces({ amount: 1.5, unit: 'tab' }, paracetamol)).toMatchObject({
      whole: 1,
      part: 0.5,
    })
  })
  it('a unit that does not convert: no link (ml of a tablet, mg of a combination, words)', () => {
    expect(proposePieces({ amount: 5, unit: 'ml' }, paracetamol)).toMatchObject({ kind: 'noLink' })
    expect(
      proposePieces(
        { amount: 480, unit: 'mg' },
        { name: 'Artemether-lumefantrine', strength: '20/120 mg' },
      ),
    ).toMatchObject({ kind: 'noLink' })
    expect(proposePieces({ amount: 1, unit: 'scoop' }, paracetamol)).toMatchObject({
      kind: 'noLink',
    })
    expect(proposePieces({ amount: 0, unit: 'mg' }, paracetamol)).toBeNull()
  })
  it('only the measure when the bottle is not known', () => {
    const syrup = { name: 'Amoxicillin', strength: '250 mg/5 ml', form: 'syrup', unit: 'bottle' }
    expect(proposePieces({ amount: 500, unit: 'mg' }, syrup)).toEqual({
      kind: 'measureOnly',
      measure: { amount: 10, unit: 'ml' },
      piece: pieceContentOf(syrup),
    })
  })
  it('puffs of an inhaler', () => {
    const p = piecesForDose(
      { amount: 2, unit: 'puffs' },
      pieceContentFromText({ name: 'Salbutamol 100 mcg/dose inhaler 200 doses' }),
    )
    expect(p).toMatchObject({ pieces: 0.01, how: 'content' })
  })
})

describe('split into whole pieces and a part', () => {
  it('whole: only an exact whole number', () => {
    expect(splitPieces(2, 'whole')).toEqual({ ok: true, whole: 2, part: 0, partMl: null })
    expect(splitPieces(1.5, 'whole')).toEqual({ ok: false, exact: 1.5 })
  })
  it('halves and quarters', () => {
    expect(splitPieces(1.5, 'half')).toEqual({ ok: true, whole: 1, part: 0.5, partMl: null })
    expect(splitPieces(0.25, 'half')).toEqual({ ok: false, exact: 0.25 })
    expect(splitPieces(0.75, 'quarter')).toEqual({ ok: true, whole: 0, part: 0.75, partMl: null })
  })
  it('by measure: the ml left over, in steps of 0.5 ml', () => {
    expect(splitPieces(1.5, 'measure', 100)).toEqual({ ok: true, whole: 1, part: 0.5, partMl: 50 })
    expect(splitPieces(0.025, 'measure', 100)).toEqual({
      ok: true,
      whole: 0,
      part: 0.025,
      partMl: 2.5,
    })
    expect(splitPieces(0.0333, 'measure', 100)).toEqual({ ok: false, exact: 0.0333 })
    expect(splitPieces(0.5, 'measure', null)).toEqual({ ok: false, exact: 0.5 })
  })
})

describe('the take-home count', () => {
  it('times a day from "How often"', () => {
    expect(timesPerDay('TDS')).toBe(3)
    expect(timesPerDay('q8h')).toBe(3)
    expect(timesPerDay('BID')).toBe(2)
    expect(timesPerDay('STAT')).toBe('once')
    expect(timesPerDay('PRN')).toBeNull()
    expect(timesPerDay('after meals')).toBeNull()
  })
  it('1 tablet twice a day for 5 days = 10', () => {
    expect(takeHomeCount({ each: 1, frequency: 'BD', days: 5 })).toMatchObject({
      exact: 10,
      total: 10,
      roundedUp: false,
    })
  })
  it('½ tablet × 3 × 5 = 7½, rounded up to 8', () => {
    expect(takeHomeCount({ each: 0.5, frequency: 'TDS', days: 5 })).toMatchObject({
      exact: 7.5,
      total: 8,
      roundedUp: true,
    })
  })
  it('5 ml × 3 × 5 of a 100 ml bottle = 1 bottle', () => {
    expect(takeHomeCount({ each: 0.05, frequency: 'TDS', days: 5 })).toMatchObject({
      exact: 0.75,
      total: 1,
    })
  })
  it('5 ml × 3 × 4 of a 60 ml bottle = exactly 1 bottle (not "rounded up")', () => {
    const syrup60: DoseItem = {
      ...amoxSyrup,
      dose: setDose({ ...amoxSyrup.dose!, contentAmount: 60 }),
    }
    const p = proposePieces({ amount: 5, unit: 'ml' }, syrup60)
    const each = p?.kind === 'exact' ? p.pieces : null
    expect(takeHomeCount({ each, frequency: 'TDS', days: 4 })).toMatchObject({
      total: 1,
      roundedUp: false,
    })
    expect(takeHomeCount({ each, frequency: 'TDS', days: 5 })).toMatchObject({
      total: 2,
      roundedUp: true,
    })
  })
  it('when needed, or no days: no count; STAT: one time', () => {
    expect(takeHomeCount({ each: 1, frequency: 'PRN', days: 5 })).toBeNull()
    expect(takeHomeCount({ each: 1, frequency: 'TDS', days: null })).toBeNull()
    expect(takeHomeCount({ each: 2, frequency: 'STAT', days: 5 })).toMatchObject({
      total: 2,
      once: true,
    })
  })
})

describe('the price of a part', () => {
  const rule = (d: Partial<ItemDose>) => setDose(d)
  it('a share of the piece price by default', () => {
    expect(partPrice(null, 0.5, 50)).toBe(25)
    expect(partPrice(rule({}), 0.25, 50)).toBe(13)
  })
  it('the price of a whole piece', () => {
    expect(partPrice(rule({ partPriceRule: 'whole' }), 0.5, 50)).toBe(50)
  })
  it('a price set (cash bills): half, quarters, by the ml', () => {
    const set = rule({ partPriceRule: 'set', halfPrice: 30, quarterPrice: 15 })
    expect(partPrice(set, 0.5, 50)).toBe(30)
    expect(partPrice(set, 0.75, 50)).toBe(45)
    expect(partPrice(rule({ partPriceRule: 'set', quarterPrice: 15 }), 0.5, 50)).toBe(30)
    expect(
      partPrice(rule({ partPriceRule: 'set', measurePrice: 20 }), 0.05, 1000, {
        mode: 'measure',
        contentMl: 100,
      }),
    ).toBe(100)
    // an insured bill: the share of its piece price
    expect(partPrice(set, 0.5, 60, { cash: false })).toBe(30)
    // set but no price for this part: the share
    expect(partPrice(rule({ partPriceRule: 'set', halfPrice: 30 }), 0.25, 50)).toBe(13)
  })
  it('the part in figures', () => {
    expect(partFigure(0.5, 'half')).toBe('½')
    expect(partFigure(0.05, 'measure', 100)).toBe('5 ml')
    expect(partFigure(0.925, 'measure', 100)).toBe('92.5 ml')
  })
})

describe('fractions shown plainly', () => {
  it('halves, quarters, thirds and decimals', () => {
    expect(fractionText(0.5)).toBe('½')
    expect(fractionText(1.5)).toBe('1½')
    expect(fractionText(0.75)).toBe('¾')
    expect(fractionText(2)).toBe('2')
    expect(fractionText(0.05)).toBe('0.05')
    expect(fractionText(12.345, 'fr')).toBe('12,35')
    expect(fractionText(1 / 3 + 1)).toBe('1⅓')
  })
})

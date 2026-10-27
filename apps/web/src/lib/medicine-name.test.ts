import { describe, expect, it } from 'vitest'
import { compareMedicineParts, medicineNameParts, tidyAmounts } from './medicine-name'

const parts = (generic: string, presentation: string | null, unit: string | null) =>
  medicineNameParts({ generic, presentation, unit })

describe('medicineNameParts', () => {
  it('writes the generic with spaced units and the dosage form', () => {
    const p = parts('Acetazolamide 250mg', 'DIAMOX 250mg tablet', 'TABLET')
    expect(p.name).toBe('Acetazolamide 250 mg tablet')
    expect(p.brand).toBe('Diamox')
    expect(p.genericOnly).toBe('Acetazolamide')
    expect(p.strengthText).toBe('250 mg')
    expect(p.form).toBe('tablet')
  })

  it('names no brand when the presentation is the generic itself', () => {
    expect(parts('Acetazolamide 250mg', 'ACETAZOLAMIDE 250mg tablet', 'TABLET').brand).toBeNull()
  })

  it('title-cases a brand of several words and reads the box size', () => {
    const p = parts('Acetylsalicylic Acid  100mg', 'CARDIO ASPIRINE Tablet  100mg tablet', 'TABLET')
    expect(p.name).toBe('Acetylsalicylic acid 100 mg tablet')
    expect(p.brand).toBe('Cardio Aspirine')
    expect(parts('Glimepiride 4mg', 'AMAREL 4mg  tablet  B/30', 'TABLET').pack).toBe(30)
  })

  it('takes the strength from the presentation when the generic has none', () => {
    const p = parts('Loperamide', 'LOPERAMIDE   2MG tablet', 'TABLET ')
    expect(p.name).toBe('Loperamide 2 mg tablet')
    const s = parts('Multivitamin', 'MULTIVITAMIN Syrup  100ml', 'BOTTLE')
    expect(s.name).toBe('Multivitamin syrup')
    expect(s.content).toBe('100 ml')
  })

  it('keeps a form the generic already names', () => {
    expect(
      parts('Clonidine 0.15mg/ml Injection', 'CATAPRESSAN  0,15 mg/ml  Injection', 'VIAL').name,
    ).toBe('Clonidine 0.15 mg/ml injection')
  })

  it('sorts by generic, then by strength, the plain generic before the brands', () => {
    const a = parts('Acetazolamide 250mg', 'DIAMOX 250mg tablet', 'TABLET')
    const b = parts('Acetazolamide 250mg', 'ACETAZOLAMIDE 250mg tablet', 'TABLET')
    const c = parts('Acetylsalicylic Acid 1g Injection', 'ASPEGIC  1g Injection', 'VIAL')
    const d = parts('Acetylsalicylic Acid 75mg', 'ACETYLSALISYLIC ACID  75mg tablet', 'TABLET')
    const sorted = [c, a, d, b].sort(compareMedicineParts)
    expect(sorted).toEqual([b, a, d, c])
  })
})

describe('tidyAmounts', () => {
  it('spaces units and uses a decimal point', () => {
    expect(tidyAmounts('ZYMAFLUOR 0,25MG')).toBe('ZYMAFLUOR 0.25 mg')
    expect(tidyAmounts('25MG/ML 3 %')).toBe('25 mg/ml 3%')
  })
})

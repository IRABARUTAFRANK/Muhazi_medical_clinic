/**
 * Clean, professional medicine names out of the RHIA list's raw text.
 *
 * The list writes a generic name ("Acetazolamide 250mg", "Acetylsalicylic Acid 160mg
 * Gastro-Resistant") and a presentation in capitals that often starts with a brand ("DIAMOX
 * 250mg tablet", "AMAREL 4mg  tablet  B/30"). Pickers show instead:
 *   name  "Acetazolamide 250 mg tablet"   (generic, proper case, a space before units, the form)
 *   brand "Diamox"                        (only when it differs from the generic)
 *   pack  20 (from "B/20") and the content ("100 ml", "40 g") when the presentation says so.
 * Pure functions (no i18n, no data access) so they are easy to test.
 */

/** The units a strength or a content is written in, as the list spells them (any case). */
const UNIT = String.raw`(?:mcg|µg|μg|mg|g|ml|mmol|meq|mui|iu|ui|units?|%)`
const NUM = String.raw`\d+(?:[.,]\d+)?`
/** "250mg", "0,25MG", "25mg/ml", "80mg/2ml", "10mg/0.5mg", "2,4 MUI", "3%". */
const AMOUNT = new RegExp(
  String.raw`(${NUM})\s*(${UNIT})(?![a-zà-ÿ])(?:\s*\/\s*(${NUM})?\s*(${UNIT})(?![a-zà-ÿ]))?`,
  'gi',
)

/** A unit in the clinic's spelling: mg, g, ml, µg, IU, MUI, %. */
function unitWord(u: string): string {
  const l = u.toLowerCase()
  if (l === 'μg' || l === 'µg') return 'µg'
  if (l === 'iu' || l === 'ui') return 'IU'
  if (l === 'mui') return 'MUI'
  if (l === 'unit' || l === 'units') return 'units'
  return l
}

/** "0,25" → "0.25" (a decimal comma; "100,000" keeps its thousands comma). */
const decimalPoint = (s: string) => s.replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2')

/** "250mg" → "250 mg", "25MG/ML" → "25 mg/ml", "3 %" → "3%". */
export function tidyAmounts(s: string): string {
  return decimalPoint(s).replace(AMOUNT, (_m, n: string, u: string, n2?: string, u2?: string) => {
    const one = (num: string, unit: string) =>
      unit === '%' ? `${num}%` : `${num} ${unitWord(unit)}`
    const first = one(n, u)
    if (!u2) return first
    return `${first}/${n2 ? one(n2, u2) : unitWord(u2)}`
  })
}

/** Dosage forms, the most specific first; each gives the form in plain lower case. */
const FORMS: [RegExp, string][] = [
  [/powder for oral solution/i, 'powder for oral solution'],
  [/powder for oral suspension/i, 'powder for oral suspension'],
  [/powder for (?:injection|injectable)/i, 'powder for injection'],
  [/oral solution/i, 'oral solution'],
  [/oral suspension/i, 'oral suspension'],
  [/oral gel/i, 'oral gel'],
  [/oral drops/i, 'oral drops'],
  [/eye drops?|\bcollyre\b/i, 'eye drops'],
  [/ear drops?/i, 'ear drops'],
  [/eye ointment|ophthalmic ointment/i, 'eye ointment'],
  [/nasal spray/i, 'nasal spray'],
  [/nebul/i, 'nebuliser solution'],
  [/inhalation|evohaler|inhaler|\ba[eé]rosol\b/i, 'inhaler'],
  [/vaginal cream/i, 'vaginal cream'],
  [/vaginal (?:tablet|tab|ovule|pessar)/i, 'vaginal tablet'],
  [/effervescent tablet/i, 'effervescent tablet'],
  [/dispersible tablet/i, 'dispersible tablet'],
  [/\btab(?:let)?s?\b|\bcomprim/i, 'tablet'],
  [/\bcapsules?\b|\bcaps\b|\bg[eé]lules?\b/i, 'capsule'],
  [/\bsyrup\b|\bsirop\b/i, 'syrup'],
  [/\bsuspension\b/i, 'suspension'],
  [/\binfusion\b|\bperfusion\b/i, 'infusion'],
  [/\binj(?:ection|ectable)?\b/i, 'injection'],
  [/\bsolutions?\b/i, 'solution'],
  [/\bcream\b|\bcr[eè]me\b/i, 'cream'],
  [/\bointment\b|\bpommade\b/i, 'ointment'],
  [/\bgel\b/i, 'gel'],
  [/\blotion\b/i, 'lotion'],
  [/\bsuppositor(?:y|ies)\b/i, 'suppository'],
  [/\bpessar(?:y|ies)\b|\bovules?\b/i, 'pessary'],
  [/\bsachets?\b/i, 'sachet'],
  [/\bdrops\b/i, 'drops'],
  [/\bspray\b/i, 'spray'],
  [/\bimplant\b/i, 'implant'],
  [/\bpatch(?:es)?\b/i, 'patch'],
  [/\btoothpaste\b/i, 'toothpaste'],
  [/\bmouthwash\b/i, 'mouthwash'],
  [/\bshampoo\b/i, 'shampoo'],
  [/\bpowder\b/i, 'powder'],
]

/** The selling unit when the text names no form: TABLET → tablet, VIAL → injection. */
const UNIT_FORM: Record<string, string> = {
  TABLET: 'tablet',
  TABLETS: 'tablet',
  CAPSULE: 'capsule',
  CAPSULES: 'capsule',
  SACHET: 'sachet',
  SUPPOSITORY: 'suppository',
  VIAL: 'injection',
  AMPOULE: 'injection',
  AMPULE: 'injection',
}

/** The dosage form a text names, or null. */
export function formOf(text: string | null | undefined): string | null {
  if (!text) return null
  for (const [re, form] of FORMS) if (re.test(text)) return form
  return null
}

/** Words of a presentation that end a brand: containers, routes, forms. */
const NOT_BRAND =
  /^(?:tube|tbe|bottle|btl|fl|flacon|vial|amp|ampoule|inj\.?|oral|b\/\d*|box|pot|sachets?|tablets?|caps?(?:ules?)?|syrup|solutions?|suspension|cream|ointment|gel|drops?|spray|toothpaste|mouthwash|injection|infusion|suppository|powder|lotion|eye|ear|nasal|vaginal|aqueous|topical|sol\.?|inhalation|nebul\.?|evohaler|for|with|and|\+|&|-|\(.*|\*+)$/i

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')

const isUpperWord = (w: string) => /[A-Z]/.test(w) && w === w.toUpperCase()

/** "CARDIO ASPIRINE" → "Cardio Aspirine"; short capitals stay ("ZIMFIL ODS" → "Zimfil ODS"). */
export function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) =>
      w.length <= 3 && isUpperWord(w)
        ? w
        : w
            .toLowerCase()
            .replace(/(^|[-'’])(\p{L})/gu, (_m, sep: string, c: string) => sep + c.toUpperCase()),
    )
    .join(' ')
}

/**
 * The generic name in proper case: the first word capitalised, the other words in lower case
 * except short capitals ("ODS", "MUI", "HCL") and words mixing cases on purpose ("pH").
 */
export function properGeneric(s: string): string {
  const clean = tidyAmounts(
    s
      .replace(/\b([A-Z]{1,2})-\s+/g, '$1-')
      .replace(/\+(?:\s*\+)+/g, '+')
      .replace(/\s+-(?=\p{L})/gu, '-')
      .replace(/\btablets\b/gi, 'tablet')
      .replace(/\bcapsules\b/gi, 'capsule')
      .replace(/\s*\+\s*/g, ' + ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
  let first = true
  return clean
    .split(' ')
    .map((w) => {
      if (!/\p{L}/u.test(w) || /\d/.test(w)) return w
      const letters = w.replace(/[^\p{L}]/gu, '')
      let out = w
      if (first) {
        if (isUpperWord(letters) && letters.length > 3) out = w.charAt(0) + w.slice(1).toLowerCase()
        else out = w.charAt(0).toUpperCase() + w.slice(1)
      } else if (isUpperWord(letters)) {
        out = letters.length <= 3 ? w : w.toLowerCase()
      } else if (/^\p{Lu}[\p{Ll}\-.’']*$/u.test(w) || /^\p{Lu}[\p{Ll}]+-\p{Lu}/u.test(w)) {
        out = w.toLowerCase()
      }
      first = false
      return out
    })
    .join(' ')
    .replace(/\s+[.*]+$/, '')
}

/** The amounts found in a text, split into strengths (250 mg, 25 mg/ml) and contents (100 ml). */
function amounts(text: string, topical: boolean) {
  const strengths: string[] = []
  const contents: string[] = []
  for (const m of decimalPoint(text).matchAll(AMOUNT)) {
    const unit = m[2]!.toLowerCase()
    const tidy = tidyAmounts(m[0])
    if (m[4]) strengths.push(tidy)
    else if (unit === 'ml' || (unit === 'g' && topical)) contents.push(tidy)
    else strengths.push(tidy)
  }
  // "120 doses" (sprays, inhalers)
  const doses = /(\d+)\s*doses?\b/i.exec(text)
  if (doses) contents.push(`${doses[1]} doses`)
  return { strengths, contents }
}

export interface MedicineNameParts {
  /** "Acetazolamide 250 mg tablet". */
  name: string
  /** The generic alone, for sorting ("acetazolamide"). */
  base: string
  /** The first strength's number, for sorting (250); null when none. */
  strength: number | null
  /** "Diamox"; null when the presentation is the generic itself. */
  brand: string | null
  /** "100 ml", "40 g", "120 doses"; null when not said. */
  content: string | null
  /** Units in one box ("B/20" → 20); null when not said. */
  pack: number | null
  /** "tablet", "oral solution"…; null when not known. */
  form: string | null
  /** The strength from the generic or, failing that, the presentation ("250 mg"). */
  strengthText: string | null
  /** The generic without its strength nor form ("Acetazolamide"). */
  genericOnly: string
}

const TOPICAL = /cream|ointment|gel|toothpaste|paste|lotion/i

/** Split one entry of the list into clean parts (see the file's comment). */
export function medicineNameParts(r: {
  generic: string
  presentation: string | null
  unit: string | null
}): MedicineNameParts {
  const pres = (r.presentation ?? '').replace(/\s+/g, ' ').trim()
  const generic = properGeneric(r.generic)
  const genericForm = formOf(r.generic)
  const form = genericForm ?? formOf(pres) ?? UNIT_FORM[(r.unit ?? '').trim().toUpperCase()] ?? null
  const unitUpper = (r.unit ?? '').trim().toUpperCase()
  const topical =
    TOPICAL.test(pres) || TOPICAL.test(r.generic) || unitUpper === 'TUBE' || unitUpper === 'POT'
  const fromPres = amounts(pres, topical)
  const genericHasAmount = /\d/.test(r.generic)
  const strengthText = genericHasAmount
    ? (amounts(r.generic, topical).strengths[0] ?? null)
    : (fromPres.strengths[0] ?? null)
  const name = [
    generic,
    !genericHasAmount ? fromPres.strengths[0] : null,
    genericForm ? null : form,
  ]
    .filter(Boolean)
    .join(' ')

  // the brand: the presentation's first words in capitals, before any number or form word
  const brandWords: string[] = []
  for (const w of pres.split(' ')) {
    if (!w || /\d/.test(w) || NOT_BRAND.test(w) || !isUpperWord(w.replace(/[^\p{L}]/gu, '') || 'a'))
      break
    brandWords.push(w.replace(/[®™,;:*]+$/, ''))
  }
  const rawBrand = brandWords.join(' ').trim()
  const b = fold(rawBrand)
  const g = fold(r.generic)
  const n = Math.min(6, b.length, g.length)
  const sameAsGeneric = !b || (n > 0 && b.slice(0, n) === g.slice(0, n))
  const brand = rawBrand && !sameAsGeneric ? titleCase(rawBrand) : null

  const pack = /\bB\s*\/\s*(\d+)\b/i.exec(pres)
  const content = fromPres.contents.find((c) => !generic.includes(c)) ?? null
  // in mg, so 1 g sorts after 75 mg
  const sm = strengthText ? /(\d+(?:\.\d+)?)\s*(µg|mcg|mg|g)?/.exec(strengthText) : null
  const scale = sm?.[2] === 'g' ? 1000 : sm?.[2] === 'µg' || sm?.[2] === 'mcg' ? 0.001 : 1
  const strengthNum = sm ? Number(sm[1]) * scale : NaN
  const genericOnly =
    generic
      .split(/\s(?=\d)/)[0]!
      .replace(new RegExp(String.raw`\s+${genericForm ?? '$^'}$`, 'i'), '')
      .trim() || generic
  return {
    name,
    base: fold(generic.split(/\d/)[0] ?? generic),
    strength: Number.isFinite(strengthNum) ? strengthNum : null,
    brand,
    content,
    pack: pack ? Number(pack[1]) : null,
    form,
    strengthText,
    genericOnly,
  }
}

/** Case- and accent-blind comparison, numbers by value ("2" before "10"). */
export const nameCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** Order of a list: by generic name, then strength, the plain generic before the brands. */
export function compareMedicineParts(a: MedicineNameParts, b: MedicineNameParts): number {
  return (
    nameCollator.compare(a.base, b.base) ||
    (a.strength ?? -1) - (b.strength ?? -1) ||
    nameCollator.compare(a.name, b.name) ||
    (a.brand ? 1 : 0) - (b.brand ? 1 : 0) ||
    nameCollator.compare(a.brand ?? '', b.brand ?? '')
  )
}

/** A name typed by the clinic, tidied the same way: "Amoxicillin 500mg" → "Amoxicillin 500 mg". */
export const tidyName = (s: string) => tidyAmounts(s.replace(/\s+/g, ' ').trim())

/** The pieces in one pack as the list writes it ("… tablet B/20" → 20); null when not said. */
export const packSizeIn = (presentation: string | null | undefined): number | null => {
  const m = /\bB\s*\/\s*(\d+)\b/i.exec(presentation ?? '')
  return m ? Number(m[1]) : null
}

/**
 * Pieces as whole packs and the rest: 503 tablets in packs of 20 are 25 packs + 3. Null when the
 * item has no pack (one piece per pack) or fewer pieces than one pack.
 */
export function splitPacks(
  units: number,
  packSize: number | null | undefined,
): { packs: number; rest: number; size: number } | null {
  const size = packSize ?? 1
  if (!Number.isFinite(units) || size < 2 || units < size) return null
  const packs = Math.floor(units / size)
  return { packs, rest: units - packs * size, size }
}

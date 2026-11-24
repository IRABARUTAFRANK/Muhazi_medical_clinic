/**
 * 0198 · The dose and the pieces (DESIGN §A, §B, §C). Pure functions: no i18n, no data access.
 *
 * A medicine knows what one piece holds (500 mg a tablet; 250 mg in 5 ml and 100 ml a bottle):
 * set by the manager (items_catalogue's 0198 columns, `ItemDose`) or, failing that, read from its
 * name ("Paracetamol 500 mg"). A dose typed by the doctor (1 g) is turned into pieces (2 tablets)
 * only when the units convert and the result is a number of pieces the medicine may be given in
 * (whole, halves, quarters, or by the ml of a bottle). Never rounded up or down silently: a dose
 * that does not come out exact proposes nothing and the doctor types the pieces.
 *
 * For WP3 (the order form, the take-home count, the nurse's row), everything is here:
 *   DOSE_UNITS / STRENGTH_UNITS / MEASURE_UNITS / COUNT_UNITS, normUnit, unitFamily, convert:
 *     the unit list of the dose select (labels: dose-words.ts `doseUnitLabel`);
 *   pieceContentOf(item): what one piece holds (set → read from the name → nothing), with `source`;
 *   partModeOf(item): how it may be given in parts now (the database's part_mode_now first);
 *   proposePieces(dose, item): the whole pieces + the part to fill in, or why nothing is proposed;
 *     (piecesForDose + splitPieces underneath, for screens that need the steps);
 *   timesPerDay(frequency), takeHomeCount({each, frequency, days}): the take-home count, rounded up;
 *   partPrice(item dose, part, piece price): the price of ½ tablet / 5 ml by the medicine's rule;
 *   partText(part, mode, piece): "½" / "5 ml" figures for the bill words and the nurse;
 *   amountText(n, unit): "500 mg", "2.5 ml" (no trailing zeros).
 * Fractions in words: lib/fraction.ts (fractionText).
 */
import { isWhole, round6 } from './fraction'

// ---------------------------------------------------------------- units (DESIGN §A.1)
export type UnitFamily = 'mass' | 'volume' | 'units' | 'mmol' | 'mEq' | 'count' | 'other'

export interface DoseUnit {
  code: string
  family: UnitFamily
  /** In the family's base unit (mg, ml, IU); 1 for the others. */
  factor: number
}

/** Every unit a dose, a strength or a content is written in, by family. */
export const DOSE_UNITS: readonly DoseUnit[] = [
  { code: 'mcg', family: 'mass', factor: 0.001 },
  { code: 'mg', family: 'mass', factor: 1 },
  { code: 'g', family: 'mass', factor: 1000 },
  { code: 'ml', family: 'volume', factor: 1 },
  { code: 'l', family: 'volume', factor: 1000 },
  { code: 'IU', family: 'units', factor: 1 },
  { code: 'MIU', family: 'units', factor: 1_000_000 },
  { code: 'mmol', family: 'mmol', factor: 1 },
  { code: 'mEq', family: 'mEq', factor: 1 },
  { code: 'tablet', family: 'count', factor: 1 },
  { code: 'capsule', family: 'count', factor: 1 },
  { code: 'ampoule', family: 'count', factor: 1 },
  { code: 'vial', family: 'count', factor: 1 },
  { code: 'sachet', family: 'count', factor: 1 },
  { code: 'drop', family: 'count', factor: 1 },
  { code: 'puff', family: 'count', factor: 1 },
  { code: 'suppository', family: 'count', factor: 1 },
  { code: 'bottle', family: 'count', factor: 1 },
  { code: 'tube', family: 'count', factor: 1 },
  { code: 'piece', family: 'count', factor: 1 },
]

/** What one piece holds may be said in these (set_item_dose's list). */
export const STRENGTH_UNITS = ['mcg', 'mg', 'g', 'IU', 'MIU', 'mmol', 'mEq'] as const
/** "250 mg in 5 ml" and the content of one piece ("100 ml", "200 puffs"). */
export const MEASURE_UNITS = ['ml', 'l', 'g', 'drop', 'puff'] as const
/** The words of one piece. */
export const COUNT_UNITS = DOSE_UNITS.filter((u) => u.family === 'count').map((u) => u.code)

const ALIASES: Record<string, string> = {
  µg: 'mcg',
  μg: 'mcg',
  ug: 'mcg',
  microgram: 'mcg',
  micrograms: 'mcg',
  milligram: 'mg',
  milligrams: 'mg',
  gram: 'g',
  grams: 'g',
  gramme: 'g',
  grammes: 'g',
  iu: 'IU',
  ui: 'IU',
  u: 'IU',
  unit: 'IU',
  units: 'IU',
  unité: 'IU',
  unités: 'IU',
  miu: 'MIU',
  mui: 'MIU',
  meq: 'mEq',
  mls: 'ml',
  litre: 'l',
  litres: 'l',
  liter: 'l',
  liters: 'l',
  tab: 'tablet',
  tabs: 'tablet',
  tablets: 'tablet',
  cp: 'tablet',
  comp: 'tablet',
  comprimé: 'tablet',
  comprimés: 'tablet',
  ikinini: 'tablet',
  ibinini: 'tablet',
  cap: 'capsule',
  caps: 'capsule',
  capsules: 'capsule',
  gélule: 'capsule',
  gélules: 'capsule',
  amp: 'ampoule',
  ampule: 'ampoule',
  ampoules: 'ampoule',
  ampules: 'ampoule',
  vials: 'vial',
  fiole: 'vial',
  sachets: 'sachet',
  drops: 'drop',
  gtt: 'drop',
  goutte: 'drop',
  gouttes: 'drop',
  puffs: 'puff',
  dose: 'puff',
  doses: 'puff',
  supp: 'suppository',
  suppositories: 'suppository',
  suppositoire: 'suppository',
  suppositoires: 'suppository',
  bottles: 'bottle',
  btl: 'bottle',
  flacon: 'bottle',
  flacons: 'bottle',
  tubes: 'tube',
  pieces: 'piece',
  pcs: 'piece',
  pc: 'piece',
}

const CODES = new Map(DOSE_UNITS.map((u) => [u.code.toLowerCase(), u]))

/**
 * A unit as the list spells it: "MG" → mg, "ui" → IU, "tabs" → tablet, "Puffs" → puff. Empty →
 * null; a unit not in the list keeps its own (trimmed) spelling (its family is 'other').
 */
export function normUnit(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().replace(/\.$/, '')
  if (!s) return null
  const l = s.toLowerCase()
  const alias = ALIASES[s] ?? ALIASES[l]
  if (alias) return alias
  const u = CODES.get(l)
  return u ? u.code : s
}

const unitOf = (code: string | null | undefined): DoseUnit | undefined => {
  const n = normUnit(code)
  return n ? CODES.get(n.toLowerCase()) : undefined
}

/** The family of a unit (mass, volume, units…); 'other' for a unit not in the list. */
export const unitFamily = (code: string | null | undefined): UnitFamily =>
  unitOf(code)?.family ?? 'other'

/**
 * An amount in another unit of the same family (1 g → 1000 mg, 0.5 l → 500 ml, 2.4 MIU →
 * 2 400 000 IU); null when they do not convert (mg ↔ ml, a tablet ↔ a capsule, other units).
 */
export function convert(amount: number, from: string, to: string): number | null {
  const a = unitOf(from)
  const b = unitOf(to)
  if (!a || !b || !Number.isFinite(amount)) return null
  if (a.family === 'count' || b.family === 'count') return a.code === b.code ? amount : null
  if (a.family !== b.family) return null
  return round6((amount * a.factor) / b.factor)
}

/** Rounded to 9 decimals: the float noise goes (0.1 × 3), a twelfth of a bottle stays exact. */
const round9 = (n: number): number => Math.round(n * 1e9) / 1e9

/** "500 mg", "2.5 ml", "1 g" (no trailing zeros, a dot for decimals). */
export const amountText = (n: number, unit: string): string => `${String(round6(n))} ${unit}`.trim()

/** The same amount in a rounder unit: 1000 mg → 1 g, 2000 mcg → 2 mg, 1000 ml → 1 l. */
export function rounderAmount(n: number, unit: string): { amount: number; unit: string } {
  const up: Record<string, string> = { mcg: 'mg', mg: 'g', ml: 'l', IU: 'MIU' }
  let a = n
  let u = normUnit(unit) ?? unit
  for (;;) {
    const next = up[u]
    const c = next ? convert(a, u, next) : null
    if (!next || c == null || c < 1 || !isWhole(c * 100)) break
    a = c
    u = next
  }
  return { amount: a, unit: u }
}

// ---------------------------------------------------------------- what one piece holds (§A.2, §A.3)
export interface Strength {
  /** 500 for 500 mg; 250 for 250 mg in 5 ml. */
  amount: number
  /** mcg, mg, g, IU, MIU, mmol, mEq. */
  unit: string
  /** 5 for "in 5 ml"; null = in one piece. */
  per: number | null
  /** ml, l, g, drop, puff (with `per`). */
  perUnit: string | null
}
export interface Content {
  /** 100 for a bottle of 100 ml. */
  amount: number
  /** ml, l, g, drop, puff. */
  unit: string
}
export interface PieceContent {
  strength: Strength | null
  content: Content | null
  /** The word of one piece (tablet, capsule, bottle, ampoule…, or the item's own word); null: not known. */
  piece: string | null
  /** set: by the manager (kept); name: read from the name (a proposal to check); none. */
  source: 'set' | 'name' | 'none'
}

export type PartMode = 'whole' | 'half' | 'quarter' | 'measure'
export type PartPriceRule = 'share' | 'whole' | 'set'
export const PART_MODES: readonly PartMode[] = ['whole', 'half', 'quarter', 'measure']

/** What one piece holds and its parts, as the database keeps them (items_catalogue, 0198). */
export interface ItemDose {
  doseAmount: number | null
  doseUnit: string | null
  dosePer: number | null
  dosePerUnit: string | null
  contentAmount: number | null
  contentUnit: string | null
  /** Set by the manager; null = by its form. */
  partMode: PartMode | null
  /** How it is given in parts now (the set mode, else by its form): the database's answer. */
  partModeNow: PartMode | null
  partPriceRule: PartPriceRule
  halfPrice: number | null
  quarterPrice: number | null
  measurePrice: number | null
  /** When someone last saved these (null: never). */
  doseSetAt: string | null
}

const numOrNull = (v: unknown): number | null =>
  v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)
const textOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null
const modeOrNull = (v: unknown): PartMode | null =>
  PART_MODES.includes(v as PartMode) ? (v as PartMode) : null

/**
 * The 0198 columns of an items_catalogue row (snake case). Null on a database without 0198 (the
 * row has no part_price_rule): the screens then read the strength from the name only.
 */
export function itemDoseFromRow(r: Record<string, unknown>): ItemDose | null {
  if (!('part_price_rule' in r)) return null
  const rule = r.part_price_rule
  return {
    doseAmount: numOrNull(r.dose_amount),
    doseUnit: textOrNull(r.dose_unit),
    dosePer: numOrNull(r.dose_per),
    dosePerUnit: textOrNull(r.dose_per_unit),
    contentAmount: numOrNull(r.content_amount),
    contentUnit: textOrNull(r.content_unit),
    partMode: modeOrNull(r.part_mode),
    partModeNow: modeOrNull(r.part_mode_now),
    partPriceRule: rule === 'whole' || rule === 'set' ? rule : 'share',
    halfPrice: numOrNull(r.half_price),
    quarterPrice: numOrNull(r.quarter_price),
    measurePrice: numOrNull(r.measure_price),
    doseSetAt: textOrNull(r.dose_set_at),
  }
}

/** The same, from set_item_dose's answer (camel case). */
export function itemDoseFromJson(d: Record<string, unknown>): ItemDose {
  const rule = d.partPriceRule
  return {
    doseAmount: numOrNull(d.doseAmount),
    doseUnit: textOrNull(d.doseUnit),
    dosePer: numOrNull(d.dosePer),
    dosePerUnit: textOrNull(d.dosePerUnit),
    contentAmount: numOrNull(d.contentAmount),
    contentUnit: textOrNull(d.contentUnit),
    partMode: modeOrNull(d.partMode),
    partModeNow: modeOrNull(d.partModeNow),
    partPriceRule: rule === 'whole' || rule === 'set' ? rule : 'share',
    halfPrice: numOrNull(d.halfPrice),
    quarterPrice: numOrNull(d.quarterPrice),
    measurePrice: numOrNull(d.measurePrice),
    doseSetAt: textOrNull(d.doseSetAt),
  }
}

/** A medicine as the dose engine reads it (Item, Medicine, StockItem all fit). */
export interface DoseItem {
  name: string
  strength?: string | null
  form?: string | null
  unit?: string | null
  sellingUnit?: string | null
  saleMode?: string | null
  packSize?: number | null
  /** The 0198 columns; null/undefined on an older database. */
  dose?: ItemDose | null
}

const FORM_PIECE: [RegExp, string][] = [
  [/effervescent|dispersible|\btab|comprim/i, 'tablet'],
  [/capsule|g[eé]lule/i, 'capsule'],
  [/sachet/i, 'sachet'],
  [/suppositor/i, 'suppository'],
  [/syrup|sirop|suspension|oral solution|solution buvable/i, 'bottle'],
  [/inhaler|inhalation|evohaler|a[eé]rosol/i, 'piece'],
]

/** The word of one piece: the item's unit (tab → tablet, amp → ampoule), else from its form. */
export function pieceWordOf(i: Pick<DoseItem, 'unit' | 'sellingUnit' | 'form'>): string | null {
  for (const w of [i.sellingUnit, i.unit]) {
    const n = normUnit(w)
    if (n) return unitFamily(n) === 'count' ? n : n.toLowerCase()
  }
  for (const [re, w] of FORM_PIECE) if (re.test(i.form ?? '')) return w
  return null
}

const NUM = String.raw`\d+(?:\.\d+)?`
const S_UNIT = String.raw`(?:mcg|µg|μg|ug|mg|g|mmol|meq|mui|miu|iu|ui|units?)`
const P_UNIT = String.raw`(?:ml|l|g|doses?|puffs?|drops?|gtt)`
/** "500 mg", "250mg/5ml", "25 mg/ml", "100 IU/ml", "4 mg/2 ml", "2.4 MUI", "100 mcg/dose". */
const STRENGTH_RE = new RegExp(
  String.raw`(?<![\d.\/])(${NUM})\s*(${S_UNIT})(?![a-zà-ÿ])(?:\s*(?:\/|\bper\b|\bin\b|\bdans\b)\s*(${NUM})?\s*(${P_UNIT})(?![a-zà-ÿ]))?`,
  'gi',
)
/** "100 ml", "10ml", "0.5 l"; "30 g" for a cream. */
const VOLUME_RE = new RegExp(
  String.raw`(?<![\d.\/])(${NUM})\s*(ml|l|litres?|liters?)(?![a-zà-ÿ])`,
  'gi',
)
const GRAM_RE = new RegExp(String.raw`(?<![\d.\/])(${NUM})\s*(g)(?![a-zà-ÿ])`, 'gi')
const DOSES_RE = /(?<![\d.])(\d+)\s*(?:doses?|puffs?|sprays?)\b/gi
/** Two strengths written together: "20/120 mg", "500mg/125mg", "Metformin + Sitagliptin". */
const COMBINATION_RE = new RegExp(
  String.raw`\d\s*\/\s*${NUM}\s*${S_UNIT}(?![a-zà-ÿ])|${S_UNIT}\s*\/\s*${NUM}\s*(?:mcg|µg|μg|ug|mg|iu|ui|mmol|meq)(?![a-zà-ÿ])|\+`,
  'i',
)
const TOPICAL_RE = /cream|cr[eè]me|ointment|pommade|gel\b|toothpaste|paste|lotion/i
const INJECTABLE_RE = /ampoule|ampule|\bamp\b|vial|fiole|inject|\binj\b/i

/** "0,25" → "0.25" (a decimal comma; "100,000" keeps its thousands comma). */
const decimalPoint = (s: string) => s.replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2')

const sameStrength = (a: Strength, b: Strength) =>
  convert(a.amount, a.unit, b.unit) === b.amount &&
  (a.per == null) === (b.per == null) &&
  (a.per == null || convert(a.per, a.perUnit ?? '', b.perUnit ?? '') === b.per)

/**
 * What one piece holds, read from the medicine's words (its name, the strength field, its form
 * and unit): exactly one strength ("500 mg", "250 mg/5 ml", "100 IU/ml"); a combination (two
 * strengths, "20/120 mg", "A + B") gives none. A content ("100 ml", "10ml", "200 doses", "30 g"
 * of a cream); more than one gives none. An ampoule or vial written "4 mg/2 ml" with no other
 * content holds 2 ml. Never stored by itself: it is shown as "read from the name — check it".
 */
export function pieceContentFromText(i: Omit<DoseItem, 'dose'>): PieceContent {
  const words = decimalPoint([i.name, i.strength].filter(Boolean).join(' '))
  const all = [words, i.form, i.unit, i.sellingUnit].filter(Boolean).join(' ')
  const piece = pieceWordOf(i)
  const topical = TOPICAL_RE.test(all) || /^(tube|pot)$/i.test((i.unit ?? '').trim())
  const strengths: Strength[] = []
  // "4 mg/2 ml" says how much liquid; "25 mg/ml" is only how strong it is
  let perWritten = false
  let rest = words
  if (!COMBINATION_RE.test(words)) {
    for (const m of words.matchAll(STRENGTH_RE)) {
      const unit = normUnit(m[2])!
      const perUnit = m[4] ? normUnit(m[4]) : null
      // "30 g" of a cream is its content, not a strength
      if (unit === 'g' && !perUnit && topical) continue
      const s: Strength = {
        amount: Number(m[1]),
        unit,
        per: perUnit ? Number(m[3] ?? 1) : null,
        perUnit,
      }
      if (!(s.amount > 0) || (s.per != null && !(s.per > 0))) continue
      if (!strengths.some((x) => sameStrength(x, s))) strengths.push(s)
      if (m[3]) perWritten = true
      rest = rest.replace(m[0], ' ')
    }
  } else {
    // a combination: its strengths are not a content either
    rest = rest.replace(STRENGTH_RE, ' ')
  }
  const strength = strengths.length === 1 ? strengths[0]! : null
  const contents: Content[] = []
  const addContent = (c: Content) => {
    if (c.amount > 0 && !contents.some((x) => convert(x.amount, x.unit, c.unit) === c.amount))
      contents.push(c)
  }
  for (const m of rest.matchAll(VOLUME_RE))
    addContent({ amount: Number(m[1]), unit: normUnit(m[2])! })
  for (const m of rest.matchAll(DOSES_RE)) addContent({ amount: Number(m[1]), unit: 'puff' })
  if (topical)
    for (const m of rest.matchAll(GRAM_RE)) addContent({ amount: Number(m[1]), unit: 'g' })
  let content = contents.length === 1 ? contents[0]! : null
  // an ampoule or a vial of "4 mg/2 ml": it holds the 2 ml
  if (
    !content &&
    contents.length === 0 &&
    strength?.per != null &&
    strength.perUnit &&
    unitFamily(strength.perUnit) === 'volume' &&
    perWritten &&
    (piece === 'ampoule' || piece === 'vial' || INJECTABLE_RE.test(all))
  )
    content = { amount: strength.per, unit: strength.perUnit }
  return {
    strength,
    content,
    piece,
    source: strength || content ? 'name' : 'none',
  }
}

/** What the manager set, as a PieceContent; null when nothing is set (then read the name). */
export function pieceContentSet(item: Pick<DoseItem, 'unit' | 'sellingUnit' | 'form' | 'dose'>) {
  const d = item.dose
  if (!d) return null
  const strength: Strength | null =
    d.doseAmount != null && d.doseUnit
      ? {
          amount: d.doseAmount,
          unit: normUnit(d.doseUnit)!,
          per: d.dosePer != null && d.dosePerUnit ? d.dosePer : null,
          perUnit: d.dosePer != null && d.dosePerUnit ? normUnit(d.dosePerUnit) : null,
        }
      : null
  const content: Content | null =
    d.contentAmount != null && d.contentUnit
      ? { amount: d.contentAmount, unit: normUnit(d.contentUnit)! }
      : null
  if (!strength && !content) return null
  return { strength, content, piece: pieceWordOf(item), source: 'set' } satisfies PieceContent
}

/**
 * What one piece holds: what the manager set (always wins), else what the name says (a proposal,
 * `source: 'name'`), else nothing (`source: 'none'`: the doctor types the pieces).
 */
export function pieceContentOf(item: DoseItem): PieceContent {
  return pieceContentSet(item) ?? pieceContentFromText(item)
}

/** The content of one piece in ml (a bottle of 100 ml → 100; 0.5 l → 500); null when not in ml/l. */
export const contentMl = (p: Pick<PieceContent, 'content'> | null | undefined): number | null =>
  p?.content ? convert(p.content.amount, p.content.unit, 'ml') : null

// ---------------------------------------------------------------- given in parts (§A.3, §C.1)
const WHOLE_RE =
  /(gastro|enteric|retard|prolonged|modified|extended|\bsr\b|\bxr\b|\ber\b|\blp\b|effervescent|capsule|gélule|gelule|sachet|suppositor|patch|inhaler|spray|drops?)/
const HALF_RE = /(tab|comprim)/
const LIQUID_RE = /(syrup|sirop|suspension|oral solution|solution buvable)/

/**
 * How a medicine may be given in parts, worked out exactly as the database does (part_mode_by,
 * migration 0198): sold only by the whole box → whole; else the mode set; else coated,
 * slow-release, effervescent tablets, capsules, sachets, suppositories, patches, inhalers, sprays
 * and drops → whole; other tablets → halves; a syrup or suspension whose content in ml is known →
 * by measure; anything else → whole.
 */
export function partModeBy(i: {
  partMode?: PartMode | null
  saleMode?: string | null
  packSize?: number | null
  /** name, strength, form, unit and selling unit, together. */
  text: string
  contentUnit?: string | null
  contentAmount?: number | null
}): PartMode {
  if ((i.saleMode ?? 'piece') === 'pack' && (i.packSize ?? 1) >= 2) return 'whole'
  if (i.partMode) return i.partMode
  const text = i.text.toLowerCase()
  if (WHOLE_RE.test(text)) return 'whole'
  if (HALF_RE.test(text)) return 'half'
  const cu = normUnit(i.contentUnit)
  if (LIQUID_RE.test(text) && (cu === 'ml' || cu === 'l') && (i.contentAmount ?? 0) > 0)
    return 'measure'
  return 'whole'
}

/** The words partModeBy reads. */
export const partModeText = (i: Omit<DoseItem, 'dose'>): string =>
  [i.name, i.strength, i.form, i.unit, i.sellingUnit].filter(Boolean).join(' ')

/**
 * How it may be given in parts now: the database's answer (part_mode_now) when it gave one; else
 * worked out the same way from what is set (a syrup's content read from its name does not count:
 * the database gives it by measure only once the content is saved).
 */
export function partModeOf(item: DoseItem): PartMode {
  if ((item.saleMode ?? 'piece') === 'pack' && (item.packSize ?? 1) >= 2) return 'whole'
  if (item.dose?.partModeNow) return item.dose.partModeNow
  return partModeBy({
    partMode: item.dose?.partMode ?? null,
    saleMode: item.saleMode,
    packSize: item.packSize,
    text: partModeText(item),
    contentUnit: item.dose?.contentUnit,
    contentAmount: item.dose?.contentAmount,
  })
}

// ---------------------------------------------------------------- the dose in pieces (§A.5)
export interface DoseAmount {
  amount: number
  /** A unit of DOSE_UNITS (any spelling), or the words typed for "other". */
  unit: string
}
export interface DosePieces {
  /** The pieces the dose is (0.5 = ½ tablet; 0.1 = a tenth of a bottle); null: only the measure is known. */
  pieces: number | null
  how: 'count' | 'strength' | 'volume' | 'content'
  /** The dose as a measure of the piece (10 ml of a syrup, 2 puffs), when it goes through one. */
  measure: { amount: number; unit: string } | null
}

/**
 * The pieces a dose is, when the units convert (null otherwise):
 *   count    the dose is in the piece's own word: 2 tablets = 2;
 *   strength the dose is in the strength's family: 1 g of 500 mg = 2; with "in 5 ml":
 *            500 mg of 250 mg in 5 ml = 10 ml, of a bottle of 100 ml = 0.1;
 *   volume   the dose is in ml/l and the piece holds ml: 5 ml of 100 ml = 0.05;
 *   content  the dose is in the content's unit: 2 puffs of 200 = 0.01.
 */
export function piecesForDose(
  dose: DoseAmount | null | undefined,
  piece: PieceContent | null | undefined,
): DosePieces | null {
  if (!dose || !piece || !(dose.amount > 0)) return null
  const unit = normUnit(dose.unit)
  if (!unit) return null
  const fam = unitFamily(unit)
  // review 0198: kept to 9 decimals (only the float noise goes): 5 ml of a 60 ml bottle is
  // 0.083333333…, and 6 decimals (0.083333 × 60 = 4.99998 ml) made it "not exact"
  const per = (pieces: number | null, how: DosePieces['how'], measure: DosePieces['measure']) => ({
    pieces: pieces == null ? null : round9(pieces),
    how,
    measure: measure ? { amount: round6(measure.amount), unit: measure.unit } : null,
  })
  // count: "2 tablets" of a tablet, "1 piece" of anything
  if (fam === 'count' && (unit === 'piece' || unit === piece.piece))
    return per(dose.amount, 'count', null)
  const s = piece.strength
  const c = piece.content
  // a measure in pieces: of the content (10 ml of a 100 ml bottle), or of a medicine stocked by
  // the ml itself (one piece = 1 ml)
  const pieceFam = unitFamily(piece.piece)
  const ofPieces = (m: { amount: number; unit: string }): number | null => {
    if (c) {
      const x = convert(m.amount, m.unit, c.unit)
      return x == null ? null : x / c.amount
    }
    return piece.piece && pieceFam !== 'count' && pieceFam !== 'other'
      ? convert(m.amount, m.unit, piece.piece)
      : null
  }
  // strength: "1 g" of a 500 mg tablet; "500 mg" of 250 mg in 5 ml
  if (s && fam !== 'count' && fam !== 'other' && fam === unitFamily(s.unit)) {
    const inStrength = convert(dose.amount, unit, s.unit)
    if (inStrength == null) return null
    const ratio = inStrength / s.amount
    if (s.per == null || !s.perUnit) return per(ratio, 'strength', null)
    const measure = { amount: ratio * s.per, unit: s.perUnit }
    return per(ofPieces(measure), 'strength', measure)
  }
  // volume: "5 ml" of a bottle of 100 ml (or of a syrup whose bottle is not known)
  if (fam === 'volume') {
    const m = { amount: dose.amount, unit }
    const pieces = ofPieces(m)
    if (pieces != null) return per(pieces, 'volume', m)
    if (s?.perUnit && unitFamily(s.perUnit) === 'volume') return per(null, 'volume', m)
    return null
  }
  // content: "2 puffs" of an inhaler of 200, "2 g" of a 30 g tube
  if (c) {
    const inContent = convert(dose.amount, unit, c.unit)
    if (inContent != null)
      return per(inContent / c.amount, 'content', { amount: dose.amount, unit })
  }
  return null
}

export type SplitResult =
  | {
      ok: true
      /** Whole pieces. */
      whole: number
      /** The part of one more piece: 0, 0.25, 0.5, 0.75, or a share of a bottle (by measure). */
      part: number
      /** By measure: the part in ml (5 for 5 ml); null otherwise. */
      partMl: number | null
    }
  | { ok: false; exact: number }

/**
 * Pieces split into whole pieces and a part the medicine may be given in: whole → only an exact
 * whole number; halves → steps of ½; quarters → steps of ¼; by measure → the ml left over, in
 * steps of 0.5 ml (needs the content in ml). Anything else is not proposed (ok: false): never
 * rounded up or down silently.
 */
export function splitPieces(
  pieces: number,
  mode: PartMode,
  contentMlOfPiece?: number | null,
): SplitResult {
  const p = round6(pieces)
  if (!(p > 0)) return { ok: false, exact: p }
  const whole = Math.floor(p + 1e-6)
  const rest = round6(p - whole)
  if (rest < 1e-6) return { ok: true, whole, part: 0, partMl: null }
  if (mode === 'half' || mode === 'quarter') {
    const step = mode === 'half' ? 0.5 : 0.25
    return isWhole(rest / step)
      ? { ok: true, whole, part: rest, partMl: null }
      : { ok: false, exact: p }
  }
  if (mode === 'measure' && contentMlOfPiece && contentMlOfPiece > 0) {
    // the ml from the pieces as given (not the 6-decimal `rest`): 1/12 of a 60 ml bottle = 5 ml
    const ml = round6((pieces - whole) * contentMlOfPiece)
    return isWhole(ml * 2) && ml > 0 && ml < contentMlOfPiece
      ? { ok: true, whole, part: rest, partMl: ml }
      : { ok: false, exact: p }
  }
  return { ok: false, exact: p }
}

export type PiecesProposal =
  /** Fill in `whole` pieces and the part (½, ¼, ¾, or `partMl` ml of a bottle). */
  | {
      kind: 'exact'
      whole: number
      part: number
      partMl: number | null
      pieces: number
      how: DosePieces['how']
      measure: DosePieces['measure']
      piece: PieceContent
      mode: PartMode
    }
  /** The units convert but the pieces are not a number this medicine is given in (1⅓ tablets). */
  | {
      kind: 'notExact'
      pieces: number
      how: DosePieces['how']
      measure: DosePieces['measure']
      piece: PieceContent
      mode: PartMode
    }
  /** Only the measure is known (10 ml of a syrup whose bottle is not known): no pieces proposed. */
  | { kind: 'measureOnly'; measure: { amount: number; unit: string }; piece: PieceContent }
  /** The unit does not turn into pieces of this medicine: the doctor types how many. */
  | { kind: 'noLink'; piece: PieceContent }

/**
 * What the order form proposes for a dose: the whole pieces and the part to fill in, only when the
 * dose comes out as a number of pieces the medicine may be given in; otherwise why not. Null when
 * no dose is typed. The proposal fills the fields while the doctor has not typed them; it is
 * always shown and editable.
 */
export function proposePieces(
  dose: DoseAmount | null | undefined,
  item: DoseItem,
): PiecesProposal | null {
  if (!dose || !(dose.amount > 0) || !normUnit(dose.unit)) return null
  const piece = pieceContentOf(item)
  const r = piecesForDose(dose, piece)
  if (!r) return { kind: 'noLink', piece }
  if (r.pieces == null)
    return r.measure
      ? { kind: 'measureOnly', measure: r.measure, piece }
      : { kind: 'noLink', piece }
  const mode = partModeOf(item)
  const s = splitPieces(r.pieces, mode, contentMl(piece))
  return s.ok
    ? {
        kind: 'exact',
        whole: s.whole,
        part: s.part,
        partMl: s.partMl,
        pieces: r.pieces,
        how: r.how,
        measure: r.measure,
        piece,
        mode,
      }
    : { kind: 'notExact', pieces: r.pieces, how: r.how, measure: r.measure, piece, mode }
}

// ---------------------------------------------------------------- the take-home count (§B)
const PER_DAY: Record<string, number> = {
  OD: 1,
  BD: 2,
  TDS: 3,
  QID: 4,
  Q4H: 6,
  Q6H: 4,
  Q8H: 3,
  Q12H: 2,
  Q24H: 1,
  NOCTE: 1,
}
const FREQ_ALIASES: Record<string, string> = {
  QD: 'OD',
  DAILY: 'OD',
  BID: 'BD',
  TID: 'TDS',
  QDS: 'QID',
  HS: 'NOCTE',
  ON: 'NOCTE',
  SOS: 'PRN',
}

/**
 * Times a day of a "How often" code: OD 1 · BD 2 · TDS 3 · QID 4 · Q8H 3 · Q6H 4 · NOCTE 1;
 * 'once' for STAT (one time in all, the days do not count); null for PRN (when needed) and for
 * words typed by hand (no count).
 */
export function timesPerDay(frequency: string | null | undefined): number | 'once' | null {
  const raw = (frequency ?? '').trim().toUpperCase().replace(/\s+/g, '')
  const code = FREQ_ALIASES[raw] ?? raw
  if (code === 'STAT') return 'once'
  return PER_DAY[code] ?? null
}

export interface TakeHome {
  /** each × times a day × days, before rounding (7.5). */
  exact: number
  /** Whole pieces to take home: the exact count rounded up (8). */
  total: number
  perDay: number
  days: number
  /** STAT: one time in all. */
  once: boolean
  roundedUp: boolean
}

/**
 * The pieces to take home: pieces each time × times a day × days, rounded UP to whole pieces
 * (½ tablet × 3 × 5 = 7.5 → 8; 5 ml of a 100 ml bottle × 3 × 5 = 0.75 → 1 bottle). STAT: one
 * time. Null when there is no count: when needed (PRN), no days, nothing each time.
 */
export function takeHomeCount(i: {
  /** Pieces each time (0.5 for ½ tablet; 0.05 for 5 ml of a 100 ml bottle). */
  each: number | null | undefined
  frequency: string | null | undefined
  days: number | null | undefined
}): TakeHome | null {
  const each = i.each ?? 0
  if (!(each > 0)) return null
  const per = timesPerDay(i.frequency)
  if (per == null) return null
  const once = per === 'once'
  const days = once ? 1 : (i.days ?? 0)
  if (!once && !(Number.isInteger(days) && days >= 1)) return null
  const perDay = once ? 1 : per
  const exact = round6(each * perDay * days)
  const total = Math.ceil(exact - 1e-6)
  return { exact, total, perDay, days, once, roundedUp: !isWhole(exact) }
}

// ---------------------------------------------------------------- the price of a part (§C.4)
/**
 * The price of a part as the bill will make it (add_part_charge_internal, 0198): rule `whole` → a
 * whole piece; rule `set` (cash bills only) → the set price (½ = the half price, or 2 × ¼; ¼; ¾ =
 * 3 × ¼; by measure = the price of 1 ml × the ml, in steps of 0.5 ml) when it is set; else (and
 * rule `share`) the piece price shared: round(piece price × part). The discount and the insurer's
 * own piece price are the bill's business; `piecePrice` is the price of one piece on that bill.
 */
export function partPrice(
  dose:
    | Pick<ItemDose, 'partPriceRule' | 'halfPrice' | 'quarterPrice' | 'measurePrice'>
    | null
    | undefined,
  part: number,
  piecePrice: number,
  opts: { mode?: PartMode; contentMl?: number | null; cash?: boolean } = {},
): number {
  const rule = dose?.partPriceRule ?? 'share'
  if (rule === 'whole') return Math.round(piecePrice)
  if (rule === 'set' && opts.cash !== false && dose) {
    let set: number | null = null
    if (opts.mode === 'measure') {
      if (dose.measurePrice != null && opts.contentMl)
        set = dose.measurePrice * (Math.round(part * opts.contentMl * 2) / 2)
    } else if (Math.abs(part - 0.5) < 1e-6)
      set = dose.halfPrice ?? (dose.quarterPrice != null ? 2 * dose.quarterPrice : null)
    else if (Math.abs(part - 0.25) < 1e-6) set = dose.quarterPrice
    else if (Math.abs(part - 0.75) < 1e-6)
      set = dose.quarterPrice != null ? 3 * dose.quarterPrice : null
    if (set != null) return Math.round(set)
  }
  return Math.round(piecePrice * part)
}

/**
 * A part as a figure for its words: "½", "¼", "¾" of a piece, or the ml by measure ("5 ml",
 * "92.5 ml"). The screen adds the piece word ("½ tablet").
 */
export function partFigure(part: number, mode: PartMode, contentMlOfPiece?: number | null): string {
  if (mode === 'measure' && contentMlOfPiece)
    return amountText(Math.round(part * contentMlOfPiece * 10) / 10, 'ml')
  if (Math.abs(part - 0.5) < 1e-6) return '½'
  if (Math.abs(part - 0.25) < 1e-6) return '¼'
  if (Math.abs(part - 0.75) < 1e-6) return '¾'
  return String(round6(Math.round(part * 100) / 100))
}

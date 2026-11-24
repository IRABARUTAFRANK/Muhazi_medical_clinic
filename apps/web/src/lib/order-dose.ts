import {
  COUNT_UNITS,
  normUnit,
  unitFamily,
  type DoseAmount,
  type PartMode,
  type PieceContent,
} from './dose'

/**
 * 0198 · The dose on an order of step 6: what the doctor types (a number and a unit from the
 * list, or "other" with its words), words for the nurse. It is never turned into the pieces to
 * give (Frank, after 0198): the doctor types how many. Pure (lib/dose.ts below).
 */

/** The unit select's last choice: words typed by the doctor. */
export const OTHER_UNIT = 'other'

export interface DoseValue {
  amount: string
  /** A unit code of the list, or OTHER_UNIT. */
  unit: string
  /** The words of the unit when OTHER_UNIT. */
  other: string
}
export const emptyDose = (unit = ''): DoseValue => ({ amount: '', unit, other: '' })

/** "1.5" → 1.5; "1,5" → 1.5; nothing or not a number → null. */
export const numberOf = (s: string): number | null => {
  const n = Number(s.replace(',', '.'))
  return s.trim() && Number.isFinite(n) ? n : null
}

/** The dose as the engine reads it; null without a number above zero or a unit. */
export function doseOf(v: DoseValue): DoseAmount | null {
  const amount = numberOf(v.amount)
  const unit = v.unit === OTHER_UNIT ? v.other.trim() : v.unit
  return amount != null && amount > 0 && unit ? { amount, unit } : null
}

/** The piece's own word as a unit of the list (tablet, bottle…), else "piece". */
export const pieceUnitOf = (p: PieceContent | null | undefined): string =>
  p?.piece && unitFamily(p.piece) === 'count' ? p.piece : 'piece'

/**
 * The units the dose select offers: mass, volume, units, mmol, mEq, the piece's own word, and
 * drops or puffs when one piece holds them (then "other").
 */
export function unitChoices(p: PieceContent | null | undefined): string[] {
  const out = ['mg', 'g', 'mcg', 'ml', 'l', 'IU', 'MIU', 'mmol', 'mEq', pieceUnitOf(p)]
  const c = normUnit(p?.content?.unit)
  if (c && (c === 'drop' || c === 'puff')) out.push(c)
  return [...new Set(out)]
}

/** The unit chosen first: the strength's (mg), else the content's (ml), else the piece's word. */
export function defaultUnit(p: PieceContent | null | undefined): string {
  if (p?.strength) return normUnit(p.strength.unit) ?? p.strength.unit
  const c = normUnit(p?.content?.unit)
  if (c) return unitFamily(c) === 'volume' ? 'ml' : c
  return pieceUnitOf(p)
}

/** A count unit of the list (tablet, bottle, puff…) — the dose is then itself a number of pieces. */
export const isCountUnit = (unit: string) => COUNT_UNITS.includes(normUnit(unit) ?? unit)

/**
 * The part allowed by the medicine: ½ (halves); ¼ ½ ¾ (quarters); by measure, ml in steps of
 * 0.5, more than 0 and less than one piece. Answers the part of one piece (0.05 for 5 ml of a
 * 100 ml bottle), 0 for none, null when not allowed.
 */
export function partOf(
  mode: PartMode,
  value: string,
  contentMlOfPiece: number | null,
): number | null {
  const v = numberOf(value)
  if (v == null || v === 0) return 0
  if (mode === 'half') return v === 0.5 ? 0.5 : null
  if (mode === 'quarter') return [0.25, 0.5, 0.75].includes(v) ? v : null
  if (mode === 'measure' && contentMlOfPiece)
    return v > 0 && v < contentMlOfPiece && Number.isInteger(v * 2) ? v / contentMlOfPiece : null
  return null
}

/** Numbers with a decimal point ("1,5" → "1.5"), as typed in a field. */
export const decimal = (v: string) => v.replace(/,/g, '.').replace(/[^\d.]/g, '')

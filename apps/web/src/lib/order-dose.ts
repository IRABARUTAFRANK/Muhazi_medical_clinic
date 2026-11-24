import {
  COUNT_UNITS,
  contentMl,
  normUnit,
  piecesForDose,
  splitPieces,
  unitFamily,
  type DoseAmount,
  type DosePieces,
  type PartMode,
  type PieceContent,
} from './dose'

/**
 * 0198 · The dose on an order of step 6 (DESIGN §A.5, §B): what the doctor types (a number and
 * a unit from the list, or "other" with its words) turned into the pieces to give — proposed
 * only when exact and allowed by how the medicine is given in parts. Pure (lib/dose.ts below).
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

export type DoseProposal =
  /** Fill in `whole` pieces and the part (0.5…; by measure: `partMl` ml). */
  | {
      kind: 'exact'
      whole: number
      part: number
      partMl: number | null
      pieces: number
      how: DosePieces['how']
      measure: DosePieces['measure']
    }
  /** The units convert, but not into a number of pieces this medicine is given in (1⅓). */
  | { kind: 'notExact'; pieces: number; how: DosePieces['how']; measure: DosePieces['measure'] }
  /** Only the measure is known (10 ml of a syrup whose bottle is not known). */
  | { kind: 'measureOnly'; measure: { amount: number; unit: string } }
  /** The unit does not turn into pieces of this medicine. */
  | { kind: 'noLink' }

/**
 * What the form proposes for a dose with the way of giving in parts that applies now (`mode`:
 * the medicine's, or 'whole' when parts cannot be given — a database without 0198).
 */
export function proposeFor(
  dose: DoseAmount | null,
  piece: PieceContent | null | undefined,
  mode: PartMode,
): DoseProposal | null {
  if (!dose || !piece) return null
  const r = piecesForDose(dose, piece)
  if (!r) return { kind: 'noLink' }
  if (r.pieces == null)
    return r.measure ? { kind: 'measureOnly', measure: r.measure } : { kind: 'noLink' }
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
      }
    : { kind: 'notExact', pieces: r.pieces, how: r.how, measure: r.measure }
}

/**
 * What a dose just typed puts in the pieces fields the doctor has not typed in himself: the
 * proposal when it is exact; nothing (empty fields, "type how many") when the dose gives no exact
 * count — never the number proposed for an earlier dose, nor the 1 the form starts with, left as
 * if it were this dose's (review 0198). No dose: the fields stay as they are.
 */
export function piecesFill(
  p: DoseProposal | null,
  touched: { quantity: boolean; part: boolean },
  partValue: ((e: Extract<DoseProposal, { kind: 'exact' }>) => string) | null,
): { quantity?: string; part?: string } {
  const out: { quantity?: string; part?: string } = {}
  if (!p) return out
  if (p.kind === 'exact') {
    if (!touched.quantity) out.quantity = String(p.whole)
    if (!touched.part && partValue) out.part = partValue(p)
  } else {
    if (!touched.quantity) out.quantity = ''
    if (!touched.part) out.part = ''
  }
  return out
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

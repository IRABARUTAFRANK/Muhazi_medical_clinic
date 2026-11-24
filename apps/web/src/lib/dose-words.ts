import type { TFunction } from 'i18next'
import { amountText, normUnit, unitFamily, type PartMode, type PieceContent } from './dose'
import { fractionText } from './fraction'

/**
 * 0198 · The words of the dose engine (lib/dose.ts) in the reader's language: the units of the
 * dose select, the piece's word, what one piece holds ("500 mg per tablet", "250 mg in 5 ml ·
 * 100 ml per bottle"), the ways of giving in parts, an opened piece ("½ tablet open"). Used by
 * Medicines & prices, Add stock and the stock screens; the order form (WP3) uses them too.
 */

const PIECE_KEYS = [
  'tablet',
  'capsule',
  'sachet',
  'ampoule',
  'vial',
  'bottle',
  'tube',
  'suppository',
  'piece',
  'ml',
]

/** The word of one piece in the reader's language ("tablet" → "comprimé"); the word itself else. */
export function pieceLabel(t: TFunction, piece: string | null | undefined): string {
  const k = normUnit(piece)
  if (k && PIECE_KEYS.includes(k)) return t(`packaging.pieceWord.${k}`, { defaultValue: k })
  if (k === 'drop' || k === 'puff') return t(`dose.units.${k}`, { defaultValue: `${k}s` })
  return k ?? t('packaging.piece', { defaultValue: 'piece' })
}

/** A unit as the dose select shows it: "micrograms (mcg)", "units (IU)", "mg", "tablet". */
export function doseUnitLabel(t: TFunction, code: string): string {
  const k = normUnit(code) ?? code
  if (['mcg', 'IU', 'MIU', 'l', 'drop', 'puff'].includes(k))
    return t(`dose.units.${k}`, { defaultValue: k })
  if (unitFamily(k) === 'count') return pieceLabel(t, k)
  return k
}

/** A strength or a content as written: "500 mg", "2.4 MIU" ("IU" and "MIU" kept as codes). */
const amount = (n: number, unit: string) => amountText(n, normUnit(unit) ?? unit)

/**
 * What one piece holds in words: "500 mg per tablet"; "250 mg in 5 ml · 100 ml per bottle";
 * "100 ml per bottle"; "" when nothing is known.
 */
export function pieceContentText(t: TFunction, p: PieceContent | null | undefined): string {
  if (!p) return ''
  const piece = pieceLabel(t, p.piece)
  const parts: string[] = []
  const s = p.strength
  if (s) {
    const a = amount(s.amount, s.unit)
    parts.push(
      s.per != null && s.perUnit
        ? t('dose.inVolume', { amount: a, per: amount(s.per, s.perUnit) })
        : t('dose.perPiece', { amount: a, piece }),
    )
  }
  if (p.content)
    parts.push(t('dose.perPiece', { amount: amount(p.content.amount, p.content.unit), piece }))
  return parts.join(' · ')
}

/** "Halves", "By measure (ml)"… */
export const partModeLabel = (t: TFunction, mode: PartMode): string => t(`dose.modes.${mode}`)

/**
 * An opened piece in words: "½ tablet open" (a cut tablet), "1 bottle open, 95 ml left" (an
 * opened bottle, by the ml). `leftText` is the database's own words ("95 ml" when by the ml).
 */
export function openPieceText(
  t: TFunction,
  p: { left: number; leftText?: string | null },
  unit: string | null | undefined,
  lang = 'en',
): string {
  const piece = pieceLabel(t, unit)
  const ml = /^\s*[\d.,]+\s*ml\s*$/i.exec(p.leftText ?? '')
  if (ml) return t('dose.openBottle', { piece, left: p.leftText!.trim() })
  return t('dose.open', { left: `${fractionText(p.left, lang)} ${piece}` })
}

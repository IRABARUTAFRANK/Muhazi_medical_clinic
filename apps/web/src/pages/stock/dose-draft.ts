import type { TFunction } from 'i18next'
import {
  normUnit,
  partModeBy,
  partModeText,
  pieceContentFromText,
  type DoseItem,
  type ItemDose,
  type PartMode,
  type PartPriceRule,
  type PieceContent,
} from '@/lib/dose'
import type { ItemDoseInput } from '@/lib/api/stock'

/**
 * What one piece holds (0198), as the form fills it (DoseFields): the strength (500 mg, or 250 mg
 * in 5 ml), the content of one piece (100 ml), how it may be given in parts and the price of a
 * part. Only what the manager set is in the draft: the strength read from the name is shown
 * beside it as a proposal and goes into the draft with one press ("Keep it").
 */
export interface DoseDraft {
  amount: string
  unit: string
  per: string
  perUnit: string
  content: string
  contentUnit: string
  /** '' = by its form. */
  mode: '' | PartMode
  rule: PartPriceRule
  halfPrice: string
  quarterPrice: string
  measurePrice: string
}

export const emptyDose = (): DoseDraft => ({
  amount: '',
  unit: '',
  per: '',
  perUnit: '',
  content: '',
  contentUnit: '',
  mode: '',
  rule: 'share',
  halfPrice: '',
  quarterPrice: '',
  measurePrice: '',
})

const str = (n: number | null | undefined) => (n == null ? '' : String(n))

/** The draft of what is saved now (empty when nothing is set). */
export function doseDraftOf(d: ItemDose | null | undefined): DoseDraft {
  if (!d) return emptyDose()
  return {
    amount: str(d.doseAmount),
    unit: d.doseUnit ?? '',
    per: str(d.dosePer),
    perUnit: d.dosePerUnit ?? '',
    content: str(d.contentAmount),
    contentUnit: d.contentUnit ?? '',
    mode: d.partMode ?? '',
    rule: d.partPriceRule,
    halfPrice: str(d.halfPrice),
    quarterPrice: str(d.quarterPrice),
    measurePrice: str(d.measurePrice),
  }
}

/** "Keep it": the strength and the content read from the name go into the draft. */
export function keepReading(d: DoseDraft, p: PieceContent): DoseDraft {
  return {
    ...d,
    amount: p.strength ? String(p.strength.amount) : d.amount,
    unit: p.strength ? p.strength.unit : d.unit,
    per: p.strength?.per != null ? String(p.strength.per) : p.strength ? '' : d.per,
    perUnit: p.strength?.perUnit ?? (p.strength ? '' : d.perUnit),
    content: p.content ? String(p.content.amount) : d.content,
    contentUnit: p.content ? p.content.unit : d.contentUnit,
  }
}

/** A number as typed ("2,5" → 2.5); null when empty or not a number. */
export const decimalOf = (s: string): number | null => {
  const v = s.trim().replace(',', '.')
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** A number field keeps digits and one decimal point. */
export const decimalInput = (s: string) =>
  s
    .replace(',', '.')
    .replace(/[^\d.]/g, '')
    .replace(/(\..*)\./g, '$1')

/** What set_item_dose takes (the whole block; empty = null). */
export function doseInput(d: DoseDraft): Omit<ItemDoseInput, 'itemId'> {
  const amount = decimalOf(d.amount)
  const per = decimalOf(d.per)
  const content = decimalOf(d.content)
  const whole = (s: string) => {
    const n = decimalOf(s)
    return n == null ? null : Math.round(n)
  }
  return {
    doseAmount: amount,
    doseUnit: amount != null ? normUnit(d.unit) : null,
    dosePer: amount != null && per != null ? per : null,
    dosePerUnit: amount != null && per != null ? normUnit(d.perUnit) : null,
    contentAmount: content,
    contentUnit: content != null ? normUnit(d.contentUnit) : null,
    partMode: d.mode || null,
    partPriceRule: d.rule,
    halfPrice: d.rule === 'set' ? whole(d.halfPrice) : null,
    quarterPrice: d.rule === 'set' ? whole(d.quarterPrice) : null,
    measurePrice: d.rule === 'set' ? decimalOf(d.measurePrice) : null,
  }
}

/** The draft says something else than what is saved. */
export const doseChanged = (d: DoseDraft, now: ItemDose | null | undefined): boolean =>
  JSON.stringify(doseInput(d)) !== JSON.stringify(doseInput(doseDraftOf(now)))

/** The words a medicine's mode "by its form" is read from. */
export type DoseWords = Omit<DoseItem, 'dose'>

/** How it will be given in parts once saved (the database works it out the same way). */
export function draftModeNow(d: DoseDraft, words: DoseWords): PartMode {
  const i = doseInput(d)
  return partModeBy({
    partMode: i.partMode,
    saleMode: words.saleMode,
    packSize: words.packSize,
    text: partModeText(words),
    contentUnit: i.contentUnit,
    contentAmount: i.contentAmount,
  })
}

/** What one piece holds as the draft says it (null when it says nothing). */
export function draftPieceContent(d: DoseDraft, words: DoseWords): PieceContent | null {
  const i = doseInput(d)
  const reading = pieceContentFromText(words)
  const strength =
    i.doseAmount != null && i.doseUnit
      ? { amount: i.doseAmount, unit: i.doseUnit, per: i.dosePer, perUnit: i.dosePerUnit }
      : null
  const content =
    i.contentAmount != null && i.contentUnit
      ? { amount: i.contentAmount, unit: i.contentUnit }
      : null
  if (!strength && !content) return null
  return { strength, content, piece: reading.piece, source: 'set' }
}

/** The first thing wrong with the draft (the database refuses the same), or null. */
export function doseProblem(t: TFunction, d: DoseDraft, words: DoseWords): string | null {
  const amount = decimalOf(d.amount)
  const per = decimalOf(d.per)
  const content = decimalOf(d.content)
  const boxOnly = (words.saleMode ?? 'piece') === 'pack' && (words.packSize ?? 1) >= 2
  if ((d.amount.trim() !== '' && !(amount != null && amount > 0)) || (amount != null) !== !!d.unit)
    return t('dose.errors.strength')
  if (
    (d.per.trim() !== '' && !(per != null && per > 0)) ||
    (per != null) !== !!d.perUnit ||
    (per != null && amount == null)
  )
    return t('dose.errors.per')
  if (
    (d.content.trim() !== '' && !(content != null && content > 0)) ||
    (content != null) !== !!d.contentUnit
  )
    return t('dose.errors.content')
  if (
    d.mode === 'measure' &&
    !(content != null && ['ml', 'l'].includes(normUnit(d.contentUnit) ?? ''))
  )
    return t('dose.errors.measure')
  if (boxOnly && d.mode && d.mode !== 'whole') return t('dose.errors.boxOnly')
  if (d.rule === 'set') {
    const now = draftModeNow(d, words)
    const missing =
      (now === 'half' && decimalOf(d.halfPrice) == null) ||
      (now === 'quarter' && decimalOf(d.quarterPrice) == null) ||
      (now === 'measure' && decimalOf(d.measurePrice) == null)
    if (missing) return t('dose.errors.setPrice')
  }
  return null
}

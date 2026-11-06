import { payerBodyOf, type PayerType } from '@/lib/api/catalogue'
import { norm, type PriceListColumn } from '@/lib/price-list-file'

/**
 * Who a price column of a published list is for, read from its name ("RAMA; MMI", "Private
 * Insurances", "Privates (Non insured)") and, when the name says nothing, from its sheet ("RAMA")
 * and the sheet's title ("… FOR RAMA, MMI, MIS/UR", "… FOR PRIVATE INSURANCE AND NON INSURED
 * RWANDANS"). A column named for several schemes ("RAMA; MMI") is paid by every one of them.
 */

/** A payer a column names: a scheme ("RAMA", "MMI", "MIS/UR"), the private insurers, or the patients without insurance. */
export interface PayerMention {
  text: string
  group: 'scheme' | 'privateInsurers' | 'privatePatients'
}

/** The insurers the clinic works with, as much as the guesses need. */
export interface InsurerLike {
  id: string
  code: string
  name: string
  type: PayerType
}

const PRIVATE_PATIENTS =
  /\b(non insured|non insures|uninsured|non assures?|private patients?|privates|cash|individuals?|self paying|abarwayi batagira)\b/
const PRIVATE_INSURERS =
  /\b(private insurances?|private insurers?|assurances? privees?|insurances?)\b/
/** Words of a facility, a date or a title: not a payer. */
const NOT_A_PAYER =
  /\b(clinics?|polyclinics?|hospitals?|facility|facilities|health|primary|secondary|secondarly|tertiary|price|prices|tariff|tarif|new|old|amount|rwf|frw|rwanda|services?|private|in|of|the|for|and|to|from|citizens?)\b/

/** The part of a title after its last "FOR" ("… 2025-2027 FOR RAMA, MMI, MIS/UR" → "RAMA, MMI, MIS/UR"). */
const forPart = (title: string) => {
  const m = /\bfor\s+(.+)$/i.exec(title.replace(/\s+/g, ' '))
  return m ? m[1]!.trim() : ''
}

/** The payers a text names: split at ; , + & "and" (a "/" between two words stays: "MIS/UR"). */
export function payerMentions(text: string | null | undefined): PayerMention[] {
  if (!text) return []
  const out: PayerMention[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/\s*(?:[;,+&]|\band\b|\bet\b|\bna\b)\s*/i)) {
    const t = raw
      .replace(/[*()[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!t) continue
    const n = norm(t)
    let group: PayerMention['group'] | null = null
    if (PRIVATE_PATIENTS.test(n)) group = 'privatePatients'
    else if (PRIVATE_INSURERS.test(n)) group = 'privateInsurers'
    // a scheme: a short name in capitals ("RAMA", "MMI", "MIS/UR", "CBHI"), not a word of a facility
    else if (/^[A-Z][A-Z0-9]{1,9}(\/[A-Z0-9]{1,9})?$/.test(t) && !NOT_A_PAYER.test(n))
      group = 'scheme'
    if (!group) continue
    const k = `${group}:${n}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ text: t, group })
  }
  return out
}

/** The payers of a column: those its name names, else those of its sheet (its name, then its title's "FOR …"). */
export function columnPayers(col: PriceListColumn): PayerMention[] {
  const own = payerMentions(col.label.replace(/^.*·\s*/, ''))
  if (own.length) return own
  const hint = col.hint ?? ''
  const [sheet, ...rest] = hint.split(' — ')
  const fromSheet = payerMentions(sheet)
  const fromTitle = payerMentions(forPart(rest.join(' — ')))
  return [
    ...fromSheet,
    ...fromTitle.filter((m) => !fromSheet.some((x) => norm(x.text) === norm(m.text))),
  ]
}

/** A scheme named in a column is this insurer: by its code, its name, or its kind (RAMA / RSSB, MMI, CBHI / Mutuelle). */
export function isInsurerNamed(insurer: InsurerLike, m: PayerMention): boolean {
  if (m.group === 'privateInsurers')
    return insurer.type === 'private' || insurer.type === 'employer'
  if (m.group !== 'scheme') return false
  const t = norm(m.text)
  if (!t) return false
  if (norm(insurer.code) === t) return true
  if (` ${norm(insurer.name)} `.includes(` ${t} `)) return true
  if (insurer.type === 'rssb_rama' && /^(rama|rssb)$/.test(t)) return true
  if (insurer.type === 'mmi' && /^(mmi|military)$/.test(t)) return true
  if (insurer.type === 'cbhi' && /^(cbhi|mutuelle?|mituweli)$/.test(t)) return true
  return false
}

/**
 * The column an insurer pays, from what the columns name: a column whose name names it ("RAMA;
 * MMI" for RSSB RAMA and for MMI), else one whose sheet names it (the sheet "RAMA", its title "FOR
 * RAMA, MMI"); an RSSB scheme pays an RSSB list's price; MMI pays RAMA's column when none names
 * it. '' when nothing says (the manager chooses).
 */
export function columnForInsurer(
  columns: PriceListColumn[],
  insurer: InsurerLike,
  rssbList = false,
): string {
  const usable = columns.filter(
    (c) =>
      !columnPayers(c).some((m) => m.group === 'privatePatients') || columnPayers(c).length > 1,
  )
  // its own name in a column's name, then in its sheet
  const byName = (scope: 'label' | 'any') =>
    usable.find((c) => {
      const ms = scope === 'label' ? payerMentions(c.label.replace(/^.*·\s*/, '')) : columnPayers(c)
      return ms.some((m) => m.group === 'scheme' && isInsurerNamed(insurer, m))
    })?.key
  const named = byName('label') ?? byName('any')
  if (named) return named
  if (rssbList) {
    if (payerBodyOf(insurer.type) !== 'RSSB') return ''
    return (
      (usable.length === 1 ? usable[0]!.key : undefined) ??
      usable.find((c) => /price|prix|tarif|tariff|amount|montant/i.test(c.label))?.key ??
      ''
    )
  }
  if (insurer.type === 'private' || insurer.type === 'employer')
    return usable.find((c) => columnPayers(c).some((m) => m.group === 'privateInsurers'))?.key ?? ''
  // MMI pays RAMA's prices (the MoH tariff's column "RAMA; MMI")
  if (insurer.type === 'mmi')
    return (
      usable.find((c) =>
        columnPayers(c).some((m) => m.group === 'scheme' && /^(rama|rssb)$/.test(norm(m.text))),
      )?.key ?? ''
    )
  return ''
}

/** The column private patients pay: one naming them ("Privates (Non insured)", a sheet "… NON INSURED RWANDANS"), else a general clinics' column, else the first. */
export function columnForPrivatePatients(columns: PriceListColumn[]): string {
  const named = (scope: 'label' | 'any') =>
    columns.find((c) =>
      (scope === 'label' ? payerMentions(c.label.replace(/^.*·\s*/, '')) : columnPayers(c)).some(
        (m) => m.group === 'privatePatients',
      ),
    )?.key
  return (
    named('label') ??
    named('any') ??
    columns.find((c) => /general clinic|clinique g/i.test(c.label))?.key ??
    columns.find((c) => /^privates?\b|cash|comptant/i.test(c.label))?.key ??
    columns[0]?.key ??
    ''
  )
}

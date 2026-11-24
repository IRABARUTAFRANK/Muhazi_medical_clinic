/**
 * Fractions shown plainly (0198): ½, 1½, ¼, ¾ (and ⅓, ⅔ when a dose does not come out even), other
 * decimals with at most 2 digits ("0.05"). Used by the order form and summary, the nurse's row
 * ("½ tablet given"), the stock's opened pieces ("½ tablet open"), the bill words and the sales
 * report. Pure: no i18n, no data access.
 */

const GLYPHS: [number, string][] = [
  [0.25, '¼'],
  [0.5, '½'],
  [0.75, '¾'],
]
const THIRDS: [number, string][] = [
  [1 / 3, '⅓'],
  [2 / 3, '⅔'],
]

const numberFormat = (lang: string, digits: number) =>
  new Intl.NumberFormat(lang === 'fr' ? 'fr' : 'en', { maximumFractionDigits: digits })

/**
 * A dose figure for a patient's label: ½, ¼, ¾ and 1½ as fractions, other decimals in the
 * language with up to 3 digits. (Moved here from dispense-label.ts, which re-exports it.)
 */
export function doseFigure(n: number, lang = 'en'): string {
  const whole = Math.floor(n)
  const rest = Math.round((n - whole) * 100) / 100
  const glyph = rest === 0.5 ? '½' : rest === 0.25 ? '¼' : rest === 0.75 ? '¾' : null
  if (rest === 0) return String(whole)
  if (glyph) return whole ? `${whole}${glyph}` : glyph
  return numberFormat(lang, 3).format(n)
}

/**
 * A number of pieces in plain figures: 0.5 → "½", 1.5 → "1½", 0.75 → "¾", 1.3333 → "1⅓",
 * 2 → "2", 0.05 → "0.05", 12.345 → "12.35" ("12,35" in French).
 */
export function fractionText(n: number, lang = 'en'): string {
  if (!Number.isFinite(n)) return ''
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  const whole = Math.floor(a + 1e-9)
  const rest = a - whole
  if (rest < 1e-6) return `${sign}${whole}`
  for (const [v, g] of [...GLYPHS, ...THIRDS]) {
    // the thirds only when they are thirds to the third decimal (1 g of 750 mg = 1⅓)
    if (Math.abs(rest - v) < (v === 1 / 3 || v === 2 / 3 ? 1e-3 : 1e-6))
      return `${sign}${whole ? whole : ''}${g}`
  }
  return sign + numberFormat(lang, 2).format(a)
}

/** True when the number is a whole number (to 6 decimals: 0.1 × 3 is 0.3). */
export const isWhole = (n: number): boolean => Math.abs(n - Math.round(n)) < 1e-6

/** Rounded to 6 decimals, so 0.1 + 0.2 reads 0.3 (amounts of a piece). */
export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6

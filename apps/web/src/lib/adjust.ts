/**
 * Price adjustments typed the way people think about them:
 *   %      "10"  → 10 % off
 *   RWF    "2000" → 2 000 RWF off the price
 *   ×      "0.8" → the patient pays 0.8 × the price (20 % off); "1.4" → 40 % more
 *   price  "6500" → a different price altogether
 * The database stores a discount as a percentage, and a different price as a typed price
 * with a reason, so everything here resolves to one of those two.
 */
export type AdjustMode = 'pct' | 'rwf' | 'x' | 'price'

export interface Adjustment {
  /** Discount percentage, 0–100, two decimals. */
  discountPct: number
  /** Set when the result is a different price (a multiplier above 1 or a typed price). */
  manualPrice: number | null
  /** Price per unit after the adjustment. */
  unit: number
  error: 'invalid' | 'tooMuch' | null
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Reads a number typed with spaces, commas or a trailing %, ×, x or RWF. */
export const readNumber = (raw: string): number | null => {
  const cleaned = raw.replace(/rwf|frw|[%×x*\s]/gi, '').replace(/,/g, '.')
  if (cleaned === '') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/** Guesses the mode from what was typed ("10%", "x0.8", "2000 RWF"); otherwise keeps `mode`. */
export const detectMode = (raw: string, mode: AdjustMode): AdjustMode => {
  const s = raw.trim().toLowerCase()
  if (s.endsWith('%')) return 'pct'
  if (/^[×x*]|[×x*]$/.test(s)) return 'x'
  if (/rwf|frw/.test(s)) return mode === 'price' ? 'price' : 'rwf'
  return mode
}

export function resolveAdjust(mode: AdjustMode, raw: string, listPrice: number): Adjustment {
  const none: Adjustment = { discountPct: 0, manualPrice: null, unit: listPrice, error: null }
  const v = readNumber(raw)
  if (v == null) return none
  if (v < 0) return { ...none, error: 'invalid' }
  switch (detectMode(raw, mode)) {
    case 'pct':
      if (v > 100) return { ...none, error: 'tooMuch' }
      return {
        discountPct: round2(v),
        manualPrice: null,
        unit: Math.round((listPrice * (100 - v)) / 100),
        error: null,
      }
    case 'rwf':
      if (listPrice <= 0) return { ...none, error: 'invalid' }
      if (v > listPrice) return { ...none, error: 'tooMuch' }
      return {
        discountPct: round2((v / listPrice) * 100),
        manualPrice: null,
        unit: Math.round(listPrice - v),
        error: null,
      }
    case 'x':
      if (v === 0 || v > 10) return { ...none, error: 'invalid' }
      if (v <= 1)
        return {
          discountPct: round2((1 - v) * 100),
          manualPrice: null,
          unit: Math.round(listPrice * v),
          error: null,
        }
      return {
        discountPct: 0,
        manualPrice: Math.round(listPrice * v),
        unit: Math.round(listPrice * v),
        error: null,
      }
    case 'price':
      return v === listPrice
        ? none
        : { discountPct: 0, manualPrice: Math.round(v), unit: Math.round(v), error: null }
  }
}

/** A discount allowance typed in any mode, as a percentage of `price` (for the prices page). */
export function allowanceAsPct(mode: AdjustMode, raw: string, price: number): number | null {
  const v = readNumber(raw)
  if (v == null) return 0
  const m = detectMode(raw, mode)
  if (m === 'pct') return v >= 0 && v <= 100 ? round2(v) : null
  if (m === 'rwf') return price > 0 && v >= 0 && v <= price ? round2((v / price) * 100) : null
  if (m === 'x') return v > 0 && v <= 1 ? round2((1 - v) * 100) : null
  return null
}

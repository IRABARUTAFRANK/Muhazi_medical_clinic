import type { TFn } from './format'

/**
 * The wording of the views added in 0102, with its English until the translations are merged
 * (the receipt and the medical report do the same with their newer keys).
 */
export const tx = (t: TFn, key: string, en: string, vars?: Record<string, unknown>): string => {
  const v = t(key, { defaultValue: en, ...(vars ?? {}) })
  return v && v !== key ? v : en
}

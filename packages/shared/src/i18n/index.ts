import en from './en.json'
import fr from './fr.json'
import rw from './rw.json'

/**
 * UI strings. English is the source of truth; French and Kinyarwanda are complete and follow
 * docs/translation-glossary.md (Kinyarwanda reviewed in full on 26 October 2026).
 * Missing keys fall back to English.
 */
export const resources = {
  en: { translation: en },
  fr: { translation: fr },
  rw: { translation: rw },
} as const

export type TranslationResource = typeof en

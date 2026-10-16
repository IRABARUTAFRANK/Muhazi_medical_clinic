import en from './en.json'
import fr from './fr.json'
import rw from './rw.json'

/**
 * UI strings. English is the source of truth; French is complete; Kinyarwanda is a draft
 * that the clinical champion must review in the translation editor (doc §14, §15).
 * Missing keys fall back to English.
 */
export const resources = {
  en: { translation: en },
  fr: { translation: fr },
  rw: { translation: rw },
} as const

export type TranslationResource = typeof en

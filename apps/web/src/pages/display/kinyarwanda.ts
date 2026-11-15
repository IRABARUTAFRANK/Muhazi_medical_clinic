import type { Lang } from '@mmc/shared'

/**
 * The desk as the place to go, in the language's own grammar (0160): Kinyarwanda says
 * "deparitoma y’ibipimo by’ibanze", "deparitoma yo gusuzuma", "deparitoma ya laboratwari" —
 * y’ before a vowel, yo before ku-/gu- (an action), ya otherwise.
 */
export const deskPhrase = (name: string, lang: Lang): string => {
  if (lang !== 'rw') return name
  const n = name.trim()
  const low = n.charAt(0).toLowerCase() + n.slice(1)
  const link = /^[aeiou]/i.test(n) ? 'y’' : /^(ku|gu)/i.test(n) ? 'yo ' : 'ya '
  return `deparitoma ${link}${low}`
}

export const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The recordings a staff member makes for the Kinyarwanda call (0165), by key. */
export const CLIP_INTRO = 'intro'
export const CLIP_STAFF = 'staff'
export const clipKeyForDesk = (station: string) => `desk:${station}`

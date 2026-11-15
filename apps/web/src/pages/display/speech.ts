/**
 * The waiting-room screen's voice (migration 0118): the browser's speech synthesis (Web Speech
 * API) says a call after the chime — "Habimana Eric, you are needed in Consultation by Dr
 * Mukamana" — in each language of the screen, one to three times, with a short pause (0159).
 * Browsers have no Kinyarwanda voice: the Kinyarwanda sentence is read by a Swahili voice when
 * there is one (close vowels), else a French one. Announcements queue up, so two calls in a row
 * are both said; a result ready goes behind the calls. Where speechSynthesis is missing (an old
 * TV browser) nothing is said and nothing breaks.
 */

export type VoiceLang = 'en' | 'fr' | 'rw'

export interface Announcement {
  text: string
  lang: VoiceLang
  /** How many times the sentence is said (1 to 3). */
  repeat: number
  /** Calls go before results. */
  priority: 'call' | 'result'
}

/** The pause between two sayings of the same sentence, and between two announcements. */
const PAUSE_MS = 700
const ESTIMATE_MS_PER_CHAR = 90

const synth = (): SpeechSynthesis | null => {
  try {
    return typeof window !== 'undefined' && 'speechSynthesis' in window
      ? window.speechSynthesis
      : null
  } catch {
    return null
  }
}

/** Whether this browser can speak at all. */
export const canSpeak = (): boolean =>
  synth() !== null && typeof SpeechSynthesisUtterance !== 'undefined'

/**
 * A ticket number said digit by digit ("A-014" → "A 0 1 4"), so the voice never says "fourteen"
 * or reads the dash.
 */
export const spokenTicket = (ticket: string): string =>
  ticket
    .replace(/[-_/.]/g, ' ')
    .replace(/(\d)(?=\d)/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * The best installed voice for the language: a natural / online one first, then any voice of
 * the language, else none (the utterance still carries `lang`, and the browser picks).
 */
export function pickVoice(lang: VoiceLang): SpeechSynthesisVoice | null {
  const s = synth()
  if (!s) return null
  let voices: SpeechSynthesisVoice[]
  try {
    voices = s.getVoices()
  } catch {
    return null
  }
  // Kinyarwanda: a Kinyarwanda voice if the device has one, else the closest — Swahili (the
  // same five vowels and most consonants), then Spanish (the vowels), then French, then any
  const wanted = lang === 'rw' ? ['rw', 'sw', 'es', 'fr', 'it', 'en'] : [lang]
  const mine =
    wanted
      .map((w) => voices.filter((v) => v.lang.toLowerCase().startsWith(w)))
      .find((list) => list.length > 0) ?? []
  if (mine.length === 0) return null
  const preferred = /natural|neural|online|google|premium|enhanced/i
  return (
    mine.find((v) => preferred.test(v.name) && !v.localService) ??
    mine.find((v) => preferred.test(v.name)) ??
    mine.find((v) => v.default) ??
    mine[0] ??
    null
  )
}

// ---------------------------------------------------------------- Kinyarwanda through another voice (0163)

/** The family of the voice that will read Kinyarwanda on this device. */
export type RwVoiceFamily = 'rw' | 'sw' | 'es' | 'fr' | 'it' | 'en' | 'none'
export function rwVoiceFamily(): RwVoiceFamily {
  const v = pickVoice('rw')
  if (!v) return canSpeak() ? 'en' : 'none'
  const l = v.lang.toLowerCase()
  for (const fam of ['rw', 'sw', 'es', 'fr', 'it', 'en'] as const) if (l.startsWith(fam)) return fam
  return 'en'
}

const VOWEL = /[aeiou]/
/**
 * A Kinyarwanda word as an English voice reads it right: syllable by syllable, each vowel
 * written the English way ("Umurwayi" → "oo-moo-rwah-yee", "Habimana" → "hah-bee-mah-nah",
 * "deparitoma" → "deh-pah-ree-toh-mah"). "c" is always "ch" in Kinyarwanda.
 */
function rwWordForEnglish(word: string): string {
  const w = word.toLowerCase().replace(/[’']/g, '')
  if (!VOWEL.test(w)) return word
  const parts = w.match(/[^aeiou]*[aeiou]+|[^aeiou]+$/g) ?? [w]
  // one word, never hyphens: hyphens make the voice stop at every syllable (0164)
  return parts
    .map((p) =>
      p
        .replace(/c(?!h)/g, 'ch')
        .replace(/g(?=[ei])/g, 'gh')
        .replace(/a+/g, 'ah')
        .replace(/e+/g, 'eh')
        .replace(/i+/g, 'ee')
        .replace(/o+/g, 'oh')
        .replace(/u+/g, 'oo'),
    )
    .join('')
}
/** For a French voice: "u" is "ou", "c" is "tch", "sh" is "ch", "ny" is "gn", every e is "é" (never silent). */
const rwWordForFrench = (word: string): string =>
  word
    .toLowerCase()
    .replace(/sh/g, 'ch')
    .replace(/c(?!h)/g, 'tch')
    .replace(/ny/g, 'gn')
    .replace(/u/g, 'ou')
    .replace(/e/g, 'é')
/** For a Spanish (or Italian) voice: "c" is "ch", "j" is "y", "h" is "j", "ny" is "ñ", "z" is "s". */
const rwWordForSpanish = (word: string): string =>
  word
    .toLowerCase()
    .replace(/jy?/g, 'y')
    .replace(/sh/g, '§')
    .replace(/c(?!h)/g, '¤')
    .replace(/h/g, 'j')
    .replace(/ny/g, 'ñ')
    .replace(/z/g, 's')
    .replace(/[§¤]/g, 'ch')

/** A Kinyarwanda sentence respelled for the voice that will read it (none for rw / sw). */
export function rwForVoice(text: string, family: RwVoiceFamily): string {
  const fn =
    family === 'en'
      ? rwWordForEnglish
      : family === 'fr'
        ? rwWordForFrench
        : family === 'es' || family === 'it'
          ? rwWordForSpanish
          : null
  if (!fn) return text
  // words only: numbers, "A 0 1 4", punctuation and "Dr." stay as they are
  return text.replace(/[A-Za-zÀ-ÿ’']{2,}/g, (w) => (/^[A-Z][a-z]*\.$/.test(w) ? w : fn(w)))
}

/** A piece of the sentence: Kinyarwanda words to respell, or a name / ticket left as it is. */
export interface RwPart {
  token: string
  value: string
  /** The value is Kinyarwanda too (a department's name): respelled like the sentence. */
  kinyarwanda?: boolean
}
/**
 * The Kinyarwanda sentence for the voice: the template (with tokens where the name, ticket,
 * department and staff go) respelled for the voice, then the pieces put in. A person's name
 * is respelled only for an English voice (Rwandan names read syllable by syllable); a ticket
 * never.
 */
export function rwSentence(template: string, parts: RwPart[], family: RwVoiceFamily): string {
  let s = rwForVoice(template, family)
  for (const p of parts) {
    const v = p.kinyarwanda
      ? rwForVoice(p.value, family)
      : family === 'en' && !/\d/.test(p.value)
        ? rwForVoice(p.value, family)
        : p.value
    s = s.split(p.token).join(v)
  }
  return s
}

export interface Announcer {
  /** Puts an announcement in the queue (said after `delayMs` when nothing is being said). */
  say: (a: Announcement, delayMs?: number) => void
  /** Drops what waits and stops the current sentence. */
  stop: () => void
  /** Whether the voice is busy (speaking, or about to). */
  busy: () => boolean
}

/**
 * The queue of announcements. `onBusy` is told when the voice starts and stops, for the
 * "speaking" indicator. Each sentence is said `repeat` times with a pause; `onend` sometimes
 * never fires (Chrome, a voice that failed), so a timer based on the sentence's length moves on.
 */
export function createAnnouncer(onBusy: (busy: boolean) => void): Announcer {
  const queue: Announcement[] = []
  let current: Announcement | null = null
  let timer: number | null = null
  let stopped = false

  const setBusy = (b: boolean) => {
    try {
      onBusy(b)
    } catch {
      /* the indicator is not worth an error */
    }
  }

  const finish = () => {
    current = null
    timer = null
    if (queue.length === 0) {
      setBusy(false)
      return
    }
    timer = window.setTimeout(next, PAUSE_MS)
  }

  const sayOnce = (a: Announcement, left: number) => {
    const s = synth()
    if (!s || typeof SpeechSynthesisUtterance === 'undefined') {
      finish()
      return
    }
    let done = false
    const after = () => {
      if (done || stopped) return
      done = true
      if (timer) window.clearTimeout(timer)
      timer = null
      if (left > 1) timer = window.setTimeout(() => sayOnce(a, left - 1), PAUSE_MS)
      else finish()
    }
    try {
      const u = new SpeechSynthesisUtterance(a.text)
      const voice = pickVoice(a.lang)
      u.lang = voice?.lang ?? (a.lang === 'fr' ? 'fr-FR' : a.lang === 'rw' ? 'rw-RW' : 'en-GB')
      if (voice) u.voice = voice
      u.rate = 0.92
      u.pitch = 1
      u.volume = 1
      u.onend = after
      u.onerror = after
      // Chrome: a paused engine (after a tab switch) says nothing until resumed
      if (s.paused) s.resume()
      s.speak(u)
      // the safety net when the browser never reports the end
      timer = window.setTimeout(after, 2_000 + a.text.length * ESTIMATE_MS_PER_CHAR)
    } catch (e) {
      // said nothing: the screen goes on (the reason is in the TV browser's console)
      console.warn('[display] the voice could not speak:', e)
      after()
    }
  }

  const next = () => {
    timer = null
    if (stopped) return
    const a = queue.shift()
    if (!a) {
      setBusy(false)
      return
    }
    current = a
    setBusy(true)
    sayOnce(a, Math.max(1, Math.min(3, Math.round(a.repeat || 1))))
  }

  return {
    say: (a, delayMs = 0) => {
      if (!canSpeak()) return
      stopped = false
      // calls go before the results that still wait
      if (a.priority === 'call') {
        const i = queue.findIndex((x) => x.priority === 'result')
        if (i < 0) queue.push(a)
        else queue.splice(i, 0, a)
      } else queue.push(a)
      if (!current && !timer) {
        setBusy(true)
        timer = window.setTimeout(() => {
          timer = null
          next()
        }, delayMs)
      }
    },
    stop: () => {
      stopped = true
      queue.length = 0
      current = null
      if (timer) window.clearTimeout(timer)
      timer = null
      try {
        synth()?.cancel()
      } catch {
        /* nothing to stop */
      }
      setBusy(false)
    },
    busy: () => current !== null || queue.length > 0,
  }
}

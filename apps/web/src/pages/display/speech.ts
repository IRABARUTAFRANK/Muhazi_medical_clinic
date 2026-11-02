/**
 * The waiting-room screen's voice (migration 0118): the browser's speech synthesis (Web Speech
 * API) says a call after the chime, "Ticket A 0 1 4. Habimana Eric. Please come to Consultation
 * 2.", once to three times with a short pause, in English or French (browsers have no
 * Kinyarwanda voice). Announcements queue up, so two calls in a row are both said; a result
 * ready goes behind the calls. Where speechSynthesis is missing (an old TV browser) nothing is
 * said and nothing breaks.
 */

export type VoiceLang = 'en' | 'fr'

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
  const mine = voices.filter((v) => v.lang.toLowerCase().startsWith(lang))
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
      u.lang = a.lang === 'fr' ? 'fr-FR' : 'en-GB'
      const voice = pickVoice(a.lang)
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

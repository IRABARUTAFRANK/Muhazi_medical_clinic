import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { AudioLines, Volume2, VolumeX, WifiOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Lang } from '@mmc/shared'
import i18n from '@/i18n'
import { useDisplayBoard, type BoardDesk, type DisplayBoard } from '@/lib/api/display'
import { ApiError } from '@/lib/api/errors'
import { useMediaQuery, useNow } from '@/lib/hooks'
import { usePrefs } from '@/store/prefs'
import { cn } from '@/lib/utils'
import { canSpeak, createAnnouncer, spokenTicket, type Announcer } from './speech'
import './display.css'

/*
 * The waiting-room screen: a TV at the waiting side (migration 0114). One column per desk with
 * the patient just called in very large type (ticket, full name, "come to Consultation 1 · Dr.
 * X"), the next five waiting (red and yellow first), and a strip of the results ready. Reads
 * the board every 3 seconds; a new call flashes, dings (Web Audio, unlocked by the Start
 * button once) and, from 0118, is said aloud by the browser's voice (English or French, 1 to 3
 * times; a result ready is announced after the calls). A line scrolls at the bottom with who is
 * next, the results ready and the message. The languages rotate every 6 seconds. Nothing
 * scrolls on a TV.
 */

const LANG_EVERY_MS = 6_000
const FLASH_MS = 6_000
/** The voice starts once the chime has rung. */
const CHIME_MS = 1_100
/** The scrolling line's speed. */
const TICKER_PX_PER_S = 75
const SOUND_KEY = 'mmc.display.sound'
/** Intl locales for the clock and the date (Kinyarwanda falls back to the English pattern). */
const LOCALE: Record<Lang, string> = { rw: 'rw-RW', en: 'en-GB', fr: 'fr-FR' }

const readSound = (): boolean => {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off'
  } catch {
    return true
  }
}

/** A short two-note chime ("ding-dong") from the Web Audio API; nothing to download. */
function ding(ctx: AudioContext) {
  const at = ctx.currentTime
  const note = (freq: number, start: number, length: number, gain: number) => {
    const osc = ctx.createOscillator()
    const vol = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    vol.gain.setValueAtTime(0.0001, at + start)
    vol.gain.exponentialRampToValueAtTime(gain, at + start + 0.02)
    vol.gain.exponentialRampToValueAtTime(0.0001, at + start + length)
    osc.connect(vol).connect(ctx.destination)
    osc.start(at + start)
    osc.stop(at + start + length + 0.05)
  }
  note(880, 0, 0.5, 0.5)
  note(1174.7, 0.22, 0.9, 0.5)
}

type TFixed = ReturnType<typeof i18n.getFixedT>

/**
 * Which entries of a list are new since the last board read, found while rendering (state
 * derived from a changed prop, as the queue rows' flash): the first read is not news; `stamp`
 * counts the times something new appeared, for the effects that ding, speak and end the flash.
 */
function useNews(sig: string | null, ids: readonly string[]) {
  const [state, setState] = useState<{
    sig: string | null
    seen: string[]
    fresh: string[]
    stamp: number
  }>({ sig: null, seen: [], fresh: [], stamp: 0 })
  if (sig !== null && state.sig !== sig) {
    const news = state.sig === null ? [] : ids.filter((id) => !state.seen.includes(id))
    setState({
      sig,
      seen: [...ids],
      fresh: news.length ? news : state.fresh,
      stamp: news.length ? state.stamp + 1 : state.stamp,
    })
  }
  return [state, setState] as const
}

export function DisplayPage({ screenKey }: { screenKey: string }) {
  const { t: tUi } = useTranslation()
  const uiLang = usePrefs((s) => s.lang)
  const { data, error, isError, failureCount } = useDisplayBoard(screenKey)
  const now = useNow(1_000)

  // the languages of the screen, rotating; a single language stays
  const langs: Lang[] = data?.languages?.length ? data.languages : [uiLang]
  const [li, setLi] = useState(0)
  const rotating = langs.length > 1
  useEffect(() => {
    if (!rotating) return
    const id = window.setInterval(() => setLi((i) => i + 1), LANG_EVERY_MS)
    return () => window.clearInterval(id)
  }, [rotating])
  const lang = langs[li % langs.length] ?? 'en'
  const t = i18n.getFixedT(lang)

  // sound: the manager's switches for the screen (chime, voice), and this TV's own on/off
  // (remembered here), which covers both
  const [sound, setSound] = useState(readSound)
  const [started, setStarted] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const audio = useRef<AudioContext | null>(null)
  const announcer = useRef<Announcer | null>(null)
  const start = () => {
    try {
      const Ctx = window.AudioContext
      if (Ctx && !audio.current) audio.current = new Ctx()
      void audio.current?.resume()
    } catch {
      /* no audio: the screen still works */
    }
    // the voice needs the same gesture; where the browser cannot speak there is no announcer
    if (canSpeak() && !announcer.current) announcer.current = createAnnouncer(setSpeaking)
    void document.documentElement.requestFullscreen?.().catch(() => undefined)
    setStarted(true)
  }
  const toggleSound = () => {
    const next = !sound
    setSound(next)
    if (!next) announcer.current?.stop()
    try {
      localStorage.setItem(SOUND_KEY, next ? 'on' : 'off')
    } catch {
      /* not remembered */
    }
  }

  // A new call: an entry of "now" not seen before (or called again: its id and time make the key).
  const nowEntries = data
    ? data.desks.flatMap((d) => d.now.map((n) => ({ key: `${n.id}:${n.calledAt}`, n, desk: d })))
    : []
  const [calls, setCalls] = useNews(
    data ? nowEntries.map((e) => e.key).join('|') : null,
    nowEntries.map((e) => e.key),
  )
  const fresh = new Set(calls.fresh.map((k) => k.slice(0, k.indexOf(':'))))
  const chimeOn = (data?.chime ?? false) && sound
  const voiceOn = (data?.voice ?? false) && sound && started
  const voiceLang = data?.voiceLang === 'fr' ? 'fr' : 'en'
  const voiceRepeat = data?.voiceRepeat ?? 2
  const dinged = useRef(0)
  useEffect(() => {
    if (!calls.stamp) return
    if (dinged.current !== calls.stamp) {
      dinged.current = calls.stamp
      if (chimeOn && audio.current) ding(audio.current)
      if (voiceOn && announcer.current) {
        // "Ticket A 0 1 4. Habimana Eric. Please come to Consultation 2." after the chime
        const tv = i18n.getFixedT(voiceLang)
        for (const key of calls.fresh) {
          const e = nowEntries.find((x) => x.key === key)
          if (!e) continue
          const room =
            e.n.room ?? tv(`register.stations.${e.desk.station}`, { defaultValue: e.desk.station })
          const vars = { ticket: spokenTicket(e.n.ticket), name: e.n.name ?? '', room }
          announcer.current.say(
            {
              text: tv(e.n.name ? 'display.voice.call' : 'display.voice.callNoName', vars),
              lang: voiceLang,
              repeat: voiceRepeat,
              priority: 'call',
            },
            chimeOn ? CHIME_MS : 0,
          )
        }
      }
    }
    // the flash ends a few seconds after the call
    const id = window.setTimeout(() => setCalls((c) => ({ ...c, fresh: [] })), FLASH_MS)
    return () => window.clearTimeout(id)
    // the entries are read at the moment of the call only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calls.stamp, chimeOn, voiceOn, voiceLang, voiceRepeat, setCalls])

  // A result ready, new since the last read: said after the calls (lower priority), once.
  const results = data?.results ?? []
  const [news] = useNews(
    data ? results.map((r) => r.id).join('|') : null,
    results.map((r) => r.id),
  )
  const spokenResults = useRef(0)
  useEffect(() => {
    if (!news.stamp || spokenResults.current === news.stamp) return
    spokenResults.current = news.stamp
    if (!voiceOn || !announcer.current) return
    const tv = i18n.getFixedT(voiceLang)
    for (const id of news.fresh) {
      const r = results.find((x) => x.id === id)
      if (!r || !r.ticket) continue
      announcer.current.say(
        {
          text: tv(r.name ? 'display.voice.results' : 'display.voice.resultsNoName', {
            ticket: spokenTicket(r.ticket),
            name: r.name ?? '',
          }),
          lang: voiceLang,
          repeat: 1,
          priority: 'result',
        },
        0,
      )
    }
    // the results are read at the moment they appear only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [news.stamp, voiceOn, voiceLang])

  // nothing is left talking when the page goes
  useEffect(() => () => announcer.current?.stop(), [])

  const unknown = error instanceof ApiError && error.hint === 'screen_unknown'
  const offline = !unknown && isError && data != null
  const stale = !unknown && failureCount > 0 && data != null
  const locale = LOCALE[lang]
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Africa/Kigali',
  }).format(now)
  const date = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Africa/Kigali',
  }).format(now)
  // a tablet or a phone: one column, and the sizes follow (the page may scroll there)
  const narrow = useMediaQuery('(max-width: 900px)')
  const cols = narrow ? 1 : Math.max(1, Math.min(data?.desks.length ?? 1, 4))

  return (
    <div className="display-root" style={{ '--cols': cols } as CSSProperties} lang={lang}>
      <header className="display-head">
        <img src="/logo.jpg" alt="" className="display-logo" />
        <div className="min-w-0">
          <div className="display-clinic">{data?.clinic ?? tUi('app.clinicName')}</div>
          <div className="display-sub">{t('display.title')}</div>
        </div>
        {(offline || stale) && (
          <span className="display-offline" role="status">
            <WifiOff size={16} aria-hidden="true" className="mr-1 inline-block align-[-2px]" />
            {t('display.offline')}
          </span>
        )}
        {speaking && (
          <span className="display-speaking" role="status">
            <AudioLines size={18} aria-hidden="true" />
            {t('display.speaking')}
          </span>
        )}
        {(data?.chime || data?.voice) && (
          <button
            type="button"
            className="display-sound"
            onClick={toggleSound}
            aria-pressed={sound}
            title={t(sound ? 'display.soundOn' : 'display.soundOff')}
          >
            {sound ? (
              <Volume2 size={18} aria-hidden="true" />
            ) : (
              <VolumeX size={18} aria-hidden="true" />
            )}
            {t(sound ? 'display.soundOn' : 'display.soundOff')}
          </button>
        )}
        <div className="display-clock">
          <div className="display-time">{time}</div>
          <div className="display-date">{date}</div>
        </div>
      </header>

      {screenKey === '' ? (
        <p className="display-notice">{t('display.noKey')}</p>
      ) : unknown ? (
        <p className="display-notice">{t('display.unknown')}</p>
      ) : !data ? (
        <p className="display-notice" aria-busy="true">
          …
        </p>
      ) : data.desks.length === 0 ? (
        <p className="display-notice">{t('display.nobody')}</p>
      ) : (
        <main className="display-main">
          {data.desks.map((d) => (
            <DeskColumn key={d.station} desk={d} fresh={fresh} t={t} />
          ))}
        </main>
      )}

      {data && <Foot data={data} t={t} />}
      {data?.ticker && <Ticker data={data} langs={langs} />}

      {!started && data && !unknown && (
        <div className="display-overlay">
          <div className="display-overlay-card">
            <h1>{t('display.title')}</h1>
            <p>{t('display.startLead')}</p>
            <button type="button" className="display-start" onClick={start} autoFocus>
              {t('display.start')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** One desk: the patient just called (large), the earlier calls (small), the next five. */
function DeskColumn({ desk, fresh, t }: { desk: BoardDesk; fresh: Set<string>; t: TFixed }) {
  const [first, ...earlier] = desk.now
  const deskName = t(`register.stations.${desk.station}`, { defaultValue: desk.station })
  return (
    <section className="display-desk" aria-label={deskName}>
      <h2 className="display-desk-head">
        <span className="truncate">{deskName}</span>
        <span className="display-count">{t('display.waiting', { count: desk.waiting })}</span>
      </h2>
      <div className={cn('display-now', first && fresh.has(first.id) && 'is-new')}>
        <div className="display-label">{t('display.now')}</div>
        {first ? (
          <>
            <div className="display-ticket">{first.ticket}</div>
            {first.name && <div className="display-name">{first.name}</div>}
            <div className="display-go">
              {first.started
                ? `${first.room ?? deskName}${first.person ? ` · ${first.person}` : ''}`
                : t('display.comeTo', { room: first.room ?? deskName })}
              {!first.started && first.person && (
                <div className="display-go-person">
                  {t('display.with', { person: first.person })}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="display-empty">{t('display.noOneCalled')}</div>
        )}
        {earlier.length > 0 && (
          <div className="display-earlier">
            {earlier.slice(0, 2).map((n) => (
              <span key={n.id}>
                <b>{n.ticket}</b>
                {n.name ? ` ${n.name}` : ''} → {n.room ?? deskName}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="display-next">
        <div className="display-label">{t('display.next')}</div>
        {desk.next.length === 0 ? (
          <div className="display-empty">{t('display.nobody')}</div>
        ) : (
          desk.next.map((n) => (
            <div key={n.id} className="display-row">
              <span className={cn('display-dot', `display-dot-${n.priority}`)} aria-hidden="true" />
              <b>{n.ticket}</b>
              <span className="display-row-name">{n.name ?? ''}</span>
              {n.priority < 3 && (
                <span className="display-urgent">
                  {t(`triage.levels.${n.priority === 1 ? 'red' : 'yellow'}`)}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  )
}

/** The results-ready strip and, without the scrolling line, the clinic's message line. */
function Foot({ data, t }: { data: DisplayBoard; t: TFixed }) {
  const message = data.ticker ? null : data.message
  if (data.results.length === 0 && !message) return null
  return (
    <footer className="display-foot">
      {data.results.length > 0 && (
        <div className="display-results">
          <span className="display-results-title">
            {t('display.resultsReady')}
            <span className="display-results-hint">{t('display.resultsHint')}</span>
          </span>
          <div className="display-chips">
            {data.results.slice(0, 8).map((r) => (
              <span key={r.id} className="display-chip">
                <b>{r.ticket ?? '—'}</b>
                {r.name ? ` ${r.name}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}
      {message && (
        <div className="display-message">
          <span>{message}</span>
        </div>
      )}
    </footer>
  )
}

/** One item of the scrolling line: a desk's next patients, the results, or the message. */
interface TickerItem {
  key: string
  lead: string
  /** "A-015 Ingabire Diane" pieces, the ticket in gold. */
  parts: { ticket: string; name: string | null }[]
}

/** The scrolling line's items, in one language. */
function tickerItems(data: DisplayBoard, lang: Lang): TickerItem[] {
  const t = i18n.getFixedT(lang)
  const items: TickerItem[] = []
  for (const d of data.desks) {
    const desk = t(`register.stations.${d.station}`, { defaultValue: d.station })
    items.push(
      d.next.length === 0
        ? { key: `${lang}-${d.station}`, lead: t('display.ticker.nobody', { desk }), parts: [] }
        : {
            key: `${lang}-${d.station}`,
            lead: t('display.ticker.next', { desk, list: '' }).replace(/\s*$/, ''),
            parts: d.next.map((n) => ({ ticket: n.ticket, name: n.name })),
          },
    )
  }
  if (data.results.length > 0)
    items.push({
      key: `${lang}-results`,
      lead: t('display.ticker.results', { list: '' }).replace(/\s*$/, ''),
      parts: data.results.slice(0, 8).map((r) => ({ ticket: r.ticket ?? '—', name: r.name })),
    })
  if (data.message) items.push({ key: `${lang}-message`, lead: data.message, parts: [] })
  return items
}

/**
 * The scrolling line (0118): the text in every language of the screen, one after the other,
 * copied twice so the loop is seamless; the speed is fixed (pixels per second), so the lap
 * takes as long as the text is wide. It never pauses.
 */
function Ticker({ data, langs }: { data: DisplayBoard; langs: Lang[] }) {
  const copy = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = copy.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setWidth((prev) => (Math.abs(prev - w) > 1 ? w : prev))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const items = langs.flatMap((l) => tickerItems(data, l))
  if (items.length === 0) return null
  const seconds = Math.max(20, Math.round(width / TICKER_PX_PER_S))
  const line = (
    <>
      {items.map((it) => (
        <span key={it.key} className="inline-flex items-center">
          <span>{it.lead}</span>
          {it.parts.map((p, i) => (
            <span key={`${it.key}-${i}`} className="ml-[0.4em]">
              <b>{p.ticket}</b>
              {p.name ? ` ${p.name}` : ''}
              {i < it.parts.length - 1 ? ' ·' : ''}
            </span>
          ))}
          <span className="display-ticker-sep" aria-hidden="true">
            ▸
          </span>
        </span>
      ))}
    </>
  )
  return (
    <div className="display-ticker" aria-hidden="true">
      <div
        className="display-ticker-track"
        style={{ '--ticker-s': `${seconds}s` } as CSSProperties}
      >
        <span ref={copy} className="display-ticker-copy">
          {line}
        </span>
        <span className="display-ticker-copy">{line}</span>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { AudioLines, Volume2, VolumeX, WifiOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Lang } from '@mmc/shared'
import i18n from '@/i18n'
import {
  useDisplayBoard,
  type BoardDesk,
  type BoardNow,
  type DisplayBoard,
} from '@/lib/api/display'
import { ApiError } from '@/lib/api/errors'
import { useNow } from '@/lib/hooks'
import { usePrefs } from '@/store/prefs'
import { cn } from '@/lib/utils'
import { canSpeak, createAnnouncer, spokenTicket, type Announcer } from './speech'
import './display.css'

/*
 * The waiting-room screen: a TV at the waiting side (migration 0114). On top the latest call as
 * one big statement (ticket, full name, "come to Consultation 1 · with Dr. X"), with the two or
 * three earlier calls under it; then ONE desk card at a time, turning every 6 seconds like a
 * slideshow (0119: ten desks never shrink into ten columns): who is being seen, the three next
 * by urgency with the doctor they will see, "and N more waiting". Reads the board every 3
 * seconds; a new call flashes, dings (Web Audio, unlocked by the Start button once) and is said
 * aloud (0118); a result ready is announced after the calls. A strip of results ready and a
 * scrolling line close the page. The languages rotate every 6 seconds. Nothing scrolls on a TV.
 */

const LANG_EVERY_MS = 6_000
/** One desk card after the other. */
const SLIDE_EVERY_MS = 6_000
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

/** A call with its desk, for the banner and the voice. */
interface Call {
  key: string
  n: BoardNow
  desk: BoardDesk
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

  // Every call of the day, newest first (the banner shows the first, the row under it the next).
  const calls: Call[] = (data?.desks ?? [])
    .flatMap((d) => d.now.map((n) => ({ key: `${n.id}:${n.calledAt}`, n, desk: d })))
    .sort((a, b) => b.n.calledAt.localeCompare(a.n.calledAt))
  // A new call: an entry not seen before (or called again: its id and time make the key).
  const [news, setNews] = useNews(
    data ? calls.map((c) => c.key).join('|') : null,
    calls.map((c) => c.key),
  )
  const freshKeys = new Set(news.fresh)
  const chimeOn = (data?.chime ?? false) && sound
  const voiceOn = (data?.voice ?? false) && sound && started
  const voiceLang = data?.voiceLang === 'fr' ? 'fr' : 'en'
  const voiceRepeat = data?.voiceRepeat ?? 2
  const dinged = useRef(0)
  useEffect(() => {
    if (!news.stamp) return
    if (dinged.current !== news.stamp) {
      dinged.current = news.stamp
      if (chimeOn && audio.current) ding(audio.current)
      if (voiceOn && announcer.current) {
        // "Ticket A 0 1 4. Habimana Eric. Please come to Consultation 2." after the chime
        const tv = i18n.getFixedT(voiceLang)
        for (const key of news.fresh) {
          const c = calls.find((x) => x.key === key)
          if (!c) continue
          const room =
            c.n.room ?? tv(`register.stations.${c.desk.station}`, { defaultValue: c.desk.station })
          const vars = { ticket: spokenTicket(c.n.ticket), name: c.n.name ?? '', room }
          announcer.current.say(
            {
              text: tv(c.n.name ? 'display.voice.call' : 'display.voice.callNoName', vars),
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
    const id = window.setTimeout(() => setNews((c) => ({ ...c, fresh: [] })), FLASH_MS)
    return () => window.clearTimeout(id)
    // the calls are read at the moment they arrive only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [news.stamp, chimeOn, voiceOn, voiceLang, voiceRepeat, setNews])

  // A result ready, new since the last read: said after the calls (lower priority), once.
  const results = data?.results ?? []
  const [resultNews] = useNews(
    data ? results.map((r) => r.id).join('|') : null,
    results.map((r) => r.id),
  )
  const spokenResults = useRef(0)
  useEffect(() => {
    if (!resultNews.stamp || spokenResults.current === resultNews.stamp) return
    spokenResults.current = resultNews.stamp
    if (!voiceOn || !announcer.current) return
    const tv = i18n.getFixedT(voiceLang)
    for (const id of resultNews.fresh) {
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
  }, [resultNews.stamp, voiceOn, voiceLang])

  // nothing is left talking when the page goes
  useEffect(() => () => announcer.current?.stop(), [])

  // the slideshow: the desks with a patient, one at a time, whatever the voice is doing
  const busyDesks = (data?.desks ?? []).filter((d) => d.now.length > 0 || d.next.length > 0)
  const [slide, setSlide] = useState(0)
  const slides = busyDesks.length
  useEffect(() => {
    if (slides < 2) return
    const id = window.setInterval(() => setSlide((i) => i + 1), SLIDE_EVERY_MS)
    return () => window.clearInterval(id)
  }, [slides])
  const current = slides ? busyDesks[slide % slides] : undefined

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

  return (
    <div className="display-root" lang={lang}>
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
      ) : (
        <main className="display-stage">
          <Banner calls={calls} fresh={freshKeys} t={t} />
          {current ? (
            <DeskSlide
              key={current.station}
              desk={current}
              index={slide % slides}
              total={slides}
              t={t}
            />
          ) : (
            <section className="display-slide display-calm">
              <h2>{t('display.noPatients')}</h2>
              <p>{t('display.noPatientsLead')}</p>
            </section>
          )}
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

const deskNameOf = (desk: BoardDesk, t: TFixed) =>
  t(`register.stations.${desk.station}`, { defaultValue: desk.station })

/** The latest call, huge, and the two or three before it in a thin row. */
function Banner({ calls, fresh, t }: { calls: Call[]; fresh: Set<string>; t: TFixed }) {
  const [latest, ...earlier] = calls
  return (
    <>
      <section
        className={cn('display-banner', latest && fresh.has(latest.key) && 'is-new')}
        aria-live="polite"
      >
        <div className="display-banner-label">{t('display.latestCall')}</div>
        {latest ? (
          <>
            <div className="display-banner-ticket">{latest.n.ticket}</div>
            <div className="display-banner-body">
              {latest.n.name && <div className="display-banner-name">{latest.n.name}</div>}
              <div className="display-banner-go">
                {latest.n.started
                  ? `${t('display.beingSeen')} · ${latest.n.room ?? deskNameOf(latest.desk, t)}`
                  : t('display.comeTo', { room: latest.n.room ?? deskNameOf(latest.desk, t) })}
                {latest.n.person && <small>{t('display.with', { person: latest.n.person })}</small>}
              </div>
            </div>
          </>
        ) : (
          <div className="display-banner-empty">{t('display.noCallYet')}</div>
        )}
      </section>
      {earlier.length > 0 && (
        <div className="display-prev">
          <span className="display-prev-label">{t('display.earlierCalls')}</span>
          {earlier.slice(0, 3).map((c) => (
            <span key={c.key}>
              <b>{c.n.ticket}</b>
              {c.n.name ? ` ${c.n.name}` : ''} → {c.n.room ?? deskNameOf(c.desk, t)}
            </span>
          ))}
        </div>
      )}
    </>
  )
}

/** One desk's card: who is being seen, the three next by urgency, how many more wait. */
function DeskSlide({
  desk,
  index,
  total,
  t,
}: {
  desk: BoardDesk
  index: number
  total: number
  t: TFixed
}) {
  const deskName = deskNameOf(desk, t)
  const seen = desk.now.find((n) => n.started) ?? desk.now[0]
  const next = desk.next.slice(0, 3)
  const more = Math.max(0, desk.waiting - next.length)
  return (
    <section className="display-slide" aria-label={deskName}>
      <div className="display-slide-head">
        <h2 className="display-slide-title">{deskName}</h2>
        <span className="display-slide-count">{t('display.waiting', { count: desk.waiting })}</span>
        {total > 1 && (
          <span
            className="display-slide-pos"
            aria-label={t('display.position', { n: index + 1, total })}
          >
            {Array.from({ length: Math.min(total, 12) }, (_, i) => (
              <span key={i} className={cn('display-slide-dot', i === index % 12 && 'is-on')} />
            ))}
            <span>
              {index + 1} / {total}
            </span>
          </span>
        )}
      </div>
      <div className="display-slide-body">
        <div className="display-slide-col">
          <div className="display-label">{t('display.now')}</div>
          {seen ? (
            <>
              <div className="display-now-ticket">{seen.ticket}</div>
              {seen.name && <div className="display-now-name">{seen.name}</div>}
              <div className="display-now-go">
                {[
                  seen.person ? t('display.with', { person: seen.person }) : null,
                  seen.room ?? deskName,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </>
          ) : (
            <div className="display-empty">{t('display.noOneCalled')}</div>
          )}
        </div>
        <div className="display-slide-col">
          <div className="display-label">{t('display.next')}</div>
          {next.length === 0 ? (
            <div className="display-empty">{t('display.nobody')}</div>
          ) : (
            next.map((n) => (
              <div key={n.id} className="display-row">
                <span
                  className={cn('display-dot', `display-dot-${n.priority}`)}
                  aria-hidden="true"
                />
                <b>{n.ticket}</b>
                {/* the name on one line, who will see them under it */}
                <span className="display-row-main">
                  <span className="display-row-name">
                    {n.name ?? ''}
                    {n.priority < 3 && (
                      <span className="display-urgent">
                        {t(`triage.levels.${n.priority === 1 ? 'red' : 'yellow'}`)}
                      </span>
                    )}
                  </span>
                  <span className="display-row-to">
                    → {n.person ? `${n.person}${n.room ? ` · ${n.room}` : ''}` : deskName}
                  </span>
                </span>
              </div>
            ))
          )}
          {more > 0 && (
            <div className="display-more">{t('display.moreWaiting', { count: more })}</div>
          )}
        </div>
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

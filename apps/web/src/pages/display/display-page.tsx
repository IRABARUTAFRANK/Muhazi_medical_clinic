import { createElement, useEffect, useRef, useState, type CSSProperties } from 'react'
import { AudioLines, GalleryHorizontal, LayoutGrid, Volume2, VolumeX, WifiOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Lang } from '@mmc/shared'
import i18n from '@/i18n'
import { stationIconFor } from '@/components/dash/kit-style'
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
import '@fontsource-variable/sora'
import '@fontsource-variable/manrope'
import './display.css'

/*
 * The waiting-room screen: a TV at the waiting side (migration 0114). 0157: the look of the
 * "Clinic Queue Display" design. On top the clinic, how many wait, the clock; then the latest
 * call as a glowing bar ("Now calling C-024 · Jean M. — please proceed to Consultation, Room
 * 1"); then the desks, in two turns that alternate every five minutes: every desk as a card in
 * a grid, then one desk at a time like a slideshow. The desk whose patient was called last
 * comes first, so a call always shows where everyone looks. Reads the board every 3 seconds;
 * a new call flashes, dings (Web Audio, unlocked by the Start button once) and is said aloud
 * (0118); a result ready is announced after the calls. A strip of results ready and the
 * scrolling line close the page. The languages rotate every 6 seconds. Nothing scrolls on a TV.
 */

const LANG_EVERY_MS = 6_000
/** The grid and the slideshow take turns. */
const VIEW_EVERY_MS = 5 * 60_000
/** One desk after the other, in the slideshow. */
const SLIDE_EVERY_MS = 10_000
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

const deskNameOf = (desk: BoardDesk, t: TFixed) =>
  t(`register.stations.${desk.station}`, { defaultValue: desk.station })
/** The room of a desk: where its patient was called (the desk's name when unknown). */
const deskRoomOf = (desk: BoardDesk): string | null =>
  desk.now.find((n) => n.room)?.room ?? desk.next.find((n) => n.room)?.room ?? null
/** The latest call of a desk, as a time to sort on. */
const lastCallOf = (desk: BoardDesk): string =>
  desk.now.reduce((m, n) => (n.calledAt > m ? n.calledAt : m), '')
/** Desks with the most recent call first; then those with someone waiting; then the rest. */
const orderDesks = (desks: readonly BoardDesk[]): BoardDesk[] =>
  [...desks].sort((a, b) => {
    const la = lastCallOf(a)
    const lb = lastCallOf(b)
    if (la !== lb) return lb.localeCompare(la)
    return b.waiting - a.waiting
  })

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

  // Every call of the day, newest first (the banner shows the first).
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

  // the desks, the last called first; the grid and the slideshow take turns every 5 minutes
  const desks = orderDesks(data?.desks ?? [])
  const busy = desks.some((d) => d.now.length > 0 || d.next.length > 0 || d.waiting > 0)
  const [mode, setMode] = useState<'grid' | 'slides'>('grid')
  const [slide, setSlide] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => {
      setMode((m) => (m === 'grid' ? 'slides' : 'grid'))
      setSlide(0)
    }, VIEW_EVERY_MS)
    return () => window.clearInterval(id)
  }, [])
  const slides = desks.length
  useEffect(() => {
    if (mode !== 'slides' || slides < 2) return
    const id = window.setInterval(() => setSlide((i) => (i + 1) % slides), SLIDE_EVERY_MS)
    return () => window.clearInterval(id)
  }, [mode, slides])
  // a new call: its desk is first, and the slideshow starts from it (derived while rendering)
  const [seenStamp, setSeenStamp] = useState(0)
  if (news.stamp !== seenStamp) {
    setSeenStamp(news.stamp)
    setSlide(0)
  }
  const totalWaiting = desks.reduce((n, d) => n + d.waiting, 0)

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
    <div className="qd" lang={lang}>
      <header className="qd-head">
        <div className="qd-brand">
          <img src="/logo.jpg" alt="" className="qd-logo" />
          <div className="min-w-0">
            <h1 className="qd-clinic">{data?.clinic ?? tUi('app.clinicName')}</h1>
            <p className="qd-sub">
              {t('display.queue')} · <b className="num">{totalWaiting}</b>{' '}
              {t('display.waitingWord')}
            </p>
          </div>
        </div>
        <div className="qd-head-right">
          {(offline || stale) && (
            <span className="qd-pill is-off" role="status">
              <WifiOff size={16} aria-hidden="true" />
              {t('display.offline')}
            </span>
          )}
          {speaking && (
            <span className="qd-pill is-speaking" role="status">
              <AudioLines size={16} aria-hidden="true" />
              {t('display.speaking')}
            </span>
          )}
          {(data?.chime || data?.voice) && (
            <button
              type="button"
              className="qd-pill qd-sound"
              onClick={toggleSound}
              aria-pressed={sound}
              title={t(sound ? 'display.soundOn' : 'display.soundOff')}
            >
              {sound ? (
                <Volume2 size={16} aria-hidden="true" />
              ) : (
                <VolumeX size={16} aria-hidden="true" />
              )}
              {t(sound ? 'display.soundOn' : 'display.soundOff')}
            </button>
          )}
          {data && desks.length > 1 && (
            <div className="qd-modes" role="group" aria-label={t('display.views')}>
              {(['grid', 'slides'] as const).map((m) => {
                const Icon = m === 'grid' ? LayoutGrid : GalleryHorizontal
                return (
                  <button
                    key={m}
                    type="button"
                    className={cn('qd-mode', mode === m && 'is-on')}
                    aria-pressed={mode === m}
                    aria-label={t(m === 'grid' ? 'display.gridView' : 'display.slidesView')}
                    title={t(m === 'grid' ? 'display.gridView' : 'display.slidesView')}
                    onClick={() => {
                      setMode(m)
                      setSlide(0)
                    }}
                  >
                    <Icon size={18} aria-hidden="true" />
                  </button>
                )
              })}
            </div>
          )}
          <div className="qd-clock">
            <div className="qd-time">{time}</div>
            <div className="qd-date">{date}</div>
          </div>
        </div>
      </header>

      {screenKey === '' ? (
        <p className="qd-notice">{t('display.noKey')}</p>
      ) : unknown ? (
        <p className="qd-notice">{t('display.unknown')}</p>
      ) : !data ? (
        <p className="qd-notice" aria-busy="true">
          …
        </p>
      ) : (
        <main className="qd-stage">
          <Banner calls={calls} fresh={freshKeys} t={t} />
          {!busy ? (
            <section className="qd-calm">
              <h2>{t('display.noPatients')}</h2>
              <p>{t('display.noPatientsLead')}</p>
            </section>
          ) : mode === 'grid' || desks.length < 2 ? (
            <DeskGrid desks={desks} t={t} />
          ) : (
            <SlideView desks={desks} index={slide % slides} t={t} />
          )}
        </main>
      )}

      {data && <Foot data={data} t={t} />}
      {data?.ticker && <Ticker data={data} langs={langs} />}

      {!started && data && !unknown && (
        <div className="qd-overlay">
          <div className="qd-overlay-card">
            <h1>{t('display.title')}</h1>
            <p>{t('display.startLead')}</p>
            <button type="button" className="qd-start" onClick={start} autoFocus>
              {t('display.start')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** The latest call as a glowing bar, and the two or three before it in a thin line. */
function Banner({ calls, fresh, t }: { calls: Call[]; fresh: Set<string>; t: TFixed }) {
  const [latest, ...earlier] = calls
  const where = (c: Call) => {
    const desk = deskNameOf(c.desk, t)
    // "Consultation 2" says the desk already; "Room 3" needs it ("Dental — Room 3")
    const room = c.n.room
    if (!room || room === desk) return desk
    return room.toLowerCase().includes(desk.toLowerCase()) ? room : `${desk} — ${room}`
  }
  return (
    <>
      <section
        key={latest?.key ?? 'none'}
        className={cn('qd-banner', latest && fresh.has(latest.key) && 'is-new')}
        aria-live="polite"
      >
        <div className="qd-banner-icon" aria-hidden="true">
          <Volume2 />
        </div>
        {latest ? (
          <>
            <div className="qd-banner-main">
              <p className="qd-banner-label">
                {t(latest.n.started ? 'display.beingSeen' : 'display.nowCalling')}
              </p>
              <p className="qd-banner-who">
                {latest.n.ticket}
                {latest.n.name ? ` · ${latest.n.name}` : ''}
              </p>
            </div>
            <div className="qd-banner-to">
              <p className="qd-banner-to-label">{t('display.proceedTo')}</p>
              <p className="qd-banner-where">{where(latest)}</p>
              {latest.n.person && (
                <p className="qd-banner-with">{t('display.with', { person: latest.n.person })}</p>
              )}
            </div>
          </>
        ) : (
          <div className="qd-banner-main">
            <p className="qd-banner-label">{t('display.latestCall')}</p>
            <p className="qd-banner-empty">{t('display.noCallYet')}</p>
          </div>
        )}
      </section>
      {earlier.length > 0 && (
        <div className="qd-prev" aria-hidden="true">
          <span>{t('display.earlierCalls')}:</span>
          {earlier.slice(0, 3).map((c) => (
            <span key={c.key}>
              <b>{c.n.ticket}</b>
              {c.n.name ? ` ${c.n.name}` : ''} → {where(c)}
            </span>
          ))}
        </div>
      )}
    </>
  )
}

/** The next patients of a desk, NEXT in gold, the urgency as a dot. */
function NextRows({ desk, rows, t }: { desk: BoardDesk; rows: number; t: TFixed }) {
  const next = desk.next.slice(0, rows)
  const more = Math.max(0, desk.waiting - next.length)
  if (next.length === 0) return <li className="qd-empty">{t('display.nobody')}</li>
  return (
    <>
      {next.map((n, i) => (
        <li key={n.id} className={cn('qd-row', i === 0 && 'is-next')}>
          <span className="qd-row-left">
            <span className={cn('qd-tag', i === 0 && 'is-next')}>
              {i === 0 ? t('display.nextTag') : `#${i + 1}`}
            </span>
            <span className={cn('qd-dot', `qd-dot-${n.priority}`)} aria-hidden="true" />
            <span className="qd-row-ticket num">{n.ticket}</span>
          </span>
          <span className="qd-row-name">
            {n.name ?? ''}
            {n.priority < 3 && (
              <>
                {n.name ? ' · ' : ''}
                {t(`triage.levels.${n.priority === 1 ? 'red' : 'yellow'}`)}
              </>
            )}
          </span>
        </li>
      ))}
      {more > 0 && <li className="qd-more">{t('display.moreWaiting', { count: more })}</li>}
    </>
  )
}

/** Every desk as a card: the one called last first, outlined in gold. */
function DeskGrid({ desks, t }: { desks: BoardDesk[]; t: TFixed }) {
  const n = desks.length
  const cols = n <= 3 ? n : n <= 4 ? 2 : n <= 9 ? 3 : 4
  const rows = n <= 3 ? 5 : n <= 6 ? 3 : n <= 9 ? 2 : 1
  return (
    <div className="qd-grid" style={{ '--qd-cols': cols } as CSSProperties}>
      {desks.map((d, i) => {
        const name = deskNameOf(d, t)
        const room = deskRoomOf(d)
        const seen = d.now.find((x) => x.started) ?? d.now[0]
        return (
          <article
            key={d.station}
            className={cn('qd-card', i === 0 && d.now.length > 0 && 'is-first')}
            aria-label={name}
          >
            <div className="qd-card-head">
              <div className="qd-card-id">
                <span className="qd-icon" aria-hidden="true">
                  {createElement(stationIconFor(d.station))}
                </span>
                <div className="min-w-0">
                  <h2 className="qd-card-name">{name}</h2>
                  {room && room !== name && <div className="qd-card-room">{room}</div>}
                </div>
              </div>
              <span className="qd-count">{t('display.waiting', { count: d.waiting })}</span>
            </div>
            <div className="qd-serving">
              <div className="qd-label">{t('display.nowServing')}</div>
              <div className="qd-serving-row">
                <span className="qd-serving-ticket num">{seen?.ticket ?? '—'}</span>
                <span className="qd-serving-name">
                  {seen ? (seen.name ?? '') : t('display.noOneCalled')}
                </span>
              </div>
              {seen?.person && (
                <div className="qd-serving-with">{t('display.with', { person: seen.person })}</div>
              )}
            </div>
            <ol className="qd-list">
              <NextRows desk={d} rows={rows} t={t} />
            </ol>
          </article>
        )
      })}
    </div>
  )
}

/** One desk at a time, large: who is being seen, and up to six next. */
function SlideView({ desks, index, t }: { desks: BoardDesk[]; index: number; t: TFixed }) {
  const d = desks[index] ?? desks[0]
  if (!d) return null
  const name = deskNameOf(d, t)
  const room = deskRoomOf(d)
  const seen = d.now.find((x) => x.started) ?? d.now[0]
  return (
    <div className="qd-slides">
      <article key={`${d.station}-${index}`} className="qd-slide" aria-label={name}>
        <div className="qd-slide-left">
          <div className="qd-slide-id">
            <span className="qd-icon" aria-hidden="true">
              {createElement(stationIconFor(d.station))}
            </span>
            <div className="min-w-0">
              <h2 className="qd-slide-name">{name}</h2>
              {room && room !== name && <div className="qd-slide-room">{room}</div>}
            </div>
          </div>
          <div>
            <div className="qd-label">{t('display.nowServing')}</div>
            <div className="qd-slide-ticket num">{seen?.ticket ?? '—'}</div>
            <div className="qd-slide-who">
              {seen ? (seen.name ?? '') : t('display.noOneCalled')}
              {seen?.person && (
                <span className="qd-serving-with">
                  {seen.name ? ' · ' : ''}
                  {t('display.with', { person: seen.person })}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="qd-slide-right">
          <div className="qd-label">{t('display.waiting', { count: d.waiting })}</div>
          <ol className="qd-slide-list">
            <NextRows desk={d} rows={6} t={t} />
          </ol>
        </div>
      </article>
      {desks.length > 1 && (
        <div
          className="qd-dots"
          aria-label={t('display.position', { n: index + 1, total: desks.length })}
        >
          {desks.map((x, i) => (
            <span key={x.station} className={cn(i === index && 'is-on')} />
          ))}
        </div>
      )}
    </div>
  )
}

/** The results-ready strip and, without the scrolling line, the clinic's message line. */
function Foot({ data, t }: { data: DisplayBoard; t: TFixed }) {
  const message = data.ticker ? null : data.message
  if (data.results.length === 0 && !message) return null
  return (
    <footer className="contents">
      {data.results.length > 0 && (
        <div className="qd-results">
          <span className="qd-results-title">
            {t('display.resultsReady')}
            <span className="qd-results-hint">{t('display.resultsHint')}</span>
          </span>
          <div className="qd-chips">
            {data.results.slice(0, 8).map((r) => (
              <span key={r.id} className="qd-chip">
                <b>{r.ticket ?? '—'}</b>
                {r.name ? ` ${r.name}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}
      {message && (
        <div className="qd-message">
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
  /** "A-015 Ingabire Diane" pieces, the ticket in the display font. */
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
          <span className="qd-ticker-sep" aria-hidden="true">
            ▸
          </span>
        </span>
      ))}
    </>
  )
  return (
    <div className="qd-ticker" aria-hidden="true">
      <div className="qd-ticker-track" style={{ '--ticker-s': `${seconds}s` } as CSSProperties}>
        <span ref={copy} className="qd-ticker-copy">
          {line}
        </span>
        <span className="qd-ticker-copy">{line}</span>
      </div>
    </div>
  )
}

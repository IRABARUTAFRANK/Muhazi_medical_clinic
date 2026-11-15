import { createElement, useEffect, useRef, useState, type CSSProperties } from 'react'
import { LogIn, Tv, AudioLines, Volume2, VolumeX, WifiOff } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { Lang } from '@mmc/shared'
import { setAfterSignIn } from '@/lib/after-sign-in'
import i18n, { ensureLang } from '@/i18n'
import { stationIconFor } from '@/components/dash/kit-style'
import {
  clipUrl,
  forgetDisplayKey,
  requestRwVoice,
  TV_SETUP_PATH,
  useDisplayBoard,
  type BoardDesk,
  type BoardNow,
  type DisplayBoard,
} from '@/lib/api/display'
import { ApiError } from '@/lib/api/errors'
import { useNow } from '@/lib/hooks'
import { usePrefs } from '@/store/prefs'
import { cn } from '@/lib/utils'
import { CLIP_INTRO, CLIP_STAFF, clipKeyForDesk, deskPhrase, upperFirst } from './kinyarwanda'
import {
  canSpeak,
  createAnnouncer,
  rwSentence,
  rwVoiceFamily,
  spokenTicket,
  type Announcement,
  type Announcer,
} from './speech'
import '@fontsource-variable/sora'
import '@fontsource-variable/manrope'
import './display.css'

/*
 * The waiting-room screen: a TV at the waiting side (migration 0114). 0157: the look of the
 * "Clinic Queue Display" design. On top the clinic, how many wait, the clock; then the latest
 * call as a glowing bar ("Now calling C-024 · Jean M. — please proceed to Consultation, Room
 * 1"); then the desks with someone called or waiting, ONE at a time like a slideshow (0160:
 * the grid of every desk is gone). The desk whose patient was called last comes first, so a
 * call always shows where everyone looks. Reads the board every 3 seconds;
 * a new call flashes, dings (Web Audio, unlocked by the Start button once) and is said aloud
 * (0118); a result ready is announced after the calls. A strip of results ready and the
 * scrolling line close the page. The languages rotate every 6 seconds. Nothing scrolls on a TV.
 */

const LANG_EVERY_MS = 6_000
/** The three languages of the clinic: a call is said once in each (0162). */
const ALL_LANGS: Lang[] = ['rw', 'en', 'fr']
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
/** A room label that only repeats the desk's name (in any language) says nothing more. */
const roomSaysDesk = (room: string, station: string, name: string) =>
  room === name || room === i18n.getFixedT('en')(`register.stations.${station}`)
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
  const navigate = useNavigate()
  const uiLang = usePrefs((s) => s.lang)
  // 0158: setting the TV up is a staff sign-in that comes back here; "Set up again" forgets the key
  const toSetup = () => {
    setAfterSignIn(TV_SETUP_PATH)
    void navigate({ to: '/', hash: 'signin' })
  }
  const resetTv = () => {
    forgetDisplayKey()
    void navigate({ to: '/display', search: { key: '' } })
  }
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
  // the language on the screen at the moment of a call, for the voice (read inside effects)
  const langNow = useRef(lang)
  useEffect(() => {
    langNow.current = lang
  }, [lang])
  /**
   * 0162: the three languages a call is said in, the first the one on the screen right now,
   * then the screen's other languages in their order, then the rest of the three.
   */
  const voiceOrder = (): Lang[] => {
    const first = langNow.current
    const rest = [...langsKey.split(','), ...ALL_LANGS].filter(
      (l, i, a) => l !== first && a.indexOf(l) === i,
    ) as Lang[]
    return [first, ...rest].slice(0, 3)
  }
  // 0159: the screen's languages are loaded (the page starts with the browser's own only),
  // else their words would fall back to English; the page renders again once they are in
  const langsKey = langs.join(',')
  const [, langsLoaded] = useState('')
  useEffect(() => {
    let on = true
    void Promise.all(ALL_LANGS.map((l) => ensureLang(l))).then(() => {
      if (on) langsLoaded(langsKey)
    })
    return () => {
      on = false
    }
  }, [langsKey])

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
  const dinged = useRef(0)
  useEffect(() => {
    if (!news.stamp) return
    if (dinged.current !== news.stamp) {
      dinged.current = news.stamp
      if (chimeOn && audio.current) ding(audio.current)
      if (voiceOn && announcer.current) {
        // 0162: "Habimana Eric, you are needed in Consultation by Dr Mukamana", three times, each
        // in a different language — first the one on the screen right now — after the chime
        const voiceLangs = voiceOrder()
        let first = true
        for (const key of news.fresh) {
          const c = calls.find((x) => x.key === key)
          if (!c) continue
          {
            for (const vl of voiceLangs) {
              const tv = i18n.getFixedT(vl)
              const department = deskPhrase(
                tv(`register.stations.${c.desk.station}`, { defaultValue: c.desk.station }),
                vl,
              )
              const vars = {
                ticket: spokenTicket(c.n.ticket),
                name: c.n.name ?? '',
                department,
                staff: c.n.person ?? '',
              }
              const k = c.n.name
                ? c.n.person
                  ? 'display.voice.call'
                  : 'display.voice.callNoStaff'
                : c.n.person
                  ? 'display.voice.callTicket'
                  : 'display.voice.callTicketNoStaff'
              const delay = first && chimeOn ? CHIME_MS : 0
              if (vl === 'rw') {
                // 0163: Kinyarwanda through the closest voice the TV has, respelled for it;
                // 0165: or the staff's recordings (only the names by the voice), or the clinic's
                // voice server (the whole sentence as audio, the voice if it does not answer)
                const fam = rwVoiceFamily()
                const deptPart = { token: '§3§', value: vars.department, kinyarwanda: true }
                const staffPart = { token: '§4§', value: vars.staff }
                const parts = [
                  { token: '§1§', value: vars.ticket },
                  { token: '§2§', value: vars.name },
                  deptPart,
                  staffPart,
                ]
                const spoken = rwSentence(
                  tv(k, { ticket: '§1§', name: '§2§', department: '§3§', staff: '§4§' }),
                  parts,
                  fam,
                )
                const mode = data?.rwVoice ?? 'browser'
                const clips = data?.clips ?? {}
                const clip = (key: string) => (clips[key] ? clipUrl(clips[key]) : null)
                const piece = (a: Partial<Announcement> & { text: string }, d = 0) =>
                  announcer.current!.say({ lang: 'rw', repeat: 1, priority: 'call', ...a }, d)
                const who = c.n.name || vars.ticket
                if (mode === 'server' && screenKey) {
                  piece({ text: spoken, audio: requestRwVoice(screenKey, tv(k, vars)) }, delay)
                } else if (
                  mode === 'recorded' &&
                  (clip(CLIP_INTRO) || clip(clipKeyForDesk(c.desk.station)) || clip(CLIP_STAFF))
                ) {
                  const intro = clip(CLIP_INTRO)
                  piece(
                    { text: rwSentence('Umurwayi witwa', [], fam), audio: intro, gapMs: 100 },
                    delay,
                  )
                  piece({
                    text: rwSentence('§2§', [{ token: '§2§', value: who }], fam),
                    gapMs: 160,
                  })
                  piece({
                    text: rwSentence('urakenewe muri §3§', [deptPart], fam),
                    audio: clip(clipKeyForDesk(c.desk.station)),
                    gapMs: 160,
                  })
                  if (c.n.person) {
                    piece({
                      text: rwSentence('ukenewe na muganga', [], fam),
                      audio: clip(CLIP_STAFF),
                      gapMs: 100,
                    })
                    piece({ text: rwSentence('§4§', [staffPart], fam) })
                  }
                } else {
                  piece({ text: spoken }, delay)
                }
              } else {
                announcer.current.say(
                  { text: tv(k, vars), lang: vl, repeat: 1, priority: 'call' },
                  delay,
                )
              }
              first = false
            }
          }
        }
      }
    }
    // the flash ends a few seconds after the call
    const id = window.setTimeout(() => setNews((c) => ({ ...c, fresh: [] })), FLASH_MS)
    return () => window.clearTimeout(id)
    // the calls are read at the moment they arrive only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [news.stamp, chimeOn, voiceOn, langsKey, setNews])

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
    for (const id of resultNews.fresh) {
      const r = results.find((x) => x.id === id)
      if (!r || !r.ticket) continue
      for (const vl of voiceOrder()) {
        const tv = i18n.getFixedT(vl)
        const rk = r.name ? 'display.voice.results' : 'display.voice.resultsNoName'
        const text =
          vl === 'rw'
            ? rwSentence(
                tv(rk, { ticket: '§1§', name: '§2§' }),
                [
                  { token: '§1§', value: spokenTicket(r.ticket) },
                  { token: '§2§', value: r.name ?? '' },
                ],
                rwVoiceFamily(),
              )
            : tv(rk, { ticket: spokenTicket(r.ticket), name: r.name ?? '' })
        announcer.current.say({ text, lang: vl, repeat: 1, priority: 'result' }, 0)
      }
    }
    // the results are read at the moment they appear only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultNews.stamp, voiceOn, langsKey])

  // nothing is left talking when the page goes
  useEffect(() => () => announcer.current?.stop(), [])

  // the desks with someone (called or waiting), the last called first, one at a time
  const allDesks = orderDesks(data?.desks ?? [])
  const desks = allDesks.filter((d) => d.now.length > 0 || d.next.length > 0 || d.waiting > 0)
  const busy = desks.length > 0
  const [slide, setSlide] = useState(0)
  const slides = desks.length
  useEffect(() => {
    if (slides < 2) return
    const id = window.setInterval(() => setSlide((i) => (i + 1) % slides), SLIDE_EVERY_MS)
    return () => window.clearInterval(id)
  }, [slides])
  // a new call: its desk is first, and the slideshow starts from it (derived while rendering)
  const [seenStamp, setSeenStamp] = useState(0)
  if (news.stamp !== seenStamp) {
    setSeenStamp(news.stamp)
    setSlide(0)
  }
  const totalWaiting = allDesks.reduce((n, d) => n + d.waiting, 0)

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
          <div className="qd-clock">
            <div className="qd-time">{time}</div>
            <div className="qd-date">{date}</div>
          </div>
        </div>
      </header>

      {screenKey === '' || unknown ? (
        <section className="qd-setup-card qd-setup-inline">
          <div className="qd-setup-head">
            <span className="qd-icon" aria-hidden="true">
              <Tv />
            </span>
            <div className="min-w-0">
              <h1 className="qd-setup-title">{t('tvSetup.title')}</h1>
              <p className="qd-setup-sub">{t(unknown ? 'tvSetup.unknown' : 'tvSetup.intro')}</p>
            </div>
          </div>
          <p className="qd-setup-lead">{t('tvSetup.how')}</p>
          <button
            type="button"
            className="qd-start"
            onClick={() => {
              if (unknown) forgetDisplayKey()
              toSetup()
            }}
            autoFocus
          >
            <LogIn size={22} aria-hidden="true" className="mr-2 inline" />
            {t('tvSetup.signIn')}
          </button>
        </section>
      ) : !data ? (
        <p className="qd-notice" aria-busy="true">
          …
        </p>
      ) : (
        <main className="qd-stage">
          <Banner calls={calls} fresh={freshKeys} t={t} lang={lang} />
          {!busy ? (
            <section className="qd-calm">
              <h2>{t('display.noPatients')}</h2>
              <p>{t('display.noPatientsLead')}</p>
            </section>
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
            <button type="button" className="qd-setup-again" onClick={resetTv}>
              {t('tvSetup.again')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The latest call still waited for as a glowing bar, and the two or three before it in a thin
 * line. A patient the clinician has taken leaves the bar (0160): the bar is for those who have
 * to come.
 */
function Banner({
  calls,
  fresh,
  t,
  lang,
}: {
  calls: Call[]
  fresh: Set<string>
  t: TFixed
  lang: Lang
}) {
  const [latest, ...earlier] = calls.filter((c) => !c.n.started)
  const where = (c: Call) => {
    const desk = deskNameOf(c.desk, t)
    const place = upperFirst(deskPhrase(desk, lang))
    // "Consultation 2" says the desk already; "Room 3" needs it ("Dental — Room 3")
    const room = c.n.room
    if (!room || roomSaysDesk(room, c.desk.station, desk)) return place
    return room.toLowerCase().includes(desk.toLowerCase()) ? room : `${place} — ${room}`
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
              <p className="qd-banner-label">{t('display.nowCalling')}</p>
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
              {room && !roomSaysDesk(room, d.station, name) && (
                <div className="qd-slide-room">{room}</div>
              )}
            </div>
          </div>
          <div>
            <div className="qd-label">{t('display.nowServing')}</div>
            {seen && <div className="qd-slide-ticket num">{seen.ticket}</div>}
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

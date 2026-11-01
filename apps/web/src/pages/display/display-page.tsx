import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Volume2, VolumeX, WifiOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Lang } from '@mmc/shared'
import i18n from '@/i18n'
import { useDisplayBoard, type BoardDesk, type DisplayBoard } from '@/lib/api/display'
import { ApiError } from '@/lib/api/errors'
import { useMediaQuery, useNow } from '@/lib/hooks'
import { usePrefs } from '@/store/prefs'
import { cn } from '@/lib/utils'
import './display.css'

/*
 * The waiting-room screen: a TV at the waiting side (migration 0114). One column per desk with
 * the patient just called in very large type (ticket, full name, "come to Consultation 1 · Dr.
 * X"), the next five waiting (red and yellow first), and a strip of the results ready. Reads
 * the board every 3 seconds; a new call flashes and dings (Web Audio, unlocked by the Start
 * button once). The languages rotate every 6 seconds. Nothing scrolls on a TV.
 */

const LANG_EVERY_MS = 6_000
const FLASH_MS = 6_000
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

  // sound: the manager's switch for the screen, and this TV's own on/off (remembered here)
  const [sound, setSound] = useState(readSound)
  const [started, setStarted] = useState(false)
  const audio = useRef<AudioContext | null>(null)
  const start = () => {
    try {
      const Ctx = window.AudioContext
      if (Ctx && !audio.current) audio.current = new Ctx()
      void audio.current?.resume()
    } catch {
      /* no audio: the screen still works */
    }
    void document.documentElement.requestFullscreen?.().catch(() => undefined)
    setStarted(true)
  }
  const toggleSound = () => {
    const next = !sound
    setSound(next)
    try {
      localStorage.setItem(SOUND_KEY, next ? 'on' : 'off')
    } catch {
      /* not remembered */
    }
  }

  // A new call: an entry of "now" not seen before (or called again). Found while rendering,
  // from the board's content (state derived from a changed prop, as the queue rows' flash):
  // the fresh entries flash, and `stamp` tells the effect below to ding once per new call.
  const nowSig = data
    ? data.desks.flatMap((d) => d.now.map((n) => `${n.id}:${n.calledAt}`)).join('|')
    : null
  const [calls, setCalls] = useState<{
    sig: string | null
    seen: Map<string, string>
    fresh: string[]
    stamp: number
  }>({ sig: null, seen: new Map(), fresh: [], stamp: 0 })
  if (data && calls.sig !== nowSig) {
    const current = new Map<string, string>()
    for (const d of data.desks) for (const n of d.now) current.set(n.id, n.calledAt)
    // the first board read is not a call
    const news =
      calls.sig === null
        ? []
        : Array.from(current)
            .filter(([id, at]) => calls.seen.get(id) !== at)
            .map(([id]) => id)
    setCalls({
      sig: nowSig,
      seen: current,
      fresh: news.length ? news : calls.fresh,
      stamp: news.length ? calls.stamp + 1 : calls.stamp,
    })
  }
  const fresh = new Set(calls.fresh)
  const chimeOn = (data?.chime ?? false) && sound
  const dinged = useRef(0)
  useEffect(() => {
    if (!calls.stamp) return
    if (dinged.current !== calls.stamp) {
      dinged.current = calls.stamp
      if (chimeOn && audio.current) ding(audio.current)
    }
    // the flash ends a few seconds after the call
    const id = window.setTimeout(() => setCalls((c) => ({ ...c, fresh: [] })), FLASH_MS)
    return () => window.clearTimeout(id)
  }, [calls.stamp, chimeOn])

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
        {data?.chime && (
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

type TFixed = ReturnType<typeof i18n.getFixedT>

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
              <span key={n.id} className={cn(fresh.has(n.id) && 'is-new')}>
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

/** The results-ready strip and the clinic's message line. */
function Foot({ data, t }: { data: DisplayBoard; t: TFixed }) {
  if (data.results.length === 0 && !data.message) return null
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
      {data.message && (
        <div className="display-message">
          <span>{data.message}</span>
        </div>
      )}
    </footer>
  )
}

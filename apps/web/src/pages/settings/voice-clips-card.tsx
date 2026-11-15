import { useEffect, useRef, useState } from 'react'
import { Check, Mic, Play, Square, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate } from '@mmc/shared'
import i18n, { ensureLang } from '@/i18n'
import { Hint, IconChip } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Flash } from '@/components/ui/flash'
import { clipUrl, useVoiceClipActions, useVoiceClips } from '@/lib/api/display'
import { STATIONS } from '@/lib/api/visits'
import { CLIP_INTRO, CLIP_STAFF, clipKeyForDesk, deskPhrase } from '@/pages/display/kinyarwanda'
import { cn } from '@/lib/utils'

/** Ten seconds is plenty for one phrase. */
const MAX_MS = 10_000
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** The clock, behind a name (the compiler's purity check reads nowMs() as render work). */
const nowMs = () => Date.now()

/**
 * 0165: the staff's own Kinyarwanda recordings for the waiting-room screen. The call is
 * "Umurwayi witwa {name}, urakenewe muri deparitoma yo gusuzuma, ukenewe na muganga {staff}":
 * a staff member records each fixed piece once — the intro, each desk's "urakenewe muri …",
 * "ukenewe na muganga" — and a screen set to "recorded" plays them, with only the names said
 * by the browser's voice. Recording uses the browser's microphone (MediaRecorder).
 */
export function VoiceClipsCard() {
  const { t } = useTranslation()
  // the Kinyarwanda words of the desks (only the app's own language is loaded at first)
  const [, rwLoaded] = useState(0)
  useEffect(() => {
    void ensureLang('rw').then(() => rwLoaded((n) => n + 1))
  }, [])
  const tr = i18n.getFixedT('rw')
  const { data: clips = [], error: loadError } = useVoiceClips()
  const { save, remove } = useVoiceClipActions()
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // the piece being recorded, and the recording made but not yet saved
  const [recording, setRecording] = useState<string | null>(null)
  const [taken, setTaken] = useState<{ key: string; blob: Blob; ms: number } | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const startedAt = useRef(0)
  const stopTimer = useRef<number | null>(null)
  const player = useRef<HTMLAudioElement | null>(null)
  const canRecord = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  const phrases: { key: string; text: string; title: string }[] = [
    { key: CLIP_INTRO, title: t('voiceClips.phrase.intro'), text: 'Umurwayi witwa …' },
    ...STATIONS.filter((s) => s !== 'beds').map((s) => ({
      key: clipKeyForDesk(s),
      title: t('voiceClips.phrase.desk', { desk: t(`register.stations.${s}`) }),
      text: `… urakenewe muri ${deskPhrase(tr(`register.stations.${s}`), 'rw')} …`,
    })),
    { key: CLIP_STAFF, title: t('voiceClips.phrase.staff'), text: '… ukenewe na muganga …' },
  ]
  const byKey = new Map(clips.map((c) => [c.key, c]))

  const stopStream = () => {
    stream.current?.getTracks().forEach((tr) => tr.stop())
    stream.current = null
  }
  useEffect(() => () => stopStream(), [])

  const start = async (key: string) => {
    setError(null)
    setNotice(null)
    setTaken(null)
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.current = s
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) =>
        MediaRecorder.isTypeSupported(m),
      )
      const r = new MediaRecorder(s, mime ? { mimeType: mime } : undefined)
      chunks.current = []
      r.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data)
      }
      r.onstop = () => {
        const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' })
        setTaken({ key, blob, ms: nowMs() - startedAt.current })
        setRecording(null)
        stopStream()
      }
      recorder.current = r
      startedAt.current = nowMs()
      r.start()
      setRecording(key)
      stopTimer.current = window.setTimeout(() => stop(), MAX_MS)
    } catch (e) {
      setError(t('voiceClips.micDenied', { why: describe(e) }))
      stopStream()
    }
  }
  const stop = () => {
    if (stopTimer.current) window.clearTimeout(stopTimer.current)
    stopTimer.current = null
    const r = recorder.current
    if (r && r.state !== 'inactive') r.stop()
  }
  const play = (src: string) => {
    player.current?.pause()
    const a = new Audio(src)
    player.current = a
    void a.play().catch(() => setError(t('voiceClips.playFailed')))
  }
  const keep = async () => {
    if (!taken) return
    setError(null)
    try {
      await save.mutateAsync({ key: taken.key, blob: taken.blob, durationMs: taken.ms })
      setTaken(null)
      setNotice(t('voiceClips.saved'))
    } catch (e) {
      setError(describe(e))
    }
  }
  const drop = async (key: string) => {
    setError(null)
    try {
      await remove.mutateAsync(key)
      setNotice(t('voiceClips.deleted'))
    } catch (e) {
      setError(describe(e))
    }
  }

  return (
    <Card className="anim-enter">
      <CardHeader hue="navy">
        <span className="flex items-center gap-2.5">
          <IconChip icon={Mic} tint="navy" />
          {t('voiceClips.title')}
        </span>
      </CardHeader>
      <CardBody className="gap-3">
        <p className="text-ink-2 m-0 text-[14px]">{t('voiceClips.lead')}</p>
        {!canRecord && <p className="text-amber m-0 text-[14px]">{t('voiceClips.noRecorder')}</p>}
        {loadError && (
          <p role="alert" className="text-red m-0 text-[14px] font-medium">
            {loadError.message}
          </p>
        )}
        {notice && <Flash onClose={() => setNotice(null)}>{notice}</Flash>}
        {error && (
          <p role="alert" className="text-red m-0 text-[14px] font-medium">
            {error}
          </p>
        )}
        <ul className="m-0 flex list-none flex-col p-0">
          {phrases.map((p) => {
            const have = byKey.get(p.key)
            const url = have ? clipUrl(have.path) : null
            const mine = taken?.key === p.key ? taken : null
            const busy = recording === p.key
            return (
              <li
                key={p.key}
                className="border-grid flex flex-wrap items-center gap-3 border-b py-2.5 last:border-b-0"
              >
                <span className="min-w-[220px] flex-1">
                  <span className="block font-semibold">{p.title}</span>
                  <span className="text-ink-2 block text-[14px]">{p.text}</span>
                  <span className="text-ink-3 block text-[12px]">
                    {have
                      ? t('voiceClips.recordedBy', {
                          name: have.recordedBy ?? '—',
                          date: formatDate(new Date(have.recordedAt)),
                        })
                      : t('voiceClips.none')}
                  </span>
                </span>
                <span className="flex flex-wrap gap-2">
                  {busy ? (
                    <Button size="sm" variant="tint-coral" onClick={stop}>
                      <Square size={14} aria-hidden="true" />
                      {t('voiceClips.stop')}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!canRecord || recording !== null}
                      onClick={() => void start(p.key)}
                    >
                      <Mic size={14} aria-hidden="true" />
                      {t(have || mine ? 'voiceClips.again' : 'voiceClips.record')}
                    </Button>
                  )}
                  {mine && (
                    <>
                      <Button
                        size="sm"
                        variant="tint-grey"
                        onClick={() => play(URL.createObjectURL(mine.blob))}
                      >
                        <Play size={14} aria-hidden="true" />
                        {t('voiceClips.listen')}
                      </Button>
                      <Button
                        size="sm"
                        variant="success"
                        loading={save.isPending}
                        onClick={() => void keep()}
                      >
                        <Check size={14} aria-hidden="true" />
                        {t('voiceClips.keep')}
                      </Button>
                    </>
                  )}
                  {!mine && url && (
                    <Button size="sm" variant="tint-grey" onClick={() => play(url)}>
                      <Play size={14} aria-hidden="true" />
                      {t('voiceClips.listen')}
                    </Button>
                  )}
                  {have && !mine && (
                    <Button
                      size="sm"
                      variant="tint-coral"
                      loading={remove.isPending && remove.variables === p.key}
                      onClick={() => void drop(p.key)}
                      aria-label={t('voiceClips.delete')}
                      title={t('voiceClips.delete')}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </Button>
                  )}
                </span>
                {busy && (
                  <span className={cn('text-red basis-full text-[13px] font-semibold')}>
                    {t('voiceClips.recording')}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
        <Hint>{t('voiceClips.hint')}</Hint>
      </CardBody>
    </Card>
  )
}

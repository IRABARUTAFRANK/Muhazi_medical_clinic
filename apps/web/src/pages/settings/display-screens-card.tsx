import { useState } from 'react'
import { Check, CircleAlert, Copy, MonitorPlay, Plus, Tv, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LANGS, formatDate, type Lang } from '@mmc/shared'
import { Hint, IconChip } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, controlClass, labelClass } from '@/components/ui/field'
import { Flash } from '@/components/ui/flash'
import {
  displayLink,
  useDisplayScreenActions,
  useDisplayScreens,
  VOICE_LANGS,
  VOICE_REPEATS,
  type DisplayScreen,
  type DisplayScreenInput,
  type VoiceLang,
} from '@/lib/api/display'
import { ApiError } from '@/lib/api/errors'
import { STATIONS, type Station } from '@/lib/api/visits'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'

/** The desks a TV can show (not the beds). */
const DESK_CHOICES: readonly Station[] = STATIONS.filter((s) => s !== 'beds')
const SCREEN_ERRORS = [
  'screen_name',
  'screen_desk',
  'screen_language',
  'screen_message',
  'screen_unknown',
  'screen_voice_lang',
  'screen_voice_repeat',
]

const emptyDraft = (): DisplayScreenInput => ({
  name: '',
  desks: [],
  showNames: true,
  chime: true,
  languages: ['rw', 'en', 'fr'],
  message: '',
  voice: true,
  voiceLang: 'en',
  voiceRepeat: 2,
  ticker: true,
})

/**
 * Settings › Display › Waiting-room screens (manager, migration 0114): the TVs at the waiting
 * side. Each screen has a name, the desks it shows, whether it shows full names, whether it
 * dings, its languages and a message line. Creating one gives its link ONCE (the key is kept as
 * a hash); the link is opened on the TV. Revoking a screen ends its link.
 */
export function DisplayScreensCard() {
  const { t } = useTranslation()
  const { data: screens = [], error: loadError } = useDisplayScreens()
  const { save, revoke } = useDisplayScreenActions()
  const confirm = useConfirm()
  const [draft, setDraft] = useState<DisplayScreenInput | null>(null)
  const [link, setLink] = useState<{ name: string; url: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const describe = (e: unknown) =>
    e instanceof ApiError && e.hint && SCREEN_ERRORS.includes(e.hint)
      ? t(`displayScreens.errors.${e.hint}`)
      : e instanceof Error
        ? e.message
        : String(e)

  const submit = async () => {
    if (!draft) return
    setError(null)
    setNotice(null)
    if (!draft.name.trim()) return setError(t('displayScreens.errors.screen_name'))
    if (draft.languages.length === 0) return setError(t('displayScreens.errors.screen_language'))
    const k = draft.id ? 'confirm.display.save' : 'confirm.display.create'
    if (
      !(await confirm({
        title: t(`${k}.title`, { name: draft.name.trim() }),
        body: t(`${k}.body`),
        confirmLabel: t(`${k}.yes`),
      }))
    )
      return
    try {
      // the desks in the order of the clinic's path (reception, triage, consultation…)
      const r = await save.mutateAsync({
        ...draft,
        name: draft.name.trim(),
        desks: DESK_CHOICES.filter((d) => draft.desks.includes(d)),
      })
      setDraft(null)
      if (r.key) setLink({ name: draft.name.trim(), url: displayLink(r.key) })
      else setNotice(t('displayScreens.saved'))
    } catch (e) {
      setError(describe(e))
    }
  }
  const doRevoke = async (s: DisplayScreen) => {
    setError(null)
    setNotice(null)
    if (
      !(await confirm({
        title: t('confirm.display.revoke.title', { name: s.name }),
        body: t('confirm.display.revoke.body'),
        confirmLabel: t('confirm.display.revoke.yes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await revoke.mutateAsync(s.id)
      setNotice(t('displayScreens.revokedDone'))
    } catch (e) {
      setError(describe(e))
    }
  }
  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link.url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2500)
    } catch {
      /* the link stays selectable in the box */
    }
  }
  const toggleIn = <T,>(list: T[], v: T) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
  const deskName = (s: string) => t(`register.stations.${s}`, { defaultValue: s })
  const checkRow = 'flex items-center gap-2 text-[14px] cursor-pointer'

  return (
    <Card className="anim-enter">
      <CardHeader hue="navy">
        <span className="flex items-center gap-2.5">
          <IconChip icon={Tv} tint="navy" />
          {t('displayScreens.title')}
        </span>
        {!draft && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setLink(null)
              setDraft(emptyDraft())
            }}
          >
            <Plus size={16} aria-hidden="true" />
            {t('displayScreens.add')}
          </Button>
        )}
      </CardHeader>
      <CardBody className="gap-3">
        <p className="text-ink-2 m-0 text-[14px]">{t('displayScreens.lead')}</p>
        {loadError && (
          <p role="alert" className="text-red m-0 text-[14px] font-medium">
            {loadError.message}
          </p>
        )}

        {/* the link, once */}
        {link && (
          <div className="border-green/40 bg-green-bg/50 flex flex-col gap-2 rounded-md border px-3 py-3">
            <span className="text-green inline-flex items-center gap-2 text-[15px] font-bold">
              <MonitorPlay size={18} aria-hidden="true" />
              {t('displayScreens.linkTitle', { name: link.name })}
            </span>
            <p className="text-ink-2 m-0 text-[14px]">{t('displayScreens.linkLead')}</p>
            <code className="bg-card border-border block rounded-md border px-3 py-2 text-[13px] break-all select-all">
              {link.url}
            </code>
            <span className="text-ink-3 text-[13px]">{t('displayScreens.openOnTv')}</span>
            <span className="flex flex-wrap gap-2">
              <Button size="sm" variant="success" onClick={() => void copy()}>
                {copied ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <Copy size={14} aria-hidden="true" />
                )}
                {t(copied ? 'displayScreens.copied' : 'displayScreens.copy')}
              </Button>
              <Button size="sm" variant="tint-grey" onClick={() => setLink(null)}>
                <X size={14} aria-hidden="true" />
                {t('common.close')}
              </Button>
            </span>
          </div>
        )}

        {/* add or change a screen */}
        {draft && (
          <form
            className="border-primary/30 bg-surface flex flex-col gap-3 rounded-md border px-3 py-3"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <Field
              label={t('displayScreens.name')}
              placeholder={t('displayScreens.namePh')}
              value={draft.name}
              maxLength={60}
              required
              autoFocus
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
              <legend className={cn(labelClass, 'mb-1')}>{t('displayScreens.desks')}</legend>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
                {DESK_CHOICES.map((s) => (
                  <label key={s} className={checkRow}>
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={draft.desks.includes(s)}
                      onChange={() => setDraft({ ...draft, desks: toggleIn(draft.desks, s) })}
                    />
                    {deskName(s)}
                  </label>
                ))}
              </div>
              <span className="text-ink-3 text-[13px]">{t('displayScreens.desksHint')}</span>
            </fieldset>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className={checkRow}>
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={draft.showNames}
                  onChange={(e) => setDraft({ ...draft, showNames: e.target.checked })}
                />
                {t('displayScreens.showNames')}
              </label>
              <label className={checkRow}>
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={draft.chime}
                  onChange={(e) => setDraft({ ...draft, chime: e.target.checked })}
                />
                {t('displayScreens.chime')}
              </label>
            </div>
            <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
              <legend className={cn(labelClass, 'mb-1')}>{t('displayScreens.languages')}</legend>
              <div className="flex flex-wrap gap-3">
                {LANGS.map((l) => (
                  <label key={l.code} className={checkRow}>
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={draft.languages.includes(l.code)}
                      onChange={() =>
                        setDraft({ ...draft, languages: toggleIn<Lang>(draft.languages, l.code) })
                      }
                    />
                    {l.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className={labelClass}>
              {t('displayScreens.message')}
              <input
                className={cn(controlClass, 'w-full font-normal')}
                placeholder={t('displayScreens.messagePh')}
                value={draft.message}
                maxLength={300}
                onChange={(e) => setDraft({ ...draft, message: e.target.value })}
              />
            </label>
            {/* the voice (0118): the browser says the call after the chime; and the scrolling line */}
            <div className="border-border flex flex-col gap-2 border-t pt-3">
              <label className={checkRow}>
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={draft.voice}
                  onChange={(e) => setDraft({ ...draft, voice: e.target.checked })}
                />
                {t('displayScreens.voice')}
              </label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className={labelClass}>
                  {t('displayScreens.voiceLang')}
                  <select
                    className={cn(controlClass, 'w-full font-normal')}
                    value={draft.voiceLang}
                    disabled={!draft.voice}
                    onChange={(e) => setDraft({ ...draft, voiceLang: e.target.value as VoiceLang })}
                  >
                    {VOICE_LANGS.map((l) => (
                      <option key={l} value={l}>
                        {t(`displayScreens.voiceLangs.${l}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={labelClass}>
                  {t('displayScreens.voiceRepeat')}
                  <select
                    className={cn(controlClass, 'w-full font-normal')}
                    value={draft.voiceRepeat}
                    disabled={!draft.voice}
                    onChange={(e) => setDraft({ ...draft, voiceRepeat: Number(e.target.value) })}
                  >
                    {VOICE_REPEATS.map((n) => (
                      <option key={n} value={n}>
                        {t('displayScreens.voiceTimes', { count: n })}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <span className="text-ink-3 text-[13px]">{t('displayScreens.voiceLangHint')}</span>
              <label className={checkRow}>
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={draft.ticker}
                  onChange={(e) => setDraft({ ...draft, ticker: e.target.checked })}
                />
                {t('displayScreens.ticker')}
              </label>
            </div>
            {error && (
              <p
                role="alert"
                className="text-red m-0 inline-flex items-start gap-2 text-[14px] font-medium"
              >
                <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
                {error}
              </p>
            )}
            <span className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" loading={save.isPending}>
                {!save.isPending && <Check size={16} aria-hidden="true" />}
                {t(draft.id ? 'displayScreens.saveChanges' : 'displayScreens.save')}
              </Button>
              <Button type="button" variant="tint-grey" onClick={() => setDraft(null)}>
                {t('common.close')}
              </Button>
            </span>
          </form>
        )}

        {!draft && error && (
          <p
            role="alert"
            className="text-red m-0 inline-flex items-start gap-2 text-[14px] font-medium"
          >
            <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
            {error}
          </p>
        )}
        {notice && <Flash onClose={() => setNotice(null)}>{notice}</Flash>}

        {/* the screens */}
        {screens.length === 0 ? (
          <p className="text-ink-3 m-0 text-[14px]">{t('displayScreens.none')}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {screens.map((s) => (
              <li
                key={s.id}
                className="border-grid flex flex-wrap items-center gap-3 border-b py-2.5 last:border-b-0"
              >
                <span className="min-w-[200px] flex-1">
                  <span className="flex flex-wrap items-center gap-2 font-semibold">
                    {s.name}
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[12px] font-semibold',
                        s.active ? 'bg-green-bg text-green' : 'bg-hover text-ink-3',
                      )}
                    >
                      {t(s.active ? 'displayScreens.active' : 'displayScreens.revoked')}
                    </span>
                  </span>
                  <span className="text-ink-3 block text-[13px]">
                    {[
                      s.desks.length
                        ? s.desks.map(deskName).join(', ')
                        : t('displayScreens.allDesks'),
                      t(s.showNames ? 'displayScreens.names' : 'displayScreens.ticketsOnly'),
                      t(s.chime ? 'displayScreens.withChime' : 'displayScreens.noChime'),
                      s.voice
                        ? t('displayScreens.voiceOn', {
                            lang: t(`displayScreens.voiceLangs.${s.voiceLang}`),
                            count: s.voiceRepeat,
                          })
                        : t('displayScreens.voiceOff'),
                      t(s.ticker ? 'displayScreens.tickerOn' : 'displayScreens.tickerOff'),
                      s.languages.map((l) => l.toUpperCase()).join(' · '),
                      s.message ? `“${s.message}”` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className="text-ink-3 block text-[12px]">
                    {t('displayScreens.createdBy', {
                      name: s.createdBy ?? '—',
                      date: formatDate(new Date(s.createdAt)),
                    })}
                  </span>
                </span>
                {s.active && (
                  <span className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="tint-blue"
                      onClick={() => {
                        setLink(null)
                        setError(null)
                        setDraft({
                          id: s.id,
                          name: s.name,
                          desks: s.desks,
                          showNames: s.showNames,
                          chime: s.chime,
                          languages: s.languages,
                          message: s.message ?? '',
                          voice: s.voice ?? true,
                          voiceLang: s.voiceLang ?? 'en',
                          voiceRepeat: s.voiceRepeat ?? 2,
                          ticker: s.ticker ?? true,
                        })
                      }}
                    >
                      {t('displayScreens.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="tint-coral"
                      loading={revoke.isPending && revoke.variables === s.id}
                      onClick={() => void doRevoke(s)}
                    >
                      {t('displayScreens.revoke')}
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <Hint>{t('displayScreens.hint')}</Hint>
      </CardBody>
    </Card>
  )
}

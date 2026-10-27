import { useState, type FormEvent } from 'react'
import { Activity, ClipboardPen, Lock, Send } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser, Triage } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { useVisitHeader, type Vital } from '@/lib/api/billing'
import { ApiError } from '@/lib/api/errors'
import { useConfirm } from '@/lib/confirm'
import { SEND_FROM_TRIAGE, useVisitActions, useVitalsTakers, type Station } from '@/lib/api/visits'
import { formatTime } from '@mmc/shared'
import { cn } from '@/lib/utils'

/**
 * Vital signs, in the order the nurse takes them, with the values a living patient can have
 * (newborn to adult, critically ill included): outside them it is a typing mistake (450 mmHg,
 * 67 °C) and the form refuses it.
 */
const VITALS = [
  { key: 'bp_sys', unit: 'mmHg', placeholder: '120', min: 40, max: 300 },
  { key: 'bp_dia', unit: 'mmHg', placeholder: '80', min: 20, max: 200 },
  { key: 'pulse', unit: 'bpm', placeholder: '72', min: 20, max: 250 },
  { key: 'temp', unit: '°C', placeholder: '36.8', min: 30, max: 44 },
  { key: 'resp', unit: '/min', placeholder: '16', min: 4, max: 100 },
  { key: 'spo2', unit: '%', placeholder: '98', min: 40, max: 100 },
  { key: 'weight', unit: 'kg', placeholder: '65', min: 0.3, max: 350 },
  { key: 'height', unit: 'cm', placeholder: '170', min: 20, max: 250 },
  { key: 'muac', unit: 'cm', placeholder: '', min: 5, max: 60 },
] as const
type VitalKey = (typeof VITALS)[number]['key']
const LEVELS: readonly Triage[] = ['red', 'yellow', 'green']
/** Roles who measure themselves; anyone else types in what a nurse measured. */
const MEASURERS = ['nurse', 'doctor', 'manager']
/** The server's answer when this person may not send the patient on (another nurse's patient). */
const REFUSED = /this patient is with|not allowed|may not|only the (nurse|triage)|another nurse/i

const pad = (n: number) => String(n).padStart(2, '0')
const nowHHMM = () => {
  const d = new Date()
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
/** Later than now (5 minutes of clock difference allowed). */
const inFuture = (iso: string) => new Date(iso).getTime() > Date.now() + 5 * 60_000
/** Today at HH:MM as an ISO timestamp (the paper sheet gives the time of day). */
const todayAt = (hhmm: string): string | null => {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const d = new Date()
  d.setHours(Number(m[1]), Number(m[2]), 0, 0)
  return d.toISOString()
}

/**
 * First measurements. Clinic practice: the nurse measures first; when she has no device at
 * hand she writes on paper and the receptionist or the doctor types the figures in. So the
 * form always says who measured and when, separately from who is typing.
 *
 * mode "triage": also the triage colour and the next station (closes the triage turn).
 * mode "add": measurements only (e.g. the doctor typing the nurse's sheet later).
 *
 * Only the nurse who has the patient sends them on. Reception typing the nurse's paper sheet once
 * the patient has left reception, or anyone the server refuses, records the measurements only.
 */
export function VitalsForm({
  user,
  encounterId,
  title,
  subtitle,
  mode,
  station,
  mayRoute = true,
  lockedNote,
  defaultNext = 'consultation',
  missing,
  existing = [],
  onSaved,
  onCancel,
}: {
  user: StaffUser
  /** Vitals already measured for this visit: shown as taken, changed only to correct them. */
  existing?: Vital[]
  encounterId: string
  title: string
  subtitle?: string
  mode: 'triage' | 'add'
  /** Where the patient waits now (reception sends on only a patient still at reception). */
  station?: Station
  /** False when this person may not send the patient on: measurements only. */
  mayRoute?: boolean
  /** Set when the patient is another nurse's: the form is shown read only, with this note. */
  lockedNote?: string | null
  /** Where the patient goes after triage: reception when the file is still incomplete. */
  defaultNext?: Station
  /** File details reception still has to take (shown next to "Send to"). */
  missing?: string[]
  onSaved: (ticket: string, station: Station | null) => void
  onCancel?: () => void
}) {
  const { t } = useTranslation()
  const actions = useVisitActions()
  const { data: takers = [] } = useVitalsTakers()
  const measuresSelf = MEASURERS.includes(user.role)
  const initial = Object.fromEntries(
    VITALS.map((v) => [v.key, String(existing.find((e) => e.code === v.key)?.value ?? '')]),
  ) as Record<VitalKey, string>
  const [values, setValues] = useState<Record<VitalKey, string>>(initial)
  const taken = existing.length > 0
  const latest = existing.reduce<Vital | null>((a, v) => (!a || v.at > a.at ? v : a), null)
  const changedKeys = (Object.keys(values) as VitalKey[]).filter(
    (k) => values[k].trim() !== initial[k].trim(),
  )
  // The server refused to send the patient on (they are another nurse's, or reception already
  // sent them on): the measurements are still saved, the nurse sends the patient on.
  const [refused, setRefused] = useState<string | null>(null)
  const measureOnly =
    mode === 'triage' &&
    (!mayRoute || refused !== null || (user.role === 'receptionist' && station !== 'reception'))
  const sends = mode === 'triage' && !measureOnly
  const sendOnOnly = sends && taken && changedKeys.length === 0
  const [level, setLevel] = useState<Triage>('green')
  // First measurements of a patient who skipped the triage desk: the colour is still given
  // (it orders every queue); the patient stays at their desk.
  const colourOnly = mode === 'add' && !taken
  const [colourSet, setColourSet] = useState(false)
  const [next, setNext] = useState<Station>(defaultNext)
  const [reason, setReason] = useState('')
  // "Measured by": me when I measure; otherwise the nurse who wrote the paper sheet.
  const [measuredBy, setMeasuredBy] = useState<string>(measuresSelf ? 'me' : '')
  const [measuredAt, setMeasuredAt] = useState(nowHHMM)
  const [error, setError] = useState<string | null>(null)
  const fromPaper = measuredBy !== 'me'
  const others = takers.filter((p) => p.id !== user.id)
  const confirm = useConfirm()
  // the patient's name for the question asked before saving (cached on the visit page)
  const { data: header } = useVisitHeader(encounterId)
  const patient = header?.name || t('confirm.visit.thisPatient')
  const ask = (title: string, body: string, yes: string) =>
    confirm({ title, body, confirmLabel: yes })
  const sendBody = () =>
    t('confirm.visit.vitalsSendBody', {
      level: t(`home.triage.${level}`),
      desk: t(`register.stations.${next}`),
    })

  /** A refusal to send on: switch to measurements only; any other error is shown as it is. */
  const failed = (err: unknown, sending: boolean) => {
    const message = err instanceof Error ? err.message : ''
    // The "Measured by" list cannot leave out a nurse whose right the manager switched off
    // (vitals_takers does not know it): the refusal names the person chosen instead.
    const server = err instanceof ApiError ? err.serverMessage : message
    if (/"measured by" is not allowed/i.test(server))
      return setError(
        t('vitalsForm.errors.takerNotAllowed', {
          name: others.find((p) => p.id === measuredBy)?.name ?? '',
        }),
      )
    if (sending && REFUSED.test(message)) setRefused(message)
    else setError(t('triage.errors.generic', { message }))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (lockedNote) return
    if (sendOnOnly) {
      if (
        !(await ask(
          t('confirm.visit.vitalsSendOn', {
            name: patient,
            desk: t(`register.stations.${next}`),
          }),
          sendBody(),
          t('confirm.visit.sendYes'),
        ))
      )
        return
      try {
        const ticket = await actions.sendFromTriage.mutateAsync({
          encounterId,
          triage: level,
          nextStation: next,
          reason,
        })
        onSaved(ticket, next)
      } catch (err) {
        failed(err, true)
      }
      return
    }
    if (taken && changedKeys.length === 0) return setError(t('vitalsForm.errors.nothingChanged'))
    if (!Object.values(values).some((v) => v.trim() !== ''))
      return setError(t('triage.errors.noVitals'))
    // a number that no patient can have is a typing mistake
    for (const v of VITALS) {
      const raw = values[v.key].trim().replace(',', '.')
      if (raw === '') continue
      const n = Number(raw)
      if (!Number.isFinite(n) || n < v.min || n > v.max)
        return setError(
          t('vitalsForm.errors.range', {
            name: t(`triage.vitals.${v.key}`),
            value: values[v.key].trim(),
            unit: v.unit,
            min: v.min,
            max: v.max,
          }),
        )
    }
    if (
      values.bp_sys.trim() &&
      values.bp_dia.trim() &&
      Number(values.bp_dia.replace(',', '.')) >= Number(values.bp_sys.replace(',', '.'))
    )
      return setError(t('vitalsForm.errors.bpOrder'))
    if (!measuredBy) return setError(t('vitalsForm.errors.who'))
    const at = todayAt(measuredAt)
    if (!at) return setError(t('vitalsForm.errors.time'))
    if (inFuture(at)) return setError(t('vitalsForm.errors.future'))
    const who = fromPaper ? (others.find((p) => p.id === measuredBy)?.name ?? '') : user.name
    const measured = t('confirm.visit.vitalsBody', { who, time: measuredAt })
    if (
      !(await (sends
        ? ask(
            t('confirm.visit.vitalsSend', {
              name: patient,
              desk: t(`register.stations.${next}`),
            }),
            `${measured} ${sendBody()}`,
            t('confirm.visit.vitalsSendYes'),
          )
        : ask(
            t(taken ? 'confirm.visit.vitalsCorrect' : 'confirm.visit.vitalsSave', {
              name: patient,
            }),
            measured,
            t('confirm.visit.saveYes'),
          )))
    )
      return
    try {
      const ticket = await actions.recordVitals.mutateAsync({
        encounterId,
        // Once taken, only the corrected values are saved again.
        vitals: taken
          ? (Object.fromEntries(changedKeys.map((k) => [k, values[k]])) as Record<string, string>)
          : values,
        triage: sends || (colourOnly && colourSet) ? level : null,
        nextStation: sends ? next : null,
        reason: sends ? reason : '',
        measuredBy: fromPaper ? measuredBy : null,
        measuredAt: at,
      })
      onSaved(ticket, sends ? next : null)
    } catch (err) {
      failed(err, sends)
    }
  }

  return (
    <Card className={cn(mode === 'add' && 'border-primary')}>
      <CardHeader hue="mint">
        <span className="inline-flex items-center gap-2">
          <Activity size={16} aria-hidden="true" />
          {title}
        </span>
        {subtitle && <span className="text-ink-3 text-xs tabular-nums">{subtitle}</span>}
      </CardHeader>
      <form onSubmit={submit}>
        <CardBody className="gap-4">
          {lockedNote && (
            <p className="bg-violet-bg text-violet border-violet/30 m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-[13px] font-semibold">
              <Lock size={16} aria-hidden="true" className="mt-px flex-none" />
              {lockedNote}
            </p>
          )}
          {!lockedNote && measureOnly && (
            <p className="bg-amber-bg text-amber border-amber/30 m-0 flex flex-wrap items-start gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-[13px] font-semibold">
              {refused && (
                <span className="basis-full">
                  {t('vitalsForm.notSentOn', { message: refused })}
                </span>
              )}
              <span className="text-ink-2 font-normal">{t('vitalsForm.nurseSendsOn')}</span>
            </p>
          )}
          {/* read only while the patient is another nurse's */}
          <fieldset
            disabled={!!lockedNote}
            className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
          >
            {taken && (
              <p className="bg-green-bg text-green border-green/30 m-0 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-[13px] font-semibold">
                <Activity size={16} aria-hidden="true" />
                {latest?.measuredBy
                  ? t('vitalsForm.taken', {
                      name: latest.measuredBy,
                      time: formatTime(new Date(latest.at)),
                    })
                  : t('vitalsForm.takenAt', {
                      time: latest ? formatTime(new Date(latest.at)) : '',
                    })}
                <span className="text-ink-2 basis-full font-normal">
                  {t('vitalsForm.takenHint')}
                </span>
              </p>
            )}
            {/* Who measured and when (the paper sheet case) */}
            <div
              className={cn(
                // minmax(0, …): long nurse names must not push "Measured at" past the card edge.
                'grid min-w-0 grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-[minmax(0,2fr)_minmax(140px,1fr)]',
                fromPaper ? 'border-amber/40 bg-amber-bg/50' : 'border-border',
              )}
            >
              <Select
                label={t('vitalsForm.measuredBy')}
                value={measuredBy}
                onChange={(e) => setMeasuredBy(e.target.value)}
                wrapperClassName="min-w-0"
                className="w-full min-w-0 truncate"
                required
              >
                {!measuresSelf && <option value="">{t('vitalsForm.pickNurse')}</option>}
                {measuresSelf && (
                  <option value="me">{t('vitalsForm.me', { name: user.name })}</option>
                )}
                {others.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.staffId ? ` · ${p.staffId}` : ''} ·{' '}
                    {t(`roles.${p.role}`, { defaultValue: p.role })}
                  </option>
                ))}
              </Select>
              <Field
                label={t('vitalsForm.measuredAt')}
                type="time"
                value={measuredAt}
                onChange={(e) => setMeasuredAt(e.target.value)}
                wrapperClassName="min-w-0"
                className="w-full min-w-0"
                required
              />
              <p className="text-ink-2 col-span-full m-0 inline-flex items-start gap-1.5 text-xs">
                <ClipboardPen size={14} aria-hidden="true" className="mt-px flex-none" />
                {fromPaper ? t('vitalsForm.paperHint') : t('vitalsForm.selfHint')}
              </p>
            </div>

            <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3">
              {VITALS.map((v) => (
                <Field
                  key={v.key}
                  label={`${t(`triage.vitals.${v.key}`)} (${v.unit})`}
                  inputMode="decimal"
                  placeholder={v.placeholder}
                  value={values[v.key]}
                  onChange={(e) => setValues((s) => ({ ...s, [v.key]: e.target.value }))}
                />
              ))}
            </div>

            {colourOnly && (
              <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                <legend className="text-ink-2 mb-1.5 text-[13px] font-semibold">
                  {t('triage.levelOptional')}
                </legend>
                <div className="flex flex-wrap gap-2">
                  {LEVELS.map((l) => (
                    <label
                      key={l}
                      className={cn(
                        'border-border flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-3 font-semibold',
                        colourSet && level === l && 'border-primary bg-primary-tint',
                      )}
                    >
                      <input
                        type="radio"
                        name="triage"
                        className="accent-primary"
                        checked={colourSet && level === l}
                        onChange={() => {
                          setLevel(l)
                          setColourSet(true)
                        }}
                      />
                      <Badge tone={l}>{t(`home.triage.${l}`)}</Badge>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {sends && (
              <>
                <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                  <legend className="text-ink-2 mb-1.5 text-[13px] font-semibold">
                    {t('triage.level')}
                  </legend>
                  <div className="flex flex-wrap gap-2">
                    {LEVELS.map((l) => (
                      <label
                        key={l}
                        className={cn(
                          'border-border flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-3 font-semibold',
                          level === l && 'border-primary bg-primary-tint',
                        )}
                      >
                        <input
                          type="radio"
                          name="triage"
                          className="accent-primary"
                          checked={level === l}
                          onChange={() => setLevel(l)}
                        />
                        <Badge tone={l}>{t(`home.triage.${l}`)}</Badge>
                        <span className="text-ink-2 text-xs font-normal">
                          {t(`triage.levels.${l}`)}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Select
                    label={t('triage.nextStation')}
                    value={next}
                    onChange={(e) => setNext(e.target.value as Station)}
                  >
                    {SEND_FROM_TRIAGE.map((s) => (
                      <option key={s} value={s}>
                        {t(`register.stations.${s}`)}
                      </option>
                    ))}
                  </Select>
                  <Field
                    label={t('triage.reason')}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={t('triage.reasonPh')}
                  />
                  {missing && missing.length > 0 && (
                    <p className="text-amber bg-amber-bg col-span-full m-0 rounded-md px-3 py-2 text-xs font-semibold">
                      {t(next === 'reception' ? 'files.sendToReception' : 'files.stillMissing', {
                        missing: missing.map((m) => t(`files.missing.${m}`)).join(', '),
                      })}
                    </p>
                  )}
                </div>
              </>
            )}
          </fieldset>

          {error && (
            <p
              role="alert"
              className="bg-red-bg text-red border-red/30 m-0 rounded-md border px-3 py-2 text-[13px] font-semibold"
            >
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {!lockedNote && (
              <Button
                type="submit"
                variant="primary"
                size="lg"
                loading={actions.recordVitals.isPending || actions.sendFromTriage.isPending}
              >
                <Send size={18} aria-hidden="true" />
                {t(sendOnOnly ? 'vitalsForm.sendOn' : sends ? 'triage.send' : 'vitalsForm.save')}
              </Button>
            )}
            {onCancel && (
              <Button type="button" variant="ghost" size="lg" onClick={onCancel}>
                {t('staff.form.cancel')}
              </Button>
            )}
          </div>
        </CardBody>
      </form>
    </Card>
  )
}

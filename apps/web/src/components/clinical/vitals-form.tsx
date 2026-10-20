import { useState, type FormEvent } from 'react'
import { Activity, ClipboardPen, Send } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser, Triage } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import type { Vital } from '@/lib/api/billing'
import { SEND_FROM_TRIAGE, useVisitActions, useVitalsTakers, type Station } from '@/lib/api/visits'
import { formatTime } from '@mmc/shared'
import { cn } from '@/lib/utils'

/** Vital signs, in the order the nurse takes them. */
const VITALS = [
  { key: 'bp_sys', unit: 'mmHg', placeholder: '120' },
  { key: 'bp_dia', unit: 'mmHg', placeholder: '80' },
  { key: 'pulse', unit: 'bpm', placeholder: '72' },
  { key: 'temp', unit: '°C', placeholder: '36.8' },
  { key: 'resp', unit: '/min', placeholder: '16' },
  { key: 'spo2', unit: '%', placeholder: '98' },
  { key: 'weight', unit: 'kg', placeholder: '65' },
  { key: 'height', unit: 'cm', placeholder: '170' },
  { key: 'muac', unit: 'cm', placeholder: '' },
] as const
type VitalKey = (typeof VITALS)[number]['key']
const LEVELS: readonly Triage[] = ['red', 'yellow', 'green']
/** Roles who measure themselves; anyone else types in what a nurse measured. */
const MEASURERS = ['nurse', 'doctor', 'manager']

const pad = (n: number) => String(n).padStart(2, '0')
const nowHHMM = () => {
  const d = new Date()
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
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
 */
export function VitalsForm({
  user,
  encounterId,
  title,
  subtitle,
  mode,
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
  const sendOnOnly = mode === 'triage' && taken && changedKeys.length === 0
  const [level, setLevel] = useState<Triage>('green')
  const [next, setNext] = useState<Station>(defaultNext)
  const [reason, setReason] = useState('')
  // "Measured by": me when I measure; otherwise the nurse who wrote the paper sheet.
  const [measuredBy, setMeasuredBy] = useState<string>(measuresSelf ? 'me' : '')
  const [measuredAt, setMeasuredAt] = useState(nowHHMM)
  const [error, setError] = useState<string | null>(null)
  const fromPaper = measuredBy !== 'me'
  const others = takers.filter((p) => p.id !== user.id)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (sendOnOnly) {
      try {
        const ticket = await actions.sendFromTriage.mutateAsync({
          encounterId,
          triage: level,
          nextStation: next,
          reason,
        })
        onSaved(ticket, next)
      } catch (err) {
        setError(t('triage.errors.generic', { message: err instanceof Error ? err.message : '' }))
      }
      return
    }
    if (taken && changedKeys.length === 0) return setError(t('vitalsForm.errors.nothingChanged'))
    if (!Object.values(values).some((v) => v.trim() !== ''))
      return setError(t('triage.errors.noVitals'))
    if (!measuredBy) return setError(t('vitalsForm.errors.who'))
    const at = todayAt(measuredAt)
    if (!at) return setError(t('vitalsForm.errors.time'))
    if (new Date(at).getTime() > Date.now() + 5 * 60_000)
      return setError(t('vitalsForm.errors.future'))
    try {
      const ticket = await actions.recordVitals.mutateAsync({
        encounterId,
        // Once taken, only the corrected values are saved again.
        vitals: taken
          ? (Object.fromEntries(changedKeys.map((k) => [k, values[k]])) as Record<string, string>)
          : values,
        triage: mode === 'triage' ? level : null,
        nextStation: mode === 'triage' ? next : null,
        reason,
        measuredBy: fromPaper ? measuredBy : null,
        measuredAt: at,
      })
      onSaved(ticket, mode === 'triage' ? next : null)
    } catch (err) {
      setError(t('triage.errors.generic', { message: err instanceof Error ? err.message : '' }))
    }
  }

  return (
    <Card className={cn(mode === 'add' && 'border-primary')}>
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <Activity size={16} aria-hidden="true" />
          {title}
        </span>
        {subtitle && <span className="text-ink-3 text-xs tabular-nums">{subtitle}</span>}
      </CardHeader>
      <form onSubmit={submit}>
        <CardBody className="gap-4">
          {taken && (
            <p className="bg-green-bg text-green m-0 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl px-3 py-2 text-[13px] font-semibold">
              <Activity size={16} aria-hidden="true" />
              {latest?.measuredBy
                ? t('vitalsForm.taken', {
                    name: latest.measuredBy,
                    time: formatTime(new Date(latest.at)),
                  })
                : t('vitalsForm.takenAt', { time: latest ? formatTime(new Date(latest.at)) : '' })}
              <span className="text-ink-2 basis-full font-normal">{t('vitalsForm.takenHint')}</span>
            </p>
          )}
          {/* Who measured and when (the paper sheet case) */}
          <div
            className={cn(
              // minmax(0, …): long nurse names must not push "Measured at" past the card edge.
              'grid min-w-0 grid-cols-1 gap-3 rounded-xl border p-3 sm:grid-cols-[minmax(0,2fr)_minmax(140px,1fr)]',
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

          {mode === 'triage' && (
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
                        'border-border flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 font-semibold',
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
                  <p className="text-amber bg-amber-bg col-span-full m-0 rounded-lg px-3 py-2 text-xs font-semibold">
                    {t(next === 'reception' ? 'files.sendToReception' : 'files.stillMissing', {
                      missing: missing.map((m) => t(`files.missing.${m}`)).join(', '),
                    })}
                  </p>
                )}
              </div>
            </>
          )}

          {error && (
            <p
              role="alert"
              className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
            >
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={actions.recordVitals.isPending || actions.sendFromTriage.isPending}
            >
              <Send size={18} aria-hidden="true" />
              {t(
                sendOnOnly
                  ? 'vitalsForm.sendOn'
                  : mode === 'triage'
                    ? 'triage.send'
                    : 'vitalsForm.save',
              )}
            </Button>
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

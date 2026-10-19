import { useState, type FormEvent } from 'react'
import { Activity, ClipboardPen, Send } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser, Triage } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { TREATING_STATIONS, useVisitActions, useVitalsTakers, type Station } from '@/lib/api/visits'
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
  onSaved,
  onCancel,
}: {
  user: StaffUser
  encounterId: string
  title: string
  subtitle?: string
  mode: 'triage' | 'add'
  onSaved: (ticket: string, station: Station | null) => void
  onCancel?: () => void
}) {
  const { t } = useTranslation()
  const actions = useVisitActions()
  const { data: takers = [] } = useVitalsTakers()
  const measuresSelf = MEASURERS.includes(user.role)
  const [values, setValues] = useState<Record<VitalKey, string>>({
    bp_sys: '',
    bp_dia: '',
    pulse: '',
    temp: '',
    resp: '',
    spo2: '',
    weight: '',
    height: '',
    muac: '',
  })
  const [level, setLevel] = useState<Triage>('green')
  const [next, setNext] = useState<Station>('consultation')
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
        vitals: values,
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
          {/* Who measured and when (the paper sheet case) */}
          <div
            className={cn(
              'grid grid-cols-1 gap-3 rounded-xl border p-3 sm:grid-cols-[2fr_1fr]',
              fromPaper ? 'border-amber/40 bg-amber-bg/50' : 'border-border',
            )}
          >
            <Select
              label={t('vitalsForm.measuredBy')}
              value={measuredBy}
              onChange={(e) => setMeasuredBy(e.target.value)}
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
              required
            />
            <p className="text-ink-2 col-span-full m-0 inline-flex items-start gap-1.5 text-xs">
              <ClipboardPen size={14} aria-hidden="true" className="mt-px flex-none" />
              {fromPaper ? t('vitalsForm.paperHint') : t('vitalsForm.selfHint')}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
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
                  {TREATING_STATIONS.map((s) => (
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
              loading={actions.recordVitals.isPending}
            >
              <Send size={18} aria-hidden="true" />
              {t(mode === 'triage' ? 'triage.send' : 'vitalsForm.save')}
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

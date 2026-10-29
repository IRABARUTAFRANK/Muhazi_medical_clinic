import { useState, type FormEvent } from 'react'
import { Activity, ClipboardPen, Lock, Plus, Send, Trash2, X } from 'lucide-react'
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
import {
  BMI_CODE,
  VITAL_CATALOGUE,
  bmiOf,
  customVitalCode,
  isCustomVital,
  useRemoveVital,
  useVitalsSetting,
  vitalName,
  vitalType,
  type VitalsInput,
} from '@/lib/api/vitals'
import { formatTime } from '@mmc/shared'
import { cn } from '@/lib/utils'
import { useMissingLabel } from './use-field-settings'

/**
 * One line of the form: a measurement of the catalogue (unit and limits known) or a custom one
 * (the typed name and unit). Outside the limits it is a typing mistake (450 mmHg, 67 °C) and the
 * form refuses it.
 */
interface Row {
  code: string
  unit: string
  /** The typed name of a custom measurement. */
  label: string | null
  min?: number
  max?: number
  placeholder: string
}
const rowOf = (code: string, custom?: { label: string; unit: string }): Row => {
  const type = vitalType(code)
  if (type)
    return {
      code,
      unit: type.unit,
      label: null,
      min: type.min,
      max: type.max,
      placeholder: type.placeholder,
    }
  return { code, unit: custom?.unit ?? '', label: custom?.label ?? null, placeholder: '' }
}
const LEVELS: readonly Triage[] = ['red', 'yellow', 'green']
/** The server's answer when this person may not send the patient on (another nurse's patient). */
const REFUSED = /this patient is with|not allowed|may not|only the (nurse|triage)|another nurse/i
/** "Other": a measurement typed by name. */
const OTHER = 'other'

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
const num = (s: string) => Number(s.trim().replace(',', '.'))

/**
 * First measurements. Clinic practice: the nurse measures first; when she has no device at
 * hand she writes on paper and the receptionist or the doctor types the figures in. So the
 * form always says who measured and when, separately from who is typing.
 *
 * The lines shown are the clinic's default set (Settings › Vital signs, in the manager's order)
 * plus whatever was already measured on this visit; "Add a measurement" brings any other one of
 * the catalogue, or a custom one by name. A saved measurement is corrected in its box or taken
 * off the visit with a reason (kept in the audit).
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
  const removeVital = useRemoveVital()
  const { data: takers = [] } = useVitalsTakers()
  const { data: setting } = useVitalsSetting()
  // what the file still needs, the clinic's own fields by their names (0108)
  const missingLabel = useMissingLabel()
  const defaults = (setting?.codes ?? []).filter((c) => c !== BMI_CODE)
  const showBmi = (setting?.codes ?? []).includes(BMI_CODE)
  // lines the person added or took off the form (a default line without a saved value)
  const [added, setAdded] = useState<Row[]>([])
  const [dropped, setDropped] = useState<string[]>([])
  const saved = new Map(existing.map((e) => [e.code, e]))
  const rows: Row[] = []
  for (const code of [...defaults, ...existing.map((e) => e.code)]) {
    if (rows.some((r) => r.code === code) || dropped.includes(code)) continue
    const e = saved.get(code)
    rows.push(
      e && isCustomVital(code)
        ? rowOf(code, { label: e.label ?? '', unit: e.unit ?? '' })
        : rowOf(code),
    )
  }
  for (const r of added) if (!rows.some((x) => x.code === r.code)) rows.push(r)
  // what is typed (a box left untouched shows the saved value)
  const initial = (code: string) => String(saved.get(code)?.value ?? '')
  const [typed, setTyped] = useState<Record<string, string>>({})
  const valueOf = (code: string) => typed[code] ?? initial(code)
  const taken = existing.length > 0
  const latest = existing.reduce<Vital | null>((a, v) => (!a || v.at > a.at ? v : a), null)
  const changedKeys = rows.map((r) => r.code).filter((c) => valueOf(c).trim() !== initial(c).trim())
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
  // "Measured by": me (whoever is signed in, reception included: she may measure too), or the
  // nurse who wrote the paper sheet. Who typed it is recorded apart (the observation's author).
  const [measuredBy, setMeasuredBy] = useState<string>('me')
  const [measuredAt, setMeasuredAt] = useState(nowHHMM)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // "Add a measurement": the one picked from the catalogue, or a custom name and unit
  const [adding, setAdding] = useState(false)
  const [pick, setPick] = useState('')
  const [customName, setCustomName] = useState('')
  const [customUnit, setCustomUnit] = useState('')
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
  const nameOf = (r: Row) => vitalName(r, t)
  const labelOf = (r: Row) => (r.unit ? `${nameOf(r)} (${r.unit})` : nameOf(r))
  // the body mass index from what is typed or saved (shown, never saved)
  const bmi = bmiOf(num(valueOf('weight')), num(valueOf('height')))
  const notShown = VITAL_CATALOGUE.filter((v) => !rows.some((r) => r.code === v.code))

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

  /** "Add a measurement": one of the catalogue, or a custom one by name. */
  const addRow = () => {
    setError(null)
    if (pick === OTHER) {
      const name = customName.trim()
      if (!name) return setError(t('vitalsForm.errors.customName'))
      const code = customVitalCode(name)
      if (!rows.some((r) => r.code === code))
        setAdded((s) => [...s, rowOf(code, { label: name, unit: customUnit.trim() })])
      setDropped((s) => s.filter((c) => c !== code))
      setCustomName('')
      setCustomUnit('')
    } else {
      if (!pick) return setError(t('vitalsForm.errors.pickMeasurement'))
      if (!rows.some((r) => r.code === pick)) setAdded((s) => [...s, rowOf(pick)])
      setDropped((s) => s.filter((c) => c !== pick))
    }
    setPick('')
    setAdding(false)
  }

  /**
   * A line taken off: a saved measurement goes off the visit with a reason (kept in the audit);
   * a line nothing was saved for just leaves the form.
   */
  const removeRow = async (r: Row) => {
    setError(null)
    setNotice(null)
    const e = saved.get(r.code)
    if (e) {
      const answer = await confirm({
        title: t('vitalsForm.confirm.removeTitle', { name: nameOf(r), patient }),
        body: t('vitalsForm.confirm.removeBody', {
          value: `${e.value}${e.unit ? ` ${e.unit}` : ''}`,
        }),
        confirmLabel: t('vitalsForm.confirm.removeYes'),
        tone: 'danger',
        input: {
          label: t('vitalsForm.removeReason'),
          placeholder: t('vitalsForm.removeReasonPh'),
          required: true,
          maxLength: 200,
        },
      })
      if (!answer.ok) return
      try {
        await removeVital.mutateAsync({ id: e.id, reason: answer.value })
        setNotice(t('vitalsForm.removed', { name: nameOf(r) }))
      } catch (err) {
        return setError(err instanceof Error ? err.message : String(err))
      }
    }
    setTyped((s) => {
      const c = { ...s }
      delete c[r.code]
      return c
    })
    setAdded((s) => s.filter((x) => x.code !== r.code))
    setDropped((s) => (s.includes(r.code) ? s : [...s, r.code]))
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
    if (!rows.some((r) => valueOf(r.code).trim() !== ''))
      return setError(t('triage.errors.noVitals'))
    // a number that no patient can have is a typing mistake
    for (const r of rows) {
      const raw = valueOf(r.code).trim()
      if (raw === '') continue
      const n = num(raw)
      if (!Number.isFinite(n) || (r.min != null && r.max != null && (n < r.min || n > r.max)))
        return setError(
          r.min != null && r.max != null
            ? t('vitalsForm.errors.range', {
                name: nameOf(r),
                value: raw,
                unit: r.unit,
                min: r.min,
                max: r.max,
              })
            : t('vitalsForm.errors.notANumber', { name: nameOf(r), value: raw }),
        )
    }
    if (
      valueOf('bp_sys').trim() &&
      valueOf('bp_dia').trim() &&
      num(valueOf('bp_dia')) >= num(valueOf('bp_sys'))
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
    // Once taken, only the corrected values are saved again. A custom measurement carries its
    // unit and typed name; one of the catalogue just its number.
    const vitals: VitalsInput = {}
    for (const r of rows) {
      const raw = valueOf(r.code).trim()
      if (raw === '' || (taken && !changedKeys.includes(r.code))) continue
      vitals[r.code] = isCustomVital(r.code)
        ? { value: num(raw), unit: r.unit || null, label: r.label }
        : raw
    }
    try {
      const ticket = await actions.recordVitals.mutateAsync({
        encounterId,
        vitals,
        triage: sends || (colourOnly && colourSet) ? level : null,
        nextStation: sends ? next : null,
        reason: sends ? reason : '',
        // always named: the database accepts reception as the one who measured only when said
        measuredBy: fromPaper ? measuredBy : user.id,
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
        <CardBody className="@container gap-4">
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
                <option value="me">{t('vitalsForm.me', { name: user.name })}</option>
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

            {/* the measurements: the clinic's default set, what was already measured, what was added */}
            <ul className="m-0 grid min-w-0 list-none grid-cols-1 gap-3 p-0 @[18rem]:grid-cols-2 @[30rem]:grid-cols-3">
              {rows.map((r) => {
                const e = saved.get(r.code)
                return (
                  <li key={r.code} className="flex min-w-0 flex-col gap-1">
                    <Field
                      label={labelOf(r)}
                      inputMode="decimal"
                      placeholder={r.placeholder}
                      value={valueOf(r.code)}
                      onChange={(e) => setTyped((s) => ({ ...s, [r.code]: e.target.value }))}
                    />
                    <span className="flex min-w-0 items-center justify-between gap-2 text-[12px]">
                      <span className="text-ink-3 min-w-0 truncate">
                        {e
                          ? t('vitalsForm.savedValue', {
                              value: `${e.value}${e.unit ? ` ${e.unit}` : ''}`,
                              time: formatTime(new Date(e.at)),
                            })
                          : isCustomVital(r.code)
                            ? t('vitalsForm.customRow')
                            : ''}
                      </span>
                      {!lockedNote && (
                        <button
                          type="button"
                          onClick={() => void removeRow(r)}
                          disabled={removeVital.isPending}
                          className={cn(
                            'inline-flex h-6 flex-none items-center gap-1 rounded px-1.5 font-semibold',
                            e ? 'text-red hover:bg-red-bg' : 'text-ink-3 hover:bg-hover',
                          )}
                          title={t(e ? 'vitalsForm.removeSaved' : 'vitalsForm.removeRow', {
                            name: nameOf(r),
                          })}
                        >
                          {e ? (
                            <Trash2 size={12} aria-hidden="true" />
                          ) : (
                            <X size={12} aria-hidden="true" />
                          )}
                          {t(e ? 'vitalsForm.remove' : 'vitalsForm.hide')}
                        </button>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
            {(showBmi || bmi != null) && (
              <p className="text-ink-2 m-0 text-[13px]">
                <b>{t('vitals.bmi')}</b>:{' '}
                {bmi != null ? (
                  <>
                    <span className="tabular-nums">{bmi}</span> kg/m²{' '}
                    <span className="text-ink-3">{t('vitalsForm.bmiComputed')}</span>
                  </>
                ) : (
                  <span className="text-ink-3">{t('vitalsForm.bmiNeeds')}</span>
                )}
              </p>
            )}

            {/* Add a measurement: one of the catalogue not shown yet, or a custom one by name */}
            {!lockedNote &&
              (adding ? (
                <div className="border-border bg-hover/50 grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <Select
                    label={t('vitalsForm.pickMeasurement')}
                    value={pick}
                    onChange={(e) => setPick(e.target.value)}
                    wrapperClassName="min-w-0"
                    className="w-full min-w-0"
                  >
                    <option value="">{t('vitalsForm.pickPh')}</option>
                    {notShown.map((v) => (
                      <option key={v.code} value={v.code}>
                        {t(`triage.vitals.${v.code}`)} ({v.unit})
                      </option>
                    ))}
                    <option value={OTHER}>{t('vitalsForm.otherMeasurement')}</option>
                  </Select>
                  {pick === OTHER && (
                    <div className="col-span-full grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                      <Field
                        label={t('vitalsForm.customName')}
                        value={customName}
                        onChange={(e) => setCustomName(e.target.value)}
                        placeholder={t('vitalsForm.customNamePh')}
                        maxLength={60}
                      />
                      <Field
                        label={t('vitalsForm.customUnit')}
                        value={customUnit}
                        onChange={(e) => setCustomUnit(e.target.value)}
                        placeholder={t('vitalsForm.customUnitPh')}
                        maxLength={20}
                      />
                    </div>
                  )}
                  <span className="col-span-full flex flex-wrap gap-2">
                    <Button type="button" variant="primary" size="sm" onClick={addRow}>
                      <Plus size={14} aria-hidden="true" />
                      {t('vitalsForm.addRow')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setAdding(false)
                        setPick('')
                      }}
                    >
                      {t('staff.form.cancel')}
                    </Button>
                  </span>
                </div>
              ) : (
                <span>
                  <Button type="button" size="sm" onClick={() => setAdding(true)}>
                    <Plus size={14} aria-hidden="true" />
                    {t('vitalsForm.addMeasurement')}
                  </Button>
                </span>
              ))}

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
                        missing: missing.map(missingLabel).join(', '),
                      })}
                    </p>
                  )}
                </div>
              </>
            )}
          </fieldset>

          {notice && (
            <p
              role="status"
              className="bg-green-bg text-green border-green/30 m-0 rounded-md border px-3 py-2 text-[13px] font-semibold"
            >
              {notice}
            </p>
          )}
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

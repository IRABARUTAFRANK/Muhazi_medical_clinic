import { useState, type FormEvent } from 'react'
import { Activity, Send } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser, Triage } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  TREATING_STATIONS,
  openItems,
  useQueueBoard,
  useVisitActions,
  type QueueItem,
  type Station,
} from '@/lib/api/visits'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'

/** Vital signs captured at triage, in the order the nurse takes them. */
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
const toneOf: Record<Triage, 'red' | 'yellow' | 'green'> = {
  red: 'red',
  yellow: 'yellow',
  green: 'green',
}

/**
 * Triage screen (MoH: vitals before the doctor). Left: everyone waiting at triage, in priority
 * order. Right: the measurements, the triage colour and the station the patient goes to next.
 */
export function TriagePage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const { data: items = [], isLoading } = useQueueBoard('triage', user.role)
  const waiting = openItems(items)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = waiting.find((i) => i.queueId === selectedId) ?? waiting[0] ?? null
  const [notice, setNotice] = useState<string | null>(null)

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="vitals">
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[260px] flex-1">
            <h1 className="m-0 text-2xl font-bold">{t('triage.title')}</h1>
            <p className="text-ink-2 m-0 mt-1 max-w-[680px]">{t('triage.lead')}</p>
          </div>
          <Badge tone="grey" dot={false}>
            {t('home.waiting', { count: waiting.length })}
          </Badge>
        </div>

        {notice && (
          <p className="bg-green-bg text-green m-0 rounded-lg px-3 py-2 text-[13px] font-semibold">
            {notice}
          </p>
        )}

        <div className="pc:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] grid grid-cols-1 gap-4">
          <Card>
            <CardHeader>
              <span>{t('triage.queueTitle')}</span>
              <span className="text-ink-3 text-xs">{isLoading ? '…' : ''}</span>
            </CardHeader>
            {waiting.length === 0 ? (
              <CardBody>
                <p className="text-ink-3 m-0 text-[13px]">{t('triage.empty')}</p>
              </CardBody>
            ) : (
              waiting.map((q) => (
                <button
                  key={q.queueId}
                  type="button"
                  onClick={() => setSelectedId(q.queueId)}
                  className={cn(
                    'border-border flex w-full items-center gap-3 border-b px-4 py-3 text-left last:border-b-0',
                    selected?.queueId === q.queueId ? 'bg-primary-tint' : 'hover:bg-surface',
                  )}
                >
                  <span className="text-primary w-14 font-bold tabular-nums">{q.ticket}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{q.name}</span>
                    <span className="text-ink-3 text-xs tabular-nums">
                      {q.ageSex} · {q.fileNumber}
                    </span>
                  </span>
                  {q.priority === 1 && <Badge tone="red">{t('home.triage.red')}</Badge>}
                  <span className="text-ink-2 text-xs tabular-nums">
                    {q.waitMin} {t('common.min')}
                  </span>
                </button>
              ))
            )}
          </Card>

          {selected ? (
            <VitalsForm
              key={selected.queueId}
              item={selected}
              canRecord={user.role !== 'manager'}
              onSent={(ticket, station) => {
                setNotice(t('triage.sent', { ticket, station: t(`register.stations.${station}`) }))
                setSelectedId(null)
              }}
            />
          ) : (
            <Card>
              <CardBody>
                <p className="text-ink-3 m-0 text-[13px]">{t('triage.select')}</p>
              </CardBody>
            </Card>
          )}
        </div>
      </main>
    </StaffShell>
  )
}

function VitalsForm({
  item,
  canRecord,
  onSent,
}: {
  item: QueueItem
  canRecord: boolean
  onSent: (ticket: string, station: Station) => void
}) {
  const { t } = useTranslation()
  const actions = useVisitActions()
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
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!Object.values(values).some((v) => v.trim() !== ''))
      return setError(t('triage.errors.noVitals'))
    try {
      const ticket = await actions.recordVitals.mutateAsync({
        encounterId: item.encounterId,
        vitals: values,
        triage: level,
        nextStation: next,
        reason,
      })
      onSent(ticket, next)
    } catch (err) {
      setError(t('triage.errors.generic', { message: err instanceof Error ? err.message : '' }))
    }
  }

  return (
    <Card>
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <Activity size={16} aria-hidden="true" />
          {item.ticket} · {item.name}
        </span>
        <span className="text-ink-3 text-xs tabular-nums">
          {item.ageSex} · {item.fileNumber}
        </span>
      </CardHeader>
      <form onSubmit={submit}>
        <CardBody className="gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {VITALS.map((v) => (
              <Field
                key={v.key}
                label={`${t(`triage.vitals.${v.key}`)} (${v.unit})`}
                inputMode="decimal"
                placeholder={v.placeholder}
                value={values[v.key]}
                onChange={(e) => setValues((s) => ({ ...s, [v.key]: e.target.value }))}
                disabled={!canRecord}
              />
            ))}
          </div>

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
                    disabled={!canRecord}
                  />
                  <Badge tone={toneOf[l]}>{t(`home.triage.${l}`)}</Badge>
                  <span className="text-ink-2 text-xs font-normal">{t(`triage.levels.${l}`)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select
              label={t('triage.nextStation')}
              value={next}
              onChange={(e) => setNext(e.target.value as Station)}
              disabled={!canRecord}
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
              disabled={!canRecord}
            />
          </div>

          {error && (
            <p
              role="alert"
              className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
            >
              {error}
            </p>
          )}
          {!canRecord && <p className="text-ink-3 m-0 text-xs">{t('triage.readOnly')}</p>}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="self-start"
            disabled={!canRecord || actions.recordVitals.isPending}
          >
            <Send size={18} aria-hidden="true" />
            {actions.recordVitals.isPending ? t('triage.sending') : t('triage.send')}
          </Button>
        </CardBody>
      </form>
    </Card>
  )
}

import { useState, type FormEvent } from 'react'
import { ClipboardList } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatTime } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { useDeskOps, useVisitTasks } from '@/lib/api/desk-ops'

const pad = (n: number) => String(n).padStart(2, '0')
const inAnHour = () => {
  const d = new Date(Date.now() + 60 * 60_000)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Doctor → nurse: leave a task on this visit ("injection at 14:00", "repeat vitals in 1 h").
 * It appears at once on the nurses' dashboard; the nurse ticks it off there.
 */
export function NurseTaskCard({ encounterId }: { encounterId: string }) {
  const { t } = useTranslation()
  const ops = useDeskOps()
  // every open task of this visit, including the ones for the nurses
  const { data: mine = [] } = useVisitTasks(encounterId)
  const [title, setTitle] = useState('')
  const [time, setTime] = useState(inAnHour)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSaved(false)
    let dueAt: string | null = null
    const m = time.match(/^(\d{1,2}):(\d{2})$/)
    if (m) {
      const d = new Date()
      d.setHours(Number(m[1]), Number(m[2]), 0, 0)
      dueAt = d.toISOString()
    }
    try {
      await ops.createTask.mutateAsync({ encounterId, title, dueAt })
      setTitle('')
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Card>
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <ClipboardList size={16} aria-hidden="true" />
          {t('ops.tasks.forNurse')}
        </span>
        <span className="text-ink-3 text-xs">{t('ops.tasks.open', { count: mine.length })}</span>
      </CardHeader>
      <form onSubmit={submit}>
        <CardBody className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[2fr_1fr_auto]">
          <Field
            label={t('ops.tasks.what')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('ops.tasks.whatPh')}
            required
          />
          <Field
            label={t('ops.tasks.when')}
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
          <Button type="submit" variant="primary" loading={ops.createTask.isPending}>
            {t('ops.tasks.send')}
          </Button>
          {(error || saved) && (
            <p
              className={
                error
                  ? 'bg-red-bg text-red col-span-full m-0 rounded-lg px-3 py-2 text-[13px] font-semibold'
                  : 'text-green col-span-full m-0 text-[13px] font-semibold'
              }
            >
              {error ?? t('ops.tasks.sent')}
            </p>
          )}
        </CardBody>
      </form>
      {mine.map((x) => (
        <Row key={x.id} className="gap-3 py-2 text-[13px]">
          <span
            className={x.overdue ? 'text-red font-bold tabular-nums' : 'text-ink-2 tabular-nums'}
          >
            {x.dueAt ? formatTime(new Date(x.dueAt)) : '—'}
          </span>
          <span className="flex-1">{x.title}</span>
          <span className="text-ink-3 text-xs">{t('ops.tasks.waitingNurse')}</span>
        </Row>
      ))}
    </Card>
  )
}

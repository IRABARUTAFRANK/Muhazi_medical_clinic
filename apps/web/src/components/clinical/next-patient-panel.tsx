import { useState } from 'react'
import { ArrowRight, BellRing, HandHelping, Hourglass, UserRound, X } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { formatTime } from '@mmc/shared'
import { Pill } from '@/components/dash/kit'
import { triageIcon, type Tint } from '@/components/dash/kit-style'
import { Button } from '@/components/ui/button'
import { useCallPatient, useNextForMe } from '@/lib/api/display'
import { useTakePatient, type Station } from '@/lib/api/visits'
import { useConfirm } from '@/lib/confirm'
import { formatDuration } from '@/lib/duration'
import { useSessionCan } from '@/components/clinical/session-desks'
import { useNow } from '@/lib/hooks'
import { cn } from '@/lib/utils'

const PRIORITY_TINT: Record<number, Tint> = { 1: 'coral', 2: 'amber', 3: 'mint' }
const PRIORITY_LEVEL: Record<number, string> = { 1: 'red', 2: 'yellow', 3: 'green' }

/**
 * "Next patient" (migration 0114): after Finish / send-on on the visit screen, and on My queue.
 * The patient to see next at this desk (sent to me by name first, then my department's, then
 * the most urgent, then arrival): Take opens the visit; Call tells them on the waiting-room
 * screen to come, without opening; Later hides the panel until the next visit.
 */
export function NextPatientPanel({
  station,
  onClose,
  className,
}: {
  station: Station
  /** "Later": the panel goes away. */
  onClose?: () => void
  className?: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const can = useSessionCan()
  const { data: next, isLoading } = useNextForMe(station)
  // the waiting minutes tick every 30 s
  const now = useNow()
  const take = useTakePatient()
  const call = useCallPatient()
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
  const desk = t(`register.stations.${station}`)

  const doTake = async () => {
    if (!next) return
    if (
      !(await confirm({
        title: t('confirm.desks.queue.take', { name: next.name, ticket: next.ticket }),
        body: t('confirm.desks.queue.takeBody'),
        confirmLabel: t('confirm.desks.queue.takeYes'),
      }))
    )
      return
    setError(null)
    try {
      await take.mutateAsync(next.queueId)
      await navigate({ to: '/app/visit', search: { encounter: next.encounterId } })
    } catch (e) {
      setError(describe(e))
    }
  }
  const doCall = async () => {
    if (!next) return
    if (
      !(await confirm({
        title: t('confirm.nextPatient.call.title', { name: next.name, ticket: next.ticket }),
        body: t('confirm.nextPatient.call.body'),
        confirmLabel: t('confirm.nextPatient.call.yes'),
      }))
    )
      return
    setError(null)
    try {
      await call.mutateAsync({ queueId: next.queueId })
      setMessage(t('nextPatient.called', { ticket: next.ticket }))
    } catch (e) {
      setError(describe(e))
    }
  }

  // the manager's switch "Start visits / take patients" is checked by the database; the panel
  // only hides when the person may not work queues at all
  if (!can('visit.start') && !next) return null
  return (
    <section
      className={cn(
        'anim-enter border-primary/30 bg-primary-tint/60 flex flex-col gap-3 rounded-[var(--mmc-radius-lg)] border px-4 py-3',
        className,
      )}
      aria-label={t('nextPatient.title')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-primary inline-flex items-center gap-2 text-[15px] font-bold">
          <UserRound size={18} aria-hidden="true" />
          {t('nextPatient.title')}
        </span>
        <span className="text-ink-3 text-[13px]">{t('nextPatient.lead')}</span>
        {onClose && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={onClose}
            title={t('nextPatient.later')}
          >
            <X size={14} aria-hidden="true" />
            {t('nextPatient.later')}
          </Button>
        )}
      </div>
      {!next ? (
        <p className="text-ink-2 m-0 text-[14px]">{isLoading ? '…' : t('queuePage.nobody')}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Pill
            tint={PRIORITY_TINT[next.priority] ?? 'mint'}
            icon={triageIcon[PRIORITY_LEVEL[next.priority] ?? 'green']}
          >
            {next.ticket}
          </Pill>
          <span className="min-w-[200px] flex-1">
            <span className="block text-[16px] font-semibold">
              {t('nextPatient.waitingAt', { ticket: next.ticket, name: next.name, desk })}
              {next.priority < 3 && (
                <span className={cn('ml-2', next.priority === 1 ? 'text-red' : 'text-yellow')}>
                  ({t(`triage.levels.${PRIORITY_LEVEL[next.priority]}`)})
                </span>
              )}
            </span>
            <span className="text-ink-3 flex flex-wrap items-center gap-x-3 text-[13px]">
              <span className="inline-flex items-center gap-1">
                <Hourglass size={12} aria-hidden="true" />
                {formatDuration(
                  Math.max(0, Math.round((now - new Date(next.queuedAt).getTime()) / 60_000)),
                  t,
                )}
              </span>
              {next.assignedToMe && (
                <span className="text-blue font-semibold">{t('nextPatient.sentToYou')}</span>
              )}
              {next.department && <span>{next.department}</span>}
              {next.calledAt && (
                <span className="text-primary inline-flex items-center gap-1 font-semibold">
                  <BellRing size={12} aria-hidden="true" />
                  {t('nextPatient.calledAt', { time: formatTime(new Date(next.calledAt)) })}
                </span>
              )}
              <span>{t('nextPatient.waitingCount', { count: next.waiting })}</span>
            </span>
          </span>
          <span className="flex flex-wrap gap-2">
            <Button variant="primary" loading={take.isPending} onClick={() => void doTake()}>
              {!take.isPending && <HandHelping size={16} aria-hidden="true" />}
              {t('home.take')}
            </Button>
            <Button variant="tint-amber" loading={call.isPending} onClick={() => void doCall()}>
              {!call.isPending && <BellRing size={16} aria-hidden="true" />}
              {t(next.calledAt ? 'nextPatient.callAgain' : 'common.call')}
            </Button>
          </span>
        </div>
      )}
      {error && (
        <p role="alert" className="text-red m-0 text-[14px] font-medium">
          {error}
        </p>
      )}
      {message && !error && (
        <p
          role="status"
          className="text-green m-0 inline-flex items-center gap-1 text-[14px] font-medium"
        >
          <ArrowRight size={14} aria-hidden="true" />
          {message}
        </p>
      )}
    </section>
  )
}

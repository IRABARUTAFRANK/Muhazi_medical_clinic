import type { CSSProperties } from 'react'
import { Check, CircleDot, Clock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf, formatTime } from '@mmc/shared'
import { useVisitJourney, type Journey } from '@/lib/api/journey'
import { useNow } from '@/lib/hooks'
import { cn } from '@/lib/utils'

type State = 'done' | 'now' | 'next'

interface Stop {
  key: string
  state: State
  title: string
  detail: string
}

const at = (iso: string | null | undefined) => (iso ? formatTime(new Date(iso)) : '')

/**
 * The visit's track, one line from the start to the end:
 * started → at triage → at the doctor → … → treatment finished → payment → left.
 * Each stop says who and when; the current one is highlighted. Reception follows a patient it has
 * sent on here; every desk sees where the patient is now and what is left.
 */
export function VisitTrack({
  encounterId,
  className,
}: {
  encounterId: string
  className?: string
}) {
  const { t } = useTranslation()
  const now = useNow(30_000)
  const { data: j } = useVisitJourney(encounterId)
  if (!j) return null
  const stops = trackOf(j, now, t)
  return (
    <nav aria-label={t('track.title')} className={cn('min-w-0', className)}>
      <ol className="m-0 flex list-none flex-wrap items-stretch gap-y-2 p-0">
        {stops.map((s, i) => (
          <li
            key={s.key}
            className="anim-enter flex min-w-0 items-stretch"
            style={{ '--i': i } as CSSProperties}
            aria-current={s.state === 'now' ? 'step' : undefined}
          >
            {i > 0 && (
              <span
                aria-hidden="true"
                className={cn(
                  'mt-[13px] h-0.5 w-5 flex-none sm:w-8',
                  s.state === 'next' ? 'bg-border' : 'bg-green',
                )}
              />
            )}
            <span
              className={cn(
                'flex max-w-[220px] min-w-0 items-start gap-2 rounded-xl border px-2.5 py-1.5',
                s.state === 'done' && 'border-green/40 bg-green-bg/50',
                s.state === 'now' && 'border-primary bg-primary-tint shadow-card',
                s.state === 'next' && 'border-border bg-card border-dashed',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 inline-flex size-5 flex-none items-center justify-center rounded-full',
                  s.state === 'done' && 'bg-green text-white',
                  s.state === 'now' && 'bg-primary text-white',
                  s.state === 'next' && 'bg-hover text-ink-3',
                )}
              >
                {s.state === 'done' ? (
                  <Check size={12} strokeWidth={3} aria-hidden="true" />
                ) : s.state === 'now' ? (
                  <CircleDot size={12} aria-hidden="true" />
                ) : (
                  <Clock size={11} aria-hidden="true" />
                )}
              </span>
              <span className="min-w-0">
                <span
                  className={cn(
                    'block truncate text-[13px] font-bold',
                    s.state === 'next' && 'text-ink-3',
                  )}
                >
                  {s.title}
                </span>
                {s.detail && (
                  <span className="text-ink-3 block text-[12px] leading-snug">{s.detail}</span>
                )}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </nav>
  )
}

type TFn = (key: string, opts?: Record<string, unknown>) => string

/** The stops of a visit, from visit_journey. */
function trackOf(j: Journey, now: number, t: TFn): Stop[] {
  const closed = j.status !== 'open'
  const station = (s: string) => t(`register.stations.${s}`, { defaultValue: s })
  const service = (s?: string | null) =>
    !s ? '' : s === 'pharmacy' ? station('pharmacy') : t(`categories.${s}`, { defaultValue: s })
  const mins = (from: string) => Math.max(0, Math.round((now - new Date(from).getTime()) / 60_000))
  const stops: Stop[] = [
    {
      key: 'start',
      state: 'done',
      title: t('track.started', { time: at(j.arrivedAt) }),
      detail: service(j.service),
    },
  ]
  // each desk the patient went through (copies closed when a colleague took the patient left out)
  const steps = j.steps.filter((s) => s.startedAt || !s.finishedAt)
  steps.forEach((s, i) => {
    const who = s.takenBy ?? s.assignedTo ?? s.department ?? null
    const state: State = s.finishedAt ? 'done' : 'now'
    const detail = s.finishedAt
      ? [who, t('track.until', { time: at(s.finishedAt) })].filter(Boolean).join(' · ')
      : s.startedAt
        ? t('track.with', { name: who ?? '', time: at(s.startedAt) })
        : [
            who ? t('track.for', { name: who }) : t('track.anyone'),
            t('track.waiting', { count: mins(s.queuedAt) }),
          ].join(' · ')
    stops.push({
      key: `step-${i}`,
      state,
      title: [station(s.station), service(s.service && s.station !== 'triage' ? s.service : null)]
        .filter(Boolean)
        .join(' · '),
      detail,
    })
  })
  // treatment finished: the doctor's "Finish visit", or the visit's end
  const treated = j.treatmentDoneAt ?? (closed ? j.closedAt : null)
  stops.push({
    key: 'treated',
    state: treated ? 'done' : 'next',
    title: t('track.treated'),
    detail: treated ? at(treated) : t('track.notYet'),
  })
  // the bill: nothing to pay, still owed, or paid
  const total = Number(j.bill?.total ?? 0)
  const balance = Number(j.bill?.balance ?? 0)
  stops.push(
    total === 0
      ? {
          key: 'pay',
          state: closed || treated ? 'done' : 'next',
          title: t('track.payment'),
          detail: t('track.nothingToPay'),
        }
      : balance > 0
        ? {
            key: 'pay',
            state: treated || closed ? 'now' : 'next',
            title: t('track.pending'),
            detail: formatRwf(balance),
          }
        : {
            key: 'pay',
            state: 'done',
            title: t('track.paid'),
            detail: [formatRwf(total), at(j.bill?.settledAt ?? null)].filter(Boolean).join(' · '),
          },
  )
  stops.push({
    key: 'left',
    state: closed ? 'done' : 'next',
    title: t('track.left'),
    detail: closed
      ? [at(j.closedAt), j.leftReason ? `“${j.leftReason}”` : null].filter(Boolean).join(' · ')
      : t('track.inClinic'),
  })
  return stops
}

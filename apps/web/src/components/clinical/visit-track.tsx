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
 * The visit's track: one line in the order things happened, e.g. started → vitals → consultation
 * → laboratory → consultation → treatment finished → pharmacy → paid → left. Done stops in time
 * order, then where the patient is now (highlighted), then what is still to come. Each stop says
 * who and when. Reception follows a patient it has sent on here; every desk sees the same line.
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

/**
 * The stops of a visit, from visit_journey, in the order they happened: what is done (by time),
 * then where the patient is now, then what is still to come. A visit has no fixed route: the
 * patient may go to the lab and back, finish the treatment, then the pharmacy, then pay.
 */
function trackOf(j: Journey, now: number, t: TFn): Stop[] {
  const closed = j.status !== 'open'
  const station = (s: string) => t(`register.stations.${s}`, { defaultValue: s })
  const service = (s?: string | null) =>
    !s ? '' : s === 'pharmacy' ? station('pharmacy') : t(`categories.${s}`, { defaultValue: s })
  const mins = (from: string) => Math.max(0, Math.round((now - new Date(from).getTime()) / 60_000))
  const ms = (iso: string) => new Date(iso).getTime()
  type Ev = Stop & { at: number }
  const done: Ev[] = []
  const current: Ev[] = []
  const next: Stop[] = []

  done.push({
    key: 'start',
    state: 'done',
    at: ms(j.arrivedAt),
    title: t('track.started', { time: at(j.arrivedAt) }),
    detail: service(j.service),
  })
  // the first measurements
  const firstVitals = [...(j.vitals ?? [])].sort((x, y) => x.at.localeCompare(y.at))[0]
  if (firstVitals)
    done.push({
      key: 'vitals',
      state: 'done',
      at: ms(firstVitals.at),
      title: t('track.vitals'),
      detail: [firstVitals.by, at(firstVitals.at)].filter(Boolean).join(' · '),
    })
  // each desk: copies of "several desks at once" that another desk took are left out (finished
  // without anyone starting, at the same moment as a desk that did)
  const near = (a: string | null, b: string | null) => !!a && !!b && Math.abs(ms(a) - ms(b)) < 5000
  const steps = j.steps.filter(
    (s) =>
      s.startedAt ||
      !s.finishedAt ||
      // not the copy of "several desks at once" that another desk took …
      (!j.steps.some((o) => o !== s && o.startedAt && near(o.queuedAt, s.queuedAt)) &&
        // … nor a place closed and opened again at the same desk at once (one stay, shown once)
        !j.steps.some((o) => o !== s && o.station === s.station && near(o.queuedAt, s.finishedAt))),
  )
  steps.forEach((s, i) => {
    const who = s.takenBy ?? s.assignedTo ?? s.department ?? null
    const desk = station(s.station)
    const what = service(s.service && s.station !== 'triage' ? s.service : null)
    // "Minor surgery · Minor surgery": the service is named only when it says more than the desk
    const title = [desk, what && what !== desk ? what : null].filter(Boolean).join(' · ')
    if (s.finishedAt)
      done.push({
        key: `step-${i}`,
        state: 'done',
        at: ms(s.startedAt ?? s.queuedAt), // in the order the desks saw the patient
        title,
        detail: [who, `${at(s.startedAt ?? s.queuedAt)}–${at(s.finishedAt)}`]
          .filter(Boolean)
          .join(' · '),
      })
    else
      current.push({
        key: `step-${i}`,
        state: 'now',
        at: ms(s.queuedAt),
        title,
        detail: s.startedAt
          ? t('track.with', { name: who ?? '', time: at(s.startedAt) })
          : [
              who ? t('track.for', { name: who }) : t('track.anyone'),
              t('track.waiting', { count: mins(s.queuedAt) }),
            ].join(' · '),
      })
  })
  // treatment finished: the doctor's "Finish visit", or the visit's end
  const treated = j.treatmentDoneAt ?? (closed ? j.closedAt : null)
  if (treated)
    done.push({
      key: 'treated',
      state: 'done',
      at: ms(treated),
      title: t('track.treated'),
      detail: at(treated),
    })
  else
    next.push({
      key: 'treated',
      state: 'next',
      title: t('track.treated'),
      detail: t('track.notYet'),
    })
  // each payment when it was made, then what is still owed
  ;(j.payments ?? []).forEach((p, i) =>
    done.push({
      key: `pay-${i}`,
      state: 'done',
      at: ms(p.at),
      title: t('track.paid'),
      detail: [formatRwf(Number(p.amount)), at(p.at)].filter(Boolean).join(' · '),
    }),
  )
  const total = Number(j.bill?.total ?? 0)
  const balance = Number(j.bill?.balance ?? 0)
  if (balance > 0)
    next.push({ key: 'owed', state: 'next', title: t('track.pending'), detail: formatRwf(balance) })
  else if (total === 0 && !(j.payments ?? []).length && !closed)
    next.push({
      key: 'owed',
      state: 'next',
      title: t('track.payment'),
      detail: t('track.nothingToPay'),
    })
  // the end of the visit: always last
  const left: Stop = {
    key: 'left',
    state: closed ? 'done' : 'next',
    title: t('track.left'),
    detail: closed
      ? [at(j.closedAt), j.leftReason ? `“${j.leftReason}”` : null].filter(Boolean).join(' · ')
      : t('track.inClinic'),
  }
  // finish_visit sends the patient to the pharmacy or the cashier at the same instant: on a tie,
  // "Treatment finished" comes before the desk that follows it
  const byTime = (x: Ev, y: Ev) =>
    x.at - y.at || (x.key === 'treated' ? 0 : 1) - (y.key === 'treated' ? 0 : 1)
  const plain = ({ key, state, title, detail }: Ev): Stop => ({ key, state, title, detail })
  return [...done.sort(byTime).map(plain), ...current.sort(byTime).map(plain), ...next, left]
}

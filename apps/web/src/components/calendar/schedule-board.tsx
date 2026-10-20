import { useState, type ReactNode } from 'react'
import { CalendarOff, ChevronLeft, ChevronRight, Globe, Lock, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  MAX_WEEKS_AHEAD,
  addDays,
  formatDayMonth,
  isDayOff,
  sameDay,
  spansFor,
  startOfDay,
  weekAvailability,
  workingAt,
  type Practitioner,
} from '@mmc/shared'
import { avatarTint, initials } from '@/components/dash/kit-style'
import { useDayNames } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import type { Visibility } from '@/lib/api/calendar'

export interface BoardDoctor {
  p: Practitioner
  department?: string | null
  visibility?: Visibility
  mine?: boolean
}

const VIS_ICON = { private: Lock, staff: Users, public: Globe } as const

/**
 * The doctors' week: one row per doctor, one column per day (today first), with the working
 * hours of each day, days off, and how many booking slots are still free. Used on the public
 * home page (public calendars) and on the staff home pages (calendars shared with the staff).
 */
export function ScheduleBoard({
  doctors,
  now,
  bookedFor,
  variant,
  action,
}: {
  doctors: BoardDoctor[]
  now: Date
  /** Live booked slots for a doctor; undefined = sample pattern. */
  bookedFor?: (p: Practitioner) => ReadonlySet<string> | undefined
  variant: 'public' | 'staff'
  /** Button at the end of the doctor's cell (Book, Edit). */
  action?: (d: BoardDoctor) => ReactNode
}) {
  const { t } = useTranslation()
  const names = useDayNames()
  const [week, setWeek] = useState(0)
  const days = Array.from({ length: 7 }, (_, i) => addDays(startOfDay(now), week * 7 + i))

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setWeek((w) => Math.max(0, w - 1))}
          disabled={week === 0}
          aria-label={t('calendar.board.prev')}
          className="border-border bg-card text-ink-2 hover:bg-hover inline-flex size-9 items-center justify-center rounded-lg border disabled:opacity-40"
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <span className="text-primary min-w-[150px] text-center text-[14px] font-bold">
          {week === 0
            ? t('calendar.board.thisWeek')
            : t('calendar.board.weekOf', { day: formatDayMonth(days[0]!) })}
        </span>
        <button
          type="button"
          onClick={() => setWeek((w) => Math.min(MAX_WEEKS_AHEAD - 1, w + 1))}
          disabled={week >= MAX_WEEKS_AHEAD - 1}
          aria-label={t('calendar.board.next')}
          className="border-border bg-card text-ink-2 hover:bg-hover inline-flex size-9 items-center justify-center rounded-lg border disabled:opacity-40"
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        <span className="text-ink-3 ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
          <Legend className="bg-green-bg border-green-dot/40" label={t('calendar.board.working')} />
          <Legend className="bg-amber-bg border-yellow-dot/50" label={t('calendar.board.dayOff')} />
          <Legend className="bg-surface border-border" label={t('calendar.board.off')} />
        </span>
      </div>

      <div className="border-border overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[820px] border-collapse text-[13px]">
          <thead>
            <tr className="bg-primary-tint">
              <th className="text-primary w-[230px] px-3 py-2.5 text-left text-[12px] font-extrabold tracking-[.06em] uppercase">
                {t('calendar.board.doctor')}
              </th>
              {days.map((d) => {
                const today = sameDay(d, now)
                return (
                  <th
                    key={d.toISOString()}
                    className={cn(
                      'px-1.5 py-2 text-center font-bold',
                      today ? 'bg-primary text-white' : 'text-ink-2',
                    )}
                  >
                    <span className="block text-[12px] tracking-[.04em] uppercase">
                      {today ? t('calendar.board.today') : names.short[d.getDay()]}
                    </span>
                    <span
                      className={cn(
                        'block text-[12px] tabular-nums',
                        today ? 'text-white/85' : 'text-ink-3',
                      )}
                    >
                      {formatDayMonth(d)}
                    </span>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {doctors.map((doc, i) => {
              const { p } = doc
              const avail = weekAvailability(p, now, week, bookedFor?.(p))
              const on = workingAt(p, now)
              const VisIcon = doc.visibility ? VIS_ICON[doc.visibility] : null
              return (
                <tr key={p.id} className="border-grid border-t">
                  <td className="bg-card px-3 py-2.5 align-top">
                    <div className="flex items-start gap-2.5">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'inline-flex size-9 flex-none items-center justify-center rounded-full text-[12px] font-extrabold',
                          avatarTint(i),
                        )}
                      >
                        {initials(p.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="text-ink block truncate text-[14px] font-bold">
                          {p.name}
                          {doc.mine && (
                            <span className="text-primary ml-1 text-[12px] font-semibold">
                              ({t('calendar.board.you')})
                            </span>
                          )}
                        </span>
                        <span className="text-ink-3 block truncate text-[12px]">
                          {[p.title, doc.department].filter(Boolean).join(' · ') || '—'}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold',
                              on ? 'bg-green-bg text-green' : 'bg-hover text-ink-3',
                            )}
                          >
                            <span
                              className={cn(
                                'size-1.5 rounded-full',
                                on ? 'bg-green-dot' : 'bg-ink-3',
                              )}
                            />
                            {on ? t('calendar.board.inNow') : t('calendar.board.notNow')}
                          </span>
                          {variant === 'staff' && VisIcon && doc.visibility && (
                            <span
                              className="text-ink-3 inline-flex items-center gap-1 text-[11px] font-semibold"
                              title={t(`calendar.visibility.${doc.visibility}.title`)}
                            >
                              <VisIcon size={11} aria-hidden="true" />
                              {t(`calendar.visibility.${doc.visibility}.short`)}
                            </span>
                          )}
                        </span>
                        {p.note && (
                          <span className="text-violet mt-1 block text-[12px] font-medium italic">
                            {p.note}
                          </span>
                        )}
                        {action && <span className="mt-1.5 block">{action(doc)}</span>}
                      </span>
                    </div>
                  </td>
                  {days.map((d, k) => {
                    const off = isDayOff(p, d)
                    const spans = off ? [] : spansFor(p.hours, d)
                    const free = avail[k]?.free ?? null
                    const today = sameDay(d, now)
                    return (
                      <td
                        key={d.toISOString()}
                        className={cn('px-1 py-1.5 align-top', today && 'bg-primary-tint/50')}
                      >
                        {off ? (
                          <span className="bg-amber-bg text-amber border-yellow-dot/50 flex h-full min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-lg border text-[11px] font-bold">
                            <CalendarOff size={14} aria-hidden="true" />
                            {t('calendar.board.dayOff')}
                          </span>
                        ) : spans.length === 0 ? (
                          <span className="bg-surface text-ink-3 border-border flex min-h-[52px] items-center justify-center rounded-lg border border-dashed text-[11px] font-semibold">
                            {t('calendar.board.off')}
                          </span>
                        ) : (
                          <span className="bg-green-bg border-green-dot/40 flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-lg border px-1 py-1 text-center">
                            {spans.map(([a, b]) => (
                              <span
                                key={a}
                                className="text-green text-[12px] font-bold whitespace-nowrap tabular-nums"
                              >
                                {a}–{b}
                              </span>
                            ))}
                            {free !== null && (
                              <span
                                className={cn(
                                  'text-[11px] font-semibold',
                                  free === 0 ? 'text-red' : 'text-ink-2',
                                )}
                              >
                                {free === 0
                                  ? t('calendar.board.full')
                                  : t('calendar.board.free', { count: free })}
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const Legend = ({ className, label }: { className: string; label: string }) => (
  <span className="inline-flex items-center gap-1.5">
    <span
      className={cn('inline-block size-3 rounded-[4px] border', className)}
      aria-hidden="true"
    />
    {label}
  </span>
)

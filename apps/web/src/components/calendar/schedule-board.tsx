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
  type TimeSpan,
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
  /** The calendar's owner (the manager opens it from the board). */
  userId?: string | null
}

const VIS_ICON = { private: Lock, staff: Users, public: Globe } as const
type TFn = (key: string, opts?: Record<string, unknown>) => string

/** "08:00–17:00" from 1024 px; "08–17" on phones and tablets when the minutes are 00. */
const shortSpan = ([a, b]: TimeSpan) =>
  a.endsWith(':00') && b.endsWith(':00') ? `${a.slice(0, 2)}–${b.slice(0, 2)}` : `${a}–${b}`

/**
 * The doctors' week: one row per doctor, one column per day (today first), with the working
 * hours of each day, days off, and how many booking slots are still free. Used on the public
 * home page (public calendars) and on the staff home pages (calendars shared with the staff).
 * Phones get one card per doctor with the seven days underneath instead of a wide table.
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
  const rows = doctors.map((doc, i) => ({
    doc,
    i,
    avail: weekAvailability(doc.p, now, week, bookedFor?.(doc.p)),
  }))

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setWeek((w) => Math.max(0, w - 1))}
          disabled={week === 0}
          aria-label={t('calendar.board.prev')}
          className="border-border bg-card text-ink-2 hover:bg-hover inline-flex size-8 items-center justify-center rounded-md border transition-colors duration-120 disabled:opacity-40"
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <span className="text-ink min-w-[130px] flex-1 text-center text-[14px] font-semibold sm:flex-none">
          {week === 0
            ? t('calendar.board.thisWeek')
            : t('calendar.board.weekOf', { day: formatDayMonth(days[0]!) })}
        </span>
        <button
          type="button"
          onClick={() => setWeek((w) => Math.min(MAX_WEEKS_AHEAD - 1, w + 1))}
          disabled={week >= MAX_WEEKS_AHEAD - 1}
          aria-label={t('calendar.board.next')}
          className="border-border bg-card text-ink-2 hover:bg-hover inline-flex size-8 items-center justify-center rounded-md border transition-colors duration-120 disabled:opacity-40"
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        <span className="text-ink-3 flex basis-full flex-wrap items-center gap-x-3 gap-y-1 text-[12px] sm:ml-auto sm:basis-auto">
          <Legend className="bg-green-bg border-green-dot/40" label={t('calendar.board.working')} />
          <Legend className="bg-amber-bg border-amber/30" label={t('calendar.board.dayOff')} />
          <Legend className="bg-surface border-border" label={t('calendar.board.off')} />
        </span>
      </div>

      {/* Phones: a card per doctor, the seven days in a small grid under the name. */}
      <div className="flex flex-col gap-3 sm:hidden">
        {rows.map(({ doc, i, avail }) => (
          <div key={doc.p.id} className="border-border bg-card rounded-md border p-3">
            <DoctorHead doc={doc} i={i} now={now} variant={variant} action={action} t={t} />
            <div className="mt-2.5 grid grid-cols-7 gap-1">
              {days.map((d, k) => {
                const today = sameDay(d, now)
                return (
                  <div key={d.toISOString()} className="flex min-w-0 flex-col gap-1">
                    <span
                      className={cn(
                        'block truncate text-center text-[11px] font-medium',
                        today ? 'text-primary' : 'text-ink-3',
                      )}
                    >
                      {names.short[d.getDay()]}
                      <span className="block text-[10px] font-normal tabular-nums">
                        {formatDayMonth(d)}
                      </span>
                    </span>
                    <DayCell
                      p={doc.p}
                      d={d}
                      free={avail[k]?.free ?? null}
                      today={today}
                      compact
                      t={t}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Tablets and PCs: the week as a table. */}
      <div className="border-border hidden overflow-x-auto rounded-md border sm:block">
        <table className="w-full min-w-[600px] border-collapse text-[12px] md:text-[13px]">
          <thead>
            <tr className="bg-surface">
              <th className="text-ink-3 w-[160px] px-3 py-2.5 text-left text-[12px] font-normal md:w-[230px]">
                {t('calendar.board.doctor')}
              </th>
              {days.map((d) => {
                const today = sameDay(d, now)
                return (
                  <th
                    key={d.toISOString()}
                    className={cn(
                      'px-1.5 py-2 text-center font-medium',
                      today ? 'bg-primary-tint text-primary' : 'text-ink-2',
                    )}
                  >
                    <span className="block text-[12px]">
                      {today ? t('calendar.board.today') : names.short[d.getDay()]}
                    </span>
                    <span
                      className={cn(
                        'block text-[12px] tabular-nums',
                        today ? 'text-primary/80' : 'text-ink-3',
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
            {rows.map(({ doc, i, avail }) => (
              <tr key={doc.p.id} className="border-grid border-t">
                <td className="bg-card px-3 py-2.5 align-top">
                  <DoctorHead doc={doc} i={i} now={now} variant={variant} action={action} t={t} />
                </td>
                {days.map((d, k) => {
                  const today = sameDay(d, now)
                  return (
                    <td
                      key={d.toISOString()}
                      className={cn('px-1 py-1.5 align-top', today && 'bg-primary-tint/50')}
                    >
                      <DayCell p={doc.p} d={d} free={avail[k]?.free ?? null} today={today} t={t} />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Avatar, name, title, "working now", visibility, note and the action button. */
function DoctorHead({
  doc,
  i,
  now,
  variant,
  action,
  t,
}: {
  doc: BoardDoctor
  i: number
  now: Date
  variant: 'public' | 'staff'
  action?: (d: BoardDoctor) => ReactNode
  t: TFn
}) {
  const { p } = doc
  const on = workingAt(p, now)
  const VisIcon = doc.visibility ? VIS_ICON[doc.visibility] : null
  return (
    <div className="flex items-start gap-2.5">
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex size-8 flex-none items-center justify-center rounded-full text-[12px] font-semibold',
          avatarTint(i),
        )}
      >
        {initials(p.name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-ink block text-[14px] font-semibold">
          {p.name}
          {doc.mine && (
            <span className="text-primary ml-1 text-[12px] font-medium">
              ({t('calendar.board.you')})
            </span>
          )}
        </span>
        <span className="text-ink-3 block text-[12px]">
          {[p.title, doc.department].filter(Boolean).join(' · ') || '—'}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              'inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[11px] font-medium',
              on ? 'border-green/30 bg-green-bg text-green' : 'border-border bg-hover text-ink-3',
            )}
          >
            <span className={cn('size-1.5 rounded-full', on ? 'bg-green-dot' : 'bg-ink-3')} />
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
          <span className="text-violet mt-1 block text-[12px] font-medium italic">{p.note}</span>
        )}
        {action && <span className="mt-1.5 block">{action(doc)}</span>}
      </span>
    </div>
  )
}

/** One day: the working periods and free count, a day off, or off. */
function DayCell({
  p,
  d,
  free,
  today,
  compact = false,
  t,
}: {
  p: Practitioner
  d: Date
  free: number | null
  today: boolean
  compact?: boolean
  t: TFn
}) {
  const off = isDayOff(p, d)
  const spans = off ? [] : spansFor(p.hours, d)
  const base = cn(
    'flex flex-col items-center justify-center gap-0.5 rounded border text-center',
    compact ? 'min-h-[44px] px-0.5 py-1' : 'min-h-[52px] px-1 py-1',
    today && compact && 'ring-primary/40 ring-2',
  )
  if (off)
    return (
      <span className={cn(base, 'bg-amber-bg text-amber border-amber/30 font-medium')}>
        <CalendarOff size={compact ? 12 : 14} aria-hidden="true" />
        {!compact && <span className="text-[11px]">{t('calendar.board.dayOff')}</span>}
      </span>
    )
  if (spans.length === 0)
    return (
      <span
        className={cn(
          base,
          'bg-surface text-ink-3 border-border border-dashed font-semibold',
          compact ? 'text-[9px]' : 'text-[11px]',
        )}
      >
        {t('calendar.board.off')}
      </span>
    )
  return (
    <span className={cn(base, 'bg-green-bg border-green-dot/40')}>
      {spans.map((s) => (
        <span
          key={s[0]}
          className={cn(
            'text-green font-semibold whitespace-nowrap tabular-nums',
            compact ? 'text-[9px] leading-tight' : 'text-[11px] md:text-[12px]',
          )}
        >
          {compact ? (
            shortSpan(s)
          ) : (
            <>
              <span className="lg:hidden">{shortSpan(s)}</span>
              <span className="hidden lg:inline">
                {s[0]}–{s[1]}
              </span>
            </>
          )}
        </span>
      ))}
      {free !== null && (
        <span
          className={cn(
            'font-semibold',
            compact ? 'text-[9px] leading-tight' : 'text-[11px]',
            free === 0 ? 'text-red' : 'text-ink-2',
          )}
        >
          {free === 0
            ? compact
              ? '0'
              : t('calendar.board.full')
            : compact
              ? String(free)
              : t('calendar.board.free', { count: free })}
        </span>
      )}
    </span>
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

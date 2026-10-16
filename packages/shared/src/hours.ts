import type { ClinicHours, DayKey, TimeSpan, WeeklyHours } from './types'

export const DAY_KEYS: readonly DayKey[] = ['0', '1', '2', '3', '4', '5', '6']

/** "08:30" → 510. */
export const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}
const pad = (n: number): string => String(n).padStart(2, '0')
export const hhmm = (minutes: number): string =>
  `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`

export const dayKeyOf = (date: Date): DayKey => String(date.getDay()) as DayKey

/** Working spans of a practitioner on a given date. */
export const spansFor = (hours: WeeklyHours, date: Date): TimeSpan[] => hours[dayKeyOf(date)] ?? []

/** Weekdays (0–6) that have at least one working span. */
export const weekdaysOf = (hours: WeeklyHours): number[] =>
  DAY_KEYS.filter((k) => (hours[k]?.length ?? 0) > 0).map(Number)

/** Sample-data helper: the same span on each listed weekday. */
export const hoursFromRange = (
  workdays: number[],
  startHour: number,
  endHour: number,
): WeeklyHours => {
  const span: TimeSpan = [hhmm(startHour * 60), hhmm(endHour * 60)]
  const out: WeeklyHours = {}
  for (const d of workdays) out[String(d) as DayKey] = [span]
  return out
}

/** First and last working minute of the week, e.g. 08:00–17:00 for the calendar header. */
export function hoursRange(hours: WeeklyHours): { start: string; end: string } | null {
  let min = Infinity
  let max = -Infinity
  for (const k of DAY_KEYS) {
    for (const [a, b] of hours[k] ?? []) {
      min = Math.min(min, toMinutes(a))
      max = Math.max(max, toMinutes(b))
    }
  }
  return Number.isFinite(min) ? { start: hhmm(min), end: hhmm(max) } : null
}

export interface OpenStatus {
  open: boolean
  /** Today's closing time when open. */
  closesAt?: string
  /** Today's opening time when closed before opening, or tomorrow's when closed for the day. */
  opensAt?: string
}

/** Is the clinic open at `now` (clinic local time assumed)? */
export function openStatus(hours: ClinicHours, now: Date): OpenStatus {
  const today = hours.days[dayKeyOf(now)]
  const minutes = now.getHours() * 60 + now.getMinutes()
  if (today) {
    const [a, b] = today
    if (minutes >= toMinutes(a) && minutes < toMinutes(b)) return { open: true, closesAt: b }
    if (minutes < toMinutes(a)) return { open: false, opensAt: a }
  }
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() + i)
    const span = hours.days[dayKeyOf(d)]
    if (span) return { open: false, opensAt: span[0] }
  }
  return { open: false }
}

/** Rows for the opening-hours card: Monday–Friday, Saturday, Sunday & holidays, Laboratory. */
export const isAllDay = (s?: TimeSpan): boolean =>
  !!s && toMinutes(s[0]) === 0 && toMinutes(s[1]) >= 24 * 60 - 1

/** True when every day of the week is a full 24 hours. */
export const isOpen247 = (hours: ClinicHours): boolean =>
  DAY_KEYS.every((k) => isAllDay(hours.days[k]))

export interface HoursRow {
  key: 'monSun' | 'monFri' | 'sat' | 'sunHol' | 'lab'
  time: string
  allDay: boolean
}

export function hoursRows(hours: ClinicHours): HoursRow[] {
  const row = (key: HoursRow['key'], s?: TimeSpan): HoursRow => ({
    key,
    time: s ? `${s[0]} – ${s[1]}` : '—',
    allDay: isAllDay(s),
  })
  if (isOpen247(hours)) return [row('monSun', hours.days['1']), row('lab', hours.lab)]
  return [
    row('monFri', hours.days['1']),
    row('sat', hours.days['6']),
    row('sunHol', hours.days['0']),
    row('lab', hours.lab),
  ]
}

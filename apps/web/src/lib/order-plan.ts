/**
 * 0198 · When an order of step 6 is given, and how often (DESIGN §D, §E): "Give at" (now, or a
 * day and a time at the clinic, up to 7 days ahead) and "Repeat" (every N hours, N times, N days
 * or until stopped). Pure: the clinic's clock is Kigali (UTC+2) whatever the device's own.
 */

const H = 3_600_000
const KIGALI = 2 * H
const pad = (n: number) => String(n).padStart(2, '0')

/** The repeat choices of the form, in hours (4 h … once a day). */
export const EVERY_CHOICES = [4, 6, 8, 12, 24] as const
/** The database's limits (create_order_planned): every 1 h … 7 days; 2 … 200 times. */
export const EVERY_MAX_HOURS = 168
export const TIMES_MIN = 2
export const TIMES_MAX = 200
/** Give at: up to 7 days ahead (and 5 minutes back, the time to press Send). */
export const AHEAD_DAYS = 7

/** The clinic's day of a moment (yyyy-mm-dd). */
export const kigaliDayOf = (ms: number) => new Date(ms + KIGALI).toISOString().slice(0, 10)
/** "14:05" at the clinic. */
export const kigaliClock = (ms: number) => new Date(ms + KIGALI).toISOString().slice(11, 16)
/** "26/11" at the clinic. */
export const kigaliDayMonth = (ms: number) => {
  const d = new Date(ms + KIGALI)
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`
}

/** The moment of a clinic day and time ("2026-11-24", "14:00") as ISO; null when not valid. */
export function firstAtOf(day: string, time: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  const t = /^(\d{2}):(\d{2})$/.exec(time)
  if (!d || !t) return null
  const ms = Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!, +t[1]!, +t[2]!) - KIGALI
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** The days the form offers: today and the next 7 (yyyy-mm-dd). */
export const dayChoices = (now: number): string[] =>
  Array.from({ length: AHEAD_DAYS + 1 }, (_, k) => kigaliDayOf(now + k * 24 * H))

/** The times of a day, every 30 minutes; today only those still to come. */
export function timeChoices(day: string, now: number): string[] {
  const today = day === kigaliDayOf(now)
  const nowMin = today ? Math.floor(((now + KIGALI) % (24 * H)) / 60_000) : -1
  const out: string[] = []
  for (let m = 0; m < 24 * 60; m += 30)
    if (m > nowMin) out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`)
  return out
}

/** The next half hour at the clinic (the time proposed when "At a time" is chosen). */
export function nextHalfHour(now: number): { day: string; time: string } {
  const ms = Math.ceil((now + 1) / (30 * 60_000)) * 30 * 60_000
  return { day: kigaliDayOf(ms), time: kigaliClock(ms) }
}

/** A time to give is allowed: from 5 minutes back to 7 days ahead. */
export const firstAtAllowed = (iso: string, now: number) => {
  const ms = Date.parse(iso)
  return ms >= now - 5 * 60_000 && ms <= now + AHEAD_DAYS * 24 * H
}

export type ForKind = 'times' | 'days' | 'until'
export interface RepeatChoice {
  /** One of EVERY_CHOICES as text, or 'other' (then `everyOther` hours). */
  every: string
  everyOther: string
  forKind: ForKind
  /** How many times, or days. */
  forCount: string
}

/** Every how many hours: a whole number 1 … 168; null when not valid. */
export function everyHoursOf(r: Pick<RepeatChoice, 'every' | 'everyOther'>): number | null {
  const h = Number(r.every === 'other' ? r.everyOther : r.every)
  return Number.isInteger(h) && h >= 1 && h <= EVERY_MAX_HOURS ? h : null
}

/**
 * How many times: the number typed; for days, days × 24 ÷ hours (whole times only: 3 days every
 * 8 hours = 9; never more than the days hold); 'until' when until stopped; null when not valid
 * (fewer than 2 or more than 200).
 */
export function timesOf(r: RepeatChoice, hours: number | null): number | 'until' | null {
  if (r.forKind === 'until') return 'until'
  const n = Number(r.forCount)
  if (!Number.isInteger(n) || n < 1 || !hours) return null
  const times = r.forKind === 'days' ? Math.floor((n * 24) / hours) : n
  return times >= TIMES_MIN && times <= TIMES_MAX ? times : null
}

/** The first and last planned times of a repeat (ms). */
export const planEnds = (first: number, hours: number, times: number) => ({
  first,
  last: first + (times - 1) * hours * H,
})

/** "14:00" today, "26/11 14:00" another day (at the clinic). */
export const whenText = (ms: number, now: number) =>
  kigaliDayOf(ms) === kigaliDayOf(now)
    ? kigaliClock(ms)
    : `${kigaliDayMonth(ms)} ${kigaliClock(ms)}`

/**
 * The plan of a repeat in words ("First at 14:00, then every 8 hours: 9 times, last on 27/11
 * 06:00"); null when once or not valid yet.
 */
export function planText(
  t: (key: string, vars?: Record<string, unknown>) => string,
  w: WhenValue,
  now: number,
): string | null {
  const hours = everyHoursOf(w)
  if (w.repeat !== 'repeat' || !hours) return null
  const count = timesOf(w, hours)
  const firstIso = w.giveAt === 'later' ? firstAtOf(w.atDay, w.atTime) : null
  const first = firstIso ? Date.parse(firstIso) : now
  if (count === 'until') return t('nurseOrders.planUntil', { first: whenText(first, now), hours })
  if (count == null) return null
  return t('nurseOrders.plan', {
    first: whenText(first, now),
    hours,
    count,
    last: whenText(planEnds(first, hours, count).last, now),
  })
}

/** Give at and Repeat (0198), as the form keeps them. */
/** (the form keeps these as text) */
export interface WhenValue {
  giveAt: 'now' | 'later'
  atDay: string
  atTime: string
  repeat: 'once' | 'repeat'
  every: string
  everyOther: string
  forKind: ForKind
  forCount: string
}

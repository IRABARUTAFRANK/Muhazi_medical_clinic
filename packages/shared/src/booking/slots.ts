import type { Practitioner } from '../types'
import { addDays, startOfDay } from '../clock'
import { isoDate } from '../format'
import { spansFor, toMinutes, weekdaysOf } from '../hours'

/** Public calendar shows 07:00–18:00 rows (lab opens 07–19; doctors work inside that window). */
export const BOOKING_FIRST_HOUR = 7
export const BOOKING_LAST_HOUR = 19
export const MAX_WEEKS_AHEAD = 3
/** A slot is held for 24 h after an inquiry (doc §6). */
export const INQUIRY_HOLD_HOURS = 24

export const bookingHours = (): number[] =>
  Array.from({ length: BOOKING_LAST_HOUR - BOOKING_FIRST_HOUR }, (_, i) => BOOKING_FIRST_HOUR + i)

/** Deterministic sample bookings used when no live booked slots are available. */
export const isSampleBooked = (seed: number, dayIdx: number, hour: number): boolean =>
  (seed * 31 + dayIdx * 17 + hour * 13) % 10 < 4

/** Key of a slot in a booked set: local date + hour, e.g. `2026-10-19T10`. */
export const slotKey = (date: Date, hour: number): string =>
  `${isoDate(date)}T${String(hour).padStart(2, '0')}`

/** Key of a five-minute step taken by a booking: local date + time, e.g. `2026-10-19T10:35`. */
export const minuteKey = (date: Date, minuteOfDay: number): string =>
  `${isoDate(date)}T${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`

/**
 * Mark a booking in a booked set: its hour (kept for older callers) and every five-minute step
 * it covers, so a 30-minute booking at 09:00 leaves 09:30 free.
 */
export function markBooked(set: Set<string>, start: Date, end?: Date | null): void {
  set.add(slotKey(start, start.getHours()))
  const from = start.getHours() * 60 + start.getMinutes()
  const minutes = end ? Math.max(5, Math.round((end.getTime() - start.getTime()) / 60_000)) : 30
  for (let m = from; m < from + minutes && m < 24 * 60; m += 5)
    set.add(minuteKey(start, m - (m % 5)))
}

/** Build a booked set from `public_booked_slots.starts_at` values (ISO strings or Dates). */
export function bookedSetFrom(startsAt: Iterable<string | Date>): Set<string> {
  const set = new Set<string>()
  for (const s of startsAt) markBooked(set, typeof s === 'string' ? new Date(s) : s)
  return set
}

/** The doctor's slot length used on the grid (5 to 60 minutes). */
const stepOf = (p: Practitioner) => Math.min(60, Math.max(5, p.slotMinutes || 60))

/**
 * The start minutes (0–59) of the slots inside this hour that fit a working period: every slot
 * of the doctor's length, e.g. 0 and 30 for 30-minute slots.
 */
export function slotMinutesIn(p: Practitioner, date: Date, hour: number): number[] {
  if (isDayOff(p, date)) return []
  const step = stepOf(p)
  const spans = spansFor(p.hours, date)
  const out: number[] = []
  for (let m = 0; m < 60; m += step) {
    const start = hour * 60 + m
    const end = start + step
    if (spans.some(([a, b]) => start >= toMinutes(a) && end <= toMinutes(b))) out.push(m)
  }
  return out
}

/** Free slot starts in this hour: not past, not covered by a confirmed booking. */
export function freeMinutesIn(
  p: Practitioner,
  now: Date,
  dayIdx: number,
  hour: number,
  booked?: ReadonlySet<string>,
): number[] {
  const date = addDays(startOfDay(now), dayIdx)
  const step = stepOf(p)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  return slotMinutesIn(p, date, hour).filter((m) => {
    const start = hour * 60 + m
    if (dayIdx === 0 && start <= nowMin) return false
    if (!booked) return true
    for (let t = start - (start % 5); t < start + step; t += 5)
      if (booked.has(minuteKey(date, t))) return false
    return true
  })
}

/** A date the practitioner marked as a day off (leave, training, …). */
export const isDayOff = (p: Practitioner, date: Date): boolean =>
  !!p.daysOff?.includes(isoDate(date))

/** Working at this minute: inside one of the day's periods and not a day off. */
export const workingAt = (p: Practitioner, at: Date): boolean => {
  if (isDayOff(p, at)) return false
  const m = at.getHours() * 60 + at.getMinutes()
  return spansFor(p.hours, at).some(([a, b]) => m >= toMinutes(a) && m < toMinutes(b))
}

/** At least one whole slot of that hour falls inside a working span, unless it is a day off. */
export const isWorking = (p: Practitioner, date: Date, hour: number): boolean =>
  slotMinutesIn(p, date, hour).length > 0

export type SlotState = 'free' | 'booked' | 'off'

/**
 * @param dayIdx days from today (0 = today). Hours already passed today count as booked.
 * @param booked live booked slots; when omitted the deterministic sample pattern is used.
 */
export function slotState(
  p: Practitioner,
  now: Date,
  dayIdx: number,
  hour: number,
  booked?: ReadonlySet<string>,
): SlotState {
  const date = addDays(startOfDay(now), dayIdx)
  if (!isWorking(p, date, hour)) return 'off'
  // live: free while one slot of the hour is still free; sample: the deterministic pattern
  if (booked) return freeMinutesIn(p, now, dayIdx, hour, booked).length > 0 ? 'free' : 'booked'
  const past = dayIdx === 0 && hour <= now.getHours()
  return past || isSampleBooked(p.seed, dayIdx, hour) ? 'booked' : 'free'
}

export interface DayAvailability {
  date: Date
  /** Free slots that day, or null when the practitioner is off. */
  free: number | null
}

/** Seven days of free-slot counts, for the landing cards. */
export function weekAvailability(
  p: Practitioner,
  now: Date,
  weekOffset = 0,
  booked?: ReadonlySet<string>,
): DayAvailability[] {
  const workdays = weekdaysOf(p.hours)
  return Array.from({ length: 7 }, (_, i) => {
    const dayIdx = weekOffset * 7 + i
    const date = addDays(startOfDay(now), dayIdx)
    if (!workdays.includes(date.getDay()) || isDayOff(p, date)) return { date, free: null }
    let free = 0
    for (const h of bookingHours()) if (slotState(p, now, dayIdx, h, booked) === 'free') free++
    return { date, free }
  })
}

export interface FreeSlot {
  date: Date
  hour: number
  dayIdx: number
}

export function nextFreeSlot(
  p: Practitioner,
  now: Date,
  horizonDays = 14,
  booked?: ReadonlySet<string>,
): FreeSlot | null {
  for (let dayIdx = 0; dayIdx < horizonDays; dayIdx++) {
    const date = addDays(startOfDay(now), dayIdx)
    for (const hour of bookingHours()) {
      if (slotState(p, now, dayIdx, hour, booked) === 'free') return { date, hour, dayIdx }
    }
  }
  return null
}

export interface CalendarCell {
  dayIdx: number
  date: Date
  hour: number
  state: SlotState
  id: string
}
export interface CalendarRow {
  hour: number
  cells: CalendarCell[]
}

export const slotId = (p: Practitioner, date: Date, hour: number): string =>
  `${p.code}|${isoDate(date)}|${hour}`

export function parseSlotId(
  id: string,
): { practitionerCode: string; date: Date; hour: number } | null {
  const [practitionerCode, iso, hourText] = id.split('|')
  if (!practitionerCode || !iso || hourText === undefined) return null
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return null
  return { practitionerCode, date: new Date(y, m - 1, d), hour: Number(hourText) }
}

export function buildCalendar(
  p: Practitioner,
  now: Date,
  weekOffset = 0,
  booked?: ReadonlySet<string>,
): { days: Date[]; rows: CalendarRow[] } {
  const days = Array.from({ length: 7 }, (_, i) => addDays(startOfDay(now), weekOffset * 7 + i))
  const rows = bookingHours().map((hour) => ({
    hour,
    cells: days.map((date, i) => {
      const dayIdx = weekOffset * 7 + i
      return {
        dayIdx,
        date,
        hour,
        state: slotState(p, now, dayIdx, hour, booked),
        id: slotId(p, date, hour),
      }
    }),
  }))
  return { days, rows }
}

/** Human reference for a sent inquiry in sample mode, e.g. MMC-2026-4831. The database assigns real ones. */
export function inquiryReference(slot: string, year: number): string {
  let hash = 0
  for (const ch of slot) hash = (hash * 31 + ch.charCodeAt(0)) % 1000
  return `MMC-${year}-${4800 + hash}`
}

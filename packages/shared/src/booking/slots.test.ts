import { describe, expect, it } from 'vitest'
import type { Practitioner } from '../types'
import { hoursFromRange, openStatus } from '../hours'
import {
  bookedSetFrom,
  freeMinutesIn,
  markBooked,
  slotMinutesIn,
  buildCalendar,
  nextFreeSlot,
  parseSlotId,
  slotId,
  slotKey,
  slotState,
  weekAvailability,
} from './slots'

// Thursday 15/10/2026 12:45
const now = new Date(2026, 9, 15, 12, 45)
const doc: Practitioner = {
  id: 'mb',
  code: 'mb',
  name: 'Dr. Mukamana Béatrice',
  title: 'General practitioner',
  cats: ['consultation'],
  langs: 'KIN · EN · FR',
  hours: hoursFromRange([1, 2, 3, 4, 5, 6], 8, 17),
  slotMinutes: 60,
  seed: 3,
}

describe('slotState (sample pattern)', () => {
  it('is off outside working hours and on days off', () => {
    expect(slotState(doc, now, 0, 7)).toBe('off')
    expect(slotState(doc, now, 0, 17)).toBe('off')
    expect(slotState(doc, now, 3, 10)).toBe('off') // Sunday 18/10
  })
  it('treats hours already passed today as booked', () => {
    expect(slotState(doc, now, 0, 12)).toBe('booked')
    expect(['free', 'booked']).toContain(slotState(doc, now, 0, 13))
  })
  it('is deterministic', () => {
    expect(slotState(doc, now, 1, 9)).toBe(slotState(doc, now, 1, 9))
  })
})

describe('slotState (live booked set)', () => {
  it('uses the booked set instead of the sample pattern', () => {
    const friday = new Date(2026, 9, 16)
    const booked = bookedSetFrom([new Date(2026, 9, 16, 9).toISOString()])
    expect(booked.has(slotKey(friday, 9))).toBe(true)
    expect(slotState(doc, now, 1, 9, booked)).toBe('booked')
    expect(slotState(doc, now, 1, 10, booked)).toBe('free')
    expect(slotState(doc, now, 1, 11, new Set())).toBe('free')
  })
  it('respects split working spans', () => {
    const split: Practitioner = {
      ...doc,
      hours: {
        '1': [
          ['08:00', '12:00'],
          ['14:00', '17:00'],
        ],
      },
    }
    const monday = 4 // 19/10/2026
    expect(slotState(split, now, monday, 11, new Set())).toBe('free')
    expect(slotState(split, now, monday, 12, new Set())).toBe('off')
    expect(slotState(split, now, monday, 13, new Set())).toBe('off')
    expect(slotState(split, now, monday, 14, new Set())).toBe('free')
  })
})

describe('weekAvailability', () => {
  it('returns seven days with null on days off', () => {
    const week = weekAvailability(doc, now)
    expect(week).toHaveLength(7)
    expect(week[3]?.free).toBeNull() // Sunday
    expect(week.filter((d) => d.free !== null)).toHaveLength(6)
  })
  it('counts every working hour as free when nothing is booked (live, empty set)', () => {
    const week = weekAvailability(doc, now, 0, new Set())
    expect(week[1]?.free).toBe(9) // Friday 08–17
  })
})

describe('nextFreeSlot', () => {
  it('finds a free slot within two weeks that is really free', () => {
    const slot = nextFreeSlot(doc, now)
    expect(slot).not.toBeNull()
    expect(slotState(doc, now, slot!.dayIdx, slot!.hour)).toBe('free')
  })
})

describe('calendar', () => {
  it('has 12 hour rows of 7 cells and stable ids', () => {
    const { days, rows } = buildCalendar(doc, now, 0)
    expect(days).toHaveLength(7)
    expect(rows).toHaveLength(12)
    expect(rows[0]?.cells).toHaveLength(7)
    const id = slotId(doc, days[1]!, 9)
    expect(parseSlotId(id)).toEqual({
      practitionerCode: 'mb',
      date: new Date(2026, 9, 16),
      hour: 9,
    })
  })
})

describe('openStatus', () => {
  const hours = {
    days: {
      '0': ['08:00', '16:00'] as [string, string],
      '1': ['07:00', '20:00'] as [string, string],
      '4': ['07:00', '20:00'] as [string, string],
      '6': ['07:00', '18:00'] as [string, string],
    },
  }
  it('is open on Thursday 12:45 and closes at 20:00', () => {
    expect(openStatus(hours, now)).toEqual({ open: true, closesAt: '20:00' })
  })
  it('is closed at 21:00 and opens next day', () => {
    expect(openStatus(hours, new Date(2026, 9, 15, 21, 0))).toEqual({
      open: false,
      opensAt: '07:00',
    })
  })
})

describe('slots shorter than an hour', () => {
  const half: Practitioner = { ...doc, slotMinutes: 30 }
  it('offers each slot of the hour, and a booking takes only its own minutes', () => {
    const friday = new Date(2026, 9, 16) // dayIdx 1 from Thursday
    expect(slotMinutesIn(half, friday, 9)).toEqual([0, 30])
    const booked = new Set<string>()
    markBooked(booked, new Date(2026, 9, 16, 9, 0), new Date(2026, 9, 16, 9, 30))
    expect(freeMinutesIn(half, now, 1, 9, booked)).toEqual([30])
    expect(slotState(half, now, 1, 9, booked)).toBe('free')
    markBooked(booked, new Date(2026, 9, 16, 9, 30), new Date(2026, 9, 16, 10, 0))
    expect(slotState(half, now, 1, 9, booked)).toBe('booked')
  })
  it('a slot that has passed today is not offered', () => {
    expect(freeMinutesIn(half, now, 0, 12, new Set())).toEqual([])
    expect(freeMinutesIn(half, now, 0, 13, new Set())).toEqual([0, 30])
  })
})

import { describe, expect, it } from 'vitest'
import { directions, type DispenseLabel } from './dispense-label'
import { pieceContentFromText, takeHomeCount } from './dose'
import { defaultUnit, doseOf, partOf, unitChoices } from './order-dose'
import {
  dayChoices,
  everyHoursOf,
  firstAtAllowed,
  firstAtOf,
  kigaliClock,
  planEnds,
  timeChoices,
  timesOf,
} from './order-plan'
import { summarizeOrder } from './order-summary'

const para = pieceContentFromText({ name: 'Paracetamol', strength: '500 mg', unit: 'tab' })
const syrup = pieceContentFromText({ name: 'Cough syrup', strength: '100 ml', unit: 'bottle' })

describe('the dose on an order: words for the nurse (after 0198)', () => {
  it('the unit offered first and the units of the list', () => {
    expect(defaultUnit(syrup)).toBe('ml')
    expect(defaultUnit(para)).toBe('mg')
    expect(unitChoices(para)).toContain('tablet')
    expect(doseOf({ amount: '1', unit: 'g', other: '' })).toEqual({ amount: 1, unit: 'g' })
    expect(doseOf({ amount: '', unit: 'mg', other: '' })).toBeNull()
  })
  it('the part typed: only what the medicine allows', () => {
    expect(partOf('half', '0.5', null)).toBe(0.5)
    expect(partOf('half', '0.25', null)).toBeNull()
    expect(partOf('quarter', '0.75', null)).toBe(0.75)
    expect(partOf('measure', '5', 100)).toBe(0.05)
    expect(partOf('measure', '5.2', 100)).toBeNull()
    expect(partOf('measure', '100', 100)).toBeNull()
    expect(partOf('half', '', null)).toBe(0)
  })
  it('1 tablet twice a day for 5 days: 10 to take home', () => {
    expect(takeHomeCount({ each: 1, frequency: 'BD', days: 5 })).toMatchObject({ total: 10 })
  })
  it('the label words the piece of "1 tab (500 mg)" and keeps the strength', () => {
    const t = ((_k: string, o: { defaultValue?: string; count?: number; dose?: string }) =>
      (o.defaultValue ?? '')
        .replace('{{count}}', String(o.count ?? ''))
        .replace('{{dose}}', o.dose ?? '')) as never
    const label = { dose: '1 tab (500 mg)', frequency: 'BD', days: 5 } as DispenseLabel
    expect(directions(label, t)).toMatch(/^Take 1 tablet \(500 mg\)/)
  })
})

describe('give at and repeat (0198)', () => {
  const now = Date.parse('2026-11-24T10:10:00Z') // 12:10 at the clinic
  it('a clinic time is UTC+2, today only the times to come, up to 7 days', () => {
    expect(firstAtOf('2026-11-24', '14:00')).toBe('2026-11-24T12:00:00.000Z')
    expect(timeChoices('2026-11-24', now)[0]).toBe('12:30')
    expect(timeChoices('2026-11-25', now)[0]).toBe('00:00')
    expect(dayChoices(now)).toHaveLength(8)
    expect(firstAtAllowed('2026-11-24T12:00:00.000Z', now)).toBe(true)
    expect(firstAtAllowed('2026-12-24T12:00:00.000Z', now)).toBe(false)
    expect(kigaliClock(now)).toBe('12:10')
  })
  it('every 8 hours: 3 times; 3 days = 9 times; until stopped; limits', () => {
    const r = { every: '8', everyOther: '', forKind: 'times' as const, forCount: '3' }
    expect(everyHoursOf(r)).toBe(8)
    expect(timesOf(r, 8)).toBe(3)
    expect(timesOf({ ...r, forKind: 'days' }, 8)).toBe(9)
    expect(timesOf({ ...r, forKind: 'until' }, 8)).toBe('until')
    expect(timesOf({ ...r, forCount: '1' }, 8)).toBeNull()
    expect(everyHoursOf({ every: 'other', everyOther: '200' })).toBeNull()
    expect(planEnds(0, 8, 3).last).toBe(16 * 3_600_000)
  })
})

describe('the box above Send with a part and a repeat (0198)', () => {
  const base = {
    kind: 'drug' as const,
    home: 0,
    stockUnits: 100,
    pack: null,
    cashPrice: 50,
    service: false,
    servicePrice: null,
    actCount: 1,
  }
  it('½ tablet alone: 25 on the bill, one tablet opened', () => {
    const s = summarizeOrder({ ...base, here: 0, part: 0.5, partPrice: 25, partOpens: true })
    expect(s).toMatchObject({ amount: 25, tone: 'ok', partOpens: true, repeat: null })
  })
  it('2 tablets every 8 hours, 3 times: 100 each time, 300 if all are given', () => {
    const s = summarizeOrder({ ...base, here: 2, times: 3 })
    expect(s.repeat).toEqual({ each: 100, times: 3, all: 300 })
  })
  it('the opened piece counts in the stock check', () => {
    expect(
      summarizeOrder({ ...base, stockUnits: 2, here: 2, part: 0.5, partPrice: 25, partOpens: true })
        .tone,
    ).toBe('short')
  })
})

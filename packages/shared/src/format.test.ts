import { describe, expect, it } from 'vitest'
import {
  formatDate,
  formatDayMonth,
  formatHour,
  formatRwf,
  formatTime,
  initials,
  isoDate,
} from './format'

describe('money', () => {
  it('writes RWF with thousands separators and no decimals', () => {
    expect(formatRwf(18300)).toBe('RWF 18,300')
    expect(formatRwf(1184000)).toBe('RWF 1,184,000')
    expect(formatRwf(0)).toBe('RWF 0')
    expect(formatRwf(2745.4)).toBe('RWF 2,745')
  })
})

describe('dates and times', () => {
  const d = new Date(2026, 9, 5, 7, 5)
  it('uses dd/mm/yyyy and 24-hour time', () => {
    expect(formatDate(d)).toBe('05/10/2026')
    expect(formatDayMonth(d)).toBe('05/10')
    expect(formatTime(d)).toBe('07:05')
    expect(formatHour(9)).toBe('09:00')
    expect(isoDate(d)).toBe('2026-10-05')
  })
})

describe('initials', () => {
  it('drops the Dr. prefix and keeps two letters', () => {
    expect(initials('Dr. Mukamana Béatrice')).toBe('MB')
    expect(initials('Uwimana Josiane')).toBe('UJ')
    expect(initials('Mugabo')).toBe('M')
  })
})

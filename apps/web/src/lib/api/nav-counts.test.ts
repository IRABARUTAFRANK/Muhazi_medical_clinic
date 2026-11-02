import { describe, expect, it } from 'vitest'
import type { NavItem } from '@mmc/shared'
import { countText, navCountOf, navLinkLabel, sampleNavCounts } from './nav-counts'

const item = (countKey?: string): NavItem => ({
  id: 'queue',
  labelKey: 'nav.queue',
  icon: 'list-ordered',
  to: '/app/queue',
  countKey,
})

describe('menu counts (0121)', () => {
  it('shows a count only above zero, red for what waits for me', () => {
    expect(navCountOf(item('queue'), { queue: 2 })).toEqual({ key: 'queue', n: 2, urgent: true })
    expect(navCountOf(item('inClinic'), { inClinic: 5 })).toEqual({
      key: 'inClinic',
      n: 5,
      urgent: false,
    })
    expect(navCountOf(item('queue'), { queue: 0 })).toBeNull()
    // a count the person does not get, or an entry without a count (Calendar)
    expect(navCountOf(item('queue'), {})).toBeNull()
    expect(navCountOf(item(), { queue: 3 })).toBeNull()
    expect(navCountOf(item('calendar'), { queue: 3 })).toBeNull()
  })

  it('caps at 99+', () => {
    expect(countText(7)).toBe('7')
    expect(countText(99)).toBe('99')
    expect(countText(100)).toBe('99+')
  })

  it('reads "My queue, 2 waiting" to a screen reader', () => {
    const t = ((key: string, o: { count: number }) => `${o.count} ${key}`) as never
    expect(navLinkLabel(t, 'My queue', { key: 'queue', n: 2, urgent: true })).toBe(
      'My queue, 2 navCount.queue',
    )
    expect(navLinkLabel(t, 'My queue', null)).toBeUndefined()
  })

  it('sample counts: the cashier has money only, the doctor no money', () => {
    expect(Object.keys(sampleNavCounts({ role: 'cashier' })).sort()).toEqual(['bills', 'payments'])
    const doctor = sampleNavCounts({ role: 'doctor' })
    expect(doctor.queue).toBeGreaterThan(0)
    expect(doctor.bills).toBeUndefined()
  })
})

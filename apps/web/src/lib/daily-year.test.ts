import { describe, expect, it } from 'vitest'
import { DASHBOARD_RANGES, isDashboardRange, rangeDates, yearsFrom } from './api/dashboard'
import { clean, navCountOf, navLinkLabel } from './api/nav-counts'
import { countNotices, isKigaliToday, type Notice } from './api/notifications'

const notice = (over: Partial<Notice>): Notice => ({
  id: 'n',
  at: new Date().toISOString(),
  kind: 'message',
  params: {},
  title: null,
  body: null,
  link: null,
  urgent: false,
  read: false,
  sender: null,
  today: true,
  ...over,
})

describe('0122: the counts are for the day', () => {
  it('the red count is today’s unread only; older unread ones are counted apart', () => {
    const c = countNotices([
      notice({ id: 'a' }),
      notice({ id: 'b', read: true }),
      notice({ id: 'c', today: false }),
      notice({ id: 'd', today: false, read: true }),
    ])
    expect(c.unread).toBe(1)
    expect(c.unreadEarlier).toBe(1)
    expect(c.items).toHaveLength(4)
  })

  it('today is the Kigali day (UTC+2), not the computer’s', () => {
    const now = new Date('2026-11-02T08:00:00Z') // 10:00 in Kigali
    expect(isKigaliToday('2026-11-01T22:30:00Z', now)).toBe(true) // 00:30 in Kigali
    expect(isKigaliToday('2026-11-01T21:30:00Z', now)).toBe(false) // 23:30 yesterday
  })

  it('the "<key>Earlier" counts go apart, zeros dropped, never in the badge number', () => {
    const c = clean({ queue: 2, queueEarlier: 3, inClinicEarlier: 0, bills: 1, junk: 'x' })
    expect(c).toEqual({ queue: 2, bills: 1, earlier: { queue: 3 } })
    const item = { id: 'q', labelKey: 'nav.myQueue', icon: 'users', to: '/app/queue' }
    expect(navCountOf({ ...item, countKey: 'queue' }, c)).toEqual({
      key: 'queue',
      n: 2,
      urgent: true,
      earlier: 3,
    })
    // only some from earlier days: the entry still shows them (n = 0 today)
    expect(navCountOf({ ...item, countKey: 'queue' }, { earlier: { queue: 1 } })).toEqual({
      key: 'queue',
      n: 0,
      urgent: true,
      earlier: 1,
    })
    const t = ((key: string, o: { count: number }) => `${o.count} ${key}`) as never
    expect(navLinkLabel(t, 'My queue', { key: 'queue', n: 2, urgent: true, earlier: 3 })).toBe(
      'My queue, 2 navCount.queue, 3 daily.earlierShort',
    )
  })
})

describe('This year', () => {
  it('is a period after This month, accepted in an address', () => {
    expect(DASHBOARD_RANGES.indexOf('year')).toBe(DASHBOARD_RANGES.indexOf('month') + 1)
    expect(isDashboardRange('year')).toBe(true)
    expect(isDashboardRange('decade')).toBe(false)
  })

  it('runs from 1 January to today', () => {
    const now = new Date(2027, 4, 17)
    const { from, to } = rangeDates('year', now)
    expect([from.getFullYear(), from.getMonth(), from.getDate()]).toEqual([2027, 0, 1])
    expect(to).toBe(now)
  })

  it('the year list: from the first visit’s year to this one, growing each new year', () => {
    const now = new Date(2027, 1, 3)
    // no visit yet: this year only
    expect(yearsFrom(null, now)).toEqual([2027])
    expect(yearsFrom(2027, now)).toEqual([2027])
    // records since 2026: 2026 and 2027; nothing before the clinic's records
    expect(yearsFrom(2026, now)).toEqual([2026, 2027])
    expect(yearsFrom(2026, new Date(2026, 5, 1))).toEqual([2026])
    // every year since the first, however many
    expect(yearsFrom(2015, now)).toHaveLength(13)
  })
})

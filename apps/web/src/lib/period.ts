import { useState } from 'react'
import { useLocation, useRouter } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { formatDate, isoDate } from '@mmc/shared'
import { rangeDates, type CustomRange, type DashboardRange } from '@/lib/api/dashboard'

export interface Period {
  range: DashboardRange
  setRange: (r: DashboardRange) => void
  custom: CustomRange
  setCustom: (c: CustomRange) => void
  /** The days covered, ISO, both included. */
  from: string
  to: string
  /** "Mon 21/10 – Thu 24/10/2026", for the page and the reports. */
  label: string
}

/** "21/10/2026", "Since the start · up to …" or "Mon 21/10 – Thu 24/10/2026". */
function usePeriodLabel() {
  const { t } = useTranslation()
  return (range: DashboardRange, from: Date, to: Date) =>
    range === 'today' || isoDate(from) === isoDate(to)
      ? formatDate(to)
      : range === 'all'
        ? t('dashboard.rangeLabels.all', { to: formatDate(to) })
        : t('dashboard.rangeLabels.week', { from: formatDate(from), to: formatDate(to) })
}

/** The first of this month to today: what Custom shows before anything is chosen. */
const thisMonth = (): CustomRange => {
  const d = new Date()
  return { from: isoDate(new Date(d.getFullYear(), d.getMonth(), 1)), to: isoDate(d) }
}

/**
 * The period every dashboard and report filters by: Today · This week · This month · All time ·
 * Custom (a month, or two dates). The week and the month run up to today.
 */
export function usePeriod(initial: DashboardRange = 'today'): Period {
  const labelOf = usePeriodLabel()
  const [range, setRange] = useState<DashboardRange>(initial)
  const [custom, setCustom] = useState<CustomRange>(thisMonth)
  const { from, to } = rangeDates(range, new Date(), custom)
  const label = labelOf(range, from, to)
  return { range, setRange, custom, setCustom, from: isoDate(from), to: isoDate(to), label }
}

type Search = Record<string, unknown>
const RANGES: readonly DashboardRange[] = ['today', 'week', 'month', 'all', 'custom']
const ISO = /^\d{4}-\d{2}-\d{2}$/
const isoOf = (v: unknown) =>
  typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
    ? v
    : undefined

/**
 * The same period, kept in the address like the Analytics page (`?range=week`,
 * `?range=custom&from=2026-10-01&to=2026-10-24`): it survives a reload, Back restores it and a
 * link carries it. A range other than custom is recomputed from today, so a "This month" link
 * keeps rolling; from/to alone mean custom. `initial` is the page's own default (left out of the
 * address); `initialCustom` the days Custom opens on when it is the default (e.g. the last 7 days).
 * `day` (an older link: one day, `?day=2026-10-21`) opens that day as Custom.
 */
export function useSearchPeriod(
  initial: DashboardRange = 'today',
  initialCustom?: CustomRange,
): Period {
  const labelOf = usePeriodLabel()
  const router = useRouter()
  const search = useLocation({ select: (l) => l.search as Search })
  const today = new Date()
  const max = isoDate(today)
  const legacyDay = isoOf(search.day)
  let sFrom = isoOf(search.from)
  let sTo = isoOf(search.to)
  let asked = RANGES.includes(search.range as DashboardRange)
    ? (search.range as DashboardRange)
    : undefined
  if (!asked && !sFrom && !sTo && legacyDay) {
    asked = 'custom'
    sFrom = legacyDay
    sTo = legacyDay
  }
  const hasDates = !!sFrom && !!sTo
  // custom: the dates of the address, in order, never after today
  let custom: CustomRange = initialCustom ?? thisMonth()
  if (hasDates) {
    const [a, b] = sFrom! <= sTo! ? [sFrom!, sTo!] : [sTo!, sFrom!]
    custom = { from: a > max ? max : a, to: b > max ? max : b }
  }
  const range: DashboardRange = asked ?? (hasDates ? 'custom' : initial)
  const { from, to } = rangeDates(range, today, custom)
  const update = (patch: Search) =>
    void router.navigate({
      to: '.',
      search: (s: Search) =>
        Object.fromEntries(
          Object.entries({ ...s, ...patch, day: undefined }).filter(([, v]) => v !== undefined),
        ),
      replace: true,
    } as never)
  return {
    range,
    setRange: (r) =>
      update(
        r === 'custom'
          ? { range: r, from: custom.from, to: custom.to }
          : { range: r === initial ? undefined : r, from: undefined, to: undefined },
      ),
    custom,
    setCustom: (c) => update({ range: 'custom', from: c.from, to: c.to }),
    from: isoDate(from),
    to: isoDate(to),
    label: labelOf(range, from, to),
  }
}

/**
 * A link to another page with the same period ("Details", "Payments and day close"):
 * `/app/payments?range=week`, `…?range=custom&from=…&to=…`, or the bare path for Today.
 */
export const periodHref = (path: string, p: Pick<Period, 'range' | 'from' | 'to'>): string =>
  p.range === 'custom'
    ? `${path}?range=custom&from=${p.from}&to=${p.to}`
    : p.range === 'today'
      ? path
      : `${path}?range=${p.range}`

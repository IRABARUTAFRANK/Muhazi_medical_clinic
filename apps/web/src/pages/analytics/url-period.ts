import { useTranslation } from 'react-i18next'
import { formatDate, isoDate } from '@mmc/shared'
import { rangeDates, type CustomRange, type DashboardRange } from '@/lib/api/dashboard'
import type { Period } from '@/lib/period'
import type { AnalyticsSearch, UpdateSearch } from './search'

/** "2026-10-21" as a local date (no time-zone shift). */
export const dayDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

/**
 * The period of the Analytics page, read from and written to the address (range, from, to), with
 * the same shape as usePeriod so PeriodSeg, PeriodCustom and the reports work unchanged.
 * A range other than custom is recomputed from today, so a "This month" link keeps rolling;
 * from/to without a range mean custom. Default: this month.
 */
export function useUrlPeriod(search: AnalyticsSearch, update: UpdateSearch): Period {
  const { t } = useTranslation()
  const today = new Date()
  const hasDates = !!search.from && !!search.to
  const range: DashboardRange =
    search.range === 'custom' && !hasDates
      ? 'month'
      : (search.range ?? (hasDates ? 'custom' : 'month'))
  const monthStart = isoDate(new Date(today.getFullYear(), today.getMonth(), 1))
  // custom: the dates of the address, in order, never after today
  let custom: CustomRange = { from: monthStart, to: isoDate(today) }
  if (hasDates) {
    const a = search.from!
    const b = search.to!
    const [from, to] = a <= b ? [a, b] : [b, a]
    const max = isoDate(today)
    custom = { from: from > max ? max : from, to: to > max ? max : to }
  }
  const { from, to } = rangeDates(range, today, custom)
  const label =
    range === 'today'
      ? formatDate(to)
      : range === 'all'
        ? t('dashboard.rangeLabels.all', { to: formatDate(to) })
        : t('dashboard.rangeLabels.week', { from: formatDate(from), to: formatDate(to) })
  return {
    range,
    setRange: (r) =>
      update(
        r === 'custom'
          ? { range: r, from: custom.from, to: custom.to, day: undefined }
          : { range: r, from: undefined, to: undefined, day: undefined },
        { replace: true },
      ),
    custom,
    setCustom: (c) => update({ range: 'custom', from: c.from, to: c.to }, { replace: true }),
    from: isoDate(from),
    to: isoDate(to),
    label,
  }
}

import { useState } from 'react'
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

/**
 * The period every dashboard and report filters by: Today · This week · This month · All time ·
 * Custom (a month, or two dates). The week and the month run up to today.
 */
export function usePeriod(initial: DashboardRange = 'today'): Period {
  const { t } = useTranslation()
  const [range, setRange] = useState<DashboardRange>(initial)
  const [custom, setCustom] = useState<CustomRange>(() => {
    const d = new Date()
    return { from: isoDate(new Date(d.getFullYear(), d.getMonth(), 1)), to: isoDate(d) }
  })
  const { from, to } = rangeDates(range, new Date(), custom)
  const label =
    range === 'today'
      ? formatDate(to)
      : range === 'all'
        ? t('dashboard.rangeLabels.all', { to: formatDate(to) })
        : t('dashboard.rangeLabels.week', { from: formatDate(from), to: formatDate(to) })
  return { range, setRange, custom, setCustom, from: isoDate(from), to: isoDate(to), label }
}

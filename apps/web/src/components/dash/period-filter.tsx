import { useTranslation } from 'react-i18next'
import { isoDate } from '@mmc/shared'
import { Field } from '@/components/ui/field'
import { Seg } from '@/components/ui/seg'
import type { DashboardRange } from '@/lib/api/dashboard'
import type { Period } from '@/lib/period'
import { cn } from '@/lib/utils'

/** The five choices, for a toolbar. */
export function PeriodSeg({ period, className }: { period: Period; className?: string }) {
  const { t } = useTranslation()
  return (
    <Seg<DashboardRange>
      className={className}
      label={t('dashboard.dateRange')}
      value={period.range}
      onChange={period.setRange}
      options={[
        { value: 'today', label: t('dashboard.ranges.today') },
        { value: 'week', label: t('dashboard.ranges.week') },
        { value: 'month', label: t('dashboard.ranges.month') },
        { value: 'all', label: t('dashboard.ranges.all') },
        { value: 'custom', label: t('dashboard.ranges.custom') },
      ]}
    />
  )
}

/** "Custom": a whole month, or two dates. Shown only while Custom is chosen. */
export function PeriodCustom({ period, className }: { period: Period; className?: string }) {
  const { t } = useTranslation()
  if (period.range !== 'custom') return null
  const { custom, setCustom } = period
  const today = isoDate(new Date())
  const pickMonth = (ym: string) => {
    const [y, m] = ym.split('-').map(Number)
    if (!y || !m) return
    const last = new Date(y, m, 0)
    setCustom({
      from: isoDate(new Date(y, m - 1, 1)),
      to: isoDate(last > new Date() ? new Date() : last),
    })
  }
  return (
    <div className={cn('anim-enter flex flex-wrap items-end gap-3', className)}>
      <Field
        label={t('dashboard.custom.month')}
        type="month"
        value={custom.from.slice(0, 7)}
        max={today.slice(0, 7)}
        onChange={(e) => e.target.value && pickMonth(e.target.value)}
        wrapperClassName="w-44"
      />
      <span className="text-ink-3 pb-3 text-[13px]">{t('dashboard.custom.or')}</span>
      <Field
        label={t('history.from')}
        type="date"
        value={custom.from}
        max={custom.to}
        onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })}
        wrapperClassName="w-44"
      />
      <Field
        label={t('history.to')}
        type="date"
        value={custom.to}
        min={custom.from}
        max={today}
        onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })}
        wrapperClassName="w-44"
      />
      <span className="text-ink-2 pb-3 text-[13px] font-semibold">{period.label}</span>
    </div>
  )
}

/** Both together, for a filter area inside a page. */
export function PeriodFilter({ period, className }: { period: Period; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <PeriodSeg period={period} className="self-start" />
      <PeriodCustom period={period} />
    </div>
  )
}

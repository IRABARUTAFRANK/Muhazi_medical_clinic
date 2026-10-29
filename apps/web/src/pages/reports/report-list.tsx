import { useState } from 'react'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconChip } from '@/components/dash/kit'
import { card } from '@/components/dash/kit-style'
import { controlClass } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { matches } from '@/lib/paging'
import { REPORT_GROUPS } from '@/lib/reports/catalog'
import type { AnyReportDef } from '@/lib/reports/defs/types'
import { cn } from '@/lib/utils'
import { GROUP_LOOK } from './report-look'

/**
 * The reports the person may run, grouped (Patients, Finance, Pharmacy…) with each group's
 * icon, and a search box. On a phone and a tablet the list is one select above the report.
 */
export function ReportList({
  reports,
  current,
  onPick,
}: {
  reports: AnyReportDef[]
  current: string | null
  onPick: (id: string) => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const shown = reports.filter((r) => matches(q, t(r.title), t(r.description)))
  const groups = REPORT_GROUPS.map((g) => ({
    g,
    items: shown.filter((r) => r.group === g),
  })).filter((x) => x.items.length > 0)
  return (
    <>
      {/* phones and tablets: one select */}
      <Select
        label={t('reports.ui.chooseReport')}
        wrapperClassName="lg:hidden"
        value={current ?? ''}
        onChange={(e) => e.target.value && onPick(e.target.value)}
      >
        <option value="">{t('reports.ui.chooseReportHint')}</option>
        {REPORT_GROUPS.map((g) => {
          const items = reports.filter((r) => r.group === g)
          return items.length ? (
            <optgroup key={g} label={t(`reports.groups.${g}`)}>
              {items.map((r) => (
                <option key={r.id} value={r.id}>
                  {t(r.title)}
                </option>
              ))}
            </optgroup>
          ) : null
        })}
      </Select>

      <nav
        aria-label={t('reports.ui.listLabel')}
        className={cn(card, 'sticky top-0 hidden gap-2 p-3 lg:flex')}
      >
        <label className="relative block">
          <span className="sr-only">{t('reports.ui.search')}</span>
          <Search
            size={16}
            aria-hidden="true"
            className="text-ink-3 pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
          />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('reports.ui.search')}
            className={cn(controlClass, 'w-full pl-9')}
          />
        </label>
        {groups.length === 0 && (
          <p className="text-ink-3 m-0 px-1 py-2 text-[14px]">{t('reports.ui.noMatch')}</p>
        )}
        {groups.map(({ g, items }) => {
          const look = GROUP_LOOK[g]
          return (
            <section key={g} className="flex flex-col gap-0.5">
              <h2 className="text-ink-2 m-0 flex items-center gap-2 px-1 pt-2 pb-1 text-[12px] font-semibold tracking-wide uppercase">
                <IconChip icon={look.icon} tint={look.hue} size="sm" />
                {t(`reports.groups.${g}`)}
              </h2>
              {items.map((r) => {
                const on = r.id === current
                return (
                  <button
                    key={r.id}
                    type="button"
                    aria-current={on ? 'page' : undefined}
                    onClick={() => onPick(r.id)}
                    className={cn(
                      'focus-visible:ring-primary/20 rounded-md px-2.5 py-2 text-left text-[14px] leading-snug transition-colors duration-120 outline-none focus-visible:ring-2',
                      on ? 'bg-primary-tint text-primary font-semibold' : 'text-ink hover:bg-hover',
                    )}
                  >
                    {t(r.title)}
                  </button>
                )
              })}
            </section>
          )
        })}
      </nav>
    </>
  )
}

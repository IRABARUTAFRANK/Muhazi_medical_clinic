import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { PeriodCustom, PeriodSeg } from '@/components/dash/period-filter'
import { Field, labelClass } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import type { Period } from '@/lib/period'
import type { ReportFilterDef, ReportOption } from '@/lib/reports/defs/types'
import { cn } from '@/lib/utils'

export type FilterDraft = Record<string, string | string[] | boolean>

const optionText = (o: ReportOption, t: (k: string) => string) =>
  o.labelIsKey ? t(o.label) : o.label

/**
 * The report's filters: the shared period (Today · This week · This month · All time · Custom),
 * then each filter of the definition: one choice (a select, "All" first), several choices (pills
 * to tick), a search, or a switch. On a phone they stack.
 */
export function ReportFilters({
  filters,
  period,
  draft,
  onChange,
  options,
  loading,
}: {
  filters: ReportFilterDef[]
  period: Period
  draft: FilterDraft
  onChange: (key: string, value: string | string[] | boolean) => void
  options: Record<string, ReportOption[] | undefined>
  /** Filters whose options are still loading. */
  loading: Record<string, boolean>
}) {
  const { t } = useTranslation()
  const hasPeriod = filters.some((f) => f.kind === 'period')
  const rest = filters.filter((f) => f.kind !== 'period')
  return (
    <div className="flex flex-col gap-4">
      {hasPeriod && (
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>{t('report.period')}</span>
          <PeriodSeg period={period} className="max-w-full flex-wrap self-start" />
          <PeriodCustom period={period} />
        </div>
      )}
      {rest.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rest.map((f) => {
            const opts = options[f.key] ?? f.options ?? []
            const hint = f.hint ? (
              <span className="text-ink-3 text-[12px] font-normal">{t(f.hint)}</span>
            ) : null
            if (f.kind === 'select')
              return (
                <div key={f.key} className="flex flex-col gap-1">
                  <Select
                    label={t(f.label)}
                    value={typeof draft[f.key] === 'string' ? (draft[f.key] as string) : ''}
                    onChange={(e) => onChange(f.key, e.target.value)}
                    disabled={loading[f.key]}
                  >
                    <option value="">{t('reports.ui.all')}</option>
                    {opts.map((o) => (
                      <option key={o.value} value={o.value}>
                        {optionText(o, t)}
                      </option>
                    ))}
                  </Select>
                  {hint}
                </div>
              )
            if (f.kind === 'text')
              return (
                <div key={f.key} className="flex flex-col gap-1">
                  <Field
                    label={t(f.label)}
                    type="search"
                    className="w-full"
                    value={typeof draft[f.key] === 'string' ? (draft[f.key] as string) : ''}
                    placeholder={f.placeholder ? t(f.placeholder) : undefined}
                    onChange={(e) => onChange(f.key, e.target.value)}
                  />
                  {hint}
                </div>
              )
            if (f.kind === 'toggle')
              // the hint under the box, as under a list (beside it, it squeezed the label)
              return (
                <div key={f.key} className="flex flex-col justify-end gap-1">
                  <label className="text-ink flex min-h-[38px] cursor-pointer items-center gap-2 text-[14px] font-medium">
                    <input
                      type="checkbox"
                      className="accent-primary size-4 shrink-0"
                      checked={draft[f.key] === true}
                      onChange={(e) => onChange(f.key, e.target.checked)}
                    />
                    {t(f.label)}
                  </label>
                  {hint}
                </div>
              )
            // several choices: pills; none ticked = all
            const chosen = Array.isArray(draft[f.key]) ? (draft[f.key] as string[]) : []
            return (
              <fieldset
                key={f.key}
                className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0 sm:col-span-2 xl:col-span-3"
              >
                <legend className={cn(labelClass, 'mb-1')}>{t(f.label)}</legend>
                <div className="flex flex-wrap gap-1.5">
                  <Pill on={chosen.length === 0} onClick={() => onChange(f.key, [])}>
                    {t('reports.ui.all')}
                  </Pill>
                  {opts.map((o) => {
                    const on = chosen.includes(o.value)
                    return (
                      <Pill
                        key={o.value}
                        on={on}
                        onClick={() =>
                          onChange(
                            f.key,
                            on ? chosen.filter((x) => x !== o.value) : [...chosen, o.value],
                          )
                        }
                      >
                        {optionText(o, t)}
                      </Pill>
                    )
                  })}
                  {loading[f.key] && (
                    <span className="text-ink-3 self-center text-[13px]">
                      {t('dashboard.loading')}
                    </span>
                  )}
                </div>
                {hint}
              </fieldset>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Pill({
  on,
  onClick,
  children,
}: {
  on: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'focus-visible:ring-primary/20 inline-flex min-h-[max(2rem,var(--tap,0px))] items-center gap-1 rounded-full border px-3 text-[13px] font-medium transition-colors duration-120 outline-none focus-visible:ring-2',
        on
          ? 'border-primary/40 bg-primary-tint text-primary'
          : 'border-border bg-card text-ink-2 hover:bg-hover',
      )}
    >
      {on && <Check size={14} aria-hidden="true" />}
      {children}
    </button>
  )
}

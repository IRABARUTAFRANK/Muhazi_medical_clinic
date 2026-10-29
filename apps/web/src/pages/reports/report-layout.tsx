import { ArrowDown, ArrowUp, Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { labelClass } from '@/components/ui/field'
import { Seg } from '@/components/ui/seg'
import { Select } from '@/components/ui/select'
import type { ReportColumnDef, ReportGroupDef, ReportTotalsAt } from '@/lib/reports/defs/types'
import { COUNT_COLUMN, columnLabel, type GroupMode, type ReportChoices } from '@/lib/reports/run'
import { cn } from '@/lib/utils'

/**
 * How the table is laid out: which columns, in which order (tick, then ↑ / ↓), "Default
 * columns" and "All"; where the totals go; the grouping (details with subtotals, or one row per
 * group); the sort. Private columns carry a lock: they are offered only to clinical readers.
 */
export function ReportLayout({
  columns,
  groups,
  choices,
  onChange,
  defaults,
  countLabel,
}: {
  columns: ReportColumnDef<unknown>[]
  groups: ReportGroupDef<unknown>[]
  choices: ReportChoices
  onChange: (c: ReportChoices) => void
  /** The report's default columns. */
  defaults: string[]
  countLabel: string
}) {
  const { t } = useTranslation()
  const set = (patch: Partial<ReportChoices>) => onChange({ ...choices, ...patch })
  const chosen = choices.columns
  // ticked columns first, in their order, then the others in the report's order
  const ordered = [
    ...chosen.map((k) => columns.find((c) => c.key === k)).filter((c) => !!c),
    ...columns.filter((c) => !chosen.includes(c.key)),
  ] as ReportColumnDef<unknown>[]
  const move = (key: string, by: -1 | 1) => {
    const i = chosen.indexOf(key)
    const j = i + by
    if (i < 0 || j < 0 || j >= chosen.length) return
    const next = [...chosen]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    set({ columns: next })
  }
  const toggle = (key: string) =>
    set({
      columns: chosen.includes(key)
        ? chosen.length > 1
          ? chosen.filter((k) => k !== key)
          : chosen
        : [...chosen, key],
    })
  const summary = !!choices.group && choices.mode === 'summary'
  // the sort: a chosen column (in a summary, the count or a totalled column)
  const sortable = summary
    ? [
        { key: COUNT_COLUMN, label: countLabel },
        ...chosen
          .map((k) => columns.find((c) => c.key === k))
          .filter((c): c is ReportColumnDef<unknown> => !!c?.total)
          .map((c) => ({ key: c.key, label: columnLabel(c, t) })),
      ]
    : chosen
        .map((k) => columns.find((c) => c.key === k))
        .filter((c): c is ReportColumnDef<unknown> => !!c)
        .map((c) => ({ key: c.key, label: columnLabel(c, t) }))
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="sr-only">{t('reports.ui.columns')}</legend>
        <div className={cn(labelClass, 'flex-row flex-wrap items-center gap-2')}>
          <span className="flex-1" aria-hidden="true">
            {t('reports.ui.columns')}{' '}
            <span className="text-ink-3 font-normal">
              {t('reports.ui.columnsCount', { count: chosen.length, total: columns.length })}
            </span>
          </span>
          <Button size="xs" variant="tint-grey" onClick={() => set({ columns: defaults })}>
            {t('reports.ui.defaultColumns')}
          </Button>
          <Button
            size="xs"
            variant="tint-grey"
            onClick={() =>
              set({
                columns: [
                  ...chosen,
                  ...columns.map((c) => c.key).filter((k) => !chosen.includes(k)),
                ],
              })
            }
          >
            {t('reports.ui.allColumns')}
          </Button>
        </div>
        <ul className="border-border bg-card m-0 max-h-72 list-none overflow-y-auto rounded-md border p-1">
          {ordered.map((c) => {
            const on = chosen.includes(c.key)
            const at = chosen.indexOf(c.key)
            const label = columnLabel(c, t)
            return (
              <li
                key={c.key}
                className={cn(
                  'flex items-center gap-2 rounded px-2 py-1',
                  on ? 'bg-primary-tint/40' : 'hover:bg-hover',
                )}
              >
                <label className="text-ink flex min-h-[max(2rem,var(--tap,0px))] min-w-0 flex-1 cursor-pointer items-center gap-2 text-[14px]">
                  <input
                    type="checkbox"
                    className="accent-primary size-4 flex-none"
                    checked={on}
                    onChange={() => toggle(c.key)}
                  />
                  <span className="min-w-0 truncate">{label}</span>
                  {c.sensitive && (
                    <Lock
                      size={13}
                      className="text-ink-3 flex-none"
                      aria-label={t('reports.ui.private')}
                    />
                  )}
                </label>
                {on && (
                  <span className="flex flex-none items-center">
                    <button
                      type="button"
                      className="text-ink-2 hover:bg-hover inline-flex size-[max(1.75rem,var(--tap,0px))] items-center justify-center rounded disabled:opacity-30"
                      disabled={at === 0}
                      onClick={() => move(c.key, -1)}
                      aria-label={t('reports.ui.moveUp', { column: label })}
                    >
                      <ArrowUp size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="text-ink-2 hover:bg-hover inline-flex size-[max(1.75rem,var(--tap,0px))] items-center justify-center rounded disabled:opacity-30"
                      disabled={at === chosen.length - 1}
                      onClick={() => move(c.key, 1)}
                      aria-label={t('reports.ui.moveDown', { column: label })}
                    >
                      <ArrowDown size={14} aria-hidden="true" />
                    </button>
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </fieldset>

      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className={labelClass}>{t('reports.ui.totals')}</span>
          <Seg<ReportTotalsAt>
            label={t('reports.ui.totals')}
            value={choices.totals}
            onChange={(v) => set({ totals: v })}
            className="max-w-full flex-wrap self-start"
            options={[
              { value: 'bottom', label: t('reports.ui.totalsBottom') },
              { value: 'top', label: t('reports.ui.totalsTop') },
              { value: 'both', label: t('reports.ui.totalsBoth') },
              { value: 'none', label: t('reports.ui.totalsNone') },
            ]}
          />
        </div>
        {groups.length > 0 && (
          <div className="flex flex-wrap items-end gap-3">
            <Select
              label={t('reports.ui.groupBy')}
              value={choices.group ?? ''}
              onChange={(e) => {
                const group = e.target.value || null
                // a summary sorted by a detail column makes no sense: back to the groups' order
                set({ group, sort: group && choices.mode === 'summary' ? null : choices.sort })
              }}
              wrapperClassName="min-w-[12rem] flex-1"
            >
              <option value="">{t('reports.ui.noGroup')}</option>
              {groups.map((g) => (
                <option key={g.key} value={g.key}>
                  {t(g.label)}
                </option>
              ))}
            </Select>
            {choices.group && (
              <div className="flex flex-col gap-1">
                <span className={labelClass}>{t('reports.ui.show')}</span>
                <Seg<GroupMode>
                  label={t('reports.ui.show')}
                  value={choices.mode}
                  onChange={(v) => set({ mode: v, sort: null })}
                  className="max-w-full flex-wrap"
                  options={[
                    { value: 'details', label: t('reports.ui.detailsSubtotals') },
                    { value: 'summary', label: t('reports.ui.summaryOnly') },
                  ]}
                />
              </div>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label={t('reports.ui.sortBy')}
            value={choices.sort?.key ?? ''}
            onChange={(e) =>
              set({
                sort: e.target.value
                  ? { key: e.target.value, dir: choices.sort?.dir ?? 'asc' }
                  : null,
              })
            }
            wrapperClassName="min-w-[12rem] flex-1"
          >
            <option value="">
              {summary ? t('reports.ui.groupOrder') : t('reports.ui.noSort')}
            </option>
            {sortable.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </Select>
          {choices.sort && (
            <Seg<'asc' | 'desc'>
              label={t('reports.ui.direction')}
              value={choices.sort.dir}
              onChange={(dir) => set({ sort: { key: choices.sort!.key, dir } })}
              options={[
                { value: 'asc', label: t('reports.ui.ascending') },
                { value: 'desc', label: t('reports.ui.descending') },
              ]}
            />
          )}
        </div>
      </div>
    </div>
  )
}

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatRwf } from '@mmc/shared'
import { tileClass, tintText, type Hue } from '@/components/dash/kit-style'
import { Pager } from '@/components/ui/list-tools'
import { docNumber } from '@/lib/doc-style'
import { usePaged } from '@/lib/paging'
import type { AnyReportDef, ReportFigureDef, ReportTotalsAt } from '@/lib/reports/defs/types'
import { formatValue, groupHeading, type ModelColumn, type ReportModel } from '@/lib/reports/run'
import { cn } from '@/lib/utils'

const PAGE = 50
const HUES: Hue[] = ['teal', 'navy', 'mint', 'amber', 'violet', 'coral']

/** The report's key figures, as tiles in the dashboard's tints. */
export function ReportFigures({ figures }: { figures: ReportFigureDef[] }) {
  const { t } = useTranslation()
  if (!figures.length) return null
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
      {figures.slice(0, 6).map((f, i) => {
        const hue = HUES[i % HUES.length]!
        const value =
          f.unit === 'RWF'
            ? formatRwf(Math.round(f.value))
            : `${docNumber(Math.round(f.value * 10) / 10)}${f.unit ? ` ${t(f.unit)}` : ''}`
        return (
          <div key={f.label} className={cn('rounded-md border px-3 py-2.5', tileClass[hue])}>
            <div className="text-ink-2 text-[13px] leading-tight font-medium">{t(f.label)}</div>
            <div
              className={cn(
                'mt-1 text-[22px] leading-tight font-semibold tabular-nums',
                tintText[hue],
              )}
            >
              {value}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** The header of a column: money columns say "(RWF)". */
const headerOf = (c: ModelColumn) =>
  c.kind === 'money' && !/\bRWF\b/.test(c.label) ? `${c.label} (RWF)` : c.label

/**
 * The table as it will print: sticky header, zebra rows, figures on the right with thousands
 * separators, each group's heading and subtotal tinted, the totals at the top, the bottom, both
 * or none; 50 rows a page. The table scrolls inside its own box on a small screen.
 */
export function ReportPreview({
  def,
  model,
  totalsAt,
  resetKey,
}: {
  def: AnyReportDef
  model: ReportModel
  totalsAt: ReportTotalsAt
  resetKey: string
}) {
  const { t } = useTranslation()
  const paged = usePaged(model.rows, PAGE, resetKey)
  const cols = model.columns
  const hasTotals = model.totals.some((v) => v != null)
  const totalLabel = model.groupLabel ? t('reports.ui.grandTotal') : t('report.total')
  const cell = (c: ModelColumn, v: unknown, empty: ReactNode) => {
    const text = formatValue(v as never, c.kind, t)
    return text === '' ? empty : text
  }
  const totalsRow = (where: 'top' | 'bottom') => (
    <tr
      className={cn(
        'bg-primary-tint text-navy-ink font-semibold',
        where === 'top' ? 'border-primary/40 border-b' : 'border-primary/40 border-t-2',
      )}
    >
      {cols.map((c, i) => {
        const v = model.totals[i]
        const text = v == null ? '' : formatValue(v, c.kind === 'yesno' ? 'number' : c.kind, t)
        return (
          <td
            key={c.key}
            className={cn(
              'px-3 py-2 whitespace-nowrap',
              c.align === 'right' && 'text-right tabular-nums',
            )}
          >
            {i === 0 ? (text ? `${totalLabel}: ${text}` : totalLabel) : text}
          </td>
        )
      })}
    </tr>
  )
  // zebra rows, counted again in each group
  const odd: boolean[] = []
  let n = 0
  for (const r of paged.slice) {
    if (r.kind === 'group') n = 0
    odd.push(r.kind === 'row' && n++ % 2 === 1)
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="border-border max-h-[70vh] max-w-full overflow-auto rounded-md border">
        {/* as wide as its content (it scrolls inside the frame): the browser never crushes a
            column to a few letters per line; long text wraps beyond its max width */}
        <table className="w-max min-w-full border-collapse text-[14px]">
          <caption className="sr-only">{t(def.title)}</caption>
          <thead className="bg-surface sticky top-0 z-[1] shadow-[0_1px_0_var(--mmc-border,#d6dee6)]">
            <tr>
              {cols.map((c, i) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn(
                    'text-ink-2 h-10 px-3 text-left align-bottom text-[12px] font-semibold',
                    i === 0 && 'min-w-[10rem]',
                    c.align === 'right' && 'text-right',
                  )}
                >
                  <div className="max-w-48">{headerOf(c)}</div>
                </th>
              ))}
            </tr>
            {hasTotals && (totalsAt === 'top' || totalsAt === 'both') && totalsRow('top')}
          </thead>
          <tbody>
            {paged.slice.map((r, ri) => {
              if (r.kind === 'group')
                return (
                  <tr key={`g${ri}`} className="border-primary/30 border-t">
                    <td
                      colSpan={cols.length}
                      className="bg-primary-tint/60 text-primary px-3 py-2 text-[14px] font-semibold"
                    >
                      {groupHeading(r.label, r.count, def, t)}
                    </td>
                  </tr>
                )
              if (r.kind === 'subtotal')
                return (
                  <tr key={`s${ri}`} className="bg-surface border-border border-y font-semibold">
                    {cols.map((c, i) => {
                      const v = r.cells[i]
                      const text =
                        v == null ? '' : formatValue(v, c.kind === 'yesno' ? 'number' : c.kind, t)
                      return (
                        <td
                          key={c.key}
                          className={cn(
                            'px-3 py-1.5 whitespace-nowrap',
                            c.align === 'right' && 'text-right tabular-nums',
                          )}
                        >
                          {i === 0 ? (text ? `${r.label}: ${text}` : r.label) : text}
                        </td>
                      )
                    })}
                  </tr>
                )
              return (
                <tr
                  key={`r${ri}`}
                  className={cn('border-grid hover:bg-hover border-b', odd[ri] && 'bg-surface/60')}
                >
                  {cols.map((c, i) => (
                    <td
                      key={c.key}
                      className={cn(
                        'px-3 py-1.5 align-top',
                        i === 0 && 'font-medium',
                        c.align === 'right' && 'text-right whitespace-nowrap tabular-nums',
                        (c.nowrap || c.kind === 'date' || c.kind === 'datetime') &&
                          'whitespace-nowrap',
                      )}
                    >
                      <div className="max-w-80">
                        {cell(c, r.cells[i], <span className="text-ink-3">–</span>)}
                      </div>
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
          {hasTotals && (totalsAt === 'bottom' || totalsAt === 'both') && (
            <tfoot>{totalsRow('bottom')}</tfoot>
          )}
        </table>
      </div>
      <Pager
        page={paged.page}
        pages={paged.pages}
        from={paged.from}
        to={paged.to}
        total={paged.total}
        onPage={paged.setPage}
      />
    </div>
  )
}

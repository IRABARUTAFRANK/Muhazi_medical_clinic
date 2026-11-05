import { useState } from 'react'
import { Columns3, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '@mmc/shared'
import { tableCell, tableHead, tableRow } from '@/components/dash/kit-style'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import {
  COLUMN_ROLES,
  rereadPriceList,
  type ColumnRole,
  type ParsedPriceList,
} from '@/lib/price-list-file'
import { cn } from '@/lib/utils'
import { errorBox } from './price-list-kit'

/**
 * What was read from the file (how many lines, from which row, the columns found, the price
 * columns, the notes) and "Correct the columns": every column of the file with a few of its values,
 * and what it is read as (line code, name, price, section, unit, instructions, detail, other code,
 * row number, or left out); the row of the column names can be changed too. The file is read again
 * at once, so a list in an unusual form (an insurer's sheet, a scan typed into Excel) is read right.
 */
export function ColumnsCheck({
  parsed,
  fileName,
  onChange,
}: {
  parsed: ParsedPriceList
  fileName: string
  onChange: (p: ParsedPriceList) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [headerRow, setHeaderRow] = useState(String(parsed.headerRow))
  const [error, setError] = useState<string | null>(null)
  const roles = parsed.layout.filter((c) => c.role !== 'price' && c.role !== 'ignore')
  /** The price columns left out by themselves (foreigners, another kind of facility). */
  const leftOut = parsed.layout.filter((c) => c.leftOut)

  const reread = (header: number, changed?: { index: number; role: ColumnRole }) => {
    const map: Record<number, ColumnRole> = {}
    // the same header row: every column keeps what it is read as, the one changed takes its role
    if (header === parsed.headerRow) for (const c of parsed.layout) map[c.index] = c.role
    if (changed) {
      // one code and one name: the column that had the role keeps another one
      if (changed.role === 'code' || changed.role === 'name')
        for (const [k, r] of Object.entries(map))
          if (r === changed.role && Number(k) !== changed.index)
            map[Number(k)] = changed.role === 'code' ? 'altCode' : 'detail'
      map[changed.index] = changed.role
    }
    const next = rereadPriceList(parsed, { headerRow: header, roles: map })
    if (!next || next.lines.length === 0) {
      setError(t('prices.lists.cols.nothing'))
      return
    }
    setError(null)
    onChange(next)
  }

  return (
    <div className="border-violet/20 bg-violet-bg/50 flex flex-col gap-1.5 rounded-md border px-3 py-2 text-[13px]">
      <span className="text-ink font-semibold">
        {parsed.format === 'pdf'
          ? t('prices.lists.readPdf', {
              count: parsed.lines.length,
              n: formatNumber(parsed.lines.length),
              file: fileName,
            })
          : t('prices.lists.read', {
              count: parsed.lines.length,
              n: formatNumber(parsed.lines.length),
              row: parsed.headerRow,
              sheet: parsed.sheet ?? fileName,
            })}
        {parsed.kind && ` · ${t(`prices.lists.kinds.${parsed.kind}`)}`}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <span className="text-ink-2">{t('prices.lists.columnsFound')}</span>
        {roles.map((r) => (
          <Badge key={`${r.index}`} tone={r.role === 'number' ? 'grey' : 'green'}>
            {t(`prices.lists.role.${r.role}`)}
            {r.label && `: ${r.label}`}
          </Badge>
        ))}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <span className="text-ink-2">
          {t('prices.lists.priceColumns', { count: parsed.columns.length })}
        </span>
        {parsed.columns.map((c) => (
          <Badge key={c.key} tone="blue">
            {c.label}
          </Badge>
        ))}
      </span>
      {leftOut.length > 0 && (
        <span className="flex flex-wrap items-center gap-1">
          <span className="text-ink-2">{t('prices.lists.cols.leftOut')}</span>
          {leftOut.map((c) => (
            <Badge key={c.index} tone="grey" title={t(`prices.lists.fc.leftOut.${c.leftOut!}`)}>
              {c.label}
            </Badge>
          ))}
          <span className="text-ink-3">
            {t(
              `prices.lists.cols.why.${leftOut.some((c) => c.leftOut === 'foreign') ? (leftOut.some((c) => c.leftOut === 'otherFacility') ? 'both' : 'foreign') : 'otherFacility'}`,
            )}
          </span>
        </span>
      )}
      {parsed.notes.length > 0 && (
        <span className="text-ink-2">
          {t('prices.lists.fileNotes')}{' '}
          <span className="text-ink">{parsed.notes.slice(0, 3).join(' · ')}</span>
        </span>
      )}
      <span>
        <Button
          type="button"
          size="sm"
          variant={open ? 'tint-grey' : 'tint-violet'}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <Columns3 size={14} aria-hidden="true" />
          {open ? t('prices.lists.cols.close') : t('prices.lists.cols.open')}
        </Button>
      </span>
      {open && (
        <div className="flex flex-col gap-2 pt-1">
          <p className="text-ink-2 m-0">{t('prices.lists.cols.lead')}</p>
          {parsed.format !== 'pdf' && (
            <div className="flex flex-wrap items-end gap-2">
              <Field
                label={t('prices.lists.cols.headerRow')}
                inputMode="numeric"
                value={headerRow}
                wrapperClassName="w-[180px]"
                onChange={(e) => setHeaderRow(e.target.value.replace(/[^\d]/g, '').slice(0, 5))}
              />
              <Button
                type="button"
                size="sm"
                variant="tint-grey"
                disabled={!headerRow || Number(headerRow) === parsed.headerRow}
                onClick={() => reread(Number(headerRow))}
              >
                <RotateCcw size={14} aria-hidden="true" />
                {t('prices.lists.cols.readAgain')}
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className={errorBox}>
              {error}
            </p>
          )}
          <div className="border-border bg-card max-h-[50vh] overflow-auto overscroll-contain rounded-md border">
            <table className="w-full border-collapse">
              <thead className="bg-surface sticky top-0 z-1">
                <tr>
                  <th className={tableHead}>{t('prices.lists.cols.column')}</th>
                  <th className={tableHead}>{t('prices.lists.cols.values')}</th>
                  <th className={tableHead}>{t('prices.lists.cols.readAs')}</th>
                </tr>
              </thead>
              <tbody>
                {parsed.layout.map((c) => (
                  <tr key={c.index} className={cn(tableRow, c.role === 'ignore' && 'opacity-60')}>
                    <td className={cn(tableCell, 'font-medium')}>{c.label}</td>
                    <td className={cn(tableCell, 'text-ink-3 text-[12px]')}>
                      {c.samples.join(' · ') || '—'}
                    </td>
                    <td className={tableCell}>
                      <select
                        aria-label={t('prices.lists.cols.readAsOf', { column: c.label })}
                        className="border-border bg-card text-ink h-9 w-full min-w-[150px] rounded-md border px-2 text-[13px]"
                        value={c.role}
                        onChange={(e) =>
                          reread(parsed.headerRow, {
                            index: c.index,
                            role: e.target.value as ColumnRole,
                          })
                        }
                      >
                        {COLUMN_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {t(`prices.lists.role.${r}`)}
                          </option>
                        ))}
                      </select>
                      {c.leftOut && (
                        <span className="text-ink-3 mt-0.5 block text-[12px]">
                          {t(`prices.lists.fc.leftOut.${c.leftOut}`)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

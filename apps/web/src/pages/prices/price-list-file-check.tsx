import { useMemo, useState } from 'react'
import { FileSearch, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '@mmc/shared'
import { tableCell, tableHead, tableRow } from '@/components/dash/kit-style'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { LeftOutReason, ParsedPriceList, PriceListLineInput } from '@/lib/price-list-file'
import { cn } from '@/lib/utils'
import { asInFile } from './price-list-kit'

type Filter = 'all' | 'noMain' | 'notNumber' | 'zero' | 'duplicate'
const PAGE = 100

const codeKey = (code: string) => code.replace(/\s+/g, '').toUpperCase()

/**
 * "Compare with the file" (Prices › Published price lists, before the check): everything read from
 * the file, in the file's order, to put side by side with the file open in Excel — every sheet (read
 * from which row, how many lines, hidden or without a table and so not read, the rows that are not
 * lines), every price column (what it is used for, or why it was left out: prices for foreigners,
 * another kind of facility; how many lines have a price in it) and the lines themselves with their
 * prices rounded as Excel shows them, with what needs a look: no price where the patients' price is
 * taken, a price that is not a number, a price of 0, a code written twice.
 */
export function FileCheck({
  parsed,
  uses,
  mainColumn,
  mainLabel,
}: {
  parsed: ParsedPriceList
  /** Per price column key: who pays it ("Private patients", "RSSB (RAMA)"…). */
  uses: Record<string, string[]>
  /** The column the clinic's patients pay (a clinic-wide list) or the insurer's own column. */
  mainColumn: string
  mainLabel: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [shown, setShown] = useState(PAGE)
  const cols = parsed.columns

  const check = useMemo(() => {
    const seen = new Map<string, number>()
    for (const l of parsed.lines) {
      const k = codeKey(l.code)
      if (k) seen.set(k, (seen.get(k) ?? 0) + 1)
    }
    const isDuplicate = (l: PriceListLineInput) => (seen.get(codeKey(l.code)) ?? 0) > 1
    const noMain = (l: PriceListLineInput) =>
      !!mainColumn && typeof l.prices[mainColumn] !== 'number'
    const notNumber = (l: PriceListLineInput) =>
      Object.values(l.prices).some((v) => typeof v === 'string')
    const zero = (l: PriceListLineInput) => Object.values(l.prices).some((v) => v === 0)
    const tests: Record<Filter, (l: PriceListLineInput) => boolean> = {
      all: () => true,
      noMain,
      notNumber,
      zero,
      duplicate: isDuplicate,
    }
    const counts = {
      noMain: parsed.lines.filter(noMain).length,
      notNumber: parsed.lines.filter(notNumber).length,
      zero: parsed.lines.filter(zero).length,
      duplicate: parsed.lines.filter(isDuplicate).length,
    }
    const perColumn = cols.map((c) => {
      let priced = 0
      let empty = 0
      let text = 0
      let zeros = 0
      for (const l of parsed.lines) {
        const v = l.prices[c.key]
        if (typeof v === 'number') {
          priced++
          if (v === 0) zeros++
        } else if (v == null) empty++
        else text++
      }
      return { ...c, priced, empty, text, zeros }
    })
    return { tests, counts, perColumn }
  }, [parsed.lines, cols, mainColumn])

  const leftOut = useMemo(() => {
    const out = new Map<string, LeftOutReason>()
    for (const s of parsed.sheets) for (const c of s.leftOut) out.set(c.label, c.why)
    return [...out.entries()]
  }, [parsed.sheets])
  const skipped = parsed.sheets.flatMap((s) => s.skipped.map((r) => ({ ...r, sheet: s.name })))
  const notRead = parsed.sheets.filter((s) => s.state !== 'read')
  const toLook =
    check.counts.noMain + check.counts.notNumber + check.counts.zero + check.counts.duplicate

  const lines = useMemo(() => {
    const q = query.trim().toLowerCase()
    return parsed.lines.filter(
      (l) =>
        check.tests[filter](l) &&
        (!q || l.code.toLowerCase().includes(q) || l.name.toLowerCase().includes(q)),
    )
  }, [parsed.lines, check, filter, query])

  const cell = (v: number | string | null | undefined) =>
    typeof v === 'number' ? (
      <span className={cn(v === 0 && 'text-amber font-semibold')}>{asInFile(v)}</span>
    ) : v == null ? (
      <span className="text-ink-3">—</span>
    ) : (
      <span className="text-red font-semibold">{v}</span>
    )

  const filters: Filter[] = ['all', 'noMain', 'notNumber', 'zero', 'duplicate']

  return (
    <div className="border-blue/20 bg-blue-bg/40 flex flex-col gap-2 rounded-md border px-3 py-2 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-ink inline-flex items-center gap-1.5 font-semibold">
          <FileSearch size={15} aria-hidden="true" className="text-blue" />
          {t('prices.lists.fc.title')}
        </span>
        <Badge tone="green">
          {t('prices.lists.fc.linesRead', {
            count: parsed.lines.length,
            n: formatNumber(parsed.lines.length),
          })}
        </Badge>
        {skipped.length > 0 && (
          <Badge tone="grey">{t('prices.lists.fc.notLines', { count: skipped.length })}</Badge>
        )}
        {notRead.length > 0 && (
          <Badge tone="yellow">
            {t('prices.lists.fc.sheetsNotRead', { count: notRead.length })}
          </Badge>
        )}
        {leftOut.length > 0 && (
          <Badge tone="grey">
            {t('prices.lists.fc.columnsLeftOut', { count: leftOut.length })}
          </Badge>
        )}
        <Badge tone={toLook > 0 ? 'orange' : 'green'}>
          {toLook > 0
            ? t('prices.lists.fc.toLook', { count: toLook })
            : t('prices.lists.fc.nothingToLook')}
        </Badge>
      </div>
      <span>
        <Button
          type="button"
          size="sm"
          variant={open ? 'tint-grey' : 'tint-blue'}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <FileSearch size={14} aria-hidden="true" />
          {open ? t('prices.lists.fc.close') : t('prices.lists.fc.open')}
        </Button>
      </span>

      {open && (
        <div className="flex flex-col gap-3 pt-1">
          <p className="text-ink-2 m-0">{t('prices.lists.fc.lead')}</p>

          {/* the sheets */}
          <section className="flex flex-col gap-1">
            <h4 className="text-ink m-0 text-[14px] font-semibold">
              {t('prices.lists.fc.sheets')}
            </h4>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {parsed.sheets.map((s, i) => (
                <li
                  key={`${s.name ?? ''}-${i}`}
                  className="border-border bg-card flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2.5 py-1.5"
                >
                  <span className="text-ink font-medium wrap-anywhere">
                    {s.name ?? t('prices.lists.fc.theFile')}
                  </span>
                  {s.state === 'read' ? (
                    <>
                      <Badge tone="green">
                        {t('prices.lists.fc.sheetRead', {
                          count: s.lines,
                          n: formatNumber(s.lines),
                          row: s.headerRow,
                        })}
                      </Badge>
                      <span className="text-ink-3">
                        {t('prices.lists.fc.rowsBelow', { count: s.rows, n: formatNumber(s.rows) })}
                        {s.skipped.length > 0 &&
                          ` · ${t('prices.lists.fc.notLines', { count: s.skipped.length })}`}
                      </span>
                    </>
                  ) : (
                    <>
                      <Badge tone="yellow">{t(`prices.lists.fc.state.${s.state}`)}</Badge>
                      <span className="text-ink-3">
                        {t('prices.lists.fc.rowsIn', { count: s.rows, n: formatNumber(s.rows) })}
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {/* the price columns */}
          <section className="flex flex-col gap-1">
            <h4 className="text-ink m-0 text-[14px] font-semibold">
              {t('prices.lists.fc.columns')}
            </h4>
            <div className="border-border bg-card overflow-x-auto rounded-md border">
              <table className="w-full border-collapse">
                <thead className="bg-surface">
                  <tr>
                    <th className={tableHead}>{t('prices.lists.fc.column')}</th>
                    <th className={tableHead}>{t('prices.lists.fc.usedFor')}</th>
                    <th className={cn(tableHead, 'text-right')}>{t('prices.lists.fc.priced')}</th>
                    <th className={cn(tableHead, 'text-right')}>{t('prices.lists.fc.empty')}</th>
                    <th className={cn(tableHead, 'text-right')}>
                      {t('prices.lists.fc.notNumber')}
                    </th>
                    <th className={cn(tableHead, 'text-right')}>{t('prices.lists.fc.zero')}</th>
                  </tr>
                </thead>
                <tbody>
                  {check.perColumn.map((c) => (
                    <tr key={c.key} className={tableRow}>
                      <td className={cn(tableCell, 'font-medium')}>{c.label}</td>
                      <td className={cn(tableCell, 'text-[13px]')}>
                        {uses[c.key]?.length ? (
                          <span className="text-green font-medium">{uses[c.key]!.join(' · ')}</span>
                        ) : (
                          <span className="text-ink-3">{t('prices.lists.fc.notUsed')}</span>
                        )}
                      </td>
                      <td className={cn(tableCell, 'text-right tabular-nums')}>
                        {formatNumber(c.priced)}
                      </td>
                      <td className={cn(tableCell, 'text-right tabular-nums')}>
                        {c.empty > 0 ? (
                          <span className="text-amber font-semibold">{formatNumber(c.empty)}</span>
                        ) : (
                          '0'
                        )}
                      </td>
                      <td className={cn(tableCell, 'text-right tabular-nums')}>
                        {c.text > 0 ? (
                          <span className="text-red font-semibold">{formatNumber(c.text)}</span>
                        ) : (
                          '0'
                        )}
                      </td>
                      <td className={cn(tableCell, 'text-right tabular-nums')}>
                        {c.zeros > 0 ? (
                          <span className="text-amber font-semibold">{formatNumber(c.zeros)}</span>
                        ) : (
                          '0'
                        )}
                      </td>
                    </tr>
                  ))}
                  {leftOut.map(([label, why]) => (
                    <tr key={`out-${label}`} className={cn(tableRow, 'opacity-70')}>
                      <td className={cn(tableCell, 'font-medium')}>{label}</td>
                      <td className={cn(tableCell, 'text-[13px]')} colSpan={5}>
                        {t(`prices.lists.fc.leftOut.${why}`)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* the lines */}
          <section className="flex flex-col gap-1.5">
            <h4 className="text-ink m-0 text-[14px] font-semibold">
              {t('prices.lists.fc.lines', { n: formatNumber(parsed.lines.length) })}
            </h4>
            <div className="flex flex-wrap items-center gap-1.5">
              {filters.map((f) => {
                const n = f === 'all' ? parsed.lines.length : check.counts[f]
                if (f !== 'all' && n === 0) return null
                return (
                  <Button
                    key={f}
                    type="button"
                    size="sm"
                    variant={
                      filter === f ? (f === 'all' ? 'tint-blue' : 'tint-amber') : 'tint-grey'
                    }
                    aria-pressed={filter === f}
                    onClick={() => {
                      setFilter(f)
                      setShown(PAGE)
                    }}
                  >
                    {t(`prices.lists.fc.filter.${f}`, {
                      count: n,
                      n: formatNumber(n),
                      who: mainLabel,
                    })}
                  </Button>
                )
              })}
            </div>
            <label className="border-border bg-card flex h-9 max-w-[420px] items-center gap-2 rounded-md border px-2.5">
              <Search size={15} aria-hidden="true" className="text-ink-3 flex-none" />
              <input
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setShown(PAGE)
                }}
                placeholder={t('prices.lists.fc.search')}
                aria-label={t('prices.lists.fc.search')}
                className="text-ink min-w-0 flex-1 bg-transparent text-[14px] outline-none"
              />
            </label>
            <div className="border-border bg-card max-h-[60vh] overflow-auto overscroll-contain rounded-md border">
              <table className="w-full border-collapse">
                <thead className="bg-surface sticky top-0 z-1">
                  <tr>
                    <th className={tableHead}>{t('prices.lists.fc.codeRow')}</th>
                    <th className={tableHead}>{t('prices.lists.fc.nameSection')}</th>
                    {cols.map((c) => (
                      <th
                        key={c.key}
                        className={cn(
                          tableHead,
                          'min-w-[5.5rem] text-right whitespace-normal',
                          c.key === mainColumn && 'text-green font-semibold',
                        )}
                      >
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lines.slice(0, shown).map((l, i) => (
                    <tr key={`${l.row}-${l.code}-${i}`} className={tableRow}>
                      <td className={cn(tableCell, 'whitespace-nowrap')}>
                        <span className="block font-mono text-[12px]">
                          {l.code || <span className="text-ink-3">—</span>}
                        </span>
                        <span className="text-ink-3 block text-[12px] tabular-nums">
                          {t('prices.lists.rowN', { n: l.row })}
                        </span>
                      </td>
                      <td className={cn(tableCell, 'min-w-[11rem]')}>
                        <span className="block">
                          {l.name}
                          {l.detail && <span className="text-ink-3"> · {l.detail}</span>}
                        </span>
                        {l.section && (
                          <span className="text-ink-3 block text-[12px]">{l.section}</span>
                        )}
                      </td>
                      {cols.map((c) => (
                        <td
                          key={c.key}
                          className={cn(
                            tableCell,
                            'text-right whitespace-nowrap tabular-nums',
                            c.key === mainColumn && 'bg-green-bg/40',
                          )}
                        >
                          {cell(l.prices[c.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {lines.length === 0 && (
                    <tr>
                      <td className={cn(tableCell, 'text-ink-3')} colSpan={2 + cols.length}>
                        {t('prices.lists.fc.noMatch')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {lines.length > shown && (
              <span>
                <Button
                  type="button"
                  size="sm"
                  variant="tint-grey"
                  onClick={() => setShown((n) => n + PAGE)}
                >
                  {t('prices.lists.fc.more', {
                    count: Math.min(PAGE, lines.length - shown),
                    left: formatNumber(lines.length - shown),
                  })}
                </Button>
              </span>
            )}
          </section>

          {/* the rows that are not lines */}
          {skipped.length > 0 && (
            <details className="border-border bg-card rounded-md border px-2.5 py-1.5">
              <summary className="text-ink cursor-pointer font-semibold">
                {t('prices.lists.fc.skippedTitle', { count: skipped.length })}
              </summary>
              <ul className="m-0 mt-1.5 flex max-h-[40vh] list-none flex-col gap-1 overflow-auto p-0">
                {skipped.map((r, i) => (
                  <li key={`${r.sheet ?? ''}-${r.row}-${i}`} className="flex flex-wrap gap-x-2">
                    <span className="text-ink-3 tabular-nums">
                      {parsed.sheets.length > 1 && r.sheet ? `${r.sheet} · ` : ''}
                      {t('prices.lists.rowN', { n: r.row })}
                    </span>
                    <Badge tone="grey">{t(`prices.lists.fc.why.${r.why}`)}</Badge>
                    <span className="text-ink-2 wrap-anywhere">{r.text}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

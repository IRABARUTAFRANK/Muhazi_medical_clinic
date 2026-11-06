import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '@mmc/shared'
import { tableCell, tableHead, tableRow } from '@/components/dash/kit-style'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import {
  COLUMN_ROLES,
  rebuildPriceList,
  type ColumnLayout,
  type ColumnRole,
  type JoinMode,
  type ParsedPriceList,
  type SheetChoice,
  type SheetReport,
} from '@/lib/price-list-file'
import { columnPayers, isInsurerNamed, type InsurerLike } from '@/lib/price-list-payers'
import { cn } from '@/lib/utils'
import { errorBox } from './price-list-kit'

const JOINS: JoinMode[] = ['auto', 'join', 'add']
const isNumeric = (s: string) => /^[\d\s.,]+$/.test(s.trim())

/**
 * Every sheet and every column of the file, to choose what is read (Prices › Price lists ›
 * upload): each sheet can be read or left out (hidden ones, the foreigners' and those without a
 * table are left out at first), and goes with the sheets above it as the same treatments (its
 * prices join theirs: the MoH tariff's sheets "RAMA" and "Private Insurances") or as other ones (its
 * lines are added); its row of column names can be changed; each of its columns is kept or left
 * out, and read as a code, a name, a price, a section… with the payers it names ("RAMA; MMI": RSSB
 * RAMA and MMI). The list is read again at once.
 */
export function SheetsEditor({
  parsed,
  insurers,
  onChange,
}: {
  parsed: ParsedPriceList
  insurers: InsurerLike[]
  onChange: (p: ParsedPriceList) => void
}) {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const firstUsed = parsed.sheets.find((s) => s.use)?.index ?? -1

  const apply = (choices: SheetChoice[]) => {
    const next = rebuildPriceList(parsed, choices)
    if (!next || next.lines.length === 0) {
      setError(t('prices.lists.sheets.nothing'))
      return
    }
    setError(null)
    onChange(next)
  }
  const change = (index: number, patch: Partial<SheetChoice>) =>
    apply(parsed.choices.map((c, i) => (i === index ? { ...c, ...patch } : c)))

  return (
    <div className="flex flex-col gap-3">
      <p className="text-ink-2 m-0">{t('prices.lists.sheets.lead')}</p>
      {error && (
        <p role="alert" className={errorBox}>
          {error}
        </p>
      )}
      {parsed.sheets.map((s) => (
        <SheetCard
          key={s.index}
          sheet={s}
          choice={parsed.choices[s.index] ?? { use: false, join: 'auto' }}
          isFirst={s.index === firstUsed}
          pdf={parsed.format === 'pdf'}
          insurers={insurers}
          onChange={(patch) => change(s.index, patch)}
        />
      ))}
    </div>
  )
}

function SheetCard({
  sheet,
  choice,
  isFirst,
  pdf,
  insurers,
  onChange,
}: {
  sheet: SheetReport
  choice: SheetChoice
  isFirst: boolean
  pdf: boolean
  insurers: InsurerLike[]
  onChange: (patch: Partial<SheetChoice>) => void
}) {
  const { t } = useTranslation()
  const [headerRow, setHeaderRow] = useState(sheet.headerRow ? String(sheet.headerRow) : '')
  const hint = [sheet.name, sheet.title].filter(Boolean).join(' — ') || null

  /** The roles of the sheet's columns with one changed (one code and one name: the other one gives way). */
  const withRole = (index: number, role: ColumnRole): Record<number, ColumnRole> => {
    const map: Record<number, ColumnRole> = {}
    for (const c of sheet.layout) map[c.index] = c.role
    if (role === 'code' || role === 'name')
      for (const [k, r] of Object.entries(map))
        if (r === role && Number(k) !== index)
          map[Number(k)] = role === 'code' ? 'altCode' : 'detail'
    map[index] = role
    return map
  }
  const keepRole = (c: ColumnLayout): ColumnRole =>
    c.leftOut || c.samples.some(isNumeric) ? 'price' : 'detail'

  /** Who a price column is for: the clinic's insurers it names, or the names it gives. */
  const payersOf = (c: ColumnLayout) =>
    columnPayers({ key: '', label: c.label, hint }).map((m) => {
      if (m.group === 'privatePatients') return t('prices.lists.sheets.privatePatients')
      if (m.group === 'privateInsurers') return t('prices.lists.sheets.privateInsurers')
      const named = insurers.filter((i) => isInsurerNamed(i, m)).map((i) => i.name)
      return named.length ? named.join(', ') : t('prices.lists.sheets.notInsurer', { name: m.text })
    })

  const state =
    sheet.state === 'read'
      ? t('prices.lists.fc.sheetRead', {
          count: sheet.lines,
          n: formatNumber(sheet.lines),
          row: sheet.headerRow,
        })
      : t(`prices.lists.fc.state.${sheet.state}`)

  return (
    <section
      className={cn(
        'border-border bg-card flex flex-col gap-2 rounded-md border px-3 py-2.5',
        !choice.use && 'bg-surface/60',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="text-ink inline-flex min-h-9 items-center gap-2 text-[15px] font-semibold">
          <input
            type="checkbox"
            className="accent-primary size-[18px]"
            checked={choice.use}
            onChange={(e) => onChange({ use: e.target.checked })}
          />
          {sheet.name ?? t('prices.lists.fc.theFile')}
        </label>
        <Badge tone={sheet.state === 'read' ? 'green' : 'yellow'}>{state}</Badge>
        {sheet.joined && <Badge tone="blue">{t('prices.lists.sheets.joined')}</Badge>}
        {sheet.zeros > 0 && (
          <span className="text-ink-3 text-[13px]">
            {t('prices.lists.fc.zeros', { count: sheet.zeros, n: formatNumber(sheet.zeros) })}
          </span>
        )}
      </div>
      {sheet.title && <span className="text-ink-3 text-[13px] wrap-anywhere">{sheet.title}</span>}

      {choice.use && (
        <div className="flex flex-wrap items-end gap-2">
          {!isFirst && (
            <label className="flex min-w-[min(320px,100%)] flex-col gap-1 text-[13px] font-medium">
              <span className="text-ink-2">{t('prices.lists.sheets.joinLabel')}</span>
              <select
                className="border-border bg-card text-ink h-9 rounded-md border px-2 text-[13px]"
                value={choice.join}
                onChange={(e) => onChange({ join: e.target.value as JoinMode })}
              >
                {JOINS.map((j) => (
                  <option key={j} value={j}>
                    {t(`prices.lists.sheets.join.${j}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!pdf && (
            <>
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
                disabled={!headerRow || Number(headerRow) === sheet.headerRow}
                // another row of names: every column is read again from it
                onClick={() => onChange({ headerRow: Number(headerRow), roles: undefined })}
              >
                <RotateCcw size={14} aria-hidden="true" />
                {t('prices.lists.cols.readAgain')}
              </Button>
            </>
          )}
        </div>
      )}

      {sheet.layout.length > 0 && (
        <div className="border-border overflow-x-auto rounded-md border">
          <table className="w-full border-collapse">
            <thead className="bg-surface">
              <tr>
                <th className={tableHead}>{t('prices.lists.sheets.keep')}</th>
                <th className={tableHead}>{t('prices.lists.cols.column')}</th>
                <th className={tableHead}>{t('prices.lists.cols.values')}</th>
                <th className={tableHead}>{t('prices.lists.cols.readAs')}</th>
              </tr>
            </thead>
            <tbody>
              {sheet.layout.map((c) => {
                const kept = c.role !== 'ignore'
                const payers = c.role === 'price' || c.leftOut ? payersOf(c) : []
                return (
                  <tr key={c.index} className={cn(tableRow, !kept && 'opacity-60')}>
                    <td className={tableCell}>
                      <input
                        type="checkbox"
                        className="accent-primary size-[18px]"
                        disabled={!choice.use}
                        checked={kept}
                        aria-label={t('prices.lists.sheets.keepOf', { column: c.label })}
                        onChange={(e) =>
                          onChange({
                            roles: withRole(c.index, e.target.checked ? keepRole(c) : 'ignore'),
                          })
                        }
                      />
                    </td>
                    <td className={cn(tableCell, 'font-medium')}>
                      {c.label}
                      {payers.length > 0 && (
                        <span className="text-navy-ink block text-[12px] font-normal">
                          {t('prices.lists.sheets.forWho')} {payers.join(' · ')}
                        </span>
                      )}
                    </td>
                    <td className={cn(tableCell, 'text-ink-3 text-[12px]')}>
                      {c.samples.join(' · ') || '—'}
                    </td>
                    <td className={tableCell}>
                      <select
                        aria-label={t('prices.lists.cols.readAsOf', { column: c.label })}
                        className="border-border bg-card text-ink h-9 w-full min-w-[150px] rounded-md border px-2 text-[13px]"
                        value={c.role}
                        disabled={!choice.use}
                        onChange={(e) =>
                          onChange({ roles: withRole(c.index, e.target.value as ColumnRole) })
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
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

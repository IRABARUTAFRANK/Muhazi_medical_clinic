import { useState } from 'react'
import { Columns3 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ParsedPriceList } from '@/lib/price-list-file'
import type { InsurerLike } from '@/lib/price-list-payers'
import { SheetsEditor } from './price-list-sheets'

/**
 * What was read from the file (how many lines, from which row, the columns found, the price
 * columns, the notes) and "Choose the sheets and columns": every sheet of the file (read or not,
 * the same treatments as the sheets above or others, its row of column names) and every column
 * (kept or left out, what it is read as, who it is for). The file is read again at once.
 */
export function ColumnsCheck({
  parsed,
  fileName,
  insurers,
  onChange,
}: {
  parsed: ParsedPriceList
  fileName: string
  insurers: InsurerLike[]
  onChange: (p: ParsedPriceList) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const roles = parsed.layout.filter((c) => c.role !== 'price' && c.role !== 'ignore')
  /** The price columns left out by themselves (foreigners, another kind of facility). */
  const leftOut = parsed.layout.filter((c) => c.leftOut)

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
      {open && <SheetsEditor parsed={parsed} insurers={insurers} onChange={onChange} />}
    </div>
  )
}

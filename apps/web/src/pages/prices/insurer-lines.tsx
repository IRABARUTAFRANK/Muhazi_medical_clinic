import { useTranslation } from 'react-i18next'
import { formatRwf } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import type { Insurer } from '@/lib/api/catalogue'
import type { InsurerPriceRow } from '@/lib/api/insurer-prices'
import { cn } from '@/lib/utils'
import type { CoverChoice, InsurerLines } from './insurer-lines-state'

/** "Now 3,500 RWF · its price list": what the insurer pays for it today and why. */
function nowText(r: InsurerPriceRow, t: (k: string, o?: Record<string, unknown>) => string) {
  const why =
    r.source === 'tariff'
      ? t('prices.insurerLines.from.own')
      : r.source === 'reference'
        ? t('prices.insurerLines.from.list')
        : r.source === 'cash'
          ? t(`prices.insurerLines.from.cash.${r.rule}`)
          : r.source === 'excluded' || r.source === 'preauth'
            ? [
                t(`prices.insurerLines.from.${r.source}`),
                r.exceptionOwn || !r.exceptionCode
                  ? null
                  : t('prices.insurerLines.onLine', { code: r.exceptionCode }),
              ]
                .filter(Boolean)
                .join(' · ')
            : t('prices.insurerLines.from.none')
  return r.price == null ? why : t('prices.insurerLines.now', { price: formatRwf(r.price), why })
}

/**
 * The insurers' part of a treatment's or a medicine's form: one box per insurer with what it pays
 * now, the exception the clinic sets on it and its own price.
 */
export function InsurerLinesFields({
  lines,
  insurers,
  isNew,
}: {
  lines: InsurerLines
  insurers: Insurer[]
  /** Not saved yet: only the prices can be given; the exceptions once it is saved. */
  isNew: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-2">
      <span className="text-ink-2 text-[14px] font-semibold">{t('prices.insurerLines.title')}</span>
      <p className="text-ink-3 m-0 text-[13px]">{t('prices.insurerLines.lead')}</p>
      {insurers.map((i) => {
        const r = lines.rowOf(i.id)
        const cover = lines.coverOf(i.id)
        const changed = cover !== lines.startCover(i.id)
        return (
          <div
            key={i.id}
            className={cn(
              'border-border flex flex-col gap-2 rounded-md border p-3',
              cover !== 'covered' && 'border-orange/40 bg-orange-bg/30',
            )}
          >
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px]">
              <span className="text-ink font-semibold">{i.name}</span>
              <span className="text-ink-3">
                {t('prices.insurerLines.covers', { pct: r?.coveragePct ?? i.coveragePct })}
              </span>
              {r?.cover && r.cover !== 'covered' && (
                <Badge tone="orange">{t('prices.insurerLines.exception')}</Badge>
              )}
              {r && (
                <span className="text-ink-2 basis-full tabular-nums sm:ml-auto sm:basis-auto">
                  {nowText(r, t)}
                </span>
              )}
            </span>
            <div
              className={cn(
                'grid grid-cols-1 gap-2',
                lines.canCover && 'sm:grid-cols-[minmax(0,1fr)_minmax(0,200px)]',
              )}
            >
              {lines.canCover && (
                <Select
                  label={t('prices.insurerLines.cover')}
                  value={cover}
                  onChange={(e) => lines.set(i.id, { cover: e.target.value as CoverChoice })}
                >
                  <option value="covered">{t('prices.insurerLines.mode.covered')}</option>
                  <option value="not_covered">{t('prices.insurerLines.mode.not_covered')}</option>
                  <option value="preauth">
                    {t('prices.insurerLines.mode.preauth', { name: i.name })}
                  </option>
                </Select>
              )}
              <Field
                label={t('prices.insurerLines.price')}
                inputMode="numeric"
                value={lines.priceOf(i.id)}
                placeholder={t('prices.insurerLines.pricePh')}
                onChange={(e) =>
                  lines.set(i.id, { price: e.target.value.replace(/[^\d]/g, '').slice(0, 10) })
                }
              />
            </div>
            {changed && (
              <Field
                label={t('prices.insurerLines.reason')}
                value={lines.reasonOf(i.id)}
                maxLength={300}
                placeholder={t('prices.insurerLines.reasonPh')}
                onChange={(e) => lines.set(i.id, { reason: e.target.value })}
              />
            )}
          </div>
        )
      })}
      {isNew && <p className="text-ink-3 m-0 text-[13px]">{t('prices.insurerLines.afterSave')}</p>}
    </div>
  )
}

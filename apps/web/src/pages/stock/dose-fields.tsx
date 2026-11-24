import { useState } from 'react'
import { ChevronDown, ChevronUp, Lock, Scale, WandSparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import {
  amountText,
  contentMl,
  MEASURE_UNITS,
  partFigure,
  partPrice,
  pieceContentFromText,
  rounderAmount,
  STRENGTH_UNITS,
  type PartMode,
} from '@/lib/dose'
import { doseUnitLabel, partModeLabel, pieceContentText, pieceLabel } from '@/lib/dose-words'
import { cn } from '@/lib/utils'
import {
  decimalInput,
  decimalOf,
  draftModeNow,
  draftPieceContent,
  keepReading,
  type DoseDraft,
  type DoseWords,
} from './dose-draft'

/**
 * What one piece of a medicine holds (0198): the strength (500 mg a tablet; 250 mg in 5 ml), the
 * content of one piece (a bottle of 100 ml), how it may be given in parts (by its form, whole
 * only, halves, quarters, by the ml) and the price of a part (a share of the piece price, a whole
 * piece, or a price set). The strength read from the name is shown as a proposal, kept with one
 * press. Prices › Medicines and Add stock (each line of a medicine) use it; dose-draft.ts reads
 * and checks it. Before the database has 0198 it shows the name's reading only.
 */
export function DoseFields({
  value,
  onChange,
  words,
  piecePrice,
  ready = true,
  idPrefix,
  collapsible = false,
  defaultOpen = true,
}: {
  value: DoseDraft
  onChange: (d: DoseDraft) => void
  /** The medicine's words as the form has them now (name, strength, form, unit, package). */
  words: DoseWords
  /** The cash price of one piece, for the example ("½ tablet: 25 RWF"). */
  piecePrice: number | null
  /** The database has 0198 (set_item_dose). */
  ready?: boolean
  idPrefix: string
  /** Add stock: a one-line summary with "Change" until opened. */
  collapsible?: boolean
  defaultOpen?: boolean
}) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(defaultOpen || !collapsible)
  const set = (patch: Partial<DoseDraft>) => onChange({ ...value, ...patch })
  const reading = pieceContentFromText(words)
  const drafted = draftPieceContent(value, words)
  const shown = drafted ?? (reading.source === 'name' ? reading : null)
  const piece = pieceLabel(t, reading.piece ?? words.unit)
  const boxOnly = (words.saleMode ?? 'piece') === 'pack' && (words.packSize ?? 1) >= 2
  const byForm = draftModeNow({ ...value, mode: '' }, words)
  const now = draftModeNow(value, words)
  const summaryText = [
    shown ? pieceContentText(t, shown) : t('dose.notSet'),
    !drafted && shown ? t('dose.readFromName') : null,
    partModeLabel(t, now),
  ]
    .filter(Boolean)
    .join(' · ')

  // the examples: "1 g = 2 × 500 mg · 250 mg = ½ tablet · ½ tablet: 25 RWF"
  const examples: string[] = []
  const s = shown?.strength
  if (s && s.per == null) {
    const two = rounderAmount(2 * s.amount, s.unit)
    examples.push(`${amountText(two.amount, two.unit)} = 2 × ${amountText(s.amount, s.unit)}`)
    if (now === 'half' || now === 'quarter')
      examples.push(`${amountText(s.amount / 2, s.unit)} = ½ ${piece}`)
  } else if (s?.per != null && s.perUnit) {
    examples.push(`${amountText(s.amount, s.unit)} = ${amountText(s.per, s.perUnit)}`)
  }
  const ml = contentMl(drafted)
  if (now !== 'whole' && piecePrice != null) {
    const part = now === 'measure' && ml ? 5 / ml : now === 'quarter' ? 0.25 : 0.5
    if (part > 0 && part < 1) {
      const price = partPrice(
        {
          partPriceRule: value.rule,
          halfPrice: decimalOf(value.halfPrice),
          quarterPrice: decimalOf(value.quarterPrice),
          measurePrice: decimalOf(value.measurePrice),
        },
        part,
        piecePrice,
        { mode: now, contentMl: ml },
      )
      const figure = partFigure(part, now, ml)
      examples.push(`${now === 'measure' ? figure : `${figure} ${piece}`}: ${formatRwf(price)}`)
    }
  }

  const heading = (
    <span className="text-ink flex min-w-0 items-center gap-1.5 text-[13px] font-semibold">
      <Scale size={15} aria-hidden="true" className="text-primary flex-none" />
      {t('dose.title')}
    </span>
  )

  if (!ready)
    return (
      <div className="border-border bg-surface flex flex-col gap-1 rounded-md border px-3 py-2">
        {heading}
        <span className="text-ink-2 text-[13px]">
          {reading.source === 'name'
            ? `${pieceContentText(t, reading)} · ${t('dose.readFromName')}`
            : t('dose.notSet')}
        </span>
        <span className="text-ink-3 flex items-start gap-1.5 text-[12px]">
          <Lock size={12} aria-hidden="true" className="mt-0.5 flex-none" />
          {t('analytics.needsUpdate')}
        </span>
      </div>
    )

  if (!open)
    return (
      <div className="border-primary/25 bg-primary-tint/30 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2">
        <span className="text-ink-2 flex min-w-0 flex-1 items-start gap-1.5 text-[13px]">
          <Scale size={14} aria-hidden="true" className="text-primary mt-0.5 flex-none" />
          <span className="min-w-0">{t('dose.summary', { text: summaryText })}</span>
        </span>
        <Button type="button" size="sm" variant="tint-teal" onClick={() => setOpen(true)}>
          <ChevronDown size={14} aria-hidden="true" />
          {t('dose.change')}
        </Button>
      </div>
    )

  const unitOptions = (list: readonly string[]) => [
    <option key="" value="">
      —
    </option>,
    ...list.map((u) => (
      <option key={u} value={u}>
        {doseUnitLabel(t, u)}
      </option>
    )),
  ]
  const modes: ('' | PartMode)[] = ['', 'whole', 'half', 'quarter', 'measure']

  return (
    <div className="border-primary/25 bg-primary-tint/30 flex flex-col gap-2.5 rounded-md border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {heading}
        {collapsible && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => setOpen(false)}
          >
            <ChevronUp size={14} aria-hidden="true" />
            {t('dose.hide')}
          </Button>
        )}
      </div>
      {!drafted && reading.source === 'name' && (
        // the name's reading: a proposal until someone keeps it
        <div className="border-primary/30 bg-card flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border px-3 py-2">
          <span className="text-ink-2 flex min-w-0 flex-1 items-start gap-1.5 text-[13px]">
            <WandSparkles size={14} aria-hidden="true" className="text-primary mt-0.5 flex-none" />
            <span className="min-w-0">
              {t('dose.fromName', { text: pieceContentText(t, reading) })}{' '}
              <span className="text-amber font-semibold">{t('dose.readFromName')}</span>
            </span>
          </span>
          <Button
            type="button"
            size="sm"
            variant="tint-teal"
            onClick={() => onChange(keepReading(value, reading))}
          >
            {t('dose.keep')}
          </Button>
        </div>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <Field
          label={t('dose.amount')}
          inputMode="decimal"
          value={value.amount}
          placeholder="500"
          onChange={(e) => set({ amount: decimalInput(e.target.value) })}
        />
        <Select
          label={t('dose.unitLabel')}
          value={value.unit}
          onChange={(e) => set({ unit: e.target.value })}
        >
          {unitOptions(STRENGTH_UNITS)}
        </Select>
        <Field
          label={t('dose.perLabel')}
          inputMode="decimal"
          value={value.per}
          placeholder="5"
          onChange={(e) => set({ per: decimalInput(e.target.value) })}
        />
        <Select
          label={t('dose.unitLabel')}
          value={value.perUnit}
          onChange={(e) => set({ perUnit: e.target.value })}
        >
          {unitOptions(MEASURE_UNITS)}
        </Select>
      </div>
      <p className="text-ink-3 m-0 text-[12px]">{t('dose.strengthHint')}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <Field
          label={t('dose.content')}
          inputMode="decimal"
          value={value.content}
          placeholder="100"
          onChange={(e) => set({ content: decimalInput(e.target.value) })}
        />
        <Select
          label={t('dose.unitLabel')}
          value={value.contentUnit}
          onChange={(e) => set({ contentUnit: e.target.value })}
        >
          {unitOptions(MEASURE_UNITS)}
        </Select>
      </div>
      <p className="text-ink-3 m-0 text-[12px]">{t('dose.contentHint')}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Select
          id={`${idPrefix}-parts`}
          label={t('dose.parts')}
          value={boxOnly ? 'whole' : value.mode}
          disabled={boxOnly}
          onChange={(e) => set({ mode: e.target.value as DoseDraft['mode'] })}
        >
          {modes.map((m) => (
            <option key={m || 'form'} value={m}>
              {m ? partModeLabel(t, m) : t('dose.modes.form')}
            </option>
          ))}
        </Select>
        {now !== 'whole' && (
          <Select
            id={`${idPrefix}-rule`}
            label={t('dose.priceRule')}
            value={value.rule}
            onChange={(e) => set({ rule: e.target.value as DoseDraft['rule'] })}
          >
            <option value="share">{t('dose.rules.share')}</option>
            <option value="whole">{t('dose.rules.wholePrice')}</option>
            <option value="set">{t('dose.rules.set')}</option>
          </Select>
        )}
      </div>
      <p className="text-ink-3 m-0 text-[12px]">
        {boxOnly
          ? t('dose.boxOnly')
          : [
              // "by its form": what that gives for this medicine
              !value.mode ? `${t('dose.modes.byForm', { mode: partModeLabel(t, byForm) })}.` : null,
              t('dose.partsHint'),
            ]
              .filter(Boolean)
              .join(' ')}
      </p>
      {now !== 'whole' && value.rule === 'set' && (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(now === 'half' || now === 'quarter') && (
              <Field
                label={t('dose.halfPrice', { piece })}
                inputMode="numeric"
                value={value.halfPrice}
                placeholder={piecePrice != null ? String(Math.round(piecePrice / 2)) : undefined}
                onChange={(e) => set({ halfPrice: e.target.value.replace(/[^\d]/g, '') })}
              />
            )}
            {now === 'quarter' && (
              <Field
                label={t('dose.quarterPrice', { piece })}
                inputMode="numeric"
                value={value.quarterPrice}
                placeholder={piecePrice != null ? String(Math.round(piecePrice / 4)) : undefined}
                onChange={(e) => set({ quarterPrice: e.target.value.replace(/[^\d]/g, '') })}
              />
            )}
            {now === 'measure' && (
              <Field
                label={t('dose.measurePrice')}
                inputMode="decimal"
                value={value.measurePrice}
                placeholder={
                  piecePrice != null && ml
                    ? String(Math.round((piecePrice / ml) * 100) / 100)
                    : undefined
                }
                onChange={(e) => set({ measurePrice: decimalInput(e.target.value) })}
              />
            )}
          </div>
          <p className="text-ink-3 m-0 text-[12px]">{t('dose.setCash')}</p>
        </>
      )}
      {examples.length > 0 && (
        <p
          className={cn(
            'text-ink-2 m-0 text-[12.5px] font-medium tabular-nums',
            !drafted && 'text-ink-3',
          )}
        >
          {t('dose.example', {
            text: examples
              .map((x) => x.replace(/(\d)\.(\d)/g, i18n.language === 'fr' ? '$1,$2' : '$1.$2'))
              .join(' · '),
          })}
        </p>
      )}
    </div>
  )
}

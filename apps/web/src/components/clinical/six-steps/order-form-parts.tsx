import type { ReactNode } from 'react'
import { BedDouble, CalendarClock, Repeat } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Field } from '@/components/ui/field'
import { Seg } from '@/components/ui/seg'
import { Select } from '@/components/ui/select'
import { doseUnitLabel } from '@/lib/dose-words'
import { OTHER_UNIT, decimal, type DoseValue } from '@/lib/order-dose'
import {
  EVERY_CHOICES,
  dayChoices,
  kigaliDayMonth,
  kigaliDayOf,
  planText,
  timeChoices,
  type WhenValue,
} from '@/lib/order-plan'

/** A field with its grey one-line hint under it: what it does. */
export function Hinted({ hint, children }: { hint: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {children}
      <span className="text-ink-3 text-xs">{hint}</span>
    </div>
  )
}

/** A small heading inside the form, with its hint. */
export function PartTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-ink-2 text-[13px] font-semibold">{title}</span>
      {hint && <span className="text-ink-3 text-xs">{hint}</span>}
    </span>
  )
}

/**
 * 0198: a dose as a number and a unit of the list (mg, g, ml, IU, the piece's word…), or "Other
 * unit" with its words. Used for the dose given here and the dose each time at home.
 */
export function DoseInput({
  label,
  value,
  onChange,
  units,
}: {
  label: string
  value: DoseValue
  onChange: (v: DoseValue) => void
  units: string[]
}) {
  const { t } = useTranslation()
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 min-[420px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Field
        label={label}
        inputMode="decimal"
        value={value.amount}
        onChange={(e) => onChange({ ...value, amount: decimal(e.target.value) })}
        placeholder="1"
      />
      <Select
        label={t('nurseOrders.doseUnit')}
        value={value.unit}
        onChange={(e) => onChange({ ...value, unit: e.target.value })}
      >
        {units.map((u) => (
          <option key={u} value={u}>
            {doseUnitLabel(t, u)}
          </option>
        ))}
        <option value={OTHER_UNIT}>{t('nurseOrders.doseOther')}</option>
      </Select>
      {value.unit === OTHER_UNIT && (
        <Field
          wrapperClassName="min-[420px]:col-span-2"
          label={t('nurseOrders.doseOtherWords')}
          value={value.other}
          maxLength={40}
          onChange={(e) => onChange({ ...value, other: e.target.value })}
          placeholder="puffs"
        />
      )}
    </div>
  )
}

/**
 * 0198: when the order is given — now, or a day and a time (up to 7 days ahead) — and whether it
 * is repeated: every 4 … 24 hours (or another number), a number of times, of days, or until
 * stopped, with the plan in words ("First at 14:00, then every 8 hours: 9 times, last on 27/11
 * 06:00"). A patient who is not in a bed is warned that the times after the visit are not given.
 */
export function OrderWhen({
  value: w,
  onChange,
  repeatable,
  inBed,
  homeSplit,
  now,
}: {
  value: WhenValue
  onChange: (patch: Partial<WhenValue>) => void
  /** Repeat is offered (not for a medicine only to take home). */
  repeatable: boolean
  inBed: boolean
  /** "Both" and Repeat: what goes home becomes its own order. */
  homeSplit: boolean
  now: number
}) {
  const { t } = useTranslation()
  const today = kigaliDayOf(now)
  const tomorrow = kigaliDayOf(now + 24 * 3_600_000)
  const dayWord = (d: string) =>
    d === today
      ? t('ops.appts.today')
      : d === tomorrow
        ? t('ops.appts.tomorrow')
        : kigaliDayMonth(Date.parse(`${d}T12:00:00Z`))
  const times = timeChoices(w.atDay, now)
  if (w.atTime && !times.includes(w.atTime)) times.unshift(w.atTime)
  const plan = planText(t, w, now)
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <PartTitle title={t('nurseOrders.giveAt')} hint={t('nurseOrders.giveAtHint')} />
        <Seg
          label={t('nurseOrders.giveAt')}
          value={w.giveAt}
          onChange={(v) => onChange({ giveAt: v })}
          options={[
            { value: 'now', label: t('nurseOrders.giveNow') },
            { value: 'later', label: t('nurseOrders.giveLater') },
          ]}
          className="self-start"
        />
        {w.giveAt === 'later' && (
          <div className="grid min-w-0 grid-cols-1 gap-3 min-[420px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:max-w-md">
            <Select
              label={t('nurseOrders.giveDay')}
              value={w.atDay}
              onChange={(e) => onChange({ atDay: e.target.value })}
            >
              {dayChoices(now).map((d) => (
                <option key={d} value={d}>
                  {dayWord(d)}
                </option>
              ))}
            </Select>
            <Select
              label={t('nurseOrders.giveTime')}
              value={w.atTime}
              onChange={(e) => onChange({ atTime: e.target.value })}
            >
              {times.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      {repeatable && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <PartTitle title={t('nurseOrders.repeat')} />
          <Seg
            label={t('nurseOrders.repeat')}
            value={w.repeat}
            onChange={(v) => onChange({ repeat: v })}
            options={[
              { value: 'once', label: t('nurseOrders.once') },
              { value: 'repeat', label: t('nurseOrders.repeat') },
            ]}
            className="self-start"
          />
          {w.repeat === 'repeat' && (
            <div className="flex min-w-0 flex-col gap-3">
              <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Select
                  label={t('nurseOrders.every')}
                  value={w.every}
                  onChange={(e) => onChange({ every: e.target.value })}
                >
                  {EVERY_CHOICES.map((h) => (
                    <option key={h} value={String(h)}>
                      {t('nurseOrders.everyPerDay', { hours: h, count: 24 / h })}
                    </option>
                  ))}
                  <option value="other">{t('nurseOrders.everyOther')}</option>
                </Select>
                {w.every === 'other' && (
                  <Field
                    label={t('nurseOrders.everyOtherHours')}
                    inputMode="numeric"
                    value={w.everyOther}
                    onChange={(e) => onChange({ everyOther: e.target.value.replace(/\D/g, '') })}
                  />
                )}
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-ink-2 text-[13px] font-medium">
                  {t('nurseOrders.forLabel')}
                </span>
                <Seg
                  label={t('nurseOrders.forLabel')}
                  value={w.forKind}
                  onChange={(v) => onChange({ forKind: v })}
                  options={[
                    { value: 'times', label: t('nurseOrders.forTimesOpt') },
                    { value: 'days', label: t('nurseOrders.forDaysOpt') },
                    { value: 'until', label: t('nurseOrders.untilStopped') },
                  ]}
                  className="self-start"
                />
              </div>
              {w.forKind !== 'until' && (
                <Field
                  wrapperClassName="sm:max-w-xs"
                  label={t(
                    w.forKind === 'times' ? 'nurseOrders.howManyTimes' : 'nurseOrders.howManyDays',
                  )}
                  inputMode="numeric"
                  value={w.forCount}
                  onChange={(e) => onChange({ forCount: e.target.value.replace(/\D/g, '') })}
                />
              )}
              {plan && (
                <p className="text-ink-2 m-0 flex min-w-0 items-start gap-1.5 text-[13px]">
                  <Repeat size={14} aria-hidden="true" className="mt-0.5 flex-none" />
                  <span className="min-w-0">{plan}</span>
                </p>
              )}
              {!inBed && (
                <p className="text-amber m-0 flex min-w-0 items-start gap-1.5 text-[13px] font-semibold">
                  <BedDouble size={14} aria-hidden="true" className="mt-0.5 flex-none" />
                  <span className="min-w-0">{t('nurseOrders.notInBed')}</span>
                </p>
              )}
              {homeSplit && (
                <p className="text-ink-2 m-0 flex min-w-0 items-start gap-1.5 text-[13px]">
                  <CalendarClock size={14} aria-hidden="true" className="mt-0.5 flex-none" />
                  <span className="min-w-0">{t('nurseOrders.homeSplit')}</span>
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

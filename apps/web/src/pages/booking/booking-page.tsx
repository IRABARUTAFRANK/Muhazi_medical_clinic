import { useState, type FormEvent } from 'react'
import { Calendar, Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import {
  CATEGORY_FILTERS,
  FEATURES,
  MAX_WEEKS_AHEAD,
  buildCalendar,
  formatDayMonth,
  formatHour,
  freeMinutesIn,
  hoursRange,
  nextFreeSlot,
  parseSlotId,
  startOfDay,
  weekdaysOf,
  type CategoryFilter,
  type Practitioner,
} from '@mmc/shared'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
import { SiteFooter } from '@/components/public/site-footer'
import { SiteNav, Wrap } from '@/components/public/site-nav'
import { inquiryErrorKey, sendInquiry } from '@/lib/api/inquiries'
import { bookedFor, useBookedSlots, usePractitioners } from '@/lib/api/public'
import { appNow, kigaliTime } from '@/lib/clock'
import { useDayNames } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import { CalendarGrid } from './calendar-grid'

interface BookingPageProps {
  category: CategoryFilter
  onCategoryChange: (category: CategoryFilter) => void
  /** A doctor chosen on the home page ("Book" next to that doctor). */
  doctor?: string
}

/**
 * Public "find a doctor" calendar: category chips → doctor list → 7-day grid → request panel.
 * Free/booked comes from each practitioner's working hours and the live booked slots; the
 * database re-checks both when the inquiry is created.
 */
export function BookingPage({ category, onCategoryChange, doctor }: BookingPageProps) {
  const { t } = useTranslation()
  const dayNames = useDayNames()
  const now = appNow()

  const { data: practitioners = [] } = usePractitioners()
  const { data: booked } = useBookedSlots(startOfDay(now), (MAX_WEEKS_AHEAD + 1) * 7)
  const filtered = practitioners.filter((p) => category === 'all' || p.cats.includes(category))

  const [docCode, setDocCode] = useState<string | null>(doctor ?? null)
  const [week, setWeek] = useState(0)
  const [pick, setPick] = useState<string | null>(null)
  // the slot inside the chosen hour (09:00, 09:30… by the doctor's slot length)
  const [minute, setMinute] = useState(0)
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [insurer, setInsurer] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [sentRef, setSentRef] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const selected: Practitioner | undefined = filtered.find((p) => p.code === docCode) ?? filtered[0]
  const calendar = selected ? buildCalendar(selected, now, week, bookedFor(booked, selected)) : null
  const range = selected ? hoursRange(selected.hours) : null

  const resetRequest = () => {
    setPick(null)
    setSentRef(null)
    setError(null)
  }
  const choose = (code: string) => {
    setDocCode(code)
    resetRequest()
  }
  const changeWeek = (delta: number) => {
    setWeek((w) => Math.min(MAX_WEEKS_AHEAD, Math.max(0, w + delta)))
    resetRequest()
  }

  const picked = pick ? parseSlotId(pick) : null
  // the free slots of the chosen hour (a confirmed booking takes only its own minutes)
  const minutes =
    picked && selected
      ? freeMinutesIn(
          selected,
          now,
          Math.round((startOfDay(picked.date).getTime() - startOfDay(now).getTime()) / 86_400_000),
          picked.hour,
          bookedFor(booked, selected),
        )
      : []
  const atMinute = minutes.includes(minute) ? minute : (minutes[0] ?? 0)
  const hhmm = (h: number, m: number) =>
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  const pickLabel = picked
    ? t('booking.pickLabel', {
        day: dayNames.short[picked.date.getDay()],
        date: `${formatDayMonth(picked.date)}/${picked.date.getFullYear()}`,
        time: hhmm(picked.hour, atMinute),
      })
    : ''
  const nextFreeLabel = (p: Practitioner) => {
    const s = nextFreeSlot(p, now, 14, bookedFor(booked, p))
    return s
      ? `${dayNames.short[s.date.getDay()]} ${formatDayMonth(s.date)} ${formatHour(s.hour)}`
      : t('booking.askReception')
  }
  const workdaysLabel = (p: Practitioner) => {
    const days = weekdaysOf(p.hours)
    return days.length === 7
      ? t('booking.everyDay')
      : days.length >= 5 && !days.includes(0)
        ? t('booking.monSat')
        : days.map((d) => dayNames.short[d]).join(' ')
  }

  const onSend = async (e: FormEvent) => {
    e.preventDefault()
    if (!selected || !picked) return
    setBusy(true)
    setError(null)
    try {
      // the clinic's time, whatever the visitor's clock says
      const startsAt = kigaliTime(
        picked.date.getFullYear(),
        picked.date.getMonth(),
        picked.date.getDate(),
        picked.hour,
        atMinute,
      )
      const result = await sendInquiry({
        practitionerCode: selected.code,
        startsAt,
        fullName,
        phone,
        insurer,
        category,
        note: reason,
      })
      setSentRef(result.reference)
    } catch (err) {
      const key = inquiryErrorKey(err instanceof Error ? err.message : '')
      setError(key === 'generic' ? t('booking.sendFailed') : t(`landing.book.errors.${key}`))
    } finally {
      setBusy(false)
    }
  }

  const weekStart = calendar?.days[0]
  const weekEnd = calendar?.days[6]

  return (
    <div className="theme-public bg-surface text-ink flex min-h-dvh flex-col text-[15px] leading-normal">
      <SiteNav current="booking" />

      <Wrap className="flex flex-col gap-5 pt-8 pb-12">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[280px] flex-1">
            <h1 className="m-0 text-3xl font-extrabold tracking-[-0.01em]">{t('booking.title')}</h1>
            <p className="text-ink-2 mt-1 mb-0">{t('booking.lead')}</p>
          </div>
          <Legend swatch="border-primary bg-card" label={t('booking.legendFree')} />
          <Legend swatch="border-transparent bg-hover" label={t('booking.legendBooked')} />
          <Legend swatch="border-primary bg-primary" label={t('booking.legendChoice')} />
        </div>

        {/* CATEGORY CHIPS */}
        <div role="group" aria-label={t('booking.categoryGroup')} className="flex flex-wrap gap-2">
          {CATEGORY_FILTERS.map((c) => {
            const count =
              c === 'all'
                ? practitioners.length
                : practitioners.filter((p) => p.cats.includes(c)).length
            const on = c === category
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                onClick={() => onCategoryChange(c)}
                className={cn(
                  'inline-flex min-h-10 items-center gap-2 rounded-full border px-3.5 text-[13px] font-semibold whitespace-nowrap transition-colors',
                  on
                    ? 'border-primary bg-primary text-on-primary'
                    : 'border-border bg-card text-ink-2 hover:bg-hover',
                )}
              >
                {t(`categories.${c}`)}
                <span className="tabular-nums opacity-80">{count}</span>
              </button>
            )
          })}
        </div>

        <div className="pc:grid-cols-[340px_minmax(0,1fr)] grid items-start gap-4">
          {/* DOCTORS */}
          <section className="flex flex-col gap-2">
            <div className="text-ink-3 px-1 text-xs font-bold tracking-[.06em] uppercase">
              {t('booking.available', {
                count: filtered.length,
                category: t(`categories.${category}`),
              })}
            </div>
            {filtered.map((p) => (
              <button
                key={p.code}
                type="button"
                aria-pressed={p.code === selected?.code}
                onClick={() => choose(p.code)}
                className={cn(
                  'bg-card hover:bg-hover flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                  p.code === selected?.code
                    ? 'border-primary ring-primary-tint ring-2'
                    : 'border-border',
                )}
              >
                <Avatar name={p.name} size="lg" />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="font-bold">{p.name}</span>
                  <span className="text-ink-2 text-[13px]">{p.title}</span>
                  <span className="flex flex-wrap gap-1">
                    {p.langs && <Chip>{p.langs}</Chip>}
                    <Chip>{workdaysLabel(p)}</Chip>
                  </span>
                  {p.note && <span className="text-violet text-xs italic">{p.note}</span>}
                  <span className="text-green text-xs font-semibold">
                    {t('booking.nextFree', { when: nextFreeLabel(p) })}
                  </span>
                </span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="bg-amber-bg text-amber rounded-lg p-4 text-sm font-semibold">
                {t('booking.noneYet')}
              </div>
            )}
            {category === 'laboratory' && (
              <div className="bg-primary-tint flex flex-col gap-1.5 rounded-lg p-4">
                <b>{t('booking.labTitle')}</b>
                <span className="text-ink-2 text-sm">{t('booking.labBody')}</span>
              </div>
            )}
          </section>

          {/* CALENDAR */}
          {selected && calendar && weekStart && weekEnd && (
            <section className="border-border bg-card flex min-w-0 flex-col gap-3 rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-3">
                <Avatar name={selected.name} size="md" />
                <span className="min-w-[200px] flex-1">
                  <b className="text-base">{selected.name}</b>
                  <span className="text-ink-2 block text-[13px]">
                    {selected.title}
                    {range ? ` · ${range.start}–${range.end}` : ''}
                  </span>
                </span>
                <span className="flex items-center gap-1.5">
                  <Button
                    size="icon"
                    aria-label={t('common.previousWeek')}
                    disabled={week === 0}
                    onClick={() => changeWeek(-1)}
                  >
                    <ChevronLeft size={18} aria-hidden="true" />
                  </Button>
                  <span className="min-w-[170px] text-center font-semibold tabular-nums">
                    {formatDayMonth(weekStart)} – {formatDayMonth(weekEnd)}/{weekEnd.getFullYear()}
                  </span>
                  <Button
                    size="icon"
                    aria-label={t('common.nextWeek')}
                    disabled={week === MAX_WEEKS_AHEAD}
                    onClick={() => changeWeek(1)}
                  >
                    <ChevronRight size={18} aria-hidden="true" />
                  </Button>
                </span>
              </div>
              <CalendarGrid
                days={calendar.days}
                rows={calendar.rows}
                todayIndex={week === 0 ? 0 : -1}
                selectedId={pick}
                onPick={(id) => {
                  // the time belongs to this doctor: the doctor stays chosen with it
                  setDocCode(selected?.code ?? null)
                  setPick(id)
                  setMinute(0)
                  setSentRef(null)
                  setError(null)
                }}
              />
            </section>
          )}
        </div>

        {/* REQUEST PANEL */}
        {pick && selected && (
          <section className="border-primary bg-card flex flex-col gap-3.5 rounded-lg border p-5 shadow-[0_12px_32px_rgba(31,41,51,.10)]">
            {!sentRef ? (
              <>
                <div className="flex flex-wrap items-center gap-4">
                  <span className="bg-primary text-on-primary inline-flex size-11 flex-none items-center justify-center rounded-full">
                    <Calendar size={20} strokeWidth={2.5} aria-hidden="true" />
                  </span>
                  <span className="min-w-[240px] flex-1">
                    <b className="text-base">{t('booking.yourRequest')}</b>
                    <span className="text-ink-2 block tabular-nums">
                      {selected.name} · {pickLabel} ·{' '}
                      {category === 'all' ? selected.title : t(`categories.${category}`)}
                    </span>
                  </span>
                  <Chip className="h-7 text-xs">{t('common.notConfirmed')}</Chip>
                </div>
                <form className="contents" onSubmit={onSend}>
                  {/* several slots in the hour (30-minute slots…): choose the exact time */}
                  {minutes.length > 1 && (
                    <div className="flex flex-wrap items-center gap-2" role="radiogroup">
                      <span className="text-ink-2 text-[13px] font-semibold">
                        {t('booking.exactTime')}
                      </span>
                      {minutes.map((m) => (
                        <button
                          key={m}
                          type="button"
                          aria-pressed={atMinute === m}
                          onClick={() => setMinute(m)}
                          className={cn(
                            'inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm font-semibold tabular-nums',
                            atMinute === m
                              ? 'border-primary bg-primary-tint text-primary'
                              : 'border-border bg-card text-ink hover:bg-hover',
                          )}
                        >
                          {hhmm(picked!.hour, m)}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Field
                      label={t('booking.fullName')}
                      placeholder={t('booking.fullNamePh')}
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      required
                    />
                    <Field
                      label={t('booking.phone')}
                      type="tel"
                      placeholder={t('booking.phonePh')}
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      required
                    />
                    <Field
                      label={t('booking.reason')}
                      placeholder={t('booking.reasonPh')}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      wrapperClassName={FEATURES.insurance ? undefined : 'sm:col-span-1'}
                    />
                    {FEATURES.insurance && (
                      <Field
                        label={t('booking.insurance')}
                        placeholder={t('booking.insurancePh')}
                        value={insurer}
                        onChange={(e) => setInsurer(e.target.value)}
                      />
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="submit"
                      variant="primary"
                      size="lg"
                      className="px-6"
                      disabled={busy}
                    >
                      {busy ? t('booking.sending') : t('common.sendRequest')}
                    </Button>
                    <span className="text-ink-3 text-[13px]">
                      <Trans i18nKey="booking.replyNote" components={{ b: <b /> }} />
                    </span>
                  </div>
                  {error && (
                    <p
                      role="alert"
                      className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
                    >
                      {error}
                    </p>
                  )}
                </form>
              </>
            ) : (
              <div role="status" className="flex flex-wrap items-center gap-4">
                <span className="bg-green-bg text-green inline-flex size-11 flex-none items-center justify-center rounded-full">
                  <Check size={22} strokeWidth={3} aria-hidden="true" />
                </span>
                <span className="min-w-[240px] flex-1">
                  <b className="text-base">{t('booking.sentTitle', { ref: sentRef })}</b>
                  <span className="text-ink-2 block tabular-nums">
                    {t('booking.sentBody', { doctor: selected.name, when: pickLabel })}
                  </span>
                </span>
                <Button onClick={resetRequest}>{t('common.makeAnother')}</Button>
              </div>
            )}
          </section>
        )}
      </Wrap>

      <SiteFooter />
    </div>
  )
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="text-ink-2 inline-flex items-center gap-1.5 text-xs">
      <i className={cn('inline-block size-3.5 rounded border', swatch)} aria-hidden="true" />
      {label}
    </span>
  )
}

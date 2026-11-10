import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { BOOKING_FIRST_HOUR, BOOKING_LAST_HOUR } from '@mmc/shared'
import { kigaliMinutes } from '@/lib/clock'
import { useNow } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import { Select } from './select'

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * A booking time picked from a list instead of the browser's clock picker: the clock picker
 * counts its steps from whatever time the field holds (08:34 gave :04, :19, :34, :49), which
 * patients and receptionists could not read. The list runs from the first to the last booking
 * hour in steps of `step` minutes; on today's date the times already past are left out. A value
 * that is not on a step (a time a patient asked for on the website) stays in the list. When
 * nothing is left today, the only line says so instead of an empty list (0152).
 */
export function TimeSelect({
  label,
  value,
  onChange,
  step = 15,
  day,
  required,
  wrapperClassName,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  /** Minutes between two times (the doctor's booking length at reception). */
  step?: number
  /** The chosen day (yyyy-mm-dd): today drops the past times. */
  day?: string
  required?: boolean
  wrapperClassName?: string
}) {
  const { t } = useTranslation()
  const every = Math.max(5, Math.min(step || 15, 120))
  // the clinic's clock (Kigali, UTC+2), whatever the phone's own time zone; ticks each minute
  const nowMs = useNow(60_000)
  const kigali = new Date(nowMs + 2 * 3_600_000)
  const today = day === kigali.toISOString().slice(0, 10)
  const nowMin = kigaliMinutes(nowMs)
  const times: string[] = []
  for (let m = BOOKING_FIRST_HOUR * 60; m <= BOOKING_LAST_HOUR * 60; m += every) {
    if (today && m <= nowMin) continue
    times.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`)
  }
  if (value && !times.includes(value)) times.unshift(value)
  const nothingToday = today && times.length === 0
  // a required chooser with nothing to choose: the browser's bubble says why, not "select an item"
  const ref = useRef<HTMLSelectElement>(null)
  const why = nothingToday ? t('common.noTimeTodayHint') : ''
  useEffect(() => {
    ref.current?.setCustomValidity(why)
  }, [why])
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', wrapperClassName)}>
      <Select
        ref={ref}
        label={label}
        value={value}
        required={required}
        aria-invalid={nothingToday || undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t(nothingToday ? 'common.noTimeToday' : 'common.chooseTime')}</option>
        {times.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </Select>
      {nothingToday && <p className="text-amber m-0 text-[12px] font-medium">{why}</p>}
    </div>
  )
}

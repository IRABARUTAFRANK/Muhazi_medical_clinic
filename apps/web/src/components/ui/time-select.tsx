import { useTranslation } from 'react-i18next'
import { BOOKING_FIRST_HOUR, BOOKING_LAST_HOUR } from '@mmc/shared'
import { useNow } from '@/lib/hooks'
import { Select } from './select'

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * A booking time picked from a list instead of the browser's clock picker: the clock picker
 * counts its steps from whatever time the field holds (08:34 gave :04, :19, :34, :49), which
 * patients and receptionists could not read. The list runs from the first to the last booking
 * hour in steps of `step` minutes; on today's date the times already past are left out. A value
 * that is not on a step (a time a patient asked for on the website) stays in the list.
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
  const nowMin = kigali.getUTCHours() * 60 + kigali.getUTCMinutes()
  const times: string[] = []
  for (let m = BOOKING_FIRST_HOUR * 60; m <= BOOKING_LAST_HOUR * 60; m += every) {
    if (today && m <= nowMin) continue
    times.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`)
  }
  if (value && !times.includes(value)) times.unshift(value)
  return (
    <Select
      label={label}
      value={value}
      required={required}
      wrapperClassName={wrapperClassName}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{t('common.chooseTime')}</option>
      {times.map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </Select>
  )
}

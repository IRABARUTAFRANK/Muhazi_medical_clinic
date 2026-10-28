import { useTranslation } from 'react-i18next'
import { formatDayMonth, formatHour, type CalendarRow } from '@mmc/shared'
import { useDayNames } from '@/lib/hooks'
import { cn } from '@/lib/utils'

interface CalendarGridProps {
  days: Date[]
  rows: CalendarRow[]
  /** Index of today inside `days`, or -1 when viewing a later week. */
  todayIndex: number
  selectedId: string | null
  onPick: (id: string) => void
}

/** 7-day × hourly grid of free / booked / off slots. */
export function CalendarGrid({ days, rows, todayIndex, selectedId, onPick }: CalendarGridProps) {
  const { t } = useTranslation()
  const dayNames = useDayNames()
  return (
    <div className="grid grid-cols-[38px_repeat(7,minmax(0,1fr))] items-stretch gap-0.5 sm:grid-cols-[64px_repeat(7,minmax(0,1fr))] sm:gap-1">
      <span />
      {days.map((d, i) => (
        <span
          key={d.toISOString()}
          className="border-border text-ink-2 border-b py-1.5 text-center text-[11px] leading-tight font-semibold sm:text-xs"
        >
          {dayNames.short[d.getDay()]}
          <b
            className={cn(
              'block text-[11px] tabular-nums sm:text-base',
              i === todayIndex ? 'text-primary' : 'text-ink',
            )}
          >
            {formatDayMonth(d)}
          </b>
        </span>
      ))}
      {rows.map((row) => (
        <HourRow
          key={row.hour}
          row={row}
          days={days}
          dayNames={dayNames.short}
          selectedId={selectedId}
          onPick={onPick}
          t={t}
        />
      ))}
    </div>
  )
}

function HourRow({
  row,
  dayNames,
  selectedId,
  onPick,
  t,
}: {
  row: CalendarRow
  days: Date[]
  dayNames: string[]
  selectedId: string | null
  onPick: (id: string) => void
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  return (
    <>
      <span className="text-ink-3 flex items-center justify-end pr-1 text-[11px] tabular-nums sm:pr-2 sm:text-xs">
        {formatHour(row.hour)}
      </span>
      {row.cells.map((cell) => {
        const selected = cell.id === selectedId
        const stateKey = selected ? 'selected' : cell.state
        const label = selected
          ? `✓ ${formatHour(cell.hour)}`
          : cell.state === 'booked'
            ? '—'
            : cell.state === 'free'
              ? formatHour(cell.hour)
              : ''
        return (
          <button
            key={cell.id}
            type="button"
            disabled={cell.state !== 'free'}
            onClick={() => onPick(cell.id)}
            aria-pressed={selected}
            aria-label={t('booking.slotAria', {
              state: t(`booking.slot.${stateKey}`),
              day: dayNames[cell.date.getDay()],
              date: formatDayMonth(cell.date),
              time: formatHour(cell.hour),
            })}
            // seven days share the width: no finger-size minimum width (each cell is 44 px high)
            className={cn(
              'flex min-h-11 min-w-0 items-center justify-center gap-1 rounded-md border px-0 text-[10px] font-semibold sm:text-xs',
              selected && 'border-primary bg-primary text-on-primary',
              !selected &&
                cell.state === 'free' &&
                'border-border bg-card text-primary hover:bg-primary-tint',
              !selected &&
                cell.state === 'booked' &&
                'bg-hover text-ink-3 cursor-not-allowed border-transparent font-medium',
              !selected &&
                cell.state === 'off' &&
                'cursor-default border-transparent bg-transparent',
            )}
          >
            {label}
          </button>
        )
      })}
    </>
  )
}

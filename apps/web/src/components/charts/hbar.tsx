import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type ChartSubject = 'money' | 'visits' | 'time'
const fillClass: Record<ChartSubject, string> = {
  money: 'bg-c-money',
  visits: 'bg-c-visits',
  time: 'bg-c-time',
}

export interface HBarRow {
  label: string
  value: number
  /** Printed value (defaults to the number). */
  display?: ReactNode
  /** Tooltip text for the row (defaults to label: display). */
  title?: string
}

interface HBarListProps {
  rows: readonly HBarRow[]
  /** Scale maximum; defaults to the largest value. */
  max?: number
  subject: ChartSubject
  /** Label column width when the list is wide enough for one row per bar. */
  labelWidth?: string
  className?: string
}

/**
 * Horizontal bars with the value written at the end of each row; one subject, one colour.
 * In narrow cards (< 448 px) the label and value sit above a full-width bar so the bar
 * keeps enough room to be read.
 */
export function HBarList({
  rows,
  max,
  subject,
  labelWidth = 'minmax(96px,120px)',
  className,
}: HBarListProps) {
  const scale = max ?? Math.max(1, ...rows.map((r) => r.value))
  const style = { '--cols': `${labelWidth} 1fr auto` } as CSSProperties
  return (
    <div className={cn('@container flex flex-col gap-2', className)}>
      {rows.map((r) => (
        <div
          key={r.label}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 @md:min-h-6 @md:grid-cols-(--cols) @md:gap-y-0"
          style={style}
          title={r.title ?? `${r.label}: ${typeof r.display === 'string' ? r.display : r.value}`}
        >
          <span className="text-ink-2 truncate text-[13px] @md:order-1">{r.label}</span>
          <span className="text-[13px] font-semibold whitespace-nowrap tabular-nums @md:order-3">
            {r.display ?? r.value}
          </span>
          <span className="bg-hover col-span-2 h-4 overflow-hidden rounded @md:order-2 @md:col-span-1">
            <span
              className={cn('block h-full rounded', fillClass[subject])}
              style={{ width: `${Math.round((r.value / scale) * 100)}%` }}
            />
          </span>
        </div>
      ))}
    </div>
  )
}

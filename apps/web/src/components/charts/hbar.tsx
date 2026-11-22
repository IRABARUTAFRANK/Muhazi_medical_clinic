import { createElement, type CSSProperties, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
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
  /** Symbol before the label (payment method, service group). */
  icon?: LucideIcon
  /** Tooltip text for the row (defaults to label: display). */
  title?: string
}

interface HBarListProps {
  rows: readonly HBarRow[]
  /** Scale maximum; defaults to the largest value. */
  max?: number
  subject: ChartSubject
  /** Explicit bar colour per row (overrides the subject colour), e.g. payment methods. */
  colors?: readonly string[]
  /** Label column width when the list is wide enough for one row per bar. Left out, the
   *  column is as wide as the longest label (at most 45 % of the list), so no label is cut. */
  labelWidth?: string
  className?: string
}

/**
 * Horizontal bars with the value written at the end of each row; one subject, one colour.
 * In narrow cards (< 448 px) the label and value sit above a full-width bar so the bar
 * keeps enough room to be read. The values share one column width (the longest value), so in
 * a wide card every bar ends at the same place and the figures line up on the right.
 */
export function HBarList({ rows, max, subject, colors, labelWidth, className }: HBarListProps) {
  const scale = max ?? Math.max(1, ...rows.map((r) => r.value))
  // the longest printed value in "ch" (tabular figures are 1 ch each; a comma or a dot is less)
  const valueCh = Math.max(
    1,
    ...rows.map((r) =>
      typeof r.display === 'string' || r.display == null ? String(r.display ?? r.value).length : 0,
    ),
  )
  // the label column: the longest label (a letter is under 1 ch) plus its symbol
  const labelCh = Math.max(1, ...rows.map((r) => r.label.length))
  const labelCol =
    labelWidth ??
    `minmax(72px,min(calc(${labelCh}ch + ${rows.some((r) => r.icon) ? '1.5rem' : '0.25rem'}),45%))`
  const style = {
    '--cols': `${labelCol} 1fr auto`,
    '--val': `${valueCh}ch`,
  } as CSSProperties
  return (
    <div className={cn('@container flex flex-col gap-2', className)}>
      {rows.map((r, i) => (
        <div
          key={r.label}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 @md:min-h-6 @md:grid-cols-(--cols) @md:gap-y-0"
          style={style}
          title={r.title ?? `${r.label}: ${typeof r.display === 'string' ? r.display : r.value}`}
        >
          <span className="text-ink-2 flex min-w-0 items-center gap-1.5 text-[14px] @md:order-1">
            {r.icon &&
              createElement(r.icon, {
                size: 15,
                className: 'text-ink-3 flex-none',
                'aria-hidden': true,
              })}
            <span className="truncate">{r.label}</span>
          </span>
          <span className="text-right text-[14px] font-semibold whitespace-nowrap tabular-nums @md:order-3 @md:min-w-(--val)">
            {r.display ?? r.value}
          </span>
          <span className="bg-hover col-span-2 h-2.5 overflow-hidden rounded-full @md:order-2 @md:col-span-1">
            <span
              className={cn(
                'bar-grow block h-full rounded-full',
                !colors?.[i] && fillClass[subject],
              )}
              style={
                {
                  width: `${Math.round((r.value / scale) * 100)}%`,
                  background: colors?.[i],
                  '--i': i,
                } as CSSProperties
              }
            />
          </span>
        </div>
      ))}
    </div>
  )
}

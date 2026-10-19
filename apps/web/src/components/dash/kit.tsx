import type { CSSProperties, ReactNode } from 'react'
import { ArrowDown, ArrowUp, Minus, type LucideIcon } from 'lucide-react'
import { formatNumber } from '@mmc/shared'
import { useCountUp } from '@/lib/motion'
import { cn } from '@/lib/utils'

/*
 * Dashboard kit (Figma: "Muhazi Clinic — Manager Dashboard v2"): tinted KPI tiles with
 * count-up numbers, 16 px cards with a soft shadow, section titles, pills and list rows.
 * Every dashboard (manager, head of station, front desk, nursing) is built from these so
 * they share one look and one motion system.
 */

import { tintClass, type Tint, card } from './kit-style'
export function CountUp({ value }: { value: number }) {
  const v = useCountUp(value, 600)
  return <>{formatNumber(v)}</>
}

export function Kpi({
  i,
  icon: IconC,
  tint,
  label,
  value,
  unit,
  delta: d,
  spark,
}: {
  i: number
  icon: LucideIcon
  tint: Tint
  label: string
  value: number
  unit: string
  delta?: { text: string; good: boolean | null; up: boolean | null }
  spark?: number[]
}) {
  const Arrow = d ? (d.up === null ? Minus : d.up ? ArrowUp : ArrowDown) : Minus
  const pill = d
    ? d.good === null
      ? 'bg-hover text-ink-2'
      : d.good
        ? 'bg-green-bg text-green'
        : 'bg-red-bg text-red'
    : ''
  return (
    <div
      className={cn(card, 'anim-enter relative gap-2.5 overflow-hidden px-[18px] pt-[18px] pb-3.5')}
      style={{ '--i': i } as CSSProperties}
    >
      <span
        className={cn(
          'inline-flex size-10 items-center justify-center rounded-xl',
          tintClass[tint],
        )}
      >
        <IconC size={18} aria-hidden="true" />
      </span>
      <span className="text-ink-2 text-[12px] font-bold tracking-[.04em] uppercase">{label}</span>
      <span className="flex flex-wrap items-baseline gap-1.5 text-[30px] leading-none font-extrabold tracking-[-0.02em] tabular-nums">
        <CountUp value={value} />
        <small className="text-ink-3 text-[13px] font-semibold">{unit}</small>
      </span>
      {d && (
        <span
          className={cn(
            'fade-in-late inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-bold tabular-nums',
            pill,
          )}
        >
          <Arrow size={12} strokeWidth={3} aria-hidden="true" />
          {d.text}
        </span>
      )}
      {spark && spark.length > 1 && <Sparkline values={spark} />}
    </div>
  )
}

export function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values)
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * 84},${34 - (v / max) * 28}`)
    .join(' ')
  return (
    <svg
      viewBox="0 0 84 34"
      className="text-violet pointer-events-none absolute right-3 bottom-3 h-[34px] w-[84px]"
      aria-hidden="true"
    >
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        pathLength={1}
        className="draw-line"
      />
    </svg>
  )
}

export function Panel({
  i,
  title,
  right,
  children,
  className,
}: {
  i: number
  title: string
  right?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn(card, 'anim-enter', className)} style={{ '--i': i } as CSSProperties}>
      <h3 className="m-0 flex items-center justify-between gap-2 text-[15px] font-bold">
        <span className="truncate">{title}</span>
        {right && <span className="text-ink-3 truncate text-xs font-semibold">{right}</span>}
      </h3>
      {children}
    </section>
  )
}

export function Pill({ tint, children }: { tint: Tint; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex min-w-6 justify-center rounded-full px-2 py-0.5 text-[11px] font-bold',
        tintClass[tint],
      )}
    >
      {children}
    </span>
  )
}

export function ListRows({
  rows,
}: {
  rows: { key: string; pill: ReactNode; label: string; value: string }[]
}) {
  return (
    <div className="flex flex-col">
      {rows.map((r, i) => (
        <div
          key={r.key}
          className="border-grid anim-enter flex min-h-9 items-center gap-2.5 border-b py-1.5 text-[13px] last:border-b-0"
          style={{ '--i': i } as CSSProperties}
        >
          {r.pill}
          <span className="min-w-0 flex-1 truncate">{r.label}</span>
          <span className="font-bold whitespace-nowrap tabular-nums">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-ink-3 m-0 py-2 text-[13px]">{children}</p>
}

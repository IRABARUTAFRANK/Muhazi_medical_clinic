import { useId, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'
import { niceScale } from './format'

/*
 * Charts of the Analytics page. One categorical palette (validated for colour-blind readers and
 * contrast in both themes, see SERIES_CSS), used in a fixed order and never cycled; a fifth
 * series and more fold into "Other" (grey). Text always wears the text colours, never a series
 * colour. Thin bars with 2 px gaps between stacked parts, 4 px rounded tops, 2 px lines,
 * recessive grid, hover/focus tooltip, and a table view next to every chart.
 */

/** The series colours: --an-1 … --an-4 and --an-other, light and dim theme. */
export const SERIES_CSS = `
.mmc-analytics{--an-1:#1a7aa3;--an-2:#d0661a;--an-3:#7a5ce0;--an-4:#2f8f5b;--an-other:#8794a3;--an-line:var(--mmc-text)}
:root[data-theme='dim'] .mmc-analytics{--an-1:#2f95c0;--an-2:#d47535;--an-3:#8f78ec;--an-4:#3fa66d;--an-other:#6b7a8c}
`
export const SERIES = ['var(--an-1)', 'var(--an-2)', 'var(--an-3)', 'var(--an-4)'] as const
export const OTHER = 'var(--an-other)'
export const LINE = 'var(--an-line)'
/** The colour of the i-th series (0-based); beyond the fourth: Other. */
export const seriesColor = (i: number) => SERIES[i] ?? OTHER

export interface BarSeries {
  key: string
  label: string
  color: string
  /** One per x; null = no data that day (single series only). */
  values: readonly (number | null)[]
}
export interface ChartLine {
  label: string
  color: string
  values: readonly (number | null)[]
  dashed?: boolean
}

const W = 640
const H = 236
const L = 50
const R = 632
const T = 14
const B = 200

/** Up to 7 x labels, always the first and the last. */
const xTickIdx = (n: number) => {
  if (n <= 7) return Array.from({ length: n }, (_, i) => i)
  const step = Math.ceil((n - 1) / 6)
  const out: number[] = []
  for (let i = 0; i < n - 1; i += step) out.push(i)
  if (n - 1 - out[out.length - 1]! < step / 2) out.pop()
  out.push(n - 1)
  return out
}

/**
 * Bars per x (days, hours), stacked by series, with optional lines on the same scale (one axis).
 * A click, or Enter on the focused bar (arrow keys move), calls onPick with the index.
 */
export function StackedBars({
  labels,
  tickLabels,
  series,
  lines = [],
  format,
  tick,
  onPick,
  selected = null,
  ariaLabel,
  noData,
  className,
}: {
  /** Long label of each x (tooltip). */
  labels: readonly string[]
  /** Short label of each x (axis). */
  tickLabels: readonly string[]
  series: readonly BarSeries[]
  lines?: readonly ChartLine[]
  format: (v: number) => string
  tick: (v: number) => string
  onPick?: (i: number) => void
  selected?: number | null
  ariaLabel: string
  /** Tooltip text for an x without data. */
  noData?: string
  className?: string
}) {
  const id = useId()
  const [hover, setHover] = useState<number | null>(null)
  const n = labels.length
  const stackTop = (i: number) => series.reduce((s, x) => s + Math.max(0, x.values[i] ?? 0), 0)
  const lineVals = lines.flatMap((l) => l.values.filter((v): v is number => v != null))
  const hi = Math.max(1, ...Array.from({ length: n }, (_, i) => stackTop(i)), ...lineVals)
  const lo = Math.min(0, ...lineVals)
  const scale = niceScale(hi)
  const step = scale.ticks[1] ?? scale.max
  const min = lo < 0 ? -Math.ceil(-lo / step) * step : 0
  const max = scale.max
  const ticks: number[] = []
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.round(v * 100) / 100)
  const band = (R - L) / Math.max(1, n)
  const barW = Math.max(1.5, Math.min(30, band * 0.7))
  const cx = (i: number) => L + band * (i + 0.5)
  const sy = (v: number) => B - ((v - min) / (max - min || 1)) * (B - T)
  const zero = sy(0)

  const pickAt = (clientX: number, el: SVGSVGElement) => {
    const rect = el.getBoundingClientRect()
    const x = ((clientX - rect.left) / rect.width) * W
    return Math.min(n - 1, Math.max(0, Math.floor((x - L) / band)))
  }
  const onMove = (e: PointerEvent<SVGSVGElement>) => setHover(pickAt(e.clientX, e.currentTarget))
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (n === 0) return
    const cur = hover ?? selected ?? n - 1
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      setHover(Math.min(n - 1, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1))))
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      setHover(e.key === 'Home' ? 0 : n - 1)
    } else if ((e.key === 'Enter' || e.key === ' ') && onPick) {
      e.preventDefault()
      onPick(cur)
    }
  }

  const tip = hover
  const tipLeft = tip == null ? 0 : (cx(tip) / W) * 100
  const tipStyle: CSSProperties =
    tip == null
      ? {}
      : tip > n * 0.6
        ? { left: `${tipLeft}%`, transform: 'translateX(calc(-100% - 10px))' }
        : { left: `${tipLeft}%`, transform: 'translateX(10px)' }

  return (
    <div className={cn('relative', className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={ariaLabel}
        aria-describedby={id}
        tabIndex={0}
        className={cn(
          'focus-visible:ring-primary/45 block overflow-visible rounded-lg font-sans outline-none focus-visible:ring-[3px]',
          onPick && 'cursor-pointer',
        )}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onClick={(e) => onPick && n > 0 && onPick(pickAt(e.clientX, e.currentTarget))}
        onKeyDown={onKey}
      >
        <desc id={id}>
          {labels
            .map((l, i) => {
              const parts = series
                .filter((s) => s.values[i] != null)
                .map((s) => `${s.label} ${format(s.values[i] ?? 0)}`)
              lines.forEach((ln) => {
                if (ln.values[i] != null) parts.push(`${ln.label} ${format(ln.values[i]!)}`)
              })
              return `${l}: ${parts.join(', ') || noData || '—'}`
            })
            .join('; ')}
        </desc>
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={L}
              x2={R}
              y1={sy(v)}
              y2={sy(v)}
              className={v === 0 ? 'stroke-border' : 'stroke-grid'}
              strokeWidth={1}
            />
            <text x={L - 6} y={sy(v) + 4} textAnchor="end" fontSize={11} className="fill-ink-3">
              {tick(v)}
            </text>
          </g>
        ))}
        {(hover != null || selected != null) && (
          <>
            {selected != null && selected < n && (
              <rect
                x={L + band * selected}
                y={T}
                width={band}
                height={B - T}
                className="fill-primary-tint"
              />
            )}
            {hover != null && hover !== selected && (
              <rect x={L + band * hover} y={T} width={band} height={B - T} className="fill-hover" />
            )}
          </>
        )}
        {Array.from({ length: n }, (_, i) => {
          let base = 0
          const parts = series
            .map((s) => ({ s, v: Math.max(0, s.values[i] ?? 0) }))
            .filter((p) => p.v > 0)
          return (
            <g key={i}>
              {parts.map((p, j) => {
                const y0 = sy(base)
                base += p.v
                const y1 = sy(base)
                const top = j === parts.length - 1
                // a 2 px gap of the card colour between stacked parts
                const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0))
                if (h <= 0) return null
                const x = cx(i) - barW / 2
                const y = y1
                if (!top)
                  return <rect key={p.s.key} x={x} y={y} width={barW} height={h} fill={p.s.color} />
                const r = Math.min(4, barW / 2, h)
                return (
                  <path
                    key={p.s.key}
                    fill={p.s.color}
                    d={`M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${y + h} Z`}
                  />
                )
              })}
            </g>
          )
        })}
        {lines.map((ln) => {
          // a line breaks where a value is missing
          const runs: string[][] = []
          let cur: string[] = []
          ln.values.forEach((v, i) => {
            if (v == null) {
              if (cur.length) runs.push(cur)
              cur = []
            } else cur.push(`${cx(i).toFixed(1)},${sy(v).toFixed(1)}`)
          })
          if (cur.length) runs.push(cur)
          return (
            <g key={ln.label}>
              {runs.map((pts, k) =>
                pts.length === 1 ? (
                  <circle
                    key={k}
                    cx={Number(pts[0]!.split(',')[0])}
                    cy={Number(pts[0]!.split(',')[1])}
                    r={3}
                    fill={ln.color}
                  />
                ) : (
                  <polyline
                    key={k}
                    points={pts.join(' ')}
                    fill="none"
                    stroke={ln.color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    strokeDasharray={ln.dashed ? '5 4' : undefined}
                  />
                ),
              )}
              {hover != null && ln.values[hover] != null && (
                <circle
                  cx={cx(hover)}
                  cy={sy(ln.values[hover]!)}
                  r={4.5}
                  fill={ln.color}
                  className="stroke-card"
                  strokeWidth={2}
                />
              )}
            </g>
          )
        })}
        <line x1={L} x2={R} y1={zero} y2={zero} className="stroke-border" strokeWidth={1} />
        {xTickIdx(n).map((i) => (
          <text
            key={i}
            x={cx(i)}
            y={H - 16}
            textAnchor="middle"
            fontSize={11}
            className="fill-ink-3"
          >
            {tickLabels[i]}
          </text>
        ))}
      </svg>
      {tip != null && (
        <div
          className="border-border bg-card shadow-card pointer-events-none absolute top-1 z-10 min-w-[140px] rounded-lg border px-2.5 py-1.5 text-[12px]"
          style={tipStyle}
          role="presentation"
        >
          <div className="text-ink mb-0.5 font-bold">{labels[tip]}</div>
          {series.every((s) => s.values[tip] == null) && lines.length === 0 ? (
            <div className="text-ink-3">{noData ?? '—'}</div>
          ) : (
            <>
              {series.map((s) => (
                <div key={s.key} className="flex items-center gap-1.5">
                  <span
                    className="size-2.5 flex-none rounded-sm"
                    style={{ background: s.color }}
                    aria-hidden="true"
                  />
                  <span className="text-ink-2 flex-1">{s.label}</span>
                  <span className="text-ink font-semibold tabular-nums">
                    {s.values[tip] == null ? (noData ?? '—') : format(s.values[tip]!)}
                  </span>
                </div>
              ))}
              {lines.map((ln) => (
                <div key={ln.label} className="flex items-center gap-1.5">
                  <span
                    className="h-0.5 w-2.5 flex-none rounded-full"
                    style={{ background: ln.color }}
                    aria-hidden="true"
                  />
                  <span className="text-ink-2 flex-1">{ln.label}</span>
                  <span className="text-ink font-semibold tabular-nums">
                    {ln.values[tip] == null ? '—' : format(ln.values[tip]!)}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** The key of a chart with two series or more: a swatch (or a line) and the name. */
export function Legend({
  items,
  className,
}: {
  items: readonly { label: string; color: string; line?: boolean; dashed?: boolean }[]
  className?: string
}) {
  return (
    <ul
      className={cn(
        'text-ink-2 m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[13px]',
        className,
      )}
    >
      {items.map((it) => (
        <li key={it.label} className="inline-flex items-center gap-1.5">
          {it.line ? (
            <svg width="16" height="8" aria-hidden="true">
              <line
                x1="1"
                x2="15"
                y1="4"
                y2="4"
                stroke={it.color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeDasharray={it.dashed ? '4 3' : undefined}
              />
            </svg>
          ) : (
            <span
              className="size-2.5 flex-none rounded-sm"
              style={{ background: it.color }}
              aria-hidden="true"
            />
          )}
          {it.label}
        </li>
      ))}
    </ul>
  )
}

/**
 * Horizontal bars that can be picked (work by kind, visits by service): a button per row, the
 * value written at the end, the chosen row marked.
 */
export function PickBars({
  rows,
  onPick,
  chosen,
  color = SERIES[0],
}: {
  rows: readonly { key: string; label: string; value: number; display?: string }[]
  onPick?: (key: string) => void
  chosen?: string | null
  color?: string
}) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <div className="@container flex flex-col gap-1">
      {rows.map((r) => {
        const on = chosen === r.key
        const inner = (
          <>
            <span className="text-ink-2 min-w-0 truncate text-left text-[14px]">{r.label}</span>
            <span className="text-ink text-right text-[14px] font-semibold whitespace-nowrap tabular-nums @md:order-3">
              {r.display ?? r.value}
            </span>
            <span className="bg-hover col-span-2 h-2.5 overflow-hidden rounded-full @md:order-2 @md:col-span-1">
              <span
                className="block h-full rounded-full"
                style={{ width: `${Math.round((r.value / max) * 100)}%`, background: color }}
              />
            </span>
          </>
        )
        const cls = cn(
          'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 rounded-lg px-2 py-1.5 @md:grid-cols-[minmax(96px,170px)_1fr_auto]',
          on && 'bg-primary-tint ring-primary/40 ring-1',
        )
        return onPick ? (
          <button
            key={r.key}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(r.key)}
            className={cn(cls, 'hover:bg-hover cursor-pointer')}
          >
            {inner}
          </button>
        ) : (
          <div key={r.key} className={cls}>
            {inner}
          </div>
        )
      })}
    </div>
  )
}

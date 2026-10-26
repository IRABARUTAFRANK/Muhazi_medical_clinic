import { useId, useState, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'

export interface LineChartProps {
  values: readonly number[]
  /** Label for each x position (shown on hover and on ticks). */
  labels: readonly string[]
  max: number
  /** Y grid lines, in data units. */
  ticks: readonly number[]
  tickLabel: (v: number) => string
  /** Value formatter for the hover tooltip and the direct labels. */
  format: (v: number) => string
  /** Indices of the x ticks to print. */
  xTicks: readonly number[]
  ariaLabel: string
  colorClass?: string
  className?: string
  /** Flat light fill under the line (dashboard revenue chart); the console has no gradients. */
  area?: boolean
  /** Draw the line over 800 ms on mount (Figma motion spec). */
  animate?: boolean
}

const W = 640
const H = 220
const L = 56
const R = 600
const T = 16
const B = 190

/**
 * Single-series line chart: recessive grid, 2 px line, direct labels on the
 * latest and peak values, crosshair + tooltip on hover.
 */
export function LineChart({
  values,
  labels,
  max,
  ticks,
  tickLabel,
  format,
  xTicks,
  ariaLabel,
  colorClass = 'text-c-money',
  className,
  area = false,
  animate = false,
}: LineChartProps) {
  const [hover, setHover] = useState<number | null>(null)
  const id = useId()
  const n = values.length
  const sx = (i: number) => L + (i / Math.max(1, n - 1)) * (R - L)
  const sy = (v: number) => B - (v / max) * (B - T)
  const points = values.map((v, i) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ')
  const last = n - 1
  const peak = values.indexOf(Math.max(...values))
  const lastValue = values[last] ?? 0
  const peakValue = values[peak] ?? 0

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * W
    const i = Math.round(((x - L) / (R - L)) * (n - 1))
    setHover(Math.min(n - 1, Math.max(0, i)))
  }

  const tipX = hover === null ? 0 : sx(hover)
  const tipAnchor = hover !== null && hover > n * 0.7 ? 'end' : 'start'
  const tipDx = tipAnchor === 'end' ? -8 : 8

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={ariaLabel}
      aria-describedby={id}
      className={cn('block overflow-visible font-sans', colorClass, className)}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      <desc id={id}>{values.map((v, i) => `${labels[i]}: ${format(v)}`).join('; ')}</desc>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={L} x2={R} y1={sy(v)} y2={sy(v)} className="stroke-grid" strokeWidth={1} />
          <text x={L - 6} y={sy(v) + 4} textAnchor="end" fontSize={11} className="fill-ink-3">
            {tickLabel(v)}
          </text>
        </g>
      ))}
      {area && n > 1 && (
        <polygon
          points={`${sx(0).toFixed(1)},${B} ${points} ${sx(last).toFixed(1)},${B}`}
          fill="currentColor"
          fillOpacity={0.08}
          className={animate ? 'fade-in-late' : undefined}
        />
      )}
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        pathLength={animate ? 1 : undefined}
        className={animate ? 'draw-line' : undefined}
      />
      {xTicks.map((i) => (
        <text key={i} x={sx(i)} y={H - 15} textAnchor="middle" fontSize={11} className="fill-ink-3">
          {labels[i]}
        </text>
      ))}
      {peak !== last && (
        <>
          <circle cx={sx(peak)} cy={sy(peakValue)} r={4} fill="currentColor" />
          <text
            x={sx(peak)}
            y={sy(peakValue) - 10}
            textAnchor="middle"
            fontSize={11}
            className="fill-ink-2"
          >
            {format(peakValue)}
          </text>
        </>
      )}
      <circle cx={sx(last)} cy={sy(lastValue)} r={5} fill="currentColor" />
      <text
        x={sx(last)}
        y={sy(lastValue) - 12}
        textAnchor="end"
        fontSize={13}
        fontWeight={600}
        className="fill-ink"
      >
        {format(lastValue)}
      </text>
      {hover !== null && (
        <g pointerEvents="none">
          <line
            x1={tipX}
            x2={tipX}
            y1={T}
            y2={B}
            className="stroke-ink-3"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <circle
            cx={tipX}
            cy={sy(values[hover] ?? 0)}
            r={5}
            fill="currentColor"
            className="stroke-card"
            strokeWidth={2}
          />
          <text
            x={tipX + tipDx}
            y={T + 12}
            textAnchor={tipAnchor}
            fontSize={12}
            fontWeight={600}
            className="fill-ink"
          >
            {format(values[hover] ?? 0)}
          </text>
          <text
            x={tipX + tipDx}
            y={T + 26}
            textAnchor={tipAnchor}
            fontSize={11}
            className="fill-ink-3"
          >
            {labels[hover]}
          </text>
        </g>
      )}
    </svg>
  )
}

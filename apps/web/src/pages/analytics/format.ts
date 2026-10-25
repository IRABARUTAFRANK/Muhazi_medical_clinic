import { formatDate, formatDayMonth, formatNumber, formatTime } from '@mmc/shared'
import { methodLabel } from '@/lib/api/dashboard'
import { formatDuration } from '@/lib/duration'
import { dayDate } from './url-period'

export type TFn = (key: string, opts?: Record<string, unknown>) => string

/** "21/10" for a chart tick; "21/10/2026" in a table. */
export const dayShort = (iso: string) => formatDayMonth(dayDate(iso))
export const dayLong = (iso: string) => formatDate(dayDate(iso))
/** "21/10 14:05" for a moment. */
export const when = (at: string | null | undefined) => {
  if (!at) return '—'
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '—' : `${formatDayMonth(d)} ${formatTime(d)}`
}
export const timeOf = (at: string) => {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '—' : formatTime(d)
}

/** 12500 → "12,500"; null → "—". */
export const num = (v: number | null | undefined) => (v == null ? '—' : formatNumber(v))
/** Axis ticks: 0, 25k, 1.5M. */
export const short = (v: number) => {
  const a = Math.abs(v)
  const s = v < 0 ? '−' : ''
  if (a >= 1_000_000) return `${s}${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`
  if (a >= 1000) return `${s}${Math.round(a / 1000)}k`
  return `${s}${Math.round(a)}`
}

/** A round axis maximum and its ticks (0 … max in 4 steps). */
export function niceScale(peak: number, steps = 4) {
  const raw = Math.max(1, peak) / steps
  const mag = 10 ** Math.floor(Math.log10(raw))
  const n = raw / mag
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag
  const max = step * steps
  return { max, ticks: Array.from({ length: steps + 1 }, (_, i) => i * step) }
}

/** Minutes as people say them, or "Not enough data". */
export const minutes = (m: number | null, t: TFn) =>
  m == null ? t('analytics.wait.notEnough') : formatDuration(m, t)

export const stationName = (s: string, t: TFn) =>
  t(`register.stations.${s}`, { defaultValue: s.charAt(0).toUpperCase() + s.slice(1) })
export const roleName = (r: string, t: TFn) => t(`staff.roles.${r}`, { defaultValue: r })
export const payMethod = (m: string, t: TFn) =>
  t(`visit.payment.methods.${m}`, { defaultValue: methodLabel(m) })
export const kindName = (k: string, t: TFn) => t(`analytics.kinds.${k}`, { defaultValue: k })
export const groupName = (g: string, t: TFn) => t(`prices.groups.${g}`, { defaultValue: g })

/** Percent with one decimal ("12.5 %"). */
export const pct = (part: number, whole: number) =>
  whole > 0 ? `${(Math.round((part / whole) * 1000) / 10).toFixed(1)} %` : '—'

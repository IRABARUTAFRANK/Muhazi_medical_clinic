type TFn = (key: string, opts?: Record<string, unknown>) => string

/** Minutes as people say them: "45 min", "1 h", "2 h 05 min". */
export function formatDuration(minutes: number, t: TFn): string {
  const m = Math.max(0, Math.round(minutes))
  if (m < 60) return t('duration.m', { m })
  const h = Math.floor(m / 60)
  const r = m % 60
  return r === 0 ? t('duration.h', { h }) : t('duration.hm', { h, m: String(r).padStart(2, '0') })
}

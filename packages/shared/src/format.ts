/** Formats from the design README: `RWF 18,300`, `dd/mm/yyyy`, 24-hour time, tabular numbers. */
const grouping = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const pad = (n: number): string => String(n).padStart(2, '0')

export const formatNumber = (n: number): string => grouping.format(n)
export const formatRwf = (n: number): string => `RWF ${grouping.format(n)}`
export const formatDate = (d: Date): string =>
  `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
export const formatDayMonth = (d: Date): string => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
export const formatTime = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`
export const formatHour = (h: number): string => `${pad(h)}:00`
/** Local calendar date as yyyy-mm-dd (no timezone shift, unlike toISOString). */
export const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** "Dr. Mukamana Béatrice" → "MB"; "Uwimana Josiane" → "UJ". */
export const initials = (name: string): string =>
  name
    .replace(/^Dr\.?\s+/i, '')
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()

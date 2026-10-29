import type { CustomRange, DashboardRange } from '@/lib/api/dashboard'
import type { ReportChoices } from './run'

/**
 * "Save as my default": the columns, their order, the sort, the grouping, where the totals go,
 * the filters and the period of one report, kept for one person in this browser (localStorage).
 * Storage may be missing or full (a private window, blocked site data): every read and write is
 * wrapped, and the report then simply opens with its own defaults.
 */
export interface ReportPreset {
  choices: Partial<ReportChoices>
  /** The filters other than the period: text, one choice, several choices, on / off. */
  filters: Record<string, string | string[] | boolean>
  period?: { range: DashboardRange; custom?: CustomRange }
}

const key = (userId: string, reportId: string) => `mmc.reports.preset.${userId}.${reportId}`

const RANGES: readonly DashboardRange[] = ['today', 'week', 'month', 'all', 'custom']
const ISO = /^\d{4}-\d{2}-\d{2}$/

/** The saved preset, checked piece by piece (anything odd is left out). */
export function loadPreset(userId: string, reportId: string): ReportPreset | null {
  try {
    const raw = localStorage.getItem(key(userId, reportId))
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<ReportPreset>
    if (!p || typeof p !== 'object') return null
    const filters: ReportPreset['filters'] = {}
    if (p.filters && typeof p.filters === 'object')
      for (const [k, v] of Object.entries(p.filters))
        if (
          typeof v === 'string' ||
          typeof v === 'boolean' ||
          (Array.isArray(v) && v.every((x) => typeof x === 'string'))
        )
          filters[k] = v
    const period =
      p.period && RANGES.includes(p.period.range)
        ? {
            range: p.period.range,
            custom:
              p.period.custom && ISO.test(p.period.custom.from) && ISO.test(p.period.custom.to)
                ? { from: p.period.custom.from, to: p.period.custom.to }
                : undefined,
          }
        : undefined
    return {
      choices: p.choices && typeof p.choices === 'object' ? p.choices : {},
      filters,
      period,
    }
  } catch {
    return null
  }
}

/** Keeps the preset; false when the browser refused. */
export function savePreset(userId: string, reportId: string, preset: ReportPreset): boolean {
  try {
    localStorage.setItem(key(userId, reportId), JSON.stringify(preset))
    return true
  } catch {
    return false
  }
}

export function clearPreset(userId: string, reportId: string) {
  try {
    localStorage.removeItem(key(userId, reportId))
  } catch {
    // nothing kept, nothing to clear
  }
}

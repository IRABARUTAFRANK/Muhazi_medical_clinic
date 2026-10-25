import {
  isActivityKind,
  isAnalyticsView,
  type ActivityKind,
  type AnalyticsView,
} from '@/lib/api/analytics'
import type { DashboardRange } from '@/lib/api/dashboard'

/**
 * The address of the Analytics page: which view is open, the period, the department, and the
 * detail open in the side panel. Everything is in the URL so a dashboard card can link straight
 * to a detail, a link can be shared, and Back closes the side panel.
 *
 *   /app/analytics?view=revenue&range=custom&from=2026-09-26&to=2026-10-25&day=2026-10-21
 *   /app/analytics?view=staff&person=<id>&kind=prescriptions
 */
export interface AnalyticsSearch {
  view?: AnalyticsView
  /** today | week | month | all | custom; from/to alone mean custom. */
  range?: DashboardRange
  from?: string
  to?: string
  /** A department (the manager picks one; a head with several departments too). */
  dept?: string
  /** Who did what: the person whose details are open. */
  person?: string
  /** Revenue: the day whose payments are open. */
  day?: string
  /** Who did what: one kind of work (chart, table and the person's records). */
  kind?: ActivityKind
  /** The breakdown shown under the chart (method, payer, signins, group…). */
  by?: string
  /** Treatments: one service category. */
  group?: string
}

const RANGES: readonly DashboardRange[] = ['today', 'week', 'month', 'all', 'custom']
const ISO = /^\d{4}-\d{2}-\d{2}$/
const ID = /^[\w-]{1,64}$/
const BY = /^[A-Za-z]{1,24}$/

const iso = (v: unknown) =>
  typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
    ? v
    : undefined
const id = (v: unknown) => (typeof v === 'string' && ID.test(v) ? v : undefined)

/** Keeps only what the page knows (anything else in the address is dropped). */
export function validateAnalyticsSearch(search: Record<string, unknown>): AnalyticsSearch {
  return {
    view: isAnalyticsView(search.view) ? search.view : undefined,
    range: RANGES.includes(search.range as DashboardRange)
      ? (search.range as DashboardRange)
      : undefined,
    from: iso(search.from),
    to: iso(search.to),
    dept: id(search.dept),
    person: id(search.person),
    day: iso(search.day),
    kind: isActivityKind(search.kind) ? search.kind : undefined,
    by: typeof search.by === 'string' && BY.test(search.by) ? search.by : undefined,
    group: id(search.group),
  }
}

/** Changes the address: `replace` for filters (no history entry), a push for a view or a detail
 *  (Back returns to where the person was). */
export type UpdateSearch = (patch: Partial<AnalyticsSearch>, opts?: { replace?: boolean }) => void

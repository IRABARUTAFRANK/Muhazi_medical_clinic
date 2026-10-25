import { useCallback } from 'react'
import type { DashboardRange } from '@/lib/api/dashboard'
import {
  useAnalyticsAccess,
  type ActivityKind,
  type AnalyticsAccess,
  type AnalyticsView,
} from '@/lib/api/analytics'

/* Addresses of the Analytics views behind the dashboard cards (see DashLink). */

/** What a link to the Analytics page may carry (the page whitelists each one). */
export interface AnalyticsSearch {
  range?: DashboardRange
  from?: string
  to?: string
  dept?: string
  person?: string
  day?: string
  kind?: ActivityKind
  by?: string
  group?: string
}

/** "/app/analytics?view=…&…" (empty values left out). */
export function analyticsHref(view: AnalyticsView, search: AnalyticsSearch = {}): string {
  const q = new URLSearchParams({ view })
  for (const [k, v] of Object.entries(search)) if (v) q.set(k, String(v))
  return `/app/analytics?${q.toString()}`
}

/** The dashboard's period for a link: the range, and the two dates when it is "Custom" (a
 *  rolling "This month" stays rolling on the Analytics page). */
export const periodSearch = (p: {
  range: DashboardRange
  from: string
  to: string
}): AnalyticsSearch =>
  p.range === 'custom' ? { range: 'custom', from: p.from, to: p.to } : { range: p.range }

/** The link builder for a person's access (exported for tests and for pages that already hold
 *  the access): undefined when that view is not theirs, so the card stays a plain card. */
export function analyticsLinker(access: AnalyticsAccess | undefined, base: AnalyticsSearch = {}) {
  return (view: AnalyticsView, extra: AnalyticsSearch = {}): string | undefined => {
    if (!access || !access.views.includes(view)) return undefined
    // a head sees their own department: say which, so the page opens on it
    // (a key present but undefined in base or extra must not wipe it out)
    const s: AnalyticsSearch = { ...base, ...extra }
    if (!s.dept && !access.manager && access.departments[0]) s.dept = access.departments[0].id
    return analyticsHref(view, s)
  }
}

/**
 * `link(view, extra)`: the address of an Analytics view with the dashboard's period, or
 * undefined when the signed-in person may not open that view (analytics_access().views).
 */
export function useAnalyticsLink(base: AnalyticsSearch = {}) {
  const { data: access } = useAnalyticsAccess()
  const { range, from, to, dept } = base
  return useCallback(
    (view: AnalyticsView, extra: AnalyticsSearch = {}) =>
      analyticsLinker(access, { range, from, to, dept })(view, extra),
    [access, range, from, to, dept],
  )
}

import { useMemo, useState } from 'react'

/*
 * Long lists everywhere (queues, notices, employees, prices, bookings…) are shown a few at a
 * time: panels on dashboards grow with "Show more", full pages turn pages. Search and sort happen
 * before paging, so the first page always holds what matters most.
 */

/** Panels: the first `step` rows, then `step` more on each "Show more". */
export function useShowMore<T>(items: readonly T[], step = 5) {
  const [count, setCount] = useState(step)
  const visible = items.slice(0, count)
  return {
    visible,
    rest: Math.max(0, items.length - visible.length),
    more: () => setCount((c) => c + step),
    less: () => setCount(step),
    expanded: count > step,
  }
}

/** Pages: `size` rows per page; the page resets when the list's content key changes. */
export function usePaged<T>(items: readonly T[], size = 15, resetKey: unknown = null) {
  const [state, setState] = useState<{ page: number; key: unknown }>({ page: 1, key: resetKey })
  // A new search or sort starts again at page 1 (derived during render, no effect).
  const page = state.key === resetKey ? state.page : 1
  if (state.key !== resetKey) setState({ page: 1, key: resetKey })
  const pages = Math.max(1, Math.ceil(items.length / size))
  const current = Math.min(page, pages)
  const slice = useMemo(
    () => items.slice((current - 1) * size, current * size),
    [items, current, size],
  )
  return {
    slice,
    page: current,
    pages,
    total: items.length,
    from: items.length === 0 ? 0 : (current - 1) * size + 1,
    to: Math.min(current * size, items.length),
    setPage: (p: number) => setState({ page: Math.max(1, Math.min(pages, p)), key: resetKey }),
  }
}

export type SortKey = 'urgent' | 'longest' | 'latest' | 'oldest' | 'name'

/** Text search over a few fields, case- and accent-insensitive. */
export const matches = (q: string, ...fields: (string | null | undefined)[]) => {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const needle = norm(q.trim())
  if (!needle) return true
  return fields.some((f) => f && norm(f).includes(needle))
}

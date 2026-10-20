import {
  ArrowDownUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Search,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useShowMore, type SortKey } from '@/lib/paging'
import { cn } from '@/lib/utils'

/** "Show 5 more (12 left)" / "Show fewer" under a panel list. */
export function ShowMore({
  rest,
  expanded,
  onMore,
  onLess,
  step = 5,
}: {
  rest: number
  expanded: boolean
  onMore: () => void
  onLess: () => void
  step?: number
}) {
  const { t } = useTranslation()
  if (rest === 0 && !expanded) return null
  return (
    <span className="flex flex-wrap items-center gap-2">
      {rest > 0 && (
        <button
          type="button"
          onClick={onMore}
          className="border-border bg-card text-primary hover:bg-hover inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold"
        >
          <ChevronDown size={14} aria-hidden="true" />
          {t('list.showMore', { count: Math.min(step, rest), rest })}
        </button>
      )}
      {expanded && (
        <button
          type="button"
          onClick={onLess}
          className="text-ink-3 hover:text-ink inline-flex min-h-9 items-center gap-1 px-2 text-[13px] font-semibold"
        >
          <ChevronUp size={14} aria-hidden="true" />
          {t('list.showLess')}
        </button>
      )}
    </span>
  )
}

/** "Showing 11–20 of 57" with previous / next and the page numbers. */
export function Pager({
  page,
  pages,
  from,
  to,
  total,
  onPage,
}: {
  page: number
  pages: number
  from: number
  to: number
  total: number
  onPage: (p: number) => void
}) {
  const { t } = useTranslation()
  if (total === 0) return null
  // At most 5 page buttons around the current page.
  const start = Math.max(1, Math.min(page - 2, pages - 4))
  const nums = Array.from({ length: Math.min(5, pages) }, (_, i) => start + i)
  const btn =
    'inline-flex size-9 items-center justify-center rounded-lg text-[13px] font-semibold tabular-nums disabled:opacity-40'
  return (
    <nav
      aria-label={t('list.pages')}
      className="flex flex-wrap items-center justify-between gap-2 pt-1"
    >
      <span className="text-ink-3 text-[13px] tabular-nums">
        {t('list.showing', { from, to, total })}
      </span>
      {pages > 1 && (
        <span className="flex items-center gap-1">
          <button
            type="button"
            className={cn(btn, 'hover:bg-hover')}
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
            aria-label={t('list.prev')}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          {nums.map((n) => (
            <button
              key={n}
              type="button"
              aria-current={n === page ? 'page' : undefined}
              className={cn(btn, n === page ? 'bg-navy text-white' : 'hover:bg-hover text-ink-2')}
              onClick={() => onPage(n)}
            >
              {n}
            </button>
          ))}
          <button
            type="button"
            className={cn(btn, 'hover:bg-hover')}
            disabled={page >= pages}
            onClick={() => onPage(page + 1)}
            aria-label={t('list.next')}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </span>
      )}
    </nav>
  )
}

/** Search box and sort choice above a long list. */
export function ListBar({
  query,
  onQuery,
  sort,
  onSort,
  sorts,
  placeholderKey = 'list.search',
  className,
}: {
  query: string
  onQuery: (q: string) => void
  sort?: SortKey
  onSort?: (s: SortKey) => void
  sorts?: SortKey[]
  placeholderKey?: string
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <label className="border-border bg-card focus-within:border-primary flex h-10 min-w-[200px] flex-1 items-center gap-2 rounded-lg border px-3">
        <Search size={16} aria-hidden="true" className="text-ink-3 flex-none" />
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          aria-label={t(placeholderKey)}
          placeholder={t(placeholderKey)}
          className="min-w-0 flex-1 bg-transparent text-[14px] outline-none"
        />
      </label>
      {sorts && sort && onSort && (
        <label className="border-border bg-card flex h-10 items-center gap-2 rounded-lg border px-3 text-[14px]">
          <ArrowDownUp size={16} aria-hidden="true" className="text-ink-3" />
          <span className="sr-only">{t('list.sortBy')}</span>
          <select
            value={sort}
            onChange={(e) => onSort(e.target.value as SortKey)}
            className="bg-transparent font-semibold outline-none"
          >
            {sorts.map((s) => (
              <option key={s} value={s}>
                {t(`list.sorts.${s}`)}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}

/**
 * A panel list shown a few rows at a time: renders `children(visibleRows)` and the
 * "Show more" / "Show fewer" buttons under it.
 */
export function ShownList<T>({
  items,
  step = 5,
  footerClassName,
  children,
}: {
  items: readonly T[]
  step?: number
  /** Padding for the buttons when the list sits directly in a card without padding. */
  footerClassName?: string
  children: (visible: T[]) => ReactNode
}) {
  const m = useShowMore(items, step)
  const buttons = (
    <ShowMore rest={m.rest} expanded={m.expanded} onMore={m.more} onLess={m.less} step={step} />
  )
  return (
    <>
      {children(m.visible)}
      {footerClassName && (m.rest > 0 || m.expanded) ? (
        <div className={footerClassName}>{buttons}</div>
      ) : (
        buttons
      )}
    </>
  )
}

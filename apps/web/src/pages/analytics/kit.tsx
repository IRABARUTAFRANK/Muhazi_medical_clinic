import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CircleAlert,
  DatabaseZap,
  Info,
  type LucideIcon,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconChip } from '@/components/dash/kit'
import {
  card,
  selectedRow,
  tableCell,
  tableFirstCell,
  tableHead,
  tableRow,
  tileClass,
  type Hue,
} from '@/components/dash/kit-style'
import { tableLink } from '@/components/ui/button'
import { controlClass } from '@/components/ui/field'
import { Pager } from '@/components/ui/list-tools'
import { Seg } from '@/components/ui/seg'
import { ApiError } from '@/lib/api/errors'
import type { Report } from '@/lib/report'
import { usePaged } from '@/lib/paging'
import { cn } from '@/lib/utils'

/* ---------------------------------------------------------------- export (Excel / PDF) */

/** The report of the open view: each view registers its builder, the header buttons call it. */
export type ReportBuilder = () => Report | null
export const ExportContext = createContext<RefObject<ReportBuilder | null> | null>(null)

/** Registers the open view's report builder (the latest one, every render). */
export function useExport(build: ReportBuilder) {
  const exportRef = useContext(ExportContext)
  useEffect(() => {
    if (exportRef) exportRef.current = build
  })
  useEffect(
    () => () => {
      if (exportRef) exportRef.current = null
    },
    [exportRef],
  )
}

/* ---------------------------------------------------------------- states */

/** The database is older than the Analytics update (0086): say so instead of showing zeros. */
export function NeedsUpdate() {
  const { t } = useTranslation()
  return (
    <p
      role="status"
      className="border-amber/30 bg-amber-bg text-amber m-0 flex items-start gap-2 rounded-md border px-3 py-2.5 text-[14px] font-medium"
    >
      <DatabaseZap size={16} aria-hidden="true" className="mt-0.5 flex-none" />
      {t('analytics.needsUpdate')}
    </p>
  )
}

/** A failed load: "not allowed" in plain words, or the error. */
export function LoadError({ error }: { error: unknown }) {
  const { t } = useTranslation()
  const text =
    error instanceof ApiError && error.code === '42501'
      ? t('analytics.notAllowed')
      : error instanceof Error
        ? error.message
        : String(error)
  return (
    <p
      role="alert"
      className="border-red/30 bg-red-bg text-red m-0 flex items-start gap-2 rounded-md border px-3 py-2.5 text-[14px] font-medium"
    >
      <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
      {text}
    </p>
  )
}

/** Grey blocks while a view loads. */
export function ViewSkeleton() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label={t('dashboard.loading')}>
      <div className="pc:grid-cols-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton h-[130px] rounded-md" />
        ))}
      </div>
      <div className="skeleton h-[280px] rounded-md" />
    </div>
  )
}

/** The four headline figures of a view: 4-up on a PC, 2-up on a tablet, 1-up on a phone. */
export function Figures({ children }: { children: ReactNode }) {
  return <div className="pc:grid-cols-4 grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
}

/** The grid of small figures inside a panel or a side panel: 2-up from 640 px. */
export const statGrid = 'grid grid-cols-1 gap-3 sm:grid-cols-2'

/**
 * A small figure (inside a panel or a side panel): the tile of the dashboard kit on its light
 * tint with an icon chip, the label 13 px, the figure 28 px, a grey note under it. The tone
 * (red for money owed, green for visits kept) colours the tile and the figure.
 */
export function Stat({
  label,
  value,
  note,
  tone,
  icon,
  tint,
}: {
  label: string
  value: ReactNode
  note?: ReactNode
  tone?: 'red' | 'green'
  /** Icon of the figure, in the tile's chip. */
  icon?: LucideIcon
  /** The tile's tint (teal unless the tone says otherwise). */
  tint?: Hue
}) {
  const hue: Hue = tint ?? (tone === 'red' ? 'coral' : tone === 'green' ? 'mint' : 'teal')
  return (
    <div className={cn(card, 'gap-1.5', tileClass[hue])}>
      <span className="flex items-start gap-2 text-[13px] font-medium">
        {icon && <IconChip icon={icon} tint={hue} size="sm" />}
        <span className="text-ink-2 min-w-0 flex-1 pt-1 break-words">{label}</span>
      </span>
      <span
        className={cn(
          'min-w-0 text-[28px] leading-8 font-semibold tracking-[-0.01em] break-words tabular-nums',
          tone === 'red' ? 'text-red' : tone === 'green' ? 'text-green' : 'text-ink',
        )}
      >
        {value}
      </span>
      {note && <span className="text-ink-2 text-[13px]">{note}</span>}
    </div>
  )
}

/**
 * One choice among several (the breakdown, the section on a phone): segmented buttons on a wide
 * screen, a list to pick from on a narrow one, so nothing scrolls sideways.
 */
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
  className?: string
}) {
  const id = useId()
  return (
    <div className={cn('min-w-0', className)}>
      <Seg
        className="hidden flex-wrap lg:inline-flex"
        size="sm"
        label={label}
        value={value}
        options={options}
        onChange={onChange}
      />
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className={cn(controlClass, 'w-full max-w-full lg:hidden')}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/* ---------------------------------------------------------------- table */

export interface Col<T> {
  key: string
  label: ReactNode
  /** The cell. */
  cell: (row: T) => ReactNode
  /** Sort value; without it the column cannot be sorted. */
  sort?: (row: T) => number | string | null
  align?: 'right'
  /** Shown from 640 px only (phones keep the few columns that matter). */
  wide?: boolean
  /** The totals row's cell. */
  total?: ReactNode
}

/**
 * A table paged by 20, sorted by any sortable column (click the header again to reverse), with
 * a totals row. `onRow` makes each row open its detail: the first cell becomes a button (keyboard)
 * and the whole row reacts to a click.
 */
export function DataTable<T>({
  rows,
  cols,
  rowKey,
  onRow,
  rowLabel,
  pageSize = 20,
  initialSort,
  totalsLabel,
  empty,
  caption,
  selectedKey,
}: {
  rows: readonly T[]
  cols: readonly Col<T>[]
  rowKey: (row: T) => string
  onRow?: (row: T) => void
  /** Accessible name of the row's button ("Open the day 21/10/2026"). */
  rowLabel?: (row: T) => string
  pageSize?: number
  initialSort?: { key: string; desc: boolean }
  /** Shows a totals row with this label in the first column. */
  totalsLabel?: string
  empty: ReactNode
  caption: string
  selectedKey?: string | null
}) {
  const { t } = useTranslation()
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(initialSort ?? null)
  const sorted = useMemo(() => {
    const col = sort && cols.find((c) => c.key === sort.key)
    if (!col?.sort) return rows
    const get = col.sort
    return [...rows].sort((a, b) => {
      const x = get(a)
      const y = get(b)
      if (x == null && y == null) return 0
      if (x == null) return 1
      if (y == null) return -1
      const c =
        typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
      return sort!.desc ? -c : c
    })
  }, [rows, cols, sort])
  const paged = usePaged(sorted, pageSize, `${sort?.key}-${sort?.desc}-${rows.length}`)
  if (rows.length === 0) return <div className="py-2">{empty}</div>
  // the header row: 12 px grey, normal weight; the rows 40 px with a 1 px divider (kit-style)
  const th = cn(tableHead, 'border-border border-b')
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="max-w-full overflow-x-auto">
        <table className="w-full border-collapse text-[14px]">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {cols.map((c) => {
                const on = sort?.key === c.key
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={on ? (sort!.desc ? 'descending' : 'ascending') : undefined}
                    className={cn(
                      th,
                      c.align === 'right' && 'text-right',
                      c.wide && 'hidden sm:table-cell',
                    )}
                  >
                    {c.sort ? (
                      <button
                        type="button"
                        onClick={() =>
                          setSort(
                            on ? { key: c.key, desc: !sort!.desc } : { key: c.key, desc: true },
                          )
                        }
                        className={cn(
                          'hover:text-ink inline-flex items-center gap-1',
                          c.align === 'right' && 'flex-row-reverse',
                          on && 'text-ink',
                        )}
                      >
                        {c.label}
                        {on ? (
                          sort!.desc ? (
                            <ArrowDown size={12} aria-hidden="true" />
                          ) : (
                            <ArrowUp size={12} aria-hidden="true" />
                          )
                        ) : (
                          <ArrowUpDown size={12} aria-hidden="true" className="opacity-50" />
                        )}
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {paged.slice.map((r) => {
              const k = rowKey(r)
              return (
                <tr
                  key={k}
                  onClick={onRow ? () => onRow(r) : undefined}
                  className={cn(
                    tableRow,
                    onRow && 'cursor-pointer',
                    selectedKey === k && selectedRow,
                  )}
                >
                  {cols.map((c, i) => (
                    <td
                      key={c.key}
                      className={cn(
                        i === 0 ? tableFirstCell : tableCell,
                        c.align === 'right' && 'text-right tabular-nums',
                        c.wide && 'hidden sm:table-cell',
                      )}
                    >
                      {i === 0 && onRow ? (
                        <button
                          type="button"
                          aria-label={rowLabel?.(r)}
                          onClick={(e) => {
                            e.stopPropagation()
                            onRow(r)
                          }}
                          className={cn(
                            tableLink,
                            '-mx-2 h-auto min-h-7 max-w-full text-left whitespace-normal',
                          )}
                        >
                          {c.cell(r)}
                        </button>
                      ) : (
                        c.cell(r)
                      )}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
          {totalsLabel && (
            <tfoot>
              <tr className="border-border bg-surface h-10 border-t font-semibold">
                {cols.map((c, i) => (
                  <td
                    key={c.key}
                    className={cn(
                      tableCell,
                      c.align === 'right' && 'text-right tabular-nums',
                      c.wide && 'hidden sm:table-cell',
                    )}
                  >
                    {i === 0 ? totalsLabel : (c.total ?? '')}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {paged.pages > 1 || rows.length > 10 ? (
        <Pager
          page={paged.page}
          pages={paged.pages}
          from={paged.from}
          to={paged.to}
          total={paged.total}
          onPage={paged.setPage}
        />
      ) : null}
      <span className="sr-only">{t('analytics.tableHint')}</span>
    </div>
  )
}

/* ---------------------------------------------------------------- side panel */

/**
 * The detail of a person or a day, over the page on the right (the whole screen on a phone),
 * so the page never grows. Escape, the close button or a click outside close it; the focus goes
 * into the panel and back to where it was.
 */
export function Drawer({
  title,
  subtitle,
  onClose,
  children,
  actions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  actions?: ReactNode
}) {
  const { t } = useTranslation()
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      before?.focus?.()
    }
  }, [])
  return (
    <div
      className="fixed inset-0 z-[60] flex justify-end bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        className="bg-card anim-enter shadow-sheet flex h-full w-[min(560px,100vw)] flex-col outline-none"
      >
        <header className="border-border bg-primary-tint/60 flex items-start gap-3 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id={id} className="text-ink m-0 text-[16px] font-semibold [overflow-wrap:anywhere]">
              {title}
            </h2>
            {subtitle && <div className="text-ink-2 mt-0.5 text-[13px]">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('analytics.close')}
            title={t('analytics.close')}
            className="hover:bg-hover text-ink-2 focus-visible:ring-primary/20 inline-flex size-9 flex-none items-center justify-center rounded-md transition-colors duration-120 outline-none focus-visible:ring-2"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">{children}</div>
        {actions && (
          <footer className="border-border flex flex-wrap gap-2 border-t px-4 py-3">
            {actions}
          </footer>
        )}
      </div>
    </div>
  )
}

/** A titled block inside a side panel: 14 px semibold title with a 1 px rule under it. */
export function Block({
  title,
  right,
  children,
}: {
  title: string
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-ink border-border m-0 flex flex-wrap items-center justify-between gap-2 border-b pb-1.5 text-[14px] font-semibold">
        {title}
        {right && <span className="text-ink-2 text-[13px] font-normal">{right}</span>}
      </h3>
      {children}
    </section>
  )
}

/** A plain line of grey text with a small symbol (nothing to show, a note). */
export function Quiet({ children, icon = Info }: { children: ReactNode; icon?: LucideIcon }) {
  return (
    <p className="text-ink-3 m-0 flex items-start gap-2 text-[14px]">
      {createElement(icon, { size: 16, className: 'mt-0.5 flex-none', 'aria-hidden': true })}
      <span className="min-w-0">{children}</span>
    </p>
  )
}

import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search, PenLine } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { controlClass } from './field'
import './search-select.css'

export interface SearchOption {
  value: string
  label: string
  /** Secondary text on the right (a price, a count). */
  hint?: string
  /** Section heading the option sits under ("Clinic medicines", "RHIA list"). */
  group?: string
  /** A small second line (brand, box size). */
  sub?: string
  /** Words that find the option without being shown (a code, the list's own spelling). */
  keywords?: string
}

/** Lists longer than this get a search box at the top of the popover. */
const SEARCH_FROM = 12
/** Rows a Page Up / Page Down moves. */
const PAGE = 8

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const wordsOf = (q: string) => fold(q).trim().split(/\s+/).filter(Boolean)
const haystack = (o: SearchOption) =>
  fold([o.label, o.sub, o.hint, o.keywords].filter(Boolean).join(' '))
const matches = (options: readonly SearchOption[], words: string[]) =>
  words.length
    ? options.filter((o) => {
        const h = haystack(o)
        return words.every((w) => h.includes(w))
      })
    : options

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The typed words in bold inside a text. */
function marked(text: string, words: string[]): ReactNode {
  if (!words.length) return text
  const re = new RegExp(`(${words.map(escapeRe).join('|')})`, 'gi')
  return text.split(re).map((part, i) =>
    i % 2 ? (
      <strong key={i} className="text-ink font-semibold">
        {part}
      </strong>
    ) : (
      part
    ),
  )
}

/**
 * A choice among many (the clinic's medicines, the 1,400+ of the RHIA list), drawn by the app
 * rather than the browser: the field shows the choice; a click, ↓ or a letter typed opens a
 * popover under it (above when there is no room below) as wide as the field (280 px at least,
 * never wider than the screen), over side panels. Long lists have a search box: every word typed
 * must appear, in any order, accents ignored; at most `limit` matches are listed, the one chosen
 * always stays, and a single match is chosen at once. ↑ ↓ Home End Page Up/Down move, Enter
 * picks, Esc closes. Long names wrap in the popover; rows are 40 px at least for fingers.
 */
/** The value of the "write it" row: never a real option's value. */
const WRITE = '\u0000write'

export function SearchSelect({
  label,
  value,
  onChange,
  options,
  emptyLabel,
  required,
  disabled,
  wrapperClassName,
  limit = 60,
  onWrite,
  writeLabel,
}: {
  label: ReactNode
  value: string
  onChange: (value: string) => void
  options: readonly SearchOption[]
  /** The empty choice ("Choose a medicine", "All"), shown when nothing is chosen. */
  emptyLabel: string
  required?: boolean
  disabled?: boolean
  wrapperClassName?: string
  limit?: number
  /**
   * Something not in the list may be written: while a search is typed, a last row offers it
   * ("Write “Zinc syrup” as the medicine name") and picking it hands the text over.
   */
  onWrite?: (text: string) => void
  /** The words of that row, with the text typed. */
  writeLabel?: (text: string) => string
}) {
  const { t } = useTranslation()
  const id = useId()
  const labelId = `${id}-label`
  const listId = `${id}-list`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeValue, setActiveValue] = useState<string | null>(null)
  const searchable = options.length > SEARCH_FROM
  const chosen = options.find((o) => o.value === value)

  // what the popover lists (only worked out while it is open)
  const words = open ? wordsOf(query) : []
  const hits = open ? matches(options, words) : []
  const shown = hits.slice(0, limit)
  if (open && chosen && !shown.includes(chosen)) shown.unshift(chosen)
  const empty: SearchOption = { value: '', label: emptyLabel }
  const base: SearchOption[] = open && !required && !words.length ? [empty, ...shown] : shown
  // the "write it" row, last, whenever something is typed and the page accepts a written name
  const writeRow: SearchOption | null =
    open && onWrite && query.trim().length >= 2
      ? {
          value: WRITE,
          label: writeLabel ? writeLabel(query.trim()) : query.trim(),
          group: t('picker.writeGroup'),
        }
      : null
  const rows: SearchOption[] = writeRow ? [...base, writeRow] : base
  const found = rows.findIndex((o) => o.value === activeValue)
  const activeIdx = found >= 0 ? found : rows.length ? 0 : -1
  const optId = (i: number) => `${id}-o-${i}`

  const close = (refocus = true) => {
    setOpen(false)
    setQuery('')
    if (refocus) triggerRef.current?.focus({ preventScroll: true })
  }
  const openWith = (q = '') => {
    if (disabled) return
    setQuery(q)
    setActiveValue(q ? null : value)
    setOpen(true)
  }
  const pick = (v: string) => {
    if (v === WRITE) {
      onWrite?.(query.trim())
      close()
      return
    }
    if (v !== value) onChange(v)
    close()
  }
  const typed = (q: string) => {
    setQuery(q)
    setActiveValue(null)
    const hit = matches(options, wordsOf(q))
    // a single match is chosen at once (as before); the popover stays open to confirm it
    if (wordsOf(q).length && hit.length === 1 && hit[0]!.value !== value) onChange(hit[0]!.value)
  }
  const move = (to: number) => {
    if (!rows.length) return
    const i = Math.max(0, Math.min(rows.length - 1, to))
    setActiveValue(rows[i]!.value)
  }

  const onListKey = (e: KeyboardEvent<HTMLElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        move(activeIdx + 1)
        return
      case 'ArrowUp':
        e.preventDefault()
        if (e.altKey) return close()
        move(activeIdx - 1)
        return
      case 'PageDown':
        e.preventDefault()
        move(activeIdx + PAGE)
        return
      case 'PageUp':
        e.preventDefault()
        move(activeIdx - PAGE)
        return
      case 'Home':
        e.preventDefault()
        move(0)
        return
      case 'End':
        e.preventDefault()
        move(rows.length - 1)
        return
      case 'Enter':
        e.preventDefault()
        if (activeIdx >= 0) pick(rows[activeIdx]!.value)
        return
      case 'Escape':
        // the side panel or dialog around must not close with it
        e.preventDefault()
        e.stopPropagation()
        close()
        return
      case 'Tab':
        e.preventDefault()
        e.stopPropagation()
        close()
        return
    }
    // a short list without a search box: a letter jumps to the next row starting with it
    if (!searchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = fold(e.key)
      const n = rows.length
      for (let s = 1; s <= n; s++) {
        const i = (activeIdx + s) % n
        if (fold(rows[i]!.label).startsWith(k)) return move(i)
      }
    }
  }

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (open) return onListKey(e)
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault()
      openWith()
    } else if (searchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // typing on the closed field starts the search
      e.preventDefault()
      openWith(e.key)
    }
  }

  // place the popover under the field (above when below is short), and follow scroll and resize
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const tr = triggerRef.current
      const pop = popRef.current
      if (!tr || !pop) return
      const r = tr.getBoundingClientRect()
      const vw = document.documentElement.clientWidth
      const vh = window.innerHeight
      const width = Math.min(Math.max(r.width, 280), vw - 16)
      const left = Math.min(Math.max(r.left, 8), vw - width - 8)
      const below = vh - r.bottom - 12
      const above = r.top - 12
      const up = below < 280 && above > below
      pop.style.width = `${width}px`
      pop.style.left = `${left}px`
      pop.style.maxHeight = `${Math.max(160, Math.min(440, up ? above : below))}px`
      pop.style.top = up ? 'auto' : `${r.bottom + 4}px`
      pop.style.bottom = up ? `${vh - r.top + 4}px` : 'auto'
      pop.dataset.side = up ? 'top' : 'bottom'
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // focus the search box (or the list) when it opens; a press outside closes it
  useEffect(() => {
    if (!open) return
    ;(inputRef.current ?? listRef.current)?.focus({ preventScroll: true })
    const outside = (e: PointerEvent) => {
      const node = e.target as Node
      if (popRef.current?.contains(node) || triggerRef.current?.contains(node)) return
      setOpen(false)
      setQuery('')
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])

  // the active row stays in sight
  useEffect(() => {
    if (!open || activeIdx < 0) return
    document.getElementById(optId(activeIdx))?.scrollIntoView({ block: 'nearest' })
  })

  return (
    <div className={cn('relative flex min-w-0 flex-col gap-1', wrapperClassName)}>
      <label id={labelId} htmlFor={`${id}-field`} className="text-ink-2 text-[13px] font-medium">
        {label}
      </label>
      <button
        ref={triggerRef}
        id={`${id}-field`}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={labelId}
        aria-required={required || undefined}
        disabled={disabled}
        title={chosen ? [chosen.label, chosen.sub].filter(Boolean).join(' · ') : undefined}
        onClick={() => (open ? close() : openWith())}
        onKeyDown={onTriggerKey}
        className={cn(
          controlClass,
          'flex w-full min-w-0 items-center gap-2 text-left',
          open && 'border-primary ring-primary/20 ring-2',
          disabled && 'cursor-not-allowed',
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate', !chosen && 'text-ink-3')}>
          {chosen ? chosen.label : emptyLabel}
          {chosen?.sub && <span className="text-ink-3"> · {chosen.sub}</span>}
        </span>
        {chosen?.hint && (
          <span className="text-ink-3 flex-none text-[12px] tabular-nums max-[420px]:hidden">
            {chosen.hint}
          </span>
        )}
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={cn(
            'text-ink-3 flex-none transition-transform motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </button>
      {required && (
        // the form's own check: submit is blocked while nothing is chosen
        <input
          tabIndex={-1}
          aria-hidden="true"
          required
          value={value}
          onChange={() => {}}
          onFocus={() => triggerRef.current?.focus()}
          className="pointer-events-none absolute bottom-0 left-4 h-px w-px opacity-0"
        />
      )}
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="mmc-pop border-border bg-card shadow-panel fixed z-[96] flex flex-col overflow-hidden rounded-lg border"
            style={{ top: 0, left: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            {searchable && (
              <div className="border-border relative flex-none border-b p-2">
                <Search
                  size={16}
                  aria-hidden="true"
                  className="text-ink-3 pointer-events-none absolute top-1/2 left-5 -translate-y-1/2"
                />
                <input
                  ref={inputRef}
                  type="search"
                  value={query}
                  onChange={(e) => typed(e.target.value)}
                  onKeyDown={onListKey}
                  placeholder={t('picker.search', { count: options.length })}
                  aria-label={t('picker.searchAria')}
                  aria-controls={listId}
                  aria-activedescendant={activeIdx >= 0 ? optId(activeIdx) : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  className={cn(controlClass, 'w-full pl-9')}
                />
              </div>
            )}
            {words.length > 0 && (
              <p className="text-ink-3 m-0 flex-none px-3 pt-2 text-[12px]" aria-live="polite">
                {hits.length
                  ? t('picker.found', { count: hits.length })
                  : onWrite
                    ? t('picker.noneWrite', { query: query.trim() })
                    : t('picker.none', { query: query.trim() })}
              </p>
            )}
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-labelledby={labelId}
              tabIndex={searchable ? undefined : -1}
              aria-activedescendant={!searchable && activeIdx >= 0 ? optId(activeIdx) : undefined}
              onKeyDown={searchable ? undefined : onListKey}
              className="m-0 max-h-[320px] min-h-0 flex-1 list-none overflow-y-auto overscroll-contain p-1 outline-none"
            >
              {rows.map((o, i) => {
                const heading = o.group && o.group !== rows[i - 1]?.group ? o.group : null
                const selected = o.value === value
                return (
                  <Fragment key={o.value || '__empty'}>
                    {heading && (
                      <li
                        role="presentation"
                        className="text-ink-3 px-2.5 pt-2.5 pb-1 text-[11px] font-semibold tracking-wide uppercase"
                      >
                        {heading}
                      </li>
                    )}
                    <li
                      id={optId(i)}
                      role="option"
                      aria-selected={selected}
                      data-active={i === activeIdx || undefined}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => i !== activeIdx && setActiveValue(o.value)}
                      onClick={() => pick(o.value)}
                      className={cn(
                        'flex min-h-10 cursor-pointer items-start gap-2 rounded-md px-2.5 py-2 text-[14px] leading-snug',
                        i === activeIdx && 'bg-hover',
                        selected && 'text-primary',
                      )}
                    >
                      {o.value === WRITE ? (
                        <PenLine
                          size={16}
                          aria-hidden="true"
                          className="text-primary mt-0.5 flex-none"
                        />
                      ) : (
                        <Check
                          size={16}
                          aria-hidden="true"
                          className={cn('mt-0.5 flex-none', !selected && 'invisible')}
                        />
                      )}
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block break-words',
                            o.value === ''
                              ? 'text-ink-3'
                              : o.value === WRITE
                                ? 'text-primary font-semibold'
                                : !selected && 'text-ink',
                            selected && 'font-semibold',
                          )}
                        >
                          {marked(o.label, words)}
                        </span>
                        {o.sub && (
                          <span className="text-ink-3 block text-[12px] break-words">
                            {marked(o.sub, words)}
                          </span>
                        )}
                      </span>
                      {o.hint && (
                        <span className="text-ink-2 mt-0.5 flex-none text-[12px] whitespace-nowrap tabular-nums">
                          {o.hint}
                        </span>
                      )}
                    </li>
                  </Fragment>
                )
              })}
              {hits.length > limit && (
                <li role="presentation" className="text-ink-3 px-2.5 py-2 text-[12px] italic">
                  {t('picker.more', { count: hits.length - limit })}
                </li>
              )}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  )
}

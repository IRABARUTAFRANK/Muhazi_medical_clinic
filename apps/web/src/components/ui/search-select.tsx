import { useId, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export interface SearchOption {
  value: string
  label: string
}

const control =
  'border-border bg-card text-ink focus:border-primary focus:ring-primary-tint h-11 w-full rounded-lg border px-3 text-[15px] font-normal outline-none focus:ring-[3px] disabled:opacity-60'

/**
 * A choice among many (the clinic's 1,400+ medicines): type a few letters, then pick among the
 * matches. Every word typed must appear (in any order); at most `limit` matches are listed, the
 * one chosen always stays; a single match is chosen at once. Short lists show the plain select.
 */
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
}: {
  label: ReactNode
  value: string
  onChange: (value: string) => void
  options: readonly SearchOption[]
  /** The first, empty choice ("Choose a medicine", "All"). */
  emptyLabel: string
  required?: boolean
  disabled?: boolean
  wrapperClassName?: string
  limit?: number
}) {
  const { t } = useTranslation()
  const id = useId()
  const [query, setQuery] = useState('')
  const searchable = options.length > 12
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const hits = words.length
    ? options.filter((o) => {
        const l = o.label.toLowerCase()
        return words.every((w) => l.includes(w))
      })
    : options
  const shown = hits.slice(0, limit)
  const chosen = options.find((o) => o.value === value)
  if (chosen && !shown.includes(chosen)) shown.unshift(chosen)

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', wrapperClassName)}>
      <label htmlFor={id} className="text-ink-2 text-[13px] font-semibold">
        {label}
      </label>
      {searchable && (
        <span className="relative">
          <Search
            size={16}
            aria-hidden="true"
            className="text-ink-3 pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
          />
          <input
            type="search"
            value={query}
            disabled={disabled}
            onChange={(e) => {
              const q = e.target.value
              setQuery(q)
              const w = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
              const found = w.length
                ? options.filter((o) => w.every((x) => o.label.toLowerCase().includes(x)))
                : []
              if (found.length === 1 && found[0]!.value !== value) onChange(found[0]!.value)
            }}
            placeholder={t('picker.search', { count: options.length })}
            aria-label={t('picker.searchAria')}
            className={cn(control, 'pl-9')}
          />
        </span>
      )}
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        disabled={disabled}
        className={control}
      >
        <option value="">
          {words.length ? t('picker.matches', { count: hits.length }) : emptyLabel}
        </option>
        {shown.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {hits.length > shown.length && (
          <option disabled value="__more">
            {t('picker.more', { count: hits.length - limit })}
          </option>
        )}
      </select>
    </div>
  )
}

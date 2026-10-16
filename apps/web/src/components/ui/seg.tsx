import { cn } from '@/lib/utils'

export interface SegOption<T extends string> {
  value: T
  label: string
}

export interface SegProps<T extends string> {
  options: ReadonlyArray<SegOption<T>>
  value: T
  onChange: (value: T) => void
  /** Accessible group name, e.g. "Language". */
  label: string
  size?: 'sm' | 'md'
  className?: string
}

/** Segmented control (language switch, date range). */
export function Seg<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'md',
  className,
}: SegProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'border-border inline-flex overflow-hidden rounded-lg border',
        size === 'sm' ? 'h-9' : 'h-10',
        className,
      )}
    >
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'min-w-11 px-2.5 text-xs font-semibold transition-colors',
              on ? 'bg-primary text-on-primary' : 'bg-card text-ink-2 hover:bg-hover',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

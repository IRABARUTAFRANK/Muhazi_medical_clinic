import { useLayoutEffect, useRef, useState } from 'react'
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

/**
 * Segmented control (language switch, date range): a grey track with a 1 px border, the chosen
 * segment a white tile with teal text. 36 px high, 32 px small — the heights of buttons. The
 * white tile is one element that slides under the chosen segment (200 ms; it jumps under
 * reduced motion), measured from the buttons so any label width works.
 */
export function Seg<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'md',
  className,
}: SegProps<T>) {
  const track = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  useLayoutEffect(() => {
    const root = track.current
    if (!root) return
    const place = () => {
      const on = root.querySelector<HTMLElement>('[aria-pressed="true"]')
      setPill(
        on
          ? {
              left: on.offsetLeft,
              top: on.offsetTop,
              width: on.offsetWidth,
              height: on.offsetHeight,
            }
          : null,
      )
    }
    place()
    // labels change with the language and the text size: measure again when the track resizes
    const ro = new ResizeObserver(place)
    ro.observe(root)
    return () => ro.disconnect()
  }, [value, options])
  return (
    <div
      ref={track}
      role="group"
      aria-label={label}
      className={cn(
        'border-border bg-surface relative inline-flex max-w-full gap-0.5 overflow-x-auto rounded-md border p-0.5',
        // grows when the buttons wrap onto a second row (long labels, French, Kinyarwanda)
        size === 'sm' ? 'min-h-8' : 'min-h-9',
        className,
      )}
    >
      {pill && (
        <span
          aria-hidden="true"
          className="border-border bg-card absolute rounded border transition-[left,top,width] duration-200 ease-out motion-reduce:transition-none"
          style={{ left: pill.left, top: pill.top, width: pill.width, height: pill.height }}
        />
      )}
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              // on a touch screen each segment is 44 px high (--tap, globals.css)
              size === 'sm'
                ? 'min-h-[max(1.75rem,var(--tap,0px))]'
                : 'min-h-[max(2rem,var(--tap,0px))]',
              'focus-visible:ring-primary/20 relative inline-flex min-w-10 flex-none items-center justify-center rounded px-3 text-[13px] font-medium whitespace-nowrap transition-colors duration-120 focus-visible:ring-2 focus-visible:outline-none',
              on ? 'text-primary' : 'text-ink-2 hover:bg-hover hover:text-ink',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

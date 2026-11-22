import type { HTMLAttributes, ReactNode } from 'react'
import type { Tone } from '@mmc/shared'
import { cn } from '@/lib/utils'

/** Small tag: a very light tint with a 1 px border of the same colour. */
const toneClass: Record<Tone, string> = {
  green: 'border-green/25 bg-green-bg text-green',
  yellow: 'border-yellow/25 bg-yellow-bg text-yellow',
  red: 'border-red/25 bg-red-bg text-red',
  blue: 'border-blue/25 bg-blue-bg text-blue',
  orange: 'border-orange/25 bg-orange-bg text-orange',
  grey: 'border-border bg-surface text-ink-2',
}
const dotClass: Record<Tone, string> = {
  green: 'bg-green-dot',
  yellow: 'bg-yellow-dot',
  red: 'bg-red-dot',
  blue: 'bg-blue-dot',
  orange: 'bg-orange-dot',
  grey: 'bg-ink-3',
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone: Tone
  /** Colour is never the only signal: show a dot (default) or pass an icon. */
  dot?: boolean
  icon?: ReactNode
}

/** 24 px tag (4 px corners, 12 px text) with a dot or icon. Triage, result flags, sync, appointment
 *  states. It stays on one line while its container has the room and is the last thing to shrink
 *  in a row; in a box narrower than its words it wraps and grows taller instead of sticking out
 *  (.mmc-tag keeps it on one line inside a table cell, globals.css). */
export function Badge({ tone, dot = true, icon, className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'mmc-tag inline-flex min-h-6 max-w-full shrink-[0.001] items-center gap-1.5 rounded border px-2 py-[3px] text-[12px] leading-[1.25] font-medium',
        toneClass[tone],
        className,
      )}
      {...props}
    >
      {icon ?? (dot && <span className={cn('size-1.5 flex-none rounded-full', dotClass[tone])} />)}
      {children}
    </span>
  )
}

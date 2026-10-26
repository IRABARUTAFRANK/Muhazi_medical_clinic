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

/** 24 px tag (4 px corners, 12 px text) with a dot or icon. Triage, result flags, sync, appointment states. */
export function Badge({ tone, dot = true, icon, className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded border px-2 text-[12px] leading-none font-medium whitespace-nowrap',
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

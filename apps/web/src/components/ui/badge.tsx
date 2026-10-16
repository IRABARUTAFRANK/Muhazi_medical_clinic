import type { HTMLAttributes, ReactNode } from 'react'
import type { Tone } from '@mmc/shared'
import { cn } from '@/lib/utils'

const toneClass: Record<Tone, string> = {
  green: 'bg-green-bg text-green',
  yellow: 'bg-yellow-bg text-yellow',
  red: 'bg-red-bg text-red',
  blue: 'bg-blue-bg text-blue',
  orange: 'bg-orange-bg text-orange',
  grey: 'border border-border bg-hover text-ink-2',
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

/** 24 px pill with a dot or icon. Triage, result flags, sync and appointment states. */
export function Badge({ tone, dot = true, icon, className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-xs font-semibold whitespace-nowrap',
        toneClass[tone],
        className,
      )}
      {...props}
    >
      {icon ?? (dot && <span className={cn('size-2 flex-none rounded-full', dotClass[tone])} />)}
      {children}
    </span>
  )
}

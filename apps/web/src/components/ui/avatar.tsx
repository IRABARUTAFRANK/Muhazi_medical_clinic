import type { HTMLAttributes } from 'react'
import { initials } from '@mmc/shared'
import { cn } from '@/lib/utils'

const sizes = {
  sm: 'size-7 text-[11px]',
  md: 'size-9 text-[12px]',
  lg: 'size-10 text-[13px]',
  xl: 'size-12 text-[14px]',
} as const

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  name: string
  size?: keyof typeof sizes
}

/** Initials in a round teal-tinted disc with a 1 px border (no photos in the sample data). */
export function Avatar({ name, size = 'lg', className, ...props }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'bg-primary-tint text-primary border-primary/25 inline-flex flex-none items-center justify-center rounded-full border font-semibold',
        sizes[size],
        className,
      )}
      {...props}
    >
      {initials(name)}
    </span>
  )
}

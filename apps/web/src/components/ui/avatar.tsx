import type { HTMLAttributes } from 'react'
import { initials } from '@mmc/shared'
import { cn } from '@/lib/utils'

const sizes = {
  sm: 'size-7 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-11 text-sm',
  xl: 'size-12 text-base',
} as const

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  name: string
  size?: keyof typeof sizes
}

/** Initials in a tinted circle (no photos in the sample data). */
export function Avatar({ name, size = 'lg', className, ...props }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'bg-primary-tint text-primary inline-flex flex-none items-center justify-center rounded-full font-bold',
        sizes[size],
        className,
      )}
      {...props}
    >
      {initials(name)}
    </span>
  )
}

import type { ReactNode } from 'react'
import { useReveal } from '@/lib/hooks'
import { cn } from '@/lib/utils'

/**
 * Wraps what opens after an action (a form, a step, a detail) so it comes into view when it
 * appears, with the cursor in its first field when `focus` is set.
 */
export function Reveal({
  children,
  focus = false,
  block = 'start',
  className,
}: {
  children: ReactNode
  focus?: boolean
  block?: ScrollLogicalPosition
  className?: string
}) {
  const ref = useReveal<HTMLDivElement>({ focus, block })
  return (
    <div ref={ref} className={cn('min-w-0 scroll-mt-4', className)}>
      {children}
    </div>
  )
}

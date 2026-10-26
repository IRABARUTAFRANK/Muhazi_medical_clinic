import type { ReactNode } from 'react'
import { Inbox, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * An empty state in a card: a small grey icon and the sentence ("No patient waiting"). The icon
 * is decoration next to the words, never the only sign.
 */
export function EmptyNote({
  icon: Icon = Inbox,
  className,
  children,
}: {
  icon?: LucideIcon
  className?: string
  children: ReactNode
}) {
  return (
    <p className={cn('text-ink-3 m-0 flex items-center gap-2 text-[13px]', className)}>
      <Icon size={16} aria-hidden="true" className="flex-none" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

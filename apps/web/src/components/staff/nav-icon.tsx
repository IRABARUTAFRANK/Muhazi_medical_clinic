import { useTranslation } from 'react-i18next'
import { Icon } from '@/components/ui/icon'
import { useNotifications } from '@/lib/api/notifications'
import { countText, type NavCount } from '@/lib/api/nav-counts'
import { cn } from '@/lib/utils'

/*
 * A navigation icon (sidebar, bottom bar, More sheet). The Notifications item carries the number
 * of unread notices, like the bell in the top bar; any other entry may carry its own count
 * (nav_counts, 0121): red for what waits for the person, neutral for information.
 */
export function NavIcon({
  id,
  name,
  size = 16,
  ring = 'ring-card',
  count,
}: {
  id: string
  name: string
  size?: number
  /** Ring around the badge, matching the background it sits on. */
  ring?: string
  /** The entry's count, drawn on the icon's corner (bottom bar, More sheet). */
  count?: NavCount | null
}) {
  return (
    <span className="relative inline-flex">
      <Icon name={name} size={size} />
      {id === 'notifications' && <UnreadBadge ring={ring} />}
      {id !== 'notifications' && count && (
        <span
          aria-hidden="true"
          className={cn(
            'absolute -top-1.5 -right-2 inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-semibold tabular-nums ring-2',
            ring,
            count.urgent ? 'bg-red-dot text-white' : 'bg-ink-2 text-card',
          )}
        >
          {countText(count.n)}
        </span>
      )}
    </span>
  )
}

/** The count beside the label in the PC sidebar: a pill at the end of the row. */
export function CountPill({ count }: { count: NavCount }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'ml-auto inline-flex min-w-5 flex-none items-center justify-center rounded-full px-1.5 text-[12px] leading-5 font-semibold tabular-nums',
        count.urgent ? 'bg-red-dot text-white' : 'bg-card text-ink-2 ring-border ring-1',
      )}
    >
      {countText(count.n)}
    </span>
  )
}

/** The unread count as a small red badge (nothing when all is read). */
export function UnreadBadge({
  ring = 'ring-card',
  className,
}: {
  ring?: string
  className?: string
}) {
  const { t } = useTranslation()
  const { data } = useNotifications()
  const n = data?.unread ?? 0
  if (n === 0) return null
  return (
    <span
      className={cn(
        'bg-red-dot absolute -top-1.5 -right-2 inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-semibold text-white tabular-nums ring-2',
        ring,
        className,
      )}
    >
      {n > 99 ? '99+' : n}
      <span className="sr-only"> {t('notify.unreadCount', { count: n })}</span>
    </span>
  )
}

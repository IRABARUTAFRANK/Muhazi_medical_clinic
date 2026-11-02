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
      {/* only some from earlier days (0122): a small grey dot, no number on the icon */}
      {id !== 'notifications' && count && count.n === 0 && (
        <span
          aria-hidden="true"
          className={cn('bg-ink-3 absolute -top-1 -right-1 size-2 rounded-full ring-2', ring)}
        />
      )}
      {id !== 'notifications' && count && count.n > 0 && (
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

/** The count beside the label in the PC sidebar: a pill at the end of the row (today's), and
 *  a small dashed grey one for what is still open from an earlier day (0122). */
export function CountPill({ count }: { count: NavCount }) {
  const { t } = useTranslation()
  return (
    <span className="ml-auto inline-flex flex-none items-center gap-1">
      {!!count.earlier && (
        <span
          aria-hidden="true"
          title={t('daily.earlierShort', { count: count.earlier })}
          className="text-ink-3 border-ink-3/60 inline-flex min-w-5 items-center justify-center rounded-full border border-dashed px-1 text-[11px] leading-4 font-semibold tabular-nums"
        >
          +{countText(count.earlier)}
        </span>
      )}
      {count.n > 0 && (
        <span
          aria-hidden="true"
          className={cn(
            'inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[12px] leading-5 font-semibold tabular-nums',
            count.urgent ? 'bg-red-dot text-white' : 'bg-card text-ink-2 ring-border ring-1',
          )}
        >
          {countText(count.n)}
        </span>
      )}
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

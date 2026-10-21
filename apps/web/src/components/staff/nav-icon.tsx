import { useTranslation } from 'react-i18next'
import { Icon } from '@/components/ui/icon'
import { useNotifications } from '@/lib/api/notifications'
import { cn } from '@/lib/utils'

/*
 * A navigation icon (rail, bottom bar, More sheet). The Notifications item carries the number of
 * unread notices, like the bell in the top bar.
 */
export function NavIcon({
  id,
  name,
  size = 22,
  ring = 'ring-[#13306b]',
}: {
  id: string
  name: string
  size?: number
  /** Ring around the badge, matching the background it sits on. */
  ring?: string
}) {
  return (
    <span className="relative inline-flex">
      <Icon name={name} size={size} />
      {id === 'notifications' && <UnreadBadge ring={ring} />}
    </span>
  )
}

/** The unread count as a small red badge (nothing when all is read). */
export function UnreadBadge({
  ring = 'ring-[#13306b]',
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
        'absolute -top-1.5 -right-2.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-[#e5484d] px-1 text-[10px] leading-[18px] font-bold text-white tabular-nums ring-2',
        ring,
        className,
      )}
    >
      {n > 99 ? '99+' : n}
      <span className="sr-only"> {t('notify.unreadCount', { count: n })}</span>
    </span>
  )
}

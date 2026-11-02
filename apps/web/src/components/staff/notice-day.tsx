import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

/*
 * The notices are for the day (0122): the red count is today's unread only. The lists group
 * "Today" and "Earlier"; an older notice left unread stays readable with a small "unread" mark.
 */

/** "Today" / "Earlier": the heading of a group of notices. */
export function NoticeDayHeading({ today, className }: { today: boolean; className?: string }) {
  const { t } = useTranslation()
  return (
    <div
      role="heading"
      aria-level={3}
      className={cn(
        'text-ink-3 bg-surface border-grid border-b px-3 py-1 text-[11px] font-semibold tracking-[0.06em] uppercase',
        className,
      )}
    >
      {t(today ? 'daily.today' : 'daily.earlier')}
    </div>
  )
}

/** The small "unread" mark of an older notice left unread (not in the red count). */
export function EarlierUnreadMark({ className }: { className?: string }) {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'border-ink-3/50 text-ink-2 inline-flex h-5 flex-none items-center rounded border border-dashed px-1.5 text-[11px] font-medium',
        className,
      )}
    >
      {t('daily.unread')}
    </span>
  )
}

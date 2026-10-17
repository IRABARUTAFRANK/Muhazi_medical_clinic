import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { useUserActions } from '@/lib/user-actions'
import { StaffLink } from './staff-link'

interface MoreSheetProps {
  user: StaffUser
  onClose: () => void
}

const item =
  'flex min-h-12 w-full items-center justify-between rounded-lg px-3 text-left text-ink no-underline hover:bg-hover'

/**
 * Tablet bottom sheet: dashboard (managers and heads of station only), settings (managers),
 * theme, sign out. No user switching: the next person signs in with their own credentials.
 */
export function MoreSheet({ user, onClose }: MoreSheetProps) {
  const { t } = useTranslation()
  const actions = useUserActions()
  const manager = user.role === 'manager'
  const dashboard = manager || user.dashboard === 'head'
  return (
    <div
      className="absolute inset-0 z-20 flex flex-col justify-end bg-[rgba(15,23,32,.45)]"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-label={t('common.more')}
        className="bg-card shadow-sheet rounded-t-2xl px-4 pt-3 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-border mx-auto mb-3 h-1 w-10 rounded-sm" />
        <div className="px-3 py-1.5">
          <span className="block text-[13px] font-semibold">{user.name}</span>
          <span className="text-ink-3 text-xs tabular-nums">
            {user.staffId ? `${user.staffId} · ` : ''}
            {user.username}
          </span>
        </div>
        <div className="border-border my-2 border-t" />
        <div className="text-ink-3 px-3 py-1.5 text-xs">{t('common.more')}</div>
        {dashboard && (
          <StaffLink to="/app/dashboard" className={item} onClick={onClose}>
            <span>{t('common.dashboard')}</span>
            <span className="text-ink-3 text-xs">{t('common.manager')}</span>
          </StaffLink>
        )}
        {manager && (
          <StaffLink to="/app/settings" className={item} onClick={onClose}>
            <span>{t('common.settings')}</span>
          </StaffLink>
        )}
        <button
          type="button"
          className={item}
          onClick={() => {
            onClose()
            actions.toggleTheme()
          }}
        >
          <span>{t(actions.theme === 'light' ? 'common.toDim' : 'common.toLight')}</span>
          <span className="text-ink-3 text-xs">{t('common.nightUse')}</span>
        </button>
        <button type="button" className={item} onClick={actions.signOut}>
          <span>{t('common.signOut')}</span>
          <span className="text-ink-3 text-xs">{t('common.backToSite')}</span>
        </button>
      </div>
    </div>
  )
}

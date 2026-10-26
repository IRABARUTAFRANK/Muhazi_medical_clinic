import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { NavItem, StaffUser, SyncState } from '@mmc/shared'
import { LangSwitch } from '@/components/public/lang-switch'
import { Button } from '@/components/ui/button'
import { useUserActions } from '@/lib/user-actions'
import { cn } from '@/lib/utils'
import { StaffLink } from './staff-link'
import { SyncBadge } from './sync-badge'
import { TextSizeControl } from './text-size-control'
import { NavIcon } from './nav-icon'

interface MoreSheetProps {
  user: StaffUser
  /** Sidebar items that did not fit in the bottom bar. */
  nav?: NavItem[]
  activeId?: string
  sync?: SyncState
  onClose: () => void
}

const item =
  'flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-3 text-left text-[14px] text-ink no-underline hover:bg-hover'

/**
 * Tablet bottom sheet: dashboard (managers and heads of station only), settings (managers),
 * theme, sign out. No user switching: the next person signs in with their own credentials.
 */
export function MoreSheet({ user, nav = [], activeId, sync, onClose }: MoreSheetProps) {
  const { t } = useTranslation()
  const actions = useUserActions()
  const manager = user.role === 'manager'
  const dashboard = manager || user.dashboard === 'head'
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="absolute inset-0 z-20 flex flex-col justify-end bg-black/40"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-label={t('common.more')}
        className="bg-card border-border shadow-sheet anim-dialog max-h-[88dvh] overflow-y-auto rounded-t-md border-t px-3 pt-2 pb-[max(16px,env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-border mx-auto mb-2 h-1 w-8 rounded-sm" />
        <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={onClose}
            className="text-ink-3 hover:bg-hover hover:text-ink order-last inline-flex size-8 items-center justify-center rounded-md"
          >
            <X size={16} aria-hidden="true" />
          </button>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium">{user.name}</span>
            <span className="text-ink-3 text-[12px] tabular-nums">
              {user.staffId ? `${user.staffId} · ` : ''}
              {user.username}
            </span>
          </span>
          {sync && <SyncBadge state={sync} />}
        </div>
        {nav.length > 0 && (
          <>
            <div className="border-border my-2 border-t" />
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
              {nav.map((n) => (
                <StaffLink
                  key={n.id}
                  to={n.to}
                  onClick={onClose}
                  aria-current={n.id === activeId ? 'page' : undefined}
                  className={cn(
                    'border-border flex min-h-16 flex-col items-center justify-center gap-1 rounded-md border px-1 text-center text-[12px] font-medium no-underline',
                    n.id === activeId
                      ? 'border-primary/30 bg-primary-tint text-primary'
                      : 'bg-card text-ink-2 hover:bg-hover',
                  )}
                >
                  <NavIcon id={n.id} name={n.icon} size={20} />
                  <span className="max-w-full leading-tight">{t(n.labelKey)}</span>
                </StaffLink>
              ))}
            </div>
          </>
        )}
        <div className="border-border my-2 border-t" />
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-1.5 lg:hidden">
          <span className="text-ink-3 text-[13px]">{t('lang.label')}</span>
          <LangSwitch size="sm" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-1.5">
          <span className="text-ink-3 text-[13px]">{t('textSize.title')}</span>
          <TextSizeControl />
        </div>
        <div className="text-ink-3 px-3 py-1.5 text-[12px]">{t('common.more')}</div>
        {dashboard && (
          <StaffLink to="/app/dashboard" className={item} onClick={onClose}>
            <span>{t('common.dashboard')}</span>
            <span className="text-ink-3 text-[12px]">
              {manager ? t('common.manager') : t('staff.positions.head')}
            </span>
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
          <span className="text-ink-3 text-[12px]">{t('common.nightUse')}</span>
        </button>
        <button
          type="button"
          className={item}
          onClick={() => {
            onClose()
            actions.lock()
          }}
        >
          <span>{t('common.lockNow')}</span>
          <span className="text-ink-3 text-[12px]">{t('common.lockNowHint')}</span>
        </button>
        <button
          type="button"
          className={item}
          onClick={() => {
            onClose()
            actions.changePin()
          }}
        >
          <span>{t('common.changePin')}</span>
          <span className="text-ink-3 text-[12px]">{t('common.changePinHint')}</span>
        </button>
        <button type="button" className={item} onClick={actions.signOut}>
          <span>{t('common.signOut')}</span>
          <span className="text-ink-3 text-[12px]">{t('common.backToSite')}</span>
        </button>
        <div className="border-border my-2 border-t" />
        <Button size="lg" className="w-full" onClick={onClose}>
          <X size={16} aria-hidden="true" />
          {t('common.close')}
        </Button>
      </div>
    </div>
  )
}

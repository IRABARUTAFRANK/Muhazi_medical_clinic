import { useEffect } from 'react'
import {
  KeyRound,
  LayoutDashboard,
  Lock,
  LogOut,
  Moon,
  Settings,
  Sun,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { NavItem, StaffUser, SyncState } from '@mmc/shared'
import { LangSwitch } from '@/components/public/lang-switch'
import { Button } from '@/components/ui/button'
import { groupNav } from '@/lib/nav'
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

/**
 * The rows that act carry colour (the owner's rule: what acts must be visible on the white):
 * a tinted background, coloured text and a 1 px border in the action's hue. Information
 * (dashboard, settings) = clinical blue; theme = grey; hold (lock) = amber; change PIN = teal;
 * leave (sign out) = coral.
 */
const row =
  'flex min-h-11 w-full items-center gap-3 rounded-md border px-3 text-left text-[14px] font-medium no-underline transition-colors duration-120 active:scale-[0.99] motion-reduce:active:scale-100'
const tint = {
  blue: 'border-blue/30 bg-blue-bg text-blue hover:border-blue/60',
  grey: 'border-border bg-surface text-ink hover:bg-hover',
  amber: 'border-amber/30 bg-amber-bg text-amber hover:border-amber/60',
  teal: 'border-primary/30 bg-primary-tint text-primary hover:border-primary/60',
  red: 'border-red/30 bg-red-bg text-red hover:border-red/60',
} as const

function ActionIcon({ icon: I }: { icon: LucideIcon }) {
  return (
    <span className="bg-card/70 inline-flex size-8 flex-none items-center justify-center rounded-md">
      <I size={16} aria-hidden="true" />
    </span>
  )
}

function RowText({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col leading-[1.2]">
      <span className="truncate">{label}</span>
      {hint && <span className="truncate text-[12px] font-normal opacity-80">{hint}</span>}
    </span>
  )
}

/**
 * Tablet bottom sheet: the menu entries that did not fit in the bar, under the same group
 * headings as the PC sidebar; then dashboard (managers and heads of station only), settings
 * (managers), theme, lock, PIN, sign out. No user switching: the next person signs in with
 * their own credentials.
 */
export function MoreSheet({ user, nav = [], activeId, sync, onClose }: MoreSheetProps) {
  const { t } = useTranslation()
  const actions = useUserActions()
  const manager = user.role === 'manager'
  const dashboard = manager || user.dashboard === 'head'
  const groups = groupNav(nav)
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
        className="bg-card border-border shadow-panel anim-dialog max-h-[88dvh] overflow-y-auto rounded-t-xl border-t px-3 pt-2 pb-[max(16px,env(safe-area-inset-bottom))]"
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
        {groups.length > 0 && <div className="border-border my-2 border-t" />}
        {/* the same group blocks as the PC sidebar: each on its tint, the active tile white */}
        {groups.map((g) => (
          <div
            key={g.id}
            role="group"
            aria-labelledby={`sheet-group-${g.id}`}
            className={cn('rail-group mb-2.5 p-2', `rail-${g.id}`)}
          >
            <div
              id={`sheet-group-${g.id}`}
              className="rail-label mb-1.5 px-1 text-[11px] font-semibold tracking-[0.06em] uppercase"
            >
              {t(g.labelKey)}
            </div>
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
              {g.items.map((n) => (
                <StaffLink
                  key={n.id}
                  to={n.to}
                  onClick={onClose}
                  aria-current={n.id === activeId ? 'page' : undefined}
                  className={cn(
                    'rail-item flex min-h-16 flex-col items-center justify-center gap-1 rounded-md px-1 text-center text-[12px] font-medium no-underline',
                    n.id === activeId && 'shadow-card',
                  )}
                >
                  <NavIcon id={n.id} name={n.icon} size={20} />
                  <span className="max-w-full leading-tight">{t(n.labelKey)}</span>
                </StaffLink>
              ))}
            </div>
          </div>
        ))}
        <div className="border-border my-2 border-t" />
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-1.5 lg:hidden">
          <span className="text-ink-3 text-[13px]">{t('lang.label')}</span>
          <LangSwitch size="sm" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-1.5">
          <span className="text-ink-3 text-[13px]">{t('textSize.title')}</span>
          <TextSizeControl />
        </div>
        <div className="text-ink-3 mt-1 mb-1.5 px-3 text-[11px] font-semibold tracking-[0.06em] uppercase">
          {t('common.more')}
        </div>
        <div className="flex flex-col gap-1.5">
          {dashboard && (
            <StaffLink to="/app/dashboard" className={cn(row, tint.blue)} onClick={onClose}>
              <ActionIcon icon={LayoutDashboard} />
              <RowText
                label={t('common.dashboard')}
                hint={manager ? t('common.manager') : t('staff.positions.head')}
              />
            </StaffLink>
          )}
          {manager && (
            <StaffLink to="/app/settings" className={cn(row, tint.blue)} onClick={onClose}>
              <ActionIcon icon={Settings} />
              <RowText label={t('common.settings')} />
            </StaffLink>
          )}
          <button
            type="button"
            className={cn(row, tint.grey)}
            onClick={() => {
              onClose()
              actions.toggleTheme()
            }}
          >
            <ActionIcon icon={actions.theme === 'light' ? Moon : Sun} />
            <RowText
              label={t(actions.theme === 'light' ? 'common.toDim' : 'common.toLight')}
              hint={t('common.nightUse')}
            />
          </button>
          <button
            type="button"
            className={cn(row, tint.amber)}
            onClick={() => {
              onClose()
              actions.lock()
            }}
          >
            <ActionIcon icon={Lock} />
            <RowText label={t('common.lockNow')} hint={t('common.lockNowHint')} />
          </button>
          <button
            type="button"
            className={cn(row, tint.teal)}
            onClick={() => {
              onClose()
              actions.changePin()
            }}
          >
            <ActionIcon icon={KeyRound} />
            <RowText label={t('common.changePin')} hint={t('common.changePinHint')} />
          </button>
          <button type="button" className={cn(row, tint.red)} onClick={actions.signOut}>
            <ActionIcon icon={LogOut} />
            <RowText label={t('common.signOut')} hint={t('common.backToSite')} />
          </button>
        </div>
        <div className="border-border my-2 border-t" />
        <Button size="lg" variant="primary" className="w-full" onClick={onClose}>
          <X size={16} aria-hidden="true" />
          {t('common.close')}
        </Button>
      </div>
    </div>
  )
}

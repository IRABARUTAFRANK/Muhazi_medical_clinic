import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { LangSwitch } from '@/components/public/lang-switch'
import { Avatar } from '@/components/ui/avatar'
import { roleLabel } from '@/lib/roles'
import { useUserActions } from '@/lib/user-actions'
import { cn } from '@/lib/utils'
import { useSession } from '@/store/session'
import { TextSizeControl } from './text-size-control'

const itemClass =
  'flex min-h-11 w-full items-center justify-between rounded-lg px-3 text-left font-normal text-ink hover:bg-hover'

interface UserMenuProps {
  user: StaffUser
  /** Tablet: open the bottom sheet instead of a dropdown. */
  onOpenSheet?: () => void
  /** Rendered on the navy top bar: glass trigger with white text. */
  onDark?: boolean
}

/**
 * Current user button with theme toggle and sign-out. There is deliberately no "switch user":
 * every action is recorded against the signed-in employee, so the next person signs in
 * with their own staff ID, username, PIN and code.
 */
export function UserMenu({ user, onOpenSheet, onDark = false }: UserMenuProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const actions = useUserActions()
  const idleHours = useSession((s) => s.sessionHours)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={t('common.currentUser')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (onOpenSheet ? onOpenSheet() : setOpen((o) => !o))}
        className={cn(
          'flex min-h-11 items-center gap-1.5 rounded-xl border py-0 pr-2 pl-1.5 transition-[background-color,transform] duration-150 focus-visible:ring-[3px] focus-visible:outline-none active:scale-[0.98] sm:gap-2.5 sm:pr-2.5',
          onDark
            ? 'glass-dark text-white focus-visible:ring-white/30'
            : 'border-border bg-card hover:bg-hover focus-visible:ring-primary/45',
        )}
      >
        <Avatar name={user.name} size="sm" />
        <span className="hidden max-w-[170px] min-w-0 flex-col items-start leading-[1.15] md:flex">
          <span className="max-w-full truncate text-[13px] font-semibold">{user.name}</span>
          <span
            className={cn(
              'max-w-full truncate text-xs font-medium',
              onDark ? 'text-white/65' : 'text-ink-3',
            )}
          >
            {roleLabel(user, t)}
          </span>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          className="border-border bg-card shadow-sheet absolute top-[52px] right-0 z-[5] flex w-[min(280px,calc(100vw-24px))] flex-col rounded-lg border p-2"
        >
          <div className="px-3 py-1.5">
            <span className="block text-[13px] font-semibold">{user.name}</span>
            <span className="text-ink-3 text-xs tabular-nums">
              {user.staffId ? `${user.staffId} · ` : ''}
              {user.username}
            </span>
            <span className="text-ink-3 block text-xs">
              {t('session.rule', { count: idleHours })}
            </span>
          </div>
          <div className="border-border my-1.5 border-t" />
          <div className="flex flex-col gap-1.5 px-3 py-1.5">
            <span className="text-ink-3 text-xs font-semibold">{t('textSize.title')}</span>
            <TextSizeControl />
          </div>
          <div className="flex flex-col gap-1.5 px-3 py-1.5 xl:hidden">
            <span className="text-ink-3 text-xs font-semibold">{t('lang.label')}</span>
            <LangSwitch size="sm" />
          </div>
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => {
              setOpen(false)
              actions.toggleTheme()
            }}
          >
            <span>{t(actions.theme === 'light' ? 'common.toDim' : 'common.toLight')}</span>
            <span className="text-ink-3 text-xs">{t('common.nightUse')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => {
              setOpen(false)
              actions.lock()
            }}
          >
            <span>{t('common.lockNow')}</span>
            <span className="text-ink-3 text-xs">{t('common.lockNowHint')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => {
              setOpen(false)
              actions.changePin()
            }}
          >
            <span>{t('common.changePin')}</span>
            <span className="text-ink-3 text-xs">{t('common.changePinHint')}</span>
          </button>
          <button type="button" role="menuitem" className={cn(itemClass)} onClick={actions.signOut}>
            <span>{t('common.signOut')}</span>
            <span className="text-ink-3 text-xs">{t('common.backToSite')}</span>
          </button>
        </div>
      )}
    </div>
  )
}

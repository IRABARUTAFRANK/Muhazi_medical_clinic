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
  'flex min-h-9 w-full items-center justify-between gap-3 rounded px-2 py-1 text-left text-[14px] font-normal text-ink hover:bg-hover'

interface UserMenuProps {
  user: StaffUser
  /** Tablet: open the bottom sheet instead of a dropdown. */
  onOpenSheet?: () => void
  /** Kept for callers; the bar is white now, so the trigger looks the same either way. */
  onDark?: boolean
}

/**
 * Current user button with theme toggle and sign-out. There is deliberately no "switch user":
 * every action is recorded against the signed-in employee, so the next person signs in
 * with their own staff ID, username, PIN and code.
 */
export function UserMenu({ user, onOpenSheet }: UserMenuProps) {
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
          'text-ink hover:bg-hover focus-visible:ring-primary/20 flex h-9 items-center gap-1.5 rounded-md border border-transparent py-0 pr-1.5 pl-1 transition-colors duration-120 focus-visible:ring-2 focus-visible:outline-none sm:gap-2',
          open && 'bg-hover',
        )}
      >
        <Avatar name={user.name} size="sm" />
        <span className="hidden max-w-[170px] min-w-0 flex-col items-start leading-[1.15] md:flex">
          <span className="max-w-full truncate text-[14px] font-medium">{user.name}</span>
          <span className="text-ink-3 max-w-full truncate text-[12px]">{roleLabel(user, t)}</span>
        </span>
        <ChevronDown size={14} aria-hidden="true" className="text-ink-3" />
      </button>
      {open && (
        <div
          role="menu"
          className="border-border bg-card shadow-sheet anim-dialog absolute top-[calc(100%+6px)] right-0 z-[5] flex w-[min(280px,calc(100vw-24px))] flex-col rounded-md border p-1"
        >
          <div className="px-2 py-1.5">
            <span className="block text-[14px] font-medium">{user.name}</span>
            <span className="text-ink-3 text-[12px] tabular-nums">
              {user.staffId ? `${user.staffId} · ` : ''}
              {user.username}
            </span>
            <span className="text-ink-3 block text-[12px]">
              {t('session.rule', { count: idleHours })}
            </span>
          </div>
          <div className="border-border my-1 border-t" />
          <div className="flex flex-col gap-1 px-2 py-1.5">
            <span className="text-ink-3 text-[12px]">{t('textSize.title')}</span>
            <TextSizeControl />
          </div>
          <div className="flex flex-col gap-1 px-2 py-1.5 xl:hidden">
            <span className="text-ink-3 text-[12px]">{t('lang.label')}</span>
            <LangSwitch size="sm" />
          </div>
          <div className="border-border my-1 border-t" />
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
            <span className="text-ink-3 text-[12px]">{t('common.nightUse')}</span>
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
            <span className="text-ink-3 text-[12px]">{t('common.lockNowHint')}</span>
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
            <span className="text-ink-3 text-[12px]">{t('common.changePinHint')}</span>
          </button>
          <button type="button" role="menuitem" className={itemClass} onClick={actions.signOut}>
            <span>{t('common.signOut')}</span>
            <span className="text-ink-3 text-[12px]">{t('common.backToSite')}</span>
          </button>
        </div>
      )}
    </div>
  )
}

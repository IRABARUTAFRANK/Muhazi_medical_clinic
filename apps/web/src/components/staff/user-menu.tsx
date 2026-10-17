import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Avatar } from '@/components/ui/avatar'
import { roleLabel } from '@/lib/roles'
import { useUserActions } from '@/lib/user-actions'
import { cn } from '@/lib/utils'

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
          'flex min-h-11 items-center gap-2.5 rounded-xl border py-0 pr-2.5 pl-1.5 transition-[background-color,transform] duration-150 focus-visible:ring-[3px] focus-visible:outline-none active:scale-[0.98]',
          onDark
            ? 'glass-dark text-white focus-visible:ring-white/30'
            : 'border-border bg-card hover:bg-hover focus-visible:ring-primary/45',
        )}
      >
        <Avatar name={user.name} size="sm" />
        <span className="flex flex-col items-start leading-[1.15]">
          <span className="text-[13px] font-semibold">{user.name}</span>
          <span className={cn('text-xs font-medium', onDark ? 'text-white/65' : 'text-ink-3')}>
            {roleLabel(user, t)}
          </span>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          className="border-border bg-card shadow-sheet absolute top-[52px] right-0 z-[5] flex w-[280px] flex-col rounded-lg border p-2"
        >
          <div className="px-3 py-1.5">
            <span className="block text-[13px] font-semibold">{user.name}</span>
            <span className="text-ink-3 text-xs tabular-nums">
              {user.staffId ? `${user.staffId} · ` : ''}
              {user.username}
            </span>
          </div>
          <div className="border-border my-1.5 border-t" />
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
          <button type="button" role="menuitem" className={cn(itemClass)} onClick={actions.signOut}>
            <span>{t('common.signOut')}</span>
            <span className="text-ink-3 text-xs">{t('common.backToSite')}</span>
          </button>
        </div>
      )}
    </div>
  )
}

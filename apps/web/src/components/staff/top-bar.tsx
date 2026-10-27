import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser, SyncState } from '@mmc/shared'
import { LangSwitch } from '@/components/public/lang-switch'
import { Logo } from '@/components/public/logo'
import { cn } from '@/lib/utils'
import { NotificationBell } from './notification-bell'
import { SyncBadge } from './sync-badge'
import { UserMenu } from './user-menu'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'

interface TopBarProps {
  user: StaffUser
  sync: SyncState
  onOpenSheet: () => void
  /** The open page's name, after the clinic's in the breadcrumb ("Clinic / Patients / History"). */
  title?: string
  /** The sidebar group the page belongs to, between the clinic and the page. */
  group?: string
}

/**
 * Search any patient from every screen: Enter opens the patient register with the matches
 * (name, file number, phone, national ID). "/" anywhere puts the cursor here.
 */
function PatientSearch({ className }: { className?: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing =
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      // the visible search box only (PC and tablet rows both render one)
      if (e.key === '/' && !typing && input.current && input.current.offsetParent !== null) {
        e.preventDefault()
        input.current.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault()
        const text = q.trim()
        void navigate({ to: '/app/patients', search: text ? { q: text } : {} })
      }}
      className={cn(
        'border-border bg-surface text-ink-3 focus-within:border-primary focus-within:ring-primary/20 flex h-9 items-center gap-2 rounded-full border px-3 text-[14px] transition-[border-color,box-shadow] duration-120 focus-within:ring-2',
        className,
      )}
    >
      <Search size={16} aria-hidden="true" />
      <input
        ref={input}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('common.searchPatient')}
        aria-label={t('common.searchPatient')}
        className="text-ink placeholder:text-ink-4 min-w-0 flex-1 border-0 bg-transparent outline-none"
      />
      <kbd className="border-border text-ink-4 hidden rounded border px-1 text-[11px] leading-4 lg:inline">
        /
      </kbd>
    </form>
  )
}

/**
 * Top bar on every staff screen: 48 px, white at 92 % with an 8 px blur so the workspace's
 * gradient shows through (.topbar), a 1 px bottom border. On a PC the sidebar
 * carries the logo, so the bar starts with the breadcrumb ("Clinic / Group / Page"), then the
 * search pill, sync state, bell, user menu and the language switch. Tablets and phones have
 * no sidebar: the logo comes first, and the search gets a second row.
 */
export function TopBar({ user, sync, onOpenSheet, title, group }: TopBarProps) {
  const { t } = useTranslation()
  return (
    <header className="topbar border-border relative z-[6] flex-none border-b">
      {/* PC: one 48 px row */}
      <div className="pc:flex hidden h-12 items-center gap-3 px-4">
        {/* the breadcrumb takes the free space, so nothing is cut while there is room */}
        <span className="text-ink-3 flex min-w-0 flex-1 items-center gap-1.5 text-[14px]">
          <span className="truncate">{t('app.clinicName')}</span>
          {group && group !== title && (
            <>
              <span className="text-ink-4" aria-hidden="true">
                /
              </span>
              <span className="truncate">{group}</span>
            </>
          )}
          {title && (
            <>
              <span className="text-ink-4" aria-hidden="true">
                /
              </span>
              <span className="text-ink truncate font-medium">{title}</span>
            </>
          )}
        </span>
        <PatientSearch className="w-[min(320px,20vw)] min-w-[180px] flex-none" />
        <SyncBadge state={sync} />
        <NotificationBell user={user} />
        <UserMenu user={user} />
        <span className="hidden xl:inline-flex">
          <LangSwitch size="sm" />
        </span>
      </div>
      {/* Tablet and phone: two rows. Phones keep only the logo, bell and person on the first
          row (sync state and language live in the "More" sheet) and the search on the second. */}
      <div className="pc:hidden flex flex-col gap-1.5 px-3 py-1.5 sm:px-4">
        <div className="flex h-10 items-center gap-2 sm:gap-3">
          <Logo
            to="/app"
            size="md"
            compact
            subtitle={t('app.shortPlace')}
            ariaLabel={t('app.staffHome')}
            className="min-w-0 [&_img]:size-7 [&_span>span:first-child]:text-[14px] [&_span>span:first-child]:font-semibold"
          />
          <span className="flex-1" />
          <span className="hidden md:inline-flex">
            <SyncBadge state={sync} />
          </span>
          <NotificationBell user={user} />
          <span className="hidden lg:inline-flex">
            <LangSwitch size="sm" />
          </span>
          <UserMenu user={user} onOpenSheet={onOpenSheet} />
        </div>
        <PatientSearch />
      </div>
    </header>
  )
}

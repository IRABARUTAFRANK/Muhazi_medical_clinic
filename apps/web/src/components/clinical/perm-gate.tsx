import type { ReactNode } from 'react'
import { ShieldOff, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { PageBanner } from '@/components/dash/page-banner'
import type { Tint } from '@/components/dash/kit-style'
import { StaffShell } from '@/components/staff/staff-shell'
import { FEATURE_KEY, type Feature } from '@/lib/api/permissions'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'

/**
 * "The manager has not allowed you to record vital signs (Settings → Who may do what)." Shown
 * where a form or a button would be, to someone whose switch is off (for their role, or for them).
 * What other permissions let them read stays on the page.
 */
export function NotAllowedNotice({
  feature,
  className,
  compact,
}: {
  feature: Feature
  className?: string
  /** One line, inside a card (no title). */
  compact?: boolean
}) {
  const { t } = useTranslation()
  const what = t(`perms.blocked.what.${FEATURE_KEY[feature]}`)
  return (
    <p
      role="status"
      className={cn(
        'bg-amber-bg text-amber border-amber/30 m-0 flex items-start gap-3 rounded-md border text-[14px]',
        compact ? 'px-3 py-2' : 'px-4 py-3.5',
        className,
      )}
    >
      <ShieldOff size={compact ? 16 : 20} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {!compact && <b className="block">{t('perms.blocked.title')}</b>}
        {t('perms.blocked.body', { what })}
      </span>
    </p>
  )
}

/** A whole page opened (by its address) by someone the manager has not allowed: the usual banner,
 *  then the notice. */
export function NotAllowedPage({
  user,
  activeId,
  feature,
  icon,
  tint,
  title,
  children,
}: {
  user: StaffUser
  activeId: string
  feature: Feature
  icon: LucideIcon
  tint: Tint
  title: string
  /** Anything still useful here (a link back home…). */
  children?: ReactNode
}) {
  return (
    <StaffShell user={user} nav={navForUser(user)} activeId={activeId}>
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <PageBanner icon={icon} tint={tint} title={title} />
        <NotAllowedNotice feature={feature} />
        {children}
      </main>
    </StaffShell>
  )
}

import type { ReactNode } from 'react'
import { Lock, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { PageBanner } from '@/components/dash/page-banner'
import type { Tint } from '@/components/dash/kit-style'
import { StaffShell } from '@/components/staff/staff-shell'
import { deskName, type DeskId } from '@/lib/api/desks'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'

/**
 * "You do not work in a department that does this. Ask the manager." Shown where a desk would be,
 * to someone whose departments do not give it (the role may, a department of theirs does not).
 */
export function NoDeskNotice({
  desks,
  className,
}: {
  /** The desk(s) this place needs: their names are said, so the manager knows which. */
  desks: readonly DeskId[]
  className?: string
}) {
  const { t } = useTranslation()
  const names = desks.map((d) => deskName(d, t)).join(', ')
  return (
    <p
      role="status"
      className={cn(
        'bg-violet-bg text-violet m-0 flex items-start gap-3 rounded-xl px-4 py-3.5 text-[14px]',
        className,
      )}
    >
      <Lock size={20} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <b className="block">{t('deskGate.title')}</b>
        {names ? t('deskGate.body', { desks: names }) : t('deskGate.bodyShort')}
      </span>
    </p>
  )
}

/** A whole desk page opened by someone without the desk: the usual banner, then the notice. */
export function NoDeskPage({
  user,
  activeId,
  desks,
  icon,
  tint,
  title,
  children,
}: {
  user: StaffUser
  activeId: string
  desks: readonly DeskId[]
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
        <NoDeskNotice desks={desks} />
        {children}
      </main>
    </StaffShell>
  )
}

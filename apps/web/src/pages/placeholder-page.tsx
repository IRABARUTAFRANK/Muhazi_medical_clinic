import { Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { buttonVariants } from '@/components/ui/button'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { navForUser } from '@/lib/nav'
import { navKeyForSection } from '@/lib/roles'

/** Honest stand-in for screens listed in the document but not designed yet (doc §12.5). */
export function PlaceholderPage({ user, section }: { user: StaffUser; section: string }) {
  const { t, i18n } = useTranslation()
  const nav = navForUser(user)
  const key = navKeyForSection(section)
  const title = i18n.exists(key) ? t(key) : section
  const activeId = nav.find((n) => n.to === `/app/${section}`)?.id

  return (
    <StaffShell user={user} nav={nav} activeId={activeId}>
      <main className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <span className="bg-primary-tint text-primary inline-flex size-14 items-center justify-center rounded-full">
          <Wrench size={28} aria-hidden="true" />
        </span>
        <h1 className="m-0 text-2xl font-bold">{t('placeholder.title', { screen: title })}</h1>
        <p className="text-ink-2 m-0 max-w-[440px]">{t('placeholder.body')}</p>
        <StaffLink to="/app" className={buttonVariants({ variant: 'default', size: 'md' })}>
          {t('placeholder.back')}
        </StaffLink>
      </main>
    </StaffShell>
  )
}

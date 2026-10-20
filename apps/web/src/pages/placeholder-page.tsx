import { Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { PageBanner } from '@/components/dash/page-banner'
import { buttonVariants } from '@/components/ui/button'
import { iconFor } from '@/components/ui/icon-map'
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
  const item = nav.find((n) => n.to === `/app/${section}`)
  const activeId = item?.id

  return (
    <StaffShell user={user} nav={nav} activeId={activeId}>
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <PageBanner icon={item ? iconFor(item.icon) : Wrench} tint="teal" title={title} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <span className="bg-primary-tint text-primary inline-flex size-14 items-center justify-center rounded-full">
            <Wrench size={28} aria-hidden="true" />
          </span>
          <h1 className="m-0 text-2xl font-bold">{t('placeholder.title', { screen: title })}</h1>
          <p className="text-ink-2 m-0 max-w-[440px]">{t('placeholder.body')}</p>
          <StaffLink to="/app" className={buttonVariants({ variant: 'default', size: 'md' })}>
            {t('placeholder.back')}
          </StaffLink>
        </div>
      </main>
    </StaffShell>
  )
}

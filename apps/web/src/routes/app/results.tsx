import { createFileRoute, redirect } from '@tanstack/react-router'
import { FlaskConical } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { NoDeskPage } from '@/components/clinical/desk-gate'
import { TREATING_DESKS, useCanDesk } from '@/lib/api/desks'
import { ResultsPage } from '@/pages/doctor/doctor-pages'
import { menuAllows } from '@/lib/nav'
import { useSession } from '@/store/session'

/**
 * The tests I ordered and their results. Whoever's menu offers it (the role, or a department
 * that gives a treating desk, 0085); someone without such a desk is told to ask the manager.
 */
export const Route = createFileRoute('/app/results')({
  beforeLoad: async () => {
    const user = useSession.getState().user
    if (!user || !(await menuAllows(user, '/app/results'))) throw redirect({ to: '/app' })
  },
  component: Page,
})

function Page() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <AtDesk user={user} />
}

function AtDesk({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const canDesk = useCanDesk(user)
  if (!canDesk(TREATING_DESKS))
    return (
      <NoDeskPage
        user={user}
        activeId="results"
        desks={TREATING_DESKS}
        icon={FlaskConical}
        tint="teal"
        title={t('nav.results')}
      />
    )
  return <ResultsPage user={user} />
}

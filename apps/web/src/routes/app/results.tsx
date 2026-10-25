import { createFileRoute, redirect } from '@tanstack/react-router'
import { FlaskConical } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { NoDeskPage } from '@/components/clinical/desk-gate'
import { TREATING_DESKS, useCanDesk } from '@/lib/api/desks'
import { ResultsPage } from '@/pages/doctor/doctor-pages'
import { useSession } from '@/store/session'

/**
 * The tests I ordered and their results. Doctors, nurses and the manager, at a desk where patients are treated
 * (their departments decide, 0085); someone without one is told to ask the manager.
 */
export const Route = createFileRoute('/app/results')({
  beforeLoad: () => {
    const role = useSession.getState().user?.role
    if (!role || !['doctor', 'nurse', 'manager'].includes(role)) throw redirect({ to: '/app' })
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

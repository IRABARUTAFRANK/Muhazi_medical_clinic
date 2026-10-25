import { createFileRoute, redirect } from '@tanstack/react-router'
import { ListOrdered } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { NoDeskPage } from '@/components/clinical/desk-gate'
import { TREATING_DESKS, useCanDesk } from '@/lib/api/desks'
import { QueuePage } from '@/pages/doctor/doctor-pages'
import { useSession } from '@/store/session'

/**
 * The doctor's desk queue on its own page. Doctors, nurses and the manager, at a desk where patients are treated
 * (their departments decide, 0085); someone without one is told to ask the manager.
 */
export const Route = createFileRoute('/app/queue')({
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
        activeId="queue"
        desks={TREATING_DESKS}
        icon={ListOrdered}
        tint="teal"
        title={t('nav.queue')}
      />
    )
  return <QueuePage user={user} />
}

import { createFileRoute, redirect } from '@tanstack/react-router'
import { ListOrdered } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { NoDeskPage } from '@/components/clinical/desk-gate'
import { TREATING_DESKS, useCanDesk } from '@/lib/api/desks'
import { QueuePage } from '@/pages/doctor/doctor-pages'
import { menuAllows } from '@/lib/nav'
import { useSession } from '@/store/session'

/**
 * The doctor's desk queue on its own page. Whoever's menu offers it (the role, or a department
 * that gives a treating desk, 0085); someone without such a desk is told to ask the manager.
 */
export const Route = createFileRoute('/app/queue')({
  beforeLoad: async () => {
    const user = useSession.getState().user
    if (!user || !(await menuAllows(user, '/app/queue'))) throw redirect({ to: '/app' })
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

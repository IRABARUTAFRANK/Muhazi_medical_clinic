import { createFileRoute, redirect } from '@tanstack/react-router'
import { LabPage } from '@/pages/lab/lab-page'
import { useSession } from '@/store/session'

/**
 * Laboratory worklist: whoever works at the laboratory or ultrasound desk (lab technicians,
 * sonographers, a doctor or nurse whose department is the Laboratory) and the manager. The page
 * itself tells someone without that desk to ask the manager (their departments decide, 0085).
 */
export const Route = createFileRoute('/app/lab')({
  beforeLoad: () => {
    if (!useSession.getState().user) throw redirect({ to: '/app' })
  },
  component: Page,
})

function Page() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <LabPage user={user} />
}

import { createFileRoute, redirect } from '@tanstack/react-router'
import { HistoryPage } from '@/pages/history/history-page'
import { useSession } from '@/store/session'

/** Activity history: managers only. */
export const Route = createFileRoute('/app/history')({
  beforeLoad: () => {
    if (useSession.getState().user?.role !== 'manager') throw redirect({ to: '/app' })
  },
  component: HistoryRoute,
})

function HistoryRoute() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <HistoryPage user={user} />
}

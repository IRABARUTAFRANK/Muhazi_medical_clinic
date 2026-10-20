import { createFileRoute } from '@tanstack/react-router'
import { HistoryPage } from '@/pages/history/history-page'
import { useSession } from '@/store/session'

/** Activity history: everyone sees their own; the manager sees everyone's. */
export const Route = createFileRoute('/app/history')({
  component: HistoryRoute,
})

function HistoryRoute() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <HistoryPage user={user} />
}

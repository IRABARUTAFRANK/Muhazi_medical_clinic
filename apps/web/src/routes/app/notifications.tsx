import { createFileRoute } from '@tanstack/react-router'
import { NotificationsPage } from '@/pages/notifications/notifications-page'
import { useSession } from '@/store/session'

/** Notifications for every role: inbox with filters; the manager also writes and sees what was sent. */
export const Route = createFileRoute('/app/notifications')({
  component: NotificationsRoute,
})

function NotificationsRoute() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <NotificationsPage user={user} />
}

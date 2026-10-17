import { createFileRoute, redirect } from '@tanstack/react-router'
import { SettingsPage } from '@/pages/settings/settings-page'
import { useSession } from '@/store/session'

/** Clinic settings: managers only. */
export const Route = createFileRoute('/app/settings')({
  beforeLoad: () => {
    if (useSession.getState().user?.role !== 'manager') throw redirect({ to: '/app' })
  },
  component: SettingsRoute,
})

function SettingsRoute() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <SettingsPage user={user} />
}

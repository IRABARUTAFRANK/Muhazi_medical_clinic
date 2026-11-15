import { createFileRoute } from '@tanstack/react-router'
import { TvSetupPage } from '@/pages/display/tv-setup-page'
import { useSession } from '@/store/session'

/** 0158: a TV set up by signing in on it (the /app layout asks for the sign-in). */
export const Route = createFileRoute('/app/tv-setup')({
  component: TvSetupRoute,
})

function TvSetupRoute() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <TvSetupPage user={user} />
}

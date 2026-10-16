import { createFileRoute } from '@tanstack/react-router'
import { ChangePinPage } from '@/pages/change-pin-page'
import { useSession } from '@/store/session'

export const Route = createFileRoute('/app/change-pin')({
  component: ChangePinRoute,
})

function ChangePinRoute() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <ChangePinPage user={user} />
}

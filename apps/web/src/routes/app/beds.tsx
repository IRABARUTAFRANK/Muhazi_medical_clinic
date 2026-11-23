import { createFileRoute, redirect } from '@tanstack/react-router'
import { BedsPage } from '@/pages/beds/beds-page'
import { useSession } from '@/store/session'

/** 0197: the patients who stay in a bed, apart from the day's visits; every bed; who stayed. */
export const Route = createFileRoute('/app/beds')({
  // only for people whose menu offers it (doctors, nurses, the manager, the cashier)
  beforeLoad: async () => {
    const user = useSession.getState().user
    if (!user || !(await (await import('@/lib/nav')).menuAllows(user, '/app/beds')))
      throw redirect({ to: '/app' })
  },
  component: BedsRoute,
})

function BedsRoute() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <BedsPage user={user} />
}

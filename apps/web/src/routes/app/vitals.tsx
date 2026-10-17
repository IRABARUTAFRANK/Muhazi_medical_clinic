import { createFileRoute, redirect } from '@tanstack/react-router'
import { TriagePage } from '@/pages/triage/triage-page'
import { useSession } from '@/store/session'

const CLINICAL = ['nurse', 'doctor', 'manager']

/** Triage: first measurements, triage colour, next station. Clinical staff only. */
export const Route = createFileRoute('/app/vitals')({
  beforeLoad: () => {
    const role = useSession.getState().user?.role
    if (!role || !CLINICAL.includes(role)) throw redirect({ to: '/app' })
  },
  component: VitalsRoute,
})

function VitalsRoute() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <TriagePage user={user} />
}

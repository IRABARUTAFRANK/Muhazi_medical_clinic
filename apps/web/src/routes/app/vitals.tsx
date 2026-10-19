import { createFileRoute, redirect } from '@tanstack/react-router'
import { TriagePage } from '@/pages/triage/triage-page'
import { useSession } from '@/store/session'

/** Nurses measure; receptionists and doctors also type in what a nurse wrote on paper. */
const MAY_RECORD = ['nurse', 'doctor', 'manager', 'receptionist']

/** Triage: first measurements, who took them, triage colour, next station. */
export const Route = createFileRoute('/app/vitals')({
  validateSearch: (search: Record<string, unknown>): { encounter?: string } => ({
    encounter: typeof search.encounter === 'string' ? search.encounter : undefined,
  }),
  beforeLoad: () => {
    const role = useSession.getState().user?.role
    if (!role || !MAY_RECORD.includes(role)) throw redirect({ to: '/app' })
  },
  component: VitalsRoute,
})

function VitalsRoute() {
  const user = useSession((s) => s.user)
  const { encounter } = Route.useSearch()
  if (!user) return null
  return <TriagePage user={user} encounter={encounter} />
}

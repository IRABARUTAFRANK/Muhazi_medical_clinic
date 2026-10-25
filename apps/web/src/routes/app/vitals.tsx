import { createFileRoute, redirect } from '@tanstack/react-router'
import { TriagePage } from '@/pages/triage/triage-page'
import { useSession } from '@/store/session'

/**
 * Triage: first measurements, who took them, triage colour, next station. Nurses measure;
 * receptionists and doctors also type in what a nurse wrote on paper. Whoever works at the triage
 * desk may open it (their departments decide, 0085); the page itself tells someone without that
 * desk to ask the manager.
 */
export const Route = createFileRoute('/app/vitals')({
  validateSearch: (search: Record<string, unknown>): { encounter?: string } => ({
    encounter: typeof search.encounter === 'string' ? search.encounter : undefined,
  }),
  beforeLoad: () => {
    if (!useSession.getState().user) throw redirect({ to: '/app' })
  },
  component: VitalsRoute,
})

function VitalsRoute() {
  const user = useSession((s) => s.user)
  const { encounter } = Route.useSearch()
  if (!user) return null
  return <TriagePage user={user} encounter={encounter} />
}

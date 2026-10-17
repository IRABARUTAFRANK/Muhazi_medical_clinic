import { createFileRoute } from '@tanstack/react-router'
import { PatientsPage } from '@/pages/patients/patients-page'
import { useSession } from '@/store/session'

/** The patient register: everyone the clinic has ever registered, searchable. */
export const Route = createFileRoute('/app/patients')({
  validateSearch: (search: Record<string, unknown>): { q?: string } => ({
    q: typeof search.q === 'string' && search.q ? search.q : undefined,
  }),
  component: PatientsRoute,
})

function PatientsRoute() {
  const user = useSession((s) => s.user)
  const { q } = Route.useSearch()
  if (!user) return null
  return <PatientsPage user={user} initialQuery={q ?? ''} />
}

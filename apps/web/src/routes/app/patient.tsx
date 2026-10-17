import { createFileRoute, redirect } from '@tanstack/react-router'
import { PatientFilePage } from '@/pages/patients/patient-file-page'
import { useSession } from '@/store/session'

/** One patient's file: demographics, visits, vitals, diagnoses, bills. */
export const Route = createFileRoute('/app/patient')({
  validateSearch: (search: Record<string, unknown>): { id: string; tab?: string } => ({
    id: typeof search.id === 'string' ? search.id : '',
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (!search.id) throw redirect({ to: '/app/patients' })
  },
  component: PatientRoute,
})

function PatientRoute() {
  const user = useSession((s) => s.user)
  const { id, tab } = Route.useSearch()
  if (!user) return null
  return <PatientFilePage key={id} user={user} patientId={id} initialTab={tab} />
}

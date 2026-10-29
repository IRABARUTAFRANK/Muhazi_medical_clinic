import { createFileRoute, redirect } from '@tanstack/react-router'
import { PatientsDocumentsPage } from '@/pages/analytics/patients-documents-page'
import { validateAnalyticsSearch, type UpdateSearch } from '@/pages/analytics/search'
import { useSession } from '@/store/session'

/**
 * Patients' documents (0102): the visits treated in a period, filtered, and their medical
 * reports printed together. The manager (the whole clinic) and the heads of a department
 * (their department); the server refuses everyone else (analytics_scope).
 */
export const Route = createFileRoute('/app/documents')({
  validateSearch: validateAnalyticsSearch,
  beforeLoad: () => {
    const user = useSession.getState().user
    if (
      user &&
      user.role !== 'manager' &&
      user.dashboard !== 'manager' &&
      user.dashboard !== 'head'
    )
      throw redirect({ to: '/app' })
  },
  component: DocumentsRoute,
})

function DocumentsRoute() {
  const user = useSession((s) => s.user)
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const update: UpdateSearch = (patch, opts) =>
    void navigate({
      search: (prev) => ({ ...prev, ...patch }),
      replace: opts?.replace ?? true,
    })
  if (!user) return null
  return <PatientsDocumentsPage key={user.id} user={user} search={search} update={update} />
}

import { createFileRoute, redirect } from '@tanstack/react-router'
import { StaffProfilePage } from '@/pages/staff/staff-profile-page'
import { useSession } from '@/store/session'

/**
 * One employee's profile (0125): `?id=<employee>` (the manager: anyone; an employee: their own;
 * without an id, one's own: "My profile"), `&tab=` overview, documents, work, access, notes.
 * The database refuses anyone else.
 */
export const Route = createFileRoute('/app/staff_/profile')({
  validateSearch: (search: Record<string, unknown>): { id?: string; tab?: string } => ({
    id: typeof search.id === 'string' && search.id ? search.id : undefined,
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  beforeLoad: ({ search }) => {
    const user = useSession.getState().user
    // someone else's profile: the manager only (the employee is sent to their own)
    if (user && search.id && search.id !== user.id && user.role !== 'manager')
      throw redirect({ to: '/app/staff/profile', search: {} })
  },
  component: StaffProfileRoute,
})

function StaffProfileRoute() {
  const user = useSession((s) => s.user)
  const { id, tab } = Route.useSearch()
  if (!user) return null
  const profileId = id ?? user.id
  return <StaffProfilePage key={profileId} user={user} profileId={profileId} initialTab={tab} />
}

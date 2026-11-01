import { createFileRoute } from '@tanstack/react-router'
import { MyDocumentsPage } from '@/pages/staff/my-documents-page'
import { useSession } from '@/store/session'

/** The documents the clinic keeps for the signed-in employee (0116): their own, read only. */
export const Route = createFileRoute('/app/my-documents')({
  component: MyDocumentsRoute,
})

function MyDocumentsRoute() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <MyDocumentsPage user={user} />
}

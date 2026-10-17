import { createFileRoute } from '@tanstack/react-router'
import { RegisterPage } from '@/pages/register/register-page'
import { useSession } from '@/store/session'

/** Patient registration and visit start: every station may use it (emergency path included). */
export const Route = createFileRoute('/app/register')({
  component: RegisterRoute,
})

function RegisterRoute() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <RegisterPage user={user} />
}

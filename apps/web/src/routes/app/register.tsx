import { createFileRoute, redirect } from '@tanstack/react-router'
import { RegisterPage } from '@/pages/register/register-page'
import { menuAllows } from '@/lib/nav'
import { useSession } from '@/store/session'

/** Patient registration and visit start: every station may use it (emergency path included). */
export const Route = createFileRoute('/app/register')({
  // only for people whose menu offers it (role, desks, switches); otherwise back home
  beforeLoad: async () => {
    const user = useSession.getState().user
    if (!user || !(await menuAllows(user, '/app/register'))) throw redirect({ to: '/app' })
  },
  component: RegisterRoute,
})

function RegisterRoute() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <RegisterPage user={user} />
}

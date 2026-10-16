import { useEffect } from 'react'
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { usePrefs } from '@/store/prefs'
import { useSession } from '@/store/session'

/**
 * Staff area: requires a signed-in user; an employee who still holds a handed-over PIN is sent
 * to the PIN change screen first; applies the light/dim theme while mounted.
 */
export const Route = createFileRoute('/app')({
  beforeLoad: ({ location }) => {
    const user = useSession.getState().user
    if (!user) throw redirect({ to: '/', hash: 'signin' })
    if (user.mustChangePin && location.pathname !== '/app/change-pin') {
      throw redirect({ to: '/app/change-pin' })
    }
  },
  component: StaffLayout,
})

function StaffLayout() {
  const theme = usePrefs((s) => s.theme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    return () => {
      delete document.documentElement.dataset.theme
    }
  }, [theme])
  return <Outlet />
}

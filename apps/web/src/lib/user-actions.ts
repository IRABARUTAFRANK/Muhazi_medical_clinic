import { useNavigate } from '@tanstack/react-router'
import type { StaffUser } from '@mmc/shared'
import { homeRouteFor } from '@/lib/roles'
import { usePrefs } from '@/store/prefs'
import { useSession } from '@/store/session'

/** Actions shared by the PC user dropdown and the tablet "More" sheet. */
export function useUserActions() {
  const navigate = useNavigate()
  const switchTo = useSession((s) => s.switchTo)
  const signOut = useSession((s) => s.signOut)
  const theme = usePrefs((s) => s.theme)
  const toggleTheme = usePrefs((s) => s.toggleTheme)
  return {
    theme,
    toggleTheme,
    switchUser: async (u: StaffUser) => {
      const result = await switchTo(u.id)
      if (result === 'switched') void navigate({ to: homeRouteFor(u) })
      else void navigate({ to: '/', hash: 'signin' })
    },
    signOut: async () => {
      await signOut()
      void navigate({ to: '/' })
    },
  }
}

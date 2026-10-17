import { useNavigate } from '@tanstack/react-router'
import { usePrefs } from '@/store/prefs'
import { useSession } from '@/store/session'

/**
 * Actions shared by the PC user dropdown and the tablet "More" sheet. No user switching: every
 * record is attributed to the signed-in employee, so the next person signs in themselves.
 */
export function useUserActions() {
  const navigate = useNavigate()
  const signOut = useSession((s) => s.signOut)
  const theme = usePrefs((s) => s.theme)
  const toggleTheme = usePrefs((s) => s.toggleTheme)
  return {
    theme,
    toggleTheme,
    signOut: async () => {
      await signOut()
      void navigate({ to: '/' })
    },
  }
}

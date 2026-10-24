import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useConfirm } from '@/lib/confirm'
import { usePrefs } from '@/store/prefs'
import { useSession } from '@/store/session'

/**
 * Actions shared by the PC user dropdown and the tablet "More" sheet. No user switching: every
 * record is attributed to the signed-in employee, so the next person signs in themselves.
 */
export function useUserActions() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const confirm = useConfirm()
  const signOut = useSession((s) => s.signOut)
  const theme = usePrefs((s) => s.theme)
  const toggleTheme = usePrefs((s) => s.toggleTheme)
  return {
    theme,
    toggleTheme,
    /** Signs out and ends this browser's trust: the next sign-in needs a new e-mailed code. */
    signOut: async () => {
      const ok = await confirm({
        title: t('confirm.signOut.title'),
        body: t('confirm.signOut.body'),
        confirmLabel: t('confirm.signOut.yes'),
      })
      if (!ok) return
      await signOut('signedOut')
      void navigate({ to: '/' })
    },
    /** Away from the desk: the screen locks now; the PIN opens it again until the hours without
     *  activity have passed (then the tab signs out). */
    lock: () => useSession.getState().lock(),
    changePin: () => void navigate({ to: '/app/change-pin' }),
  }
}

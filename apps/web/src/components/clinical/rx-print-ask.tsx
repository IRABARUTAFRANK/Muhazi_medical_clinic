import { useTranslation } from 'react-i18next'
import { useConfirm } from '@/lib/confirm'
import { RegistrationTick } from './rx-registration-tick'

/**
 * 0204 · Before a prescription is printed (Frank: "when I print it, ask me whether to include
 * it"): "Print the prescription?" with one box, unticked, to put the prescriber's registration no.
 * on it. Answers whether to print, and whether to include it.
 */
export function useAskRxPrint() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  return async (): Promise<{ ok: boolean; showRegistration: boolean }> => {
    const choice = { showRegistration: false }
    const ok = await confirm({
      title: t('rxDoc.printAsk.title'),
      body: <RegistrationTick onChange={(v) => (choice.showRegistration = v)} />,
      confirmLabel: t('rxDoc.printAsk.yes'),
    })
    return { ok, showRegistration: ok && choice.showRegistration }
  }
}

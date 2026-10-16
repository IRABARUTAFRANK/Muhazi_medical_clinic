import { useTranslation } from 'react-i18next'
import { LANGS } from '@mmc/shared'
import { Seg } from '@/components/ui/seg'
import { usePrefs } from '@/store/prefs'

const options = LANGS.map((l) => ({ value: l.code, label: l.label }))

/** KIN / EN / FR switch, present on every public and staff screen. */
export function LangSwitch({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const { t } = useTranslation()
  const lang = usePrefs((s) => s.lang)
  const setLang = usePrefs((s) => s.setLang)
  return (
    <Seg options={options} value={lang} onChange={setLang} label={t('lang.label')} size={size} />
  )
}

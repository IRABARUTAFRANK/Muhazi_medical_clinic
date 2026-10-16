import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { resources } from '@mmc/shared/i18n'
import { usePrefs } from './store/prefs'

void i18n.use(initReactI18next).init({
  resources,
  lng: usePrefs.getState().lang,
  fallbackLng: 'en',
  supportedLngs: ['rw', 'en', 'fr'],
  interpolation: { escapeValue: false },
  returnNull: false,
})

const applyLang = (lang: string) => {
  document.documentElement.lang = lang
}
applyLang(i18n.language)

usePrefs.subscribe((state, previous) => {
  if (state.lang !== previous.lang) {
    void i18n.changeLanguage(state.lang)
    applyLang(state.lang)
  }
})

export default i18n

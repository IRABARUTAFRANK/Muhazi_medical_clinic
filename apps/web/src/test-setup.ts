// Vitest: the tests use the i18n instance (`i18n.t`, `changeLanguage`) without the page's start-up,
// which loads one language at a time (0146). Here every language is loaded at once, synchronously.
import i18n, { type Resource } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { resources } from '@mmc/shared/i18n'

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources: resources as unknown as Resource,
    lng: 'en',
    fallbackLng: 'en',
    supportedLngs: ['rw', 'en', 'fr'],
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
  })
}

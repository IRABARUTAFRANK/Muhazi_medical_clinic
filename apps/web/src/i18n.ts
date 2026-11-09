import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { usePrefs } from './store/prefs'

/*
 * UI strings: English is the source of truth; French and Kinyarwanda are complete (i18n:check
 * keeps the three files at the same keys). Only the language in use is loaded (each file is
 * about half a megabyte): the page starts with one, the others come when someone switches.
 */
type Lang = 'rw' | 'en' | 'fr'
const LOADERS: Record<Lang, () => Promise<{ default: Record<string, unknown> }>> = {
  en: () => import('@mmc/shared/i18n/en.json'),
  fr: () => import('@mmc/shared/i18n/fr.json'),
  rw: () => import('@mmc/shared/i18n/rw.json'),
}
const asLang = (l: string): Lang => (l === 'rw' || l === 'fr' ? l : 'en')

const loading = new Map<Lang, Promise<void>>()
/** The language's strings, loaded once. */
function ensureLang(l: Lang): Promise<void> {
  if (i18n.hasResourceBundle(l, 'translation')) return Promise.resolve()
  let p = loading.get(l)
  if (!p) {
    p = LOADERS[l]().then((m) => {
      i18n.addResourceBundle(l, 'translation', m.default, true, true)
    })
    loading.set(l, p)
  }
  return p
}

const applyLang = (lang: string) => {
  document.documentElement.lang = lang
}

/** Starts i18n with the chosen language's strings; the page renders after this. */
export async function initI18n(): Promise<void> {
  const lang = asLang(usePrefs.getState().lang)
  const first = (await LOADERS[lang]()).default
  await i18n.use(initReactI18next).init({
    resources: { [lang]: { translation: first } },
    lng: lang,
    fallbackLng: 'en',
    supportedLngs: ['rw', 'en', 'fr'],
    interpolation: { escapeValue: false },
    returnNull: false,
  })
  applyLang(lang)
  // English is the fallback for a key missing elsewhere: fetched quietly after the first paint
  if (lang !== 'en') void ensureLang('en')
}

usePrefs.subscribe((state, previous) => {
  if (state.lang !== previous.lang) {
    const l = asLang(state.lang)
    void ensureLang(l).then(() => i18n.changeLanguage(l))
    applyLang(l)
  }
})

export default i18n

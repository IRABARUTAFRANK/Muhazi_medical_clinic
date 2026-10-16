import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Lang, Theme } from '@mmc/shared'

interface PrefsState {
  lang: Lang
  theme: Theme
  setLang: (lang: Lang) => void
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

/** Per-device preferences: interface language and light/dim theme. */
export const usePrefs = create<PrefsState>()(
  persist(
    (set, get) => ({
      lang: 'en',
      theme: 'light',
      setLang: (lang) => set({ lang }),
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set({ theme: get().theme === 'light' ? 'dim' : 'light' }),
    }),
    { name: 'mmc.prefs' },
  ),
)

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Lang, Theme } from '@mmc/shared'

/** Size of everything on the staff screens (text, icons, spacing scale together). */
export type TextSize = 'normal' | 'large' | 'xlarge'
export const TEXT_ZOOM: Record<TextSize, number> = { normal: 1, large: 1.1, xlarge: 1.2 }

interface PrefsState {
  lang: Lang
  theme: Theme
  textSize: TextSize
  setTextSize: (size: TextSize) => void
  setLang: (lang: Lang) => void
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

/** Per-device preferences: interface language, light/dim theme and text size. */
export const usePrefs = create<PrefsState>()(
  persist(
    (set, get) => ({
      lang: 'en',
      theme: 'light',
      // "Large" by default: the screens are read at arm's length on shared clinic PCs.
      textSize: 'large',
      setTextSize: (textSize) => set({ textSize }),
      setLang: (lang) => set({ lang }),
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set({ theme: get().theme === 'light' ? 'dim' : 'light' }),
    }),
    { name: 'mmc.prefs' },
  ),
)

import { useEffect } from 'react'
import type { Lang, Theme } from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import { type TextSize, usePrefs } from '@/store/prefs'

/**
 * Preferences follow the person (migration 0031): text size, theme and language are saved on the
 * profile. When a staff screen opens they are loaded once per signed-in person (so every device
 * looks the same), and every later change is saved back.
 */
let loadedFor: string | null = null

const SIZES: TextSize[] = ['normal', 'large', 'xlarge']
const THEMES: Theme[] = ['light', 'dim']
const LANGS: Lang[] = ['rw', 'en', 'fr']

export function usePrefsSync(userId: string) {
  useEffect(() => {
    if (!supabase || loadedFor === userId) return
    let cancelled = false
    void (async () => {
      const { data } = await supabase.rpc('my_prefs')
      if (cancelled) return
      const p = (data ?? {}) as { textSize?: TextSize; theme?: Theme; lang?: Lang }
      const s = usePrefs.getState()
      if (p.textSize && SIZES.includes(p.textSize) && p.textSize !== s.textSize)
        s.setTextSize(p.textSize)
      if (p.theme && THEMES.includes(p.theme) && p.theme !== s.theme) s.setTheme(p.theme)
      if (p.lang && LANGS.includes(p.lang) && p.lang !== s.lang) s.setLang(p.lang)
      loadedFor = userId
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  useEffect(
    () =>
      usePrefs.subscribe((s, prev) => {
        if (!supabase || loadedFor !== userId) return
        if (s.textSize === prev.textSize && s.theme === prev.theme && s.lang === prev.lang) return
        void supabase.rpc('save_my_prefs', {
          p_prefs: { textSize: s.textSize, theme: s.theme, lang: s.lang },
        })
      }),
    [userId],
  )
}

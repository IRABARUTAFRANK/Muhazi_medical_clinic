import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/**
 * A desktop monitor shows more pixels than a laptop or a tablet, so the same 14 px text looks
 * small and the page floats in empty space. The staff screen scales up a step on a wide screen
 * (1,280 px and more) and another on a very wide one (1,700 px and more); the person's own text
 * size (Settings › Display) multiplies it. The public site does the same in CSS (.theme-public).
 */
export function useScreenScale(): number {
  const wide = useMediaQuery('(min-width: 1280px)')
  const veryWide = useMediaQuery('(min-width: 1700px)')
  return veryWide ? 1.15 : wide ? 1.08 : 1
}

/** PC layout from 901 px (left rail); tablet layout below (bottom bar). */
export const useIsPc = (): boolean => useMediaQuery('(min-width: 901px)')

/** Localised weekday names from the translation files. */
export function useDayNames(): { short: string[]; long: string[] } {
  const { t } = useTranslation()
  return {
    short: t('days.short', { returnObjects: true }) as string[],
    long: t('days.long', { returnObjects: true }) as string[],
  }
}

/** The current time in ms, refreshed every `everyMs` (for "waiting 12 min" labels). */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs)
    return () => window.clearInterval(id)
  }, [everyMs])
  return now
}

/**
 * Something that opens after an action (the "Where does the patient go?" step, a form, a
 * message) may open far from the button pressed: bring it into view when it appears and,
 * with `focus`, put the cursor in its first field (the chosen option first). `block: 'nearest'`
 * moves the page only when it is out of view. Smooth unless the person asks for less motion.
 */
export function useReveal<T extends HTMLElement>({
  focus = false,
  block = 'start',
}: { focus?: boolean; block?: ScrollLogicalPosition } = {}) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block })
    if (focus) {
      const target =
        el.querySelector<HTMLElement>('input[type=radio]:checked') ??
        el.querySelector<HTMLElement>(
          'input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not([disabled]), select:not([disabled]), textarea:not([disabled])',
        )
      target?.focus({ preventScroll: true })
    }
    // once, when it appears
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return ref
}

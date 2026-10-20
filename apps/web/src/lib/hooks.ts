import { useEffect, useState, useSyncExternalStore } from 'react'
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

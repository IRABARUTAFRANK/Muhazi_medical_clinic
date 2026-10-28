import type { NavItem } from '@mmc/shared'
import { useMediaQuery } from '@/lib/hooks'

/** How many items fit in the bottom bar: 3 on small phones (under 480 px the labels would be cut
 *  to a few letters), 4 on phones, 6 on small tablets, 7 from 820 px, 8 from 880 px. */
export function useBarCount(): number {
  const narrow = !useMediaQuery('(min-width: 480px)')
  const phone = !useMediaQuery('(min-width: 560px)')
  const small = !useMediaQuery('(min-width: 820px)')
  const mid = !useMediaQuery('(min-width: 880px)')
  return narrow ? 3 : phone ? 4 : small ? 6 : mid ? 7 : 8
}

/** Items shown in the bar; when the active one would be hidden it takes the last place. */
export function splitNav(nav: NavItem[], count: number, activeId?: string) {
  if (nav.length <= count + 1) return { shown: nav, rest: [] as NavItem[] }
  const shown = nav.slice(0, count)
  const active = nav.find((n) => n.id === activeId)
  if (active && !shown.includes(active)) shown[count - 1] = active
  return { shown, rest: nav.filter((n) => !shown.includes(n)) }
}

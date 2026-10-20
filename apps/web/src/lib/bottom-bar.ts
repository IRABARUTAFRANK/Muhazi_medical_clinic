import type { NavItem } from '@mmc/shared'
import { useMediaQuery } from '@/lib/hooks'

/** How many items fit in the bottom bar: 4 on phones, 6 on small tablets, 8 on wide ones. */
export function useBarCount(): number {
  const phone = !useMediaQuery('(min-width: 560px)')
  const small = !useMediaQuery('(min-width: 820px)')
  return phone ? 4 : small ? 6 : 8
}

/** Items shown in the bar; when the active one would be hidden it takes the last place. */
export function splitNav(nav: NavItem[], count: number, activeId?: string) {
  if (nav.length <= count + 1) return { shown: nav, rest: [] as NavItem[] }
  const shown = nav.slice(0, count)
  const active = nav.find((n) => n.id === activeId)
  if (active && !shown.includes(active)) shown[count - 1] = active
  return { shown, rest: nav.filter((n) => !shown.includes(n)) }
}

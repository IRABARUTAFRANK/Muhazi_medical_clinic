import i18next from 'i18next'
import type { NavItem } from '@mmc/shared'
import { ACCOUNTS_TABS } from '@/pages/finance/accounts-tabs'
import { NAV_GROUPS, navGroupOf } from '@/lib/nav'

/**
 * 0213: the pages and features of the menu the search bar suggests: every page the person may
 * open, and the tabs of Finance and Stock, matched in the screen's language and in English (a
 * word typed in English finds the page when the screen is in Kinyarwanda or French).
 */
export interface PageHit {
  key: string
  navId: string
  icon: string
  label: string
  /** Where it sits: the menu's group, or the page of a tab. */
  where: string
  to: string
  search?: Record<string, string>
}

type T = (key: string, opts?: Record<string, unknown>) => string

// the first tab ('stock') is the page itself
const STOCK_TAB_IDS = ['prescriptions', 'walkin', 'add', 'rooms', 'reports'] as const

/** Lowercase without accents ("Kinésithérapie" → "kinesitherapie"). */
export const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/** All the pages and tabs of this person's menu, with their words in two languages. */
export function pagesOf(nav: NavItem[], t: T): (PageHit & { words: string })[] {
  const en = i18next.getFixedT('en') as unknown as T
  const groupLabel = (id: string) => {
    const g = NAV_GROUPS.find((x) => x.id === navGroupOf(id))
    return g ? t(g.labelKey) : ''
  }
  const out: (PageHit & { words: string })[] = []
  for (const n of nav) {
    const label = t(n.labelKey)
    out.push({
      key: `page:${n.id}`,
      navId: n.id,
      icon: n.icon,
      label,
      where: groupLabel(n.id),
      to: n.to,
      words: fold([label, en(n.labelKey), n.id].join(' ')),
    })
    if (n.to === '/app/finance')
      for (const tab of ACCOUNTS_TABS) {
        const k = `accounts.tabs.${tab}`
        out.push({
          key: `finance:${tab}`,
          navId: n.id,
          icon: n.icon,
          label: t(k),
          where: label,
          to: n.to,
          search: { tab },
          words: fold([t(k), en(k), tab].join(' ')),
        })
      }
    if (n.to === '/app/stock')
      for (const tab of STOCK_TAB_IDS) {
        const k = `stock.tabs.${tab}`
        out.push({
          key: `stock:${tab}`,
          navId: n.id,
          icon: n.icon,
          label: t(k),
          where: label,
          to: n.to,
          search: { tab },
          words: fold([t(k), en(k), tab].join(' ')),
        })
      }
  }
  // a page shown twice in a menu (a shortcut) once only
  const seen = new Set<string>()
  return out.filter((p) => {
    const k = `${p.to}?${p.search?.tab ?? ''}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** The pages and tabs whose words hold every word typed, those that start with it first. */
export function matchPages(pages: (PageHit & { words: string })[], q: string, max = 5): PageHit[] {
  const words = fold(q).split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return pages
    .filter((p) => words.every((w) => p.words.includes(w)))
    .map((p) => ({
      p,
      score:
        (fold(p.label).startsWith(words[0]!) ? 0 : 2) +
        (p.words.split(/\s+/).some((w) => w.startsWith(words[0]!)) ? 0 : 1),
    }))
    .sort((a, b) => a.score - b.score)
    .slice(0, max)
    .map(({ p }) => ({
      key: p.key,
      navId: p.navId,
      icon: p.icon,
      label: p.label,
      where: p.where,
      to: p.to,
      search: p.search,
    }))
}

import { Ellipsis } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { NavItem } from '@mmc/shared'
import { splitNav, useBarCount } from '@/lib/bottom-bar'
import { countText, navCountOf, navLinkLabel, useNavCounts } from '@/lib/api/nav-counts'
import { useNotifications } from '@/lib/api/notifications'
import { cn } from '@/lib/utils'
import { StaffLink } from './staff-link'
import { NavIcon } from './nav-icon'

interface TabletNavProps {
  nav: NavItem[]
  activeId?: string
  onMore: () => void
}

/**
 * A one-word label longer than its tab (Imbonerahamwe on a 360 px phone) would be broken at any
 * letter. Kinyarwanda syllables end with a vowel, so a long word gets a soft hyphen after each
 * vowel that a consonant follows (not in its first two or last three letters): the browser then
 * breaks it at a syllable, with a hyphen (Imbonera-hamwe). English and French use the browser's
 * own hyphenation (hyphens-auto on the label).
 */
const softBreaks = (label: string, lang: string): string =>
  lang.startsWith('rw')
    ? label.replace(/\p{L}{10,}/gu, (word) =>
        word.replace(/[aeiou](?=[^aeiou])/gi, (v: string, at: number) =>
          at >= 2 && at < word.length - 3 ? v + '\u00AD' : v,
        ),
      )
    : label

const tab =
  'flex min-h-13 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md border-0 bg-transparent px-0 min-[400px]:px-1 text-[11px] min-[400px]:text-[12px] font-medium text-ink-2 no-underline transition-colors duration-120 hover:bg-hover hover:text-ink'

/** Tablet bottom bar: white with a 1 px top border, the same ≤ 5 items plus "More". Each entry
 *  carries its count on the icon (0121); "More" carries what waits for the person inside it (the
 *  unread notices and the red counts of the entries that did not fit), added up. */
export function TabletNav({ nav, activeId, onMore }: TabletNavProps) {
  const { t, i18n } = useTranslation()
  const { shown, rest } = splitNav(nav, useBarCount(), activeId)
  const moreActive = rest.some((n) => n.id === activeId)
  const { data: counts } = useNavCounts()
  const waitingInside = rest.reduce((sum, n) => {
    const c = navCountOf(n, counts)
    // today's only (0122): what is left from earlier days is shown on the entry itself
    return c?.urgent ? sum + c.n : sum
  }, 0)
  const { data: notices } = useNotifications()
  const unreadInside = rest.some((n) => n.id === 'notifications') ? (notices?.unread ?? 0) : 0
  const moreTotal = waitingInside + unreadInside
  return (
    <nav
      aria-label={t('common.mainNav')}
      className="border-border bg-card pc:hidden flex flex-none gap-0.5 border-t px-1 py-1 pb-[max(4px,env(safe-area-inset-bottom))] min-[400px]:gap-1 min-[400px]:px-2"
    >
      {shown.map((n) => {
        const active = n.id === activeId
        const count = navCountOf(n, counts)
        return (
          <StaffLink
            key={n.id}
            to={n.to}
            aria-current={active ? 'page' : undefined}
            aria-label={navLinkLabel(t, t(n.labelKey), count)}
            className={cn(tab, active && 'bg-primary-tint text-primary')}
          >
            <NavIcon id={n.id} name={n.icon} size={20} count={count} />
            {/* a two-word label (My prescriptions) wraps onto a second line; a word longer than the
                tab (a very narrow phone) breaks at a syllable, with a hyphen (softBreaks) */}
            <span className="line-clamp-2 max-w-full text-center leading-[1.15] [text-wrap:balance] wrap-break-word hyphens-auto">
              {softBreaks(t(n.labelKey), i18n.language)}
            </span>
          </StaffLink>
        )
      })}
      <button
        type="button"
        className={cn(tab, moreActive && 'bg-primary-tint text-primary')}
        onClick={onMore}
        aria-label={
          moreTotal > 0
            ? `${t('common.more')}, ${t('navCount.waiting', { count: moreTotal })}`
            : undefined
        }
      >
        <span className="relative inline-flex">
          <Ellipsis size={20} aria-hidden="true" />
          {/* what waits inside More, added up: unread notices + My queue, results… (red) */}
          {moreTotal > 0 && (
            <span
              aria-hidden="true"
              className="bg-red-dot ring-card absolute -top-1.5 -right-2 inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-semibold text-white tabular-nums ring-2"
            >
              {countText(moreTotal)}
            </span>
          )}
        </span>
        {t('common.more')}
      </button>
    </nav>
  )
}

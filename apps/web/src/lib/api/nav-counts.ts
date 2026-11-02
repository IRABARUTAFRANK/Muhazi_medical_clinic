import { useQuery } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import type { NavItem, StaffUser } from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { apiError, isMissingFunction } from './errors'

/**
 * The counts on the menu (migration 0121, nav_counts): "My queue 2", "My bookings 4", like the
 * red count on Notifications. Plain counts of the signed-in person, no names; only the keys that
 * apply to the person come back, and each menu entry shows its own (NavItem.countKey).
 *
 * The counts are for the day (0122, Kigali): the badge counts today's work only; what is still
 * open from an earlier day comes as "<key>Earlier" and is shown apart ("From earlier days").
 */
export const NAV_COUNT_KEYS = [
  'queue',
  'inClinic',
  'results',
  'prescriptions',
  'myBookings',
  'bookings',
  'worklist',
  'pharmacy',
  'stock',
  'bills',
  'payments',
  'recordAccess',
  'documents',
  'filesToComplete',
] as const
export type NavCountKey = (typeof NAV_COUNT_KEYS)[number]
export type NavCounts = Partial<Record<NavCountKey, number>> & {
  /** Still open from an earlier day (0122): shown apart, never in the badge. */
  earlier?: Partial<Record<NavCountKey, number>>
}

/** Things waiting for ME (red, like Notifications); the others are information (neutral). */
const WAITING_FOR_ME: ReadonlySet<NavCountKey> = new Set<NavCountKey>([
  'queue',
  'results',
  'worklist',
  'pharmacy',
  'stock',
  'payments',
  'recordAccess',
])
export const isWaitingForMe = (key: NavCountKey): boolean => WAITING_FOR_ME.has(key)

export const isNavCountKey = (key: string | undefined): key is NavCountKey =>
  !!key && (NAV_COUNT_KEYS as readonly string[]).includes(key)

/** "99+" past 99. */
export const countText = (n: number): string => (n > 99 ? '99+' : String(n))

/** One entry's count: how many, and whether it waits for the person (red) or informs (neutral). */
export interface NavCount {
  key: NavCountKey
  /** Today's (the badge). */
  n: number
  urgent: boolean
  /** Still open from an earlier day (0122), when there is any. */
  earlier?: number
}

/** The count of a menu entry, when there is one to show (today's, or some from earlier days). */
export function navCountOf(item: NavItem, counts: NavCounts | undefined): NavCount | null {
  const key = item.countKey
  if (!isNavCountKey(key)) return null
  const n = counts?.[key] ?? 0
  const earlier = counts?.earlier?.[key] ?? 0
  if (n <= 0 && earlier <= 0) return null
  return earlier > 0
    ? { key, n, urgent: isWaitingForMe(key), earlier }
    : { key, n, urgent: isWaitingForMe(key) }
}

/** What a screen reader hears for the entry: "My queue, 2 waiting". */
export const navLinkLabel = (
  t: TFunction,
  label: string,
  count: NavCount | null,
): string | undefined =>
  count
    ? [
        label,
        count.n > 0 ? t(`navCount.${count.key}`, { count: count.n }) : null,
        count.earlier ? t('daily.earlierShort', { count: count.earlier }) : null,
      ]
        .filter(Boolean)
        .join(', ')
    : undefined

/** Sample mode: a few counts by role, so the menu looks as it will live. */
export function sampleNavCounts(user: Pick<StaffUser, 'role'>): NavCounts {
  switch (user.role) {
    case 'doctor':
      return {
        queue: 2,
        inClinic: 3,
        results: 1,
        prescriptions: 2,
        myBookings: 4,
        earlier: { queue: 1, inClinic: 1 },
      }
    case 'nurse':
      return { queue: 3, inClinic: 4, myBookings: 1 }
    case 'receptionist':
      return { inClinic: 9, bookings: 4, filesToComplete: 2 }
    case 'cashier':
      return { bills: 5, payments: 1 }
    case 'pharmacist':
      return { pharmacy: 2 }
    case 'lab_tech':
      return { worklist: 4 }
    case 'manager':
      return {
        inClinic: 9,
        bookings: 4,
        myBookings: 1,
        bills: 5,
        recordAccess: 1,
        documents: 2,
        earlier: { inClinic: 2, bills: 1 },
      }
    default:
      return {}
  }
}

/** Keep the numbers only (the database gives nothing else; a newer one may add keys); the
 *  "<key>Earlier" ones (0122) go under `earlier`. */
export const clean = (data: unknown): NavCounts => {
  const out: NavCounts = {}
  const earlier: Partial<Record<NavCountKey, number>> = {}
  if (data && typeof data === 'object')
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      const base = k.endsWith('Earlier') ? k.slice(0, -'Earlier'.length) : null
      if (base !== null && isNavCountKey(base)) {
        if (v > 0) earlier[base] = v
      } else if (isNavCountKey(k)) out[k] = v
    }
  if (Object.keys(earlier).length > 0) out.earlier = earlier
  return out
}

/** The person's counts, read again every 20 seconds and when the window comes back to the front.
 *  A database before 0121: no counts (the menu shows none). */
export function useNavCounts() {
  const user = useSession((s) => s.user)
  return useQuery({
    queryKey: ['nav-counts', user?.id ?? null],
    enabled: !!user,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
    queryFn: async (): Promise<NavCounts> => {
      if (!supabase) return user ? sampleNavCounts(user) : {}
      const { data, error } = await supabase.rpc('nav_counts')
      if (error) {
        if (isMissingFunction(error)) return {}
        throw apiError(error)
      }
      return clean(data)
    },
  })
}

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
export type NavCounts = Partial<Record<NavCountKey, number>>

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
  n: number
  urgent: boolean
}

/** The count of a menu entry, when there is one to show (more than zero). */
export function navCountOf(item: NavItem, counts: NavCounts | undefined): NavCount | null {
  const key = item.countKey
  if (!isNavCountKey(key)) return null
  const n = counts?.[key] ?? 0
  return n > 0 ? { key, n, urgent: isWaitingForMe(key) } : null
}

/** What a screen reader hears for the entry: "My queue, 2 waiting". */
export const navLinkLabel = (
  t: TFunction,
  label: string,
  count: NavCount | null,
): string | undefined =>
  count ? `${label}, ${t(`navCount.${count.key}`, { count: count.n })}` : undefined

/** Sample mode: a few counts by role, so the menu looks as it will live. */
export function sampleNavCounts(user: Pick<StaffUser, 'role'>): NavCounts {
  switch (user.role) {
    case 'doctor':
      return { queue: 2, inClinic: 3, results: 1, prescriptions: 2, myBookings: 4 }
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
      return { inClinic: 9, bookings: 4, myBookings: 1, bills: 5, recordAccess: 1, documents: 2 }
    default:
      return {}
  }
}

/** Keep the numbers only (the database gives nothing else; a newer one may add keys). */
const clean = (data: unknown): NavCounts => {
  const out: NavCounts = {}
  if (data && typeof data === 'object')
    for (const [k, v] of Object.entries(data as Record<string, unknown>))
      if (isNavCountKey(k) && typeof v === 'number' && Number.isFinite(v)) out[k] = v
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

import type { ClinicProfile, StaffUser } from '@mmc/shared'
import type { AnalyticsAccess } from '@/lib/api/analytics'
import type { Period } from '@/lib/period'
import type { AnalyticsSearch, UpdateSearch } from './search'

/** What every view of the Analytics page receives. */
export interface ViewProps {
  user: StaffUser
  access: AnalyticsAccess
  period: Period
  search: AnalyticsSearch
  update: UpdateSearch
  /** The department the figures are limited to (null: the whole clinic, for the manager). */
  dept: string | null
  /** For the reports' letterhead. */
  clinic: ClinicProfile | null
}

/** A view's breakdown key from the address, or the default. */
export const pickBy = <T extends string>(
  by: string | undefined,
  all: readonly T[],
  fallback: T,
): T => (by && (all as readonly string[]).includes(by) ? (by as T) : fallback)

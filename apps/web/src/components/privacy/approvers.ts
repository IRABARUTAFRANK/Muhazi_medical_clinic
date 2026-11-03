import type { StaffUser } from '@mmc/shared'
import type { Feature } from '@/lib/api/permissions'
import { isDoctorUser } from '@/lib/roles'

/** The manager reviews the emergency accesses and reads the whole access log. */
export const isManagerUser = (user: StaffUser): boolean =>
  user.role === 'manager' || user.dashboard === 'manager'

/** Who answers requests to see past records (0088 → 0095): the manager, and whoever the manager
 *  allowed to in Settings → Who may do what ("Answer record-access requests", for a role or as an
 *  exception for one person). A head of department no longer answers by position. `may` is the
 *  person's switches (permsNow / permsReady / useCan). 0126: an approver is a doctor. */
export const isApprover = (user: StaffUser, may: ReadonlySet<Feature>): boolean =>
  isDoctorUser(user) && (isManagerUser(user) || may.has('records.approve'))

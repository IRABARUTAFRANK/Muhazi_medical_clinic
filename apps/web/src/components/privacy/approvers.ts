import type { StaffUser } from '@mmc/shared'

/** Who answers requests to see past records (0088): the manager, and the heads of a department
 *  (headOf is set for heads only, not for assistants). The database decides per patient (the
 *  heads of the departments in charge of the patient). */
export const isApprover = (user: StaffUser): boolean =>
  user.role === 'manager' || user.dashboard === 'manager' || !!user.headOf

/** The manager reviews the emergency accesses and reads the whole access log. */
export const isManagerUser = (user: StaffUser): boolean =>
  user.role === 'manager' || user.dashboard === 'manager'

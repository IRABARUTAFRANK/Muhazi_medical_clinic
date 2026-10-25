import type { StaffUser } from '@mmc/shared'
import { useCanDesk } from '@/lib/api/desks'
import { useSession } from '@/store/session'

/** Nobody signed in (never inside the staff pages): no desk at all. */
const NOBODY: StaffUser = { id: 'nobody', username: '', name: '', role: 'cashier' }

/**
 * canDesk('pharmacy') for the signed-in person, for the parts that are not handed the user
 * (a test row, the pharmacy hand-over). While the desks load: today's rule of the role.
 */
export function useSessionCanDesk() {
  const user = useSession((s) => s.user)
  return useCanDesk(user ?? NOBODY)
}

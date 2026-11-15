import type { StaffUser } from '@mmc/shared'
import { AFTER_SIGN_IN } from '@/lib/api/display'
import { homeRouteFor } from '@/lib/roles'

/** Where a sign-in started from the waiting-room screen comes back to (0158): asked once. */
export const setAfterSignIn = (path: string) => {
  try {
    sessionStorage.setItem(AFTER_SIGN_IN, path)
  } catch {
    /* no storage: the person lands on their home */
  }
}
export const takeAfterSignIn = (user: StaffUser): string => {
  let path = ''
  try {
    path = sessionStorage.getItem(AFTER_SIGN_IN) ?? ''
    sessionStorage.removeItem(AFTER_SIGN_IN)
  } catch {
    /* none kept */
  }
  return /^\/app\/[\w-]+$/.test(path) ? path : homeRouteFor(user)
}

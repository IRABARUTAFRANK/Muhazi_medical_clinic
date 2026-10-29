import { useMemo } from 'react'
import type { StaffUser } from '@mmc/shared'
import { useSessionCanDesk } from '@/components/clinical/session-desks'
import { DESKS, type DeskId } from '@/lib/api/desks'
import { MANAGED_FEATURES, useCan, type Feature } from '@/lib/api/permissions'
import { useMyStores } from '@/lib/api/rooms'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import type { ReportContext } from './defs/types'

/**
 * Who asks for a report: built once from the session by the report centre (and by the menu,
 * from the same answers read during render). Each report's `allowed` reads it; its database
 * function checks the same rights again, so a report never shows more than the screens do.
 */

/** Roles that read clinical records: a doctor's own patients only is enforced by the database. */
const CLINICAL_ROLES: readonly string[] = ['doctor', 'nurse', 'lab_tech']

export function buildReportContext(
  user: StaffUser,
  parts: {
    can: (feature: string) => boolean
    canDesk: (desk: string) => boolean
    holdsStore: boolean
    sample: boolean
  },
): ReportContext {
  const isManager = user.role === 'manager' || user.dashboard === 'manager'
  const isHead = user.dashboard === 'head'
  return {
    user,
    isManager,
    isHead,
    can: parts.can,
    canDesk: parts.canDesk,
    holdsStore: parts.holdsStore,
    clinical:
      isManager || isHead || CLINICAL_ROLES.includes(user.role) || user.dbRole === 'sonographer',
    sample: parts.sample,
  }
}

/** Nobody signed in (never inside the staff pages). */
const NOBODY: StaffUser = { id: 'nobody', username: '', name: '', role: 'cashier' }

/** The signed-in person's report context (null when nobody is signed in). */
export function useReportContext(): ReportContext | null {
  const user = useSession((s) => s.user)
  const can = useCan(user ?? NOBODY)
  const canDesk = useSessionCanDesk()
  const { data: stores } = useMyStores(!!user)
  const holdsStore = (stores?.length ?? 0) > 0
  // the switches and the desks are read again in the background: follow their answers
  const switches = MANAGED_FEATURES.map((f) => can(f)).join('')
  const desks = DESKS.map((d) => canDesk(d)).join('')
  return useMemo(
    () =>
      user
        ? buildReportContext(user, {
            can: (f) => can(f as Feature),
            canDesk: (d) => canDesk(d as DeskId),
            holdsStore,
            sample: !supabase,
          })
        : null,
    // can / canDesk are new functions every render: their answers are the dependencies
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, switches, desks, holdsStore],
  )
}

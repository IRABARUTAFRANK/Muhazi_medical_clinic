import type { Role, StaffUser } from '@mmc/shared'
import { DESKS, ROLE_DESKS, TREATING_DESKS, useMyDesks, type DeskId } from '@/lib/api/desks'
import type { Feature } from '@/lib/api/permissions'
import type { DbRole } from '@/lib/api/staff'
import { DOCTOR_DESKS, extraDesks } from '@/lib/nav'

/**
 * Which home a person gets, and which blocks it shows, from their ROLE and their DESKS (0085):
 * the role picks its usual dashboard while the person works at one of its desks; someone whose
 * departments give none of them gets the dashboard of a desk they do work at; the desks their
 * departments give beyond that dashboard add blocks under it ("Your other desks"). The manager
 * and the cashier are not changed (the manager has every desk; the cashier's home is money).
 */

/** The dashboards of the home page. */
export type HomeKind = 'reception' | 'nurse' | 'doctor' | 'lab' | 'pharmacy' | 'cashier'

export const ROLE_KIND: Record<Role, HomeKind> = {
  receptionist: 'reception',
  nurse: 'nurse',
  doctor: 'doctor',
  lab_tech: 'lab',
  pharmacist: 'pharmacy',
  cashier: 'cashier',
  manager: 'doctor',
}

/** The desks a dashboard is for: the person works at one of them, or it is not their home. */
const KIND_MAIN: Record<HomeKind, readonly DeskId[]> = {
  reception: ['reception', 'triage'],
  nurse: ['triage', ...TREATING_DESKS],
  doctor: TREATING_DESKS,
  lab: ['laboratory', 'ultrasound'],
  pharmacy: ['pharmacy'],
  cashier: [],
}

/** The desks a dashboard already shows (no extra block for them). */
export const KIND_NATIVE: Record<HomeKind, readonly DeskId[]> = {
  reception: ['reception', 'triage'],
  nurse: ['reception', 'triage', ...TREATING_DESKS],
  doctor: ['reception', ...DOCTOR_DESKS, 'fp', 'hiv'],
  lab: ['laboratory', 'ultrasound'],
  pharmacy: ['pharmacy'],
  cashier: DESKS,
}

/** The desks named in "ask the manager" when the person has none of their role's desks. */
export const NOTICE_DESKS: Record<HomeKind, readonly DeskId[]> = {
  reception: ['reception'],
  nurse: ['triage', 'nursing'],
  doctor: ['consultation'],
  lab: ['laboratory', 'ultrasound'],
  pharmacy: ['pharmacy'],
  cashier: [],
}

/** Another dashboard, in this order, for someone without their role's desks. */
const OTHER_KINDS: readonly HomeKind[] = ['pharmacy', 'lab', 'nurse', 'reception']

/** The quick actions of the home toolbar and the desks they need (others: always shown). */
const ACTION_DESKS: Record<string, readonly DeskId[]> = {
  registerPatient: ['reception'],
  walkInTicket: ['reception'],
  vitals: ['triage'],
  injection: ['nursing'],
  dressing: ['nursing'],
  admit: ['nursing'],
  openNext: TREATING_DESKS,
  newPrescription: TREATING_DESKS,
  newOrder: TREATING_DESKS,
  myResults: TREATING_DESKS,
  myPrescriptions: TREATING_DESKS,
  worklist: ['laboratory', 'ultrasound'],
  stock: ['pharmacy'],
}

/** …and the manager's switch they need (Settings → Who may do what; others: none). */
const ACTION_PERMS: Record<string, Feature> = {
  registerPatient: 'visit.start',
  walkInTicket: 'visit.start',
  vitals: 'vitals.write',
  injection: 'clinical.write',
  dressing: 'clinical.write',
  admit: 'clinical.write',
  newPrescription: 'clinical.write',
  newOrder: 'orders.write',
  takePayment: 'payment.take',
  dayClose: 'payment.take',
}

const dbRoleOf = (user: StaffUser): DbRole => (user.dbRole ?? user.role) as DbRole

/**
 * The desks of the signed-in person for the home page: every desk they work at, and those a
 * department of theirs gives (the ones that add blocks). While loading: today's rule of the role.
 */
export function useHomeDesks(user: StaffUser) {
  const { data } = useMyDesks(user)
  const desks: readonly DeskId[] = data?.desks ?? ROLE_DESKS[dbRoleOf(user)] ?? []
  const has = (list: DeskId | readonly DeskId[]) =>
    typeof list === 'string' ? desks.includes(list) : list.some((d) => desks.includes(d))
  return { desks, extra: extraDesks(data), loaded: !!data, has }
}

/** The dashboard of the person, and whether they work at none of their role's desks. */
export function homeKindFor(
  role: Role,
  desks: readonly DeskId[],
): { kind: HomeKind; noDesk: boolean } {
  const own = ROLE_KIND[role]
  if (own === 'cashier' || role === 'manager') return { kind: own, noDesk: false }
  const has = (list: readonly DeskId[]) => list.some((d) => desks.includes(d))
  if (has(KIND_MAIN[own])) return { kind: own, noDesk: false }
  const other = OTHER_KINDS.find((k) => has(KIND_MAIN[k]))
  return other ? { kind: other, noDesk: false } : { kind: own, noDesk: true }
}

/** May this quick action of the home toolbar show (its desk is one of the person's, and the
 *  manager allows its work)? */
export const actionShown = (
  id: string,
  desks: readonly DeskId[],
  can: (f: Feature) => boolean = () => true,
): boolean => {
  const need = ACTION_DESKS[id]
  const perm = ACTION_PERMS[id]
  return (!need || need.some((d) => desks.includes(d))) && (!perm || can(perm))
}

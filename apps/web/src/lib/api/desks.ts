import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { StaffUser } from '@mmc/shared'
import { queryClient } from '@/lib/query-client'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { isMissingFunction, throwIf } from './errors'
import { permsReady, samplePermsOf, type Feature } from './permissions'
import { sampleStaffData, type DbRole } from './staff'

/**
 * The desks a person works at (migration 0085). The ROLE is the ceiling: what a person of that
 * role may ever use. The DEPARTMENTS a person works in decide which desks they actually get, among
 * those. When no department of the clinic gives a desk, the role alone decides it, as before.
 * The manager always has every desk. Money never comes from a desk (payment.take and the other
 * switches stay with the role); room stores ("My store") stay with their holders.
 *
 * Live: my_desks, desks_of (staff_directory.desks, my_session_profile().desks), may_use_desk,
 * role_desk_matrix, set_role_desk. A refusal at a desk: 42501 with hint 'no_desk'
 * (ApiError kind 'noDesk': "You do not work in a department that does this; ask the manager").
 * Before 0085 (PGRST202) and in sample mode: today's rule by role (ROLE_DESKS).
 */

/** Every desk, in the order the screens list them. The keys are the department services (0071)
 *  plus 'reception'. */
export const DESKS = [
  'reception',
  'triage',
  'consultation',
  'dental',
  'surgery',
  'circ',
  'nursing',
  'fp',
  'hiv',
  'laboratory',
  'ultrasound',
  'pharmacy',
] as const
export type DeskId = (typeof DESKS)[number]

/** The desks where patients are treated: the clinical record, prescribing, ordering tests. */
export const TREATING_DESKS: readonly DeskId[] = [
  'consultation',
  'dental',
  'surgery',
  'circ',
  'nursing',
  'fp',
  'hiv',
]

/** Why the person has a desk: manager, a department of theirs, kept on day one by the rule of
 *  before (until the manager places them), the role (no department gives that desk) or the doctor
 *  they cover. The manager's per-person exception only ever takes a desk away. */
export type DeskVia = 'manager' | 'department' | 'kept' | 'role' | 'cover'

export interface MyDesks {
  /** The desks the person may use now. */
  desks: DeskId[]
  via: Partial<Record<DeskId, DeskVia>>
  /** The desks some active department gives (the others follow the role). */
  offered: DeskId[]
  /** The desks the person's role may ever use. */
  ceiling: DeskId[]
  /** True when the database does not know desks yet (before 0085): computed from the role. */
  fallback: boolean
}

/** The clinic's default ceilings (role_desk as seeded by 0085; the manager changes them). */
export const DEFAULT_CEILINGS: Record<Exclude<DbRole, 'manager'>, DeskId[]> = {
  doctor: [...DESKS],
  nurse: [...DESKS],
  lab_tech: ['laboratory', 'ultrasound'],
  sonographer: ['ultrasound'],
  pharmacist: ['pharmacy'],
  receptionist: ['reception', 'triage'],
  // none of the desks (the manager may add one in Settings)
  cashier: [],
}

/** Today's rule by role (before departments decided): the safety net when no department gives a
 *  desk, and the answer before 0085. It follows the permission each desk needed: start a visit
 *  (reception), vital signs (triage), clinical record (treating desks) and handing over medicines
 *  (pharmacy); the worklists were run by the lab tech (laboratory) and the sonographer (ultrasound;
 *  also a doctor whose usual desk is the ultrasound, which the database knows). */
export const ROLE_DESKS: Record<DbRole, DeskId[]> = {
  receptionist: ['reception', 'triage'],
  cashier: [],
  nurse: ['reception', 'triage', ...TREATING_DESKS],
  doctor: ['reception', 'triage', ...TREATING_DESKS],
  sonographer: ['ultrasound'],
  lab_tech: ['laboratory'],
  pharmacist: ['pharmacy'],
  manager: [...DESKS],
}

/** The switch (Settings → Who may do what) a desk needs, as the database's desk_permission: start
 *  a visit at reception, vital signs at triage, the clinical record at the treating desks, tests and
 *  results at the worklists. The pharmacy follows handing over medicines, which is not a switch. */
export const DESK_PERMISSION: Partial<Record<DeskId, Feature>> = {
  reception: 'visit.start',
  triage: 'vitals.write',
  laboratory: 'orders.write',
  ultrasound: 'orders.write',
  consultation: 'clinical.write',
  dental: 'clinical.write',
  surgery: 'clinical.write',
  circ: 'clinical.write',
  nursing: 'clinical.write',
  fp: 'clinical.write',
  hiv: 'clinical.write',
}
/** Does the person have the switch this desk needs? */
const switchAllows = (desk: DeskId, perms: ReadonlySet<string>): boolean => {
  const f = DESK_PERMISSION[desk]
  return !f || perms.has(f)
}

export const isDesk = (s: string): s is DeskId => (DESKS as readonly string[]).includes(s)
const onlyDesks = (list: readonly string[] | null | undefined): DeskId[] =>
  DESKS.filter((d) => (list ?? []).includes(d))

/** A desk's name in the reader's language ("Laboratory worklist", "Pharmacy desk"…), for the
 *  employee form's "Can use: …" line and the settings table. */
export const deskName = (
  desk: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string => t(`desks.names.${desk}`, { defaultValue: desk })

/** "Can use: Consultation, Laboratory worklist" (nothing: "Can use: no desk"). */
export const desksText = (
  desks: readonly string[],
  t: (key: string, opts?: Record<string, unknown>) => string,
): string =>
  t('desks.canUse', {
    list: desks.length ? desks.map((d) => deskName(d, t)).join(', ') : t('desks.none'),
  })

/** The database role of a signed-in person (a sonographer is 'lab_tech' in the UI). */
const dbRoleOf = (user: Pick<StaffUser, 'role' | 'dbRole'>): DbRole =>
  (user.dbRole ?? user.role) as DbRole

/** The desk of a test: its station, else its category (imaging → ultrasound). */
export const deskOfRequest = (
  station: string | null | undefined,
  category: string | null | undefined,
): DeskId =>
  station === 'ultrasound' || station === 'laboratory'
    ? station
    : category === 'imaging'
      ? 'ultrasound'
      : 'laboratory'

/** The desks of a place where patients wait (Theatre: surgery and circumcision; Beds: nursing). */
export const STATION_DESKS: Record<string, DeskId[]> = {
  reception: ['reception'],
  triage: ['triage'],
  consultation: ['consultation'],
  dental: ['dental'],
  theatre: ['surgery', 'circ'],
  nursing: ['nursing', 'fp', 'hiv'],
  beds: ['nursing'],
  laboratory: ['laboratory'],
  ultrasound: ['ultrasound'],
  pharmacy: ['pharmacy'],
  cashier: [],
}

/** The desks a department gives with itself, whatever the role's switches: the worklists and the
 *  pharmacy (the others also need the role's switch: start a visit, vital signs, the record). */
const WORKLIST_DESKS: readonly DeskId[] = ['laboratory', 'ultrasound', 'pharmacy']

/**
 * The desks a person gets (the database's rule, for the employee form's live "Can use" line):
 * the role's ceiling ∩ (the desks of the chosen departments, or a desk kept on day one, or — for a
 * desk no department of the clinic gives — today's rule of the role). A department gives
 * reception, triage and the treating desks only with the role's switch for them (start a visit,
 * vital signs, the clinical record); the worklists and the pharmacy come with the department.
 * The manager gets every desk.
 *
 *   role        the role chosen in the form
 *   services    the services of each department chosen (department.services)
 *   ceiling     the role's ceiling (useRoleDeskMatrix().roles[role]; DEFAULT_CEILINGS while loading)
 *   offered     the desks some active department of the clinic gives (all departments' services)
 *   kept        the desks the employee kept on day one (staff_directory.kept_desks)
 *   perms       the person's own switches (sample mode); without them, today's rule of the role
 */
export function desksFor(i: {
  role: DbRole
  services: readonly (readonly string[])[]
  ceiling?: readonly string[] | null
  offered: readonly string[]
  kept?: readonly string[] | null
  perms?: ReadonlySet<string> | null
}): { desks: DeskId[]; via: Partial<Record<DeskId, 'department' | 'kept' | 'role' | 'manager'>> } {
  if (i.role === 'manager')
    return { desks: [...DESKS], via: Object.fromEntries(DESKS.map((d) => [d, 'manager'])) }
  const ceiling = new Set(i.ceiling ?? DEFAULT_CEILINGS[i.role])
  const mine = new Set(i.services.flat())
  const offered = new Set(i.offered)
  const kept = new Set(i.kept ?? [])
  const perms = i.perms
  // the switch the desk needs: the person's own when known, else today's rule of the role
  const switchOn = (d: DeskId) => (perms ? switchAllows(d, perms) : ROLE_DESKS[i.role].includes(d))
  const via: Partial<Record<DeskId, 'department' | 'kept' | 'role'>> = {}
  for (const d of DESKS) {
    if (!ceiling.has(d)) continue
    if (mine.has(d) && (WORKLIST_DESKS.includes(d) || switchOn(d))) via[d] = 'department'
    else if (kept.has(d) && (!perms || switchOn(d))) via[d] = 'kept'
    else if (!offered.has(d) && ROLE_DESKS[i.role].includes(d) && switchOn(d)) via[d] = 'role'
  }
  return { desks: DESKS.filter((d) => via[d]), via }
}

/** The services of a department that the role may not use (the form warns when nothing is left). */
export const desksOutsideCeiling = (
  role: DbRole,
  services: readonly string[],
  ceiling?: readonly string[] | null,
): DeskId[] => {
  if (role === 'manager') return []
  const c = new Set(ceiling ?? DEFAULT_CEILINGS[role])
  return onlyDesks(services).filter((d) => !c.has(d))
}

/** True when a department gives services but none the role may use (the form's warning). */
export const departmentGivesNothing = (
  role: DbRole,
  services: readonly string[],
  ceiling?: readonly string[] | null,
): boolean =>
  role !== 'manager' &&
  onlyDesks(services).length > 0 &&
  desksOutsideCeiling(role, services, ceiling).length === onlyDesks(services).length

// ---------------------------------------------------------------- sample mode (no Supabase)
const sampleCeilings: Record<string, DeskId[]> = Object.fromEntries(
  Object.entries(DEFAULT_CEILINGS).map(([r, d]) => [r, [...d]]),
)
const sampleOffered = (): DeskId[] =>
  onlyDesks(sampleStaffData().departments.flatMap((d) => d.services))
function sampleDesksOf(userId: string, role: DbRole): MyDesks {
  const { departments, employees } = sampleStaffData()
  const me = employees.find((e) => e.id === userId)
  const services = (me?.departments ?? []).map(
    (m) => departments.find((d) => d.id === m.departmentId)?.services ?? [],
  )
  const offered = sampleOffered()
  // the sample switches decide reception, triage, the treating desks and the worklists too
  const perms = samplePermsOf(userId, role)
  const r = desksFor({ role, services, ceiling: sampleCeilings[role], offered, perms })
  return {
    desks: r.desks,
    via: r.via,
    offered,
    ceiling: role === 'manager' ? [...DESKS] : [...(sampleCeilings[role] ?? [])],
    fallback: false,
  }
}

/** Before 0085: the desks by role, as the app decided until now, less those whose switch the
 *  manager turned off (the functions behind them refuse: vital signs, start a visit…). */
const fromRole = (role: DbRole, perms?: ReadonlySet<string>): MyDesks => {
  const desks = ROLE_DESKS[role].filter(
    (d) => role === 'manager' || !perms || switchAllows(d, perms),
  )
  return {
    desks: [...desks],
    via: Object.fromEntries(
      desks.map((d) => [d, role === 'manager' ? 'manager' : 'role']),
    ) as MyDesks['via'],
    offered: [],
    ceiling: role === 'manager' ? [...DESKS] : [...(DEFAULT_CEILINGS[role] ?? [])],
    fallback: true,
  }
}

async function readMyDesks(user: Pick<StaffUser, 'id' | 'role' | 'dbRole'>): Promise<MyDesks> {
  const role = dbRoleOf(user)
  if (!supabase) return sampleDesksOf(user.id, role)
  const { data, error } = await supabase.rpc('my_desks')
  // an older database (0085 not applied) or a failed read: the role decides, as before
  if (error || !data) return fromRole(role, await permsReady(user))
  const j = data as {
    desks?: string[]
    via?: Record<string, DeskVia>
    offered?: string[]
    ceiling?: string[]
  }
  return {
    desks: onlyDesks(j.desks),
    via: Object.fromEntries(
      Object.entries(j.via ?? {}).filter(([d]) => isDesk(d)),
    ) as MyDesks['via'],
    offered: onlyDesks(j.offered),
    ceiling: onlyDesks(j.ceiling),
    fallback: false,
  }
}

const myKey = (userId: string) => ['desks', 'mine', userId] as const

/** The desks of the person, waited for (route guards): the cached answer, or read now. */
export function desksReady(user: StaffUser): Promise<MyDesks> {
  return queryClient.ensureQueryData({
    queryKey: myKey(user.id),
    staleTime: 60_000,
    queryFn: () => readMyDesks(user),
  })
}

/** The desks of the signed-in person (refreshed every minute, like the profile). */
export function useMyDesks(user: StaffUser) {
  return useQuery({
    queryKey: myKey(user.id),
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: () => readMyDesks(user),
  })
}

/** canDesk('laboratory'): while loading, today's rule of the person's role (no flicker). */
export function useCanDesk(user: StaffUser) {
  const { data } = useMyDesks(user)
  const desks = data?.desks ?? ROLE_DESKS[dbRoleOf(user)]
  return (desk: DeskId | readonly DeskId[]) =>
    typeof desk === 'string' ? desks.includes(desk) : desk.some((d) => desks.includes(d))
}

/** May the person treat patients (any treating desk)? The clinical record, prescribing, tests. */
export const canTreat = (desks: readonly DeskId[]): boolean =>
  TREATING_DESKS.some((d) => desks.includes(d))

/**
 * The desks of the person, read during render (menus, the home chooser), from the query cache:
 * the first time it is asked for, it is fetched; when the answer changes the signed-in user is
 * renewed so every open screen draws its menu again (as holdsRoomStore in lib/nav does). Until
 * the first answer: today's rule of the role.
 */
export function desksNow(user: StaffUser): DeskId[] {
  const key = myKey(user.id)
  queueMicrotask(() => {
    void queryClient.prefetchQuery({
      queryKey: key,
      staleTime: 60_000,
      queryFn: async () => {
        const before = queryClient.getQueryData<MyDesks>(key)
        const now = await readMyDesks(user)
        if (!before || before.desks.join() !== now.desks.join())
          window.setTimeout(() => {
            const u = useSession.getState().user
            if (u && u.id === user.id) useSession.setState({ user: { ...u } })
          }, 0)
        return now
      },
    })
  })
  return queryClient.getQueryData<MyDesks>(key)?.desks ?? ROLE_DESKS[dbRoleOf(user)]
}

// ---------------------------------------------------------------- the manager sets the ceilings
export interface RoleDeskMatrix {
  desks: DeskId[]
  /** The ceiling of each role (the manager is not listed: every desk). */
  roles: Partial<Record<Exclude<DbRole, 'manager'>, DeskId[]>>
  /** The desks some active department gives. */
  offered: DeskId[]
  /** True before 0085: the defaults, read only. */
  fallback: boolean
}

/** Settings → Who may do what → "Desks each role may use" (manager). */
export function useRoleDeskMatrix() {
  return useQuery({
    queryKey: ['desks', 'matrix'],
    queryFn: async (): Promise<RoleDeskMatrix> => {
      if (!supabase)
        return {
          desks: [...DESKS],
          roles: Object.fromEntries(
            Object.entries(sampleCeilings).map(([r, d]) => [r, [...d]]),
          ) as RoleDeskMatrix['roles'],
          offered: sampleOffered(),
          fallback: false,
        }
      const { data, error } = await supabase.rpc('role_desk_matrix')
      if (error && isMissingFunction(error))
        return { desks: [...DESKS], roles: { ...DEFAULT_CEILINGS }, offered: [], fallback: true }
      throwIf(error)
      const m = (data ?? {}) as {
        desks?: string[]
        roles?: Record<string, string[]>
        offered?: string[]
      }
      return {
        desks: m.desks?.length ? onlyDesks(m.desks) : [...DESKS],
        roles: Object.fromEntries(
          Object.entries(m.roles ?? {}).map(([r, d]) => [r, onlyDesks(d)]),
        ) as RoleDeskMatrix['roles'],
        offered: onlyDesks(m.offered),
        fallback: false,
      }
    },
  })
}

export function useRoleDeskActions() {
  const qc = useQueryClient()
  const setRoleDesk = useMutation({
    mutationFn: async (i: { role: Exclude<DbRole, 'manager'>; desk: DeskId; allowed: boolean }) => {
      if (!supabase) {
        const list = new Set(sampleCeilings[i.role] ?? [])
        if (i.allowed) list.add(i.desk)
        else list.delete(i.desk)
        sampleCeilings[i.role] = DESKS.filter((d) => list.has(d))
        return
      }
      const { error } = await supabase.rpc('set_role_desk', {
        p_role: i.role,
        p_desk: i.desk,
        p_allowed: i.allowed,
      })
      throwIf(error)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['desks'] })
      // the employee list shows each person's desks
      await qc.invalidateQueries({ queryKey: ['staff', 'employees'] })
    },
  })
  return { setRoleDesk }
}

/** The manager takes away a desk an employee kept on day one (forget_kept_desk): the employee then
 *  follows their departments for it. */
export function useKeptDeskActions() {
  const qc = useQueryClient()
  const forget = useMutation({
    mutationFn: async (i: { profileId: string; desk: DeskId }) => {
      if (!supabase) return
      const { error } = await supabase.rpc('forget_kept_desk', {
        p_profile_id: i.profileId,
        p_desk: i.desk,
      })
      throwIf(error)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['desks'] })
      await qc.invalidateQueries({ queryKey: ['staff', 'employees'] })
    },
  })
  return { forget }
}

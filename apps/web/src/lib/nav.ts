import { ROLE_HOME, type NavItem, type StaffUser } from '@mmc/shared'
import { desksNow, TREATING_DESKS, type DeskId, type MyDesks } from '@/lib/api/desks'
import { permsNow } from '@/lib/api/permissions'
import { isRoomStore, sampleStock } from '@/lib/api/stock'
import { queryClient } from '@/lib/query-client'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'

/** Every role's rail ends with the notifications page (inbox, filters; manager: sent). */
const NOTICES: NavItem = {
  id: 'notifications',
  labelKey: 'nav.notifications',
  icon: 'bell',
  to: '/app/notifications',
}

/** Activity history: the manager's covers everyone, everybody else's their own work. */
const HISTORY: NavItem = {
  id: 'history',
  labelKey: 'nav.history',
  icon: 'history',
  to: '/app/history',
}

/**
 * Manager rail (the dashboard is the manager's home page, doc §12.3). The manager runs the
 * whole clinic and can work at any station, so every operation has its own entry, in the
 * order a patient moves: register → triage → in the clinic (open visits) → patient files,
 * then the clinic's own management (prices, employees, settings).
 */
export const MANAGER_NAV: NavItem[] = [
  { id: 'dashboard', labelKey: 'nav.dashboard', icon: 'layout-dashboard', to: '/app/dashboard' },
  // the detailed views behind the dashboard cards (one view at a time)
  { id: 'analytics', labelKey: 'nav.analytics', icon: 'bar-chart-3', to: '/app/analytics' },
  { id: 'register', labelKey: 'nav.register', icon: 'user-plus', to: '/app/register' },
  { id: 'vitals', labelKey: 'nav.triage', icon: 'activity', to: '/app/vitals' },
  { id: 'visits', labelKey: 'nav.inClinic', icon: 'stethoscope', to: '/app/visits' },
  { id: 'appointments', labelKey: 'nav.bookings', icon: 'calendar', to: '/app/appointments' },
  { id: 'calendar', labelKey: 'nav.doctorCalendars', icon: 'calendar-days', to: '/app/calendar' },
  { id: 'patients', labelKey: 'nav.patients', icon: 'users', to: '/app/patients' },
  { id: 'lab', labelKey: 'nav.worklist', icon: 'flask-conical', to: '/app/lab' },
  { id: 'bills', labelKey: 'nav.bills', icon: 'wallet', to: '/app/bills' },
  { id: 'payments', labelKey: 'nav.payments', icon: 'banknote', to: '/app/payments' },
  { id: 'prices', labelKey: 'nav.prices', icon: 'receipt', to: '/app/prices' },
  { id: 'stock', labelKey: 'nav.stock', icon: 'package', to: '/app/stock' },
  { id: 'staff', labelKey: 'nav.staff', icon: 'id-card', to: '/app/staff' },
  HISTORY,
  NOTICES,
  { id: 'settings', labelKey: 'nav.settings', icon: 'settings', to: '/app/settings' },
]

/** Front desk: the dashboard, then the patient's path from the door. */
export const RECEPTION_NAV: NavItem[] = [
  { id: 'home', labelKey: 'nav.home', icon: 'layout-dashboard', to: '/app' },
  { id: 'register', labelKey: 'nav.register', icon: 'user-plus', to: '/app/register' },
  // reception types the nurse's paper sheet on the triage screen and sends the patient on
  { id: 'vitals', labelKey: 'nav.triage', icon: 'activity', to: '/app/vitals' },
  { id: 'visits', labelKey: 'nav.inClinic', icon: 'stethoscope', to: '/app/visits' },
  { id: 'appointments', labelKey: 'nav.bookings', icon: 'calendar', to: '/app/appointments' },
  { id: 'patients', labelKey: 'nav.patients', icon: 'users', to: '/app/patients' },
  HISTORY,
  NOTICES,
]

/** Nursing: the dashboard, triage first, then everyone in the clinic and the files. A nurse who
 *  holds a room store (the ward) also gets "My store" (see withMyStore). */
export const NURSE_NAV: NavItem[] = [
  { id: 'home', labelKey: 'nav.home', icon: 'layout-dashboard', to: '/app' },
  { id: 'vitals', labelKey: 'nav.triage', icon: 'activity', to: '/app/vitals' },
  { id: 'register', labelKey: 'nav.register', icon: 'user-plus', to: '/app/register' },
  { id: 'visits', labelKey: 'nav.inClinic', icon: 'stethoscope', to: '/app/visits' },
  { id: 'patients', labelKey: 'nav.patients', icon: 'users', to: '/app/patients' },
  HISTORY,
  NOTICES,
]

/**
 * "My store": the room stores the person holds (a doctor's office, the ward, the laboratory).
 * Same page as the stock page (it shows only their stores); the id keeps the entry lit there.
 */
const MY_STORE: NavItem = {
  id: 'stock',
  labelKey: 'nav.myStore',
  icon: 'package',
  to: '/app/stock',
}
/** The person's own calendar (hours, days off, bookings). */
const CALENDAR: NavItem = {
  id: 'calendar',
  labelKey: 'nav.calendar',
  icon: 'calendar-days',
  to: '/app/calendar',
}
/** Everyone in the clinic now, by desk. */
const IN_CLINIC: NavItem = {
  id: 'visits',
  labelKey: 'nav.inClinic',
  icon: 'stethoscope',
  to: '/app/visits',
}
/** Patient files: the pharmacy and the laboratory look a patient up too. */
const PATIENTS: NavItem = {
  id: 'patients',
  labelKey: 'nav.patients',
  icon: 'users',
  to: '/app/patients',
}

/** A head of department also opens the dashboard (their department's figures). */
const HEAD_DASHBOARD: NavItem = {
  id: 'dashboard',
  labelKey: 'nav.dashboard',
  icon: 'layout-dashboard',
  to: '/app/dashboard',
}
/** …and the detailed views of their department (no money). */
const HEAD_ANALYTICS: NavItem = {
  id: 'analytics',
  labelKey: 'nav.analytics',
  icon: 'bar-chart-3',
  to: '/app/analytics',
}
const withHeadDashboard = (user: StaffUser, items: NavItem[]): NavItem[] =>
  user.dashboard === 'head' ? [items[0]!, HEAD_DASHBOARD, HEAD_ANALYTICS, ...items.slice(1)] : items

/** Navigation items for the user: the role's menu, shaped by the desks they work at and by what
 *  the manager allows them (Settings → Who may do what). The manager's menu never changes. */
export const navForUser = (user: StaffUser): NavItem[] =>
  user.dashboard === 'manager' || user.role === 'manager'
    ? MANAGER_NAV
    : withMyStore(
        user,
        withHeadDashboard(user, withSwitches(user, withDesks(user, navForStaff(user)))),
      )

/* ---------------------------------------------------------------- switches (Who may do what) */

const BILLS: NavItem = { id: 'bills', labelKey: 'nav.bills', icon: 'wallet', to: '/app/bills' }
const PAYMENTS: NavItem = {
  id: 'payments',
  labelKey: 'nav.payments',
  icon: 'banknote',
  to: '/app/payments',
}
const BOOKINGS: NavItem = {
  id: 'appointments',
  labelKey: 'nav.bookings',
  icon: 'calendar',
  to: '/app/appointments',
}

/**
 * The menu follows the manager's switches, read again every minute (permsNow):
 *   off  an entry that only serves the feature goes: Triage without "Record vital signs", Register
 *        without "Start visits" (Patients stays, to find a patient);
 *   on   a role whose menu lacks it gets it: Bills and Payments with "Take payments", Bookings
 *        with "Answer booking requests".
 * The cashier keeps Bills and Payments when switched off: what was taken stays readable there.
 */
function withSwitches(user: StaffUser, items: NavItem[]): NavItem[] {
  const may = permsNow(user)
  const kept = items.filter(
    (n) =>
      !(n.to === '/app/vitals' && !may.has('vitals.write')) &&
      !(n.to === '/app/register' && !may.has('visit.start')),
  )
  const has = (to: string) => kept.some((n) => n.to === to)
  const added: NavItem[] = [
    ...(may.has('appointment.approve') && !has('/app/appointments') ? [BOOKINGS] : []),
    ...(may.has('payment.take') && user.role !== 'cashier' && !has('/app/bills')
      ? [BILLS, PAYMENTS]
      : []),
  ]
  if (!added.length) return kept
  // before History and the notices, which close every menu
  const at = kept.findIndex((n) => n.to === '/app/history')
  const cut = at >= 0 ? at : kept.length
  return [...kept.slice(0, cut), ...added, ...kept.slice(cut)]
}

/* ---------------------------------------------------------------- desks (migration 0085) */

/** The desks where a doctor sees patients (the doctor's queue, tests ordered, prescriptions). */
export const DOCTOR_DESKS: readonly DeskId[] = ['consultation', 'dental', 'surgery', 'circ']

/** The lab worklist (the laboratory or ultrasound desk of someone whose role menu lacks it). */
const LAB_WORKLIST: NavItem = {
  id: 'worklist',
  labelKey: 'nav.labWorklist',
  icon: 'flask-conical',
  to: '/app/lab',
}
/** The pharmacy desk (hand over, counter sale, the pharmacy's stock): the stock page. */
const PHARMACY_DESK: NavItem = {
  id: 'stock',
  labelKey: 'nav.pharmacy',
  icon: 'pill',
  to: '/app/stock',
}
const doctorEntry = (id: 'queue' | 'results' | 'prescriptions'): NavItem =>
  ROLE_HOME.doctor.nav.find((n) => n.id === id)!

/**
 * The menu entries that belong to a desk, in the order they are added after Home:
 *   keep  the role's own entry stays while the person has one of these desks;
 *   add   someone whose role menu lacks it gets it when a department of theirs (or the manager's
 *         exception for them) gives one of these desks.
 * A desk the person has only because their role always had it (no department gives it) adds
 * nothing: on the day departments start deciding, nobody's menu changes.
 */
const DESK_ENTRIES: { item: NavItem; keep: readonly DeskId[]; add: readonly DeskId[] }[] = [
  { item: RECEPTION_NAV[1]!, keep: ['reception'], add: ['reception'] },
  { item: RECEPTION_NAV[2]!, keep: ['triage'], add: ['triage'] },
  { item: doctorEntry('queue'), keep: TREATING_DESKS, add: DOCTOR_DESKS },
  { item: doctorEntry('results'), keep: TREATING_DESKS, add: DOCTOR_DESKS },
  { item: doctorEntry('prescriptions'), keep: TREATING_DESKS, add: DOCTOR_DESKS },
  { item: LAB_WORKLIST, keep: ['laboratory', 'ultrasound'], add: ['laboratory', 'ultrasound'] },
  { item: PHARMACY_DESK, keep: ['pharmacy'], add: ['pharmacy'] },
]

/** The desks a department of the person gives: the ones that add entries to the menu and blocks
 *  to the home page. A desk kept on day one or decided by the role adds nothing (the menu stays as
 *  before); a doctor covered by a nurse adds nothing (the cover has its own panels). */
export const extraDesks = (mine: Pick<MyDesks, 'desks' | 'via'> | undefined): DeskId[] =>
  (mine?.desks ?? []).filter((d) => mine?.via[d] === 'department')

/**
 * The desks of the person now, read during render from the query cache (desksNow fetches them
 * the first time and redraws the menus when they change). Until the first answer: today's rule
 * of the role, and nothing extra.
 */
export function desksOfUser(user: StaffUser): { desks: DeskId[]; extra: DeskId[] } {
  const desks = desksNow(user)
  const mine = queryClient.getQueryData<MyDesks>(['desks', 'mine', user.id])
  return { desks, extra: extraDesks(mine) }
}

/** The role's menu without the desk entries the person does not work at, plus those their
 *  departments give (right after Home). The cashier's menu is money only: never changed. */
function withDesks(user: StaffUser, items: NavItem[]): NavItem[] {
  if (user.role === 'cashier') return items
  const { desks, extra } = desksOfUser(user)
  const has = (list: readonly DeskId[]) => list.some((d) => desks.includes(d))
  const kept = items.filter((n) => {
    const entry = DESK_ENTRIES.find((e) => e.item.to === n.to)
    // the pharmacist's own "Stock" is the pharmacy desk
    return !entry || has(entry.keep)
  })
  const added = DESK_ENTRIES.filter(
    (e) => !kept.some((n) => n.to === e.item.to) && e.add.some((d) => extra.includes(d)),
  ).map((e) => e.item)
  return added.length ? [kept[0]!, ...added, ...kept.slice(1)] : kept
}

/**
 * Whether the person holds a room store, as last read from the database (my_stores). The menu
 * is built during render, so the answer comes from the query cache: the first time it is asked
 * for, it is fetched, and when the answer changes the signed-in user is renewed so every open
 * screen draws its menu again (the same way a role changed by the manager reaches the menu).
 */
const holdsKey = (userId: string) => ['stock', 'rooms', 'nav-holds', userId] as const
async function readHolds(): Promise<boolean> {
  if (!supabase)
    return sampleStock.locations.some(
      (l) => l.active !== false && isRoomStore(l) && sampleStock.holds(l.id),
    )
  const { data, error } = await supabase.rpc('my_stores')
  // an older database (no room stores yet) or a failed read: no entry
  if (error) return false
  return Array.isArray(data) && data.length > 0
}
function holdsRoomStore(user: StaffUser): boolean {
  const key = holdsKey(user.id)
  queueMicrotask(() => {
    void queryClient.prefetchQuery({
      queryKey: key,
      staleTime: 5 * 60_000,
      queryFn: async () => {
        const before = queryClient.getQueryData<boolean>(key) ?? false
        const now = await readHolds()
        if (now !== before)
          window.setTimeout(() => {
            const u = useSession.getState().user
            if (u && u.id === user.id) useSession.setState({ user: { ...u } })
          }, 0)
        return now
      },
    })
  })
  return queryClient.getQueryData<boolean>(key) ?? false
}
/** Whoever has the pharmacy desk has the full stock page already; anyone else holding a store
 *  gets My store. */
const withMyStore = (user: StaffUser, items: NavItem[]): NavItem[] =>
  items.some((n) => n.to === '/app/stock') || !holdsRoomStore(user)
    ? items
    : [...items.slice(0, -2), MY_STORE, ...items.slice(-2)]

const navForStaff = (user: StaffUser): NavItem[] =>
  user.dashboard === 'manager' || user.role === 'manager'
    ? MANAGER_NAV
    : user.role === 'receptionist'
      ? RECEPTION_NAV
      : user.role === 'nurse'
        ? NURSE_NAV
        : user.role === 'pharmacist'
          ? [...ROLE_HOME.pharmacist.nav, PATIENTS, HISTORY, NOTICES]
          : user.role === 'lab_tech'
            ? // sonographers keep their own calendar and have no stock to manage
              user.dbRole === 'sonographer'
              ? [...ROLE_HOME.lab_tech.nav, CALENDAR, PATIENTS, HISTORY, NOTICES]
              : [...ROLE_HOME.lab_tech.nav, PATIENTS, HISTORY, NOTICES]
            : user.role === 'doctor'
              ? [...ROLE_HOME.doctor.nav, IN_CLINIC, PATIENTS, HISTORY, NOTICES]
              : // the cashier looks a patient up to collect what a past visit still owes
                [...ROLE_HOME.cashier.nav, PATIENTS, HISTORY, NOTICES]

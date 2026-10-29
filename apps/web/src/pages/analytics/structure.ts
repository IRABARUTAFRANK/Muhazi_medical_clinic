import {
  Activity,
  Banknote,
  Boxes,
  CalendarCheck,
  CalendarClock,
  CircleCheck,
  ClipboardList,
  Coins,
  FileText,
  FlaskConical,
  HeartPulse,
  Hourglass,
  ListOrdered,
  ListTodo,
  type LucideIcon,
  Pill,
  Receipt,
  ReceiptText,
  ShoppingCart,
  Siren,
  Stethoscope,
  Store,
  Tablets,
  TestTubes,
  Timer,
  Undo2,
  UserCheck,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react'
import { canOpenView, type AnalyticsAccess, type AnalyticsView } from '@/lib/api/analytics'
import type { TFn } from './format'
import { tx } from './words'

/**
 * The structure of the Analytics page follows the dashboard of the person (0102): the views of
 * that dashboard, in the dashboard's order, grouped as its cards are. The server lists the views
 * (analytics_access.dashboardViews); this file says which group each one belongs to, its icon
 * and its name. The groups appear in the order their first view appears.
 */

/** The group of each view (the group's words: `analytics.groups.*`). */
const GROUP_OF: Record<AnalyticsView, string> = {
  revenue: 'money',
  receipts: 'payments',
  staff: 'people',
  visits: 'patients',
  treatments: 'clinical',
  lab: 'desks',
  pharmacy: 'desks',
  triage: 'desks',
  stock: 'stock',
  waiting: 'waiting',
  documents: 'documents',
  collections: 'money',
  methods: 'money',
  openBills: 'money',
  refunds: 'payments',
  handovers: 'pharmacy',
  walkIn: 'pharmacy',
  expiry: 'stock',
  outside: 'pharmacy',
  tests: 'lab',
  turnaround: 'lab',
  verification: 'lab',
  byTest: 'lab',
  myPatients: 'mine',
  vitals: 'mine',
  waitingNow: 'waiting',
  diagnoses: 'records',
  prescriptions: 'records',
  orders: 'records',
  tasks: 'mine',
  registrations: 'desk',
  bookings: 'desk',
  arrivals: 'desk',
}

export const VIEW_ICONS: Record<AnalyticsView, LucideIcon> = {
  revenue: Wallet,
  receipts: ReceiptText,
  staff: Users,
  visits: UserCheck,
  treatments: ListOrdered,
  lab: FlaskConical,
  pharmacy: Pill,
  triage: HeartPulse,
  stock: Boxes,
  waiting: Hourglass,
  documents: FileText,
  collections: Coins,
  methods: Banknote,
  openBills: Receipt,
  refunds: Undo2,
  handovers: Tablets,
  walkIn: ShoppingCart,
  expiry: CalendarClock,
  outside: Store,
  tests: TestTubes,
  turnaround: Timer,
  verification: CircleCheck,
  byTest: ClipboardList,
  myPatients: Stethoscope,
  vitals: Activity,
  waitingNow: Hourglass,
  diagnoses: ClipboardList,
  prescriptions: Pill,
  orders: FlaskConical,
  tasks: ListTodo,
  registrations: UserPlus,
  bookings: CalendarCheck,
  arrivals: Siren,
}

/** The English of the newer groups and views until the translations are merged. */
const GROUP_EN: Record<string, string> = {
  money: 'Money',
  people: 'People',
  patients: 'Patients',
  desks: 'Desks',
  stock: 'Stock',
  waiting: 'Waiting',
  clinical: 'Clinical',
  documents: 'Documents',
  payments: 'Payments',
  pharmacy: 'Pharmacy',
  lab: 'Laboratory',
  mine: 'My work',
  records: 'My records',
  desk: 'The desk',
}
const VIEW_EN: Record<AnalyticsView, string> = {
  revenue: 'Revenue',
  receipts: 'Receipts',
  staff: 'Who did what',
  visits: 'Patients and visits',
  treatments: 'Treatments',
  lab: 'Laboratory',
  pharmacy: 'Pharmacy',
  triage: 'Triage',
  stock: 'Stock',
  waiting: 'Waiting times',
  documents: 'Patients’ documents',
  collections: 'Collections',
  methods: 'Payment methods',
  openBills: 'Open bills',
  refunds: 'Refunds',
  handovers: 'Hand-overs',
  walkIn: 'Walk-in sales',
  expiry: 'Expiry',
  outside: 'Bought outside',
  tests: 'Tests',
  turnaround: 'Turnaround',
  verification: 'Verification',
  byTest: 'By test',
  myPatients: 'My patients seen',
  vitals: 'Vital signs taken',
  waitingNow: 'Waiting now',
  diagnoses: 'Diagnoses',
  prescriptions: 'Prescriptions',
  orders: 'Tests requested',
  tasks: 'Tasks',
  registrations: 'Registrations',
  bookings: 'Bookings',
  arrivals: 'Arrivals',
}

export const groupName = (key: string, t: TFn) =>
  tx(t, `analytics.groups.${key}`, GROUP_EN[key] ?? key)
export const viewName = (view: AnalyticsView, t: TFn) =>
  tx(t, `analytics.views.${view}`, VIEW_EN[view])

export interface ViewGroup {
  key: string
  views: AnalyticsView[]
}

/**
 * The groups of the page for this person: the dashboard's views in its order, grouped by the
 * group each belongs to (a group opens where its first view appears). The manager's and a
 * head's older server lists (before 0102) are arranged the same way. The first view is the
 * default one: the first card of the dashboard.
 */
export function structureFor(access: AnalyticsAccess): {
  groups: ViewGroup[]
  first?: AnalyticsView
} {
  const ordered = (access.dashboardViews.length ? access.dashboardViews : access.views).filter(
    (v) => canOpenView(access, v),
  )
  const groups: ViewGroup[] = []
  for (const v of ordered) {
    const key = GROUP_OF[v]
    const g = groups.find((x) => x.key === key)
    if (g) {
      if (!g.views.includes(v)) g.views.push(v)
    } else groups.push({ key, views: [v] })
  }
  return { groups, first: ordered[0] }
}

/** The views whose figures are those of one department (the department choice shows). */
export const DEPARTMENT_VIEWS: readonly AnalyticsView[] = [
  'staff',
  'visits',
  'treatments',
  'waiting',
  'triage',
  'documents',
]

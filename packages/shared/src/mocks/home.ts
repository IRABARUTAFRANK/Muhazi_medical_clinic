import type {
  Appointment,
  Bed,
  CalendarItem,
  HomeRole,
  Inquiry,
  LabResult,
  NavItem,
  NurseTask,
  OpenBill,
  ProvisionalReceipt,
  QueueCounts,
  QueueRow,
  QuickAction,
} from '../types'

export interface ClinicNow {
  inClinic: number
  avgWaitMin: number
  bedsOccupied: number
  bedsTotal: number
}
export const CLINIC_NOW: ClinicNow = { inClinic: 23, avgWaitMin: 18, bedsOccupied: 5, bedsTotal: 8 }
export const CLINIC_NOW_QUIET: ClinicNow = {
  inClinic: 2,
  avgWaitMin: 0,
  bedsOccupied: 3,
  bedsTotal: 8,
}

const q = (
  ticket: string,
  name: string,
  ageSex: string,
  triage: QueueRow['triage'],
  waitMin: number,
  insurer: string,
): QueueRow => ({ ticket, name, ageSex, triage, waitMin, insurer })

const nav = (id: string, icon: string, to = `/app/${id}`): NavItem => ({
  id,
  labelKey: `nav.${id}`,
  icon,
  to,
})
const act = (id: string, icon: string, primary: boolean, to: string): QuickAction => ({
  id,
  labelKey: `home.actions.${id}`,
  icon,
  primary,
  to,
})

export interface RoleHome {
  /** Station name shown in "My queue · {{station}}". */
  station: string
  nav: NavItem[]
  queue: QueueRow[]
  counts: QueueCounts
  actions: QuickAction[]
  /** Label of the per-row queue button. */
  rowAction: 'open' | 'call'
}

export const ROLE_HOME: Record<HomeRole, RoleHome> = {
  receptionist: {
    station: 'Reception',
    nav: [
      nav('home', 'home', '/app'),
      nav('patients', 'users', '/app/patients'),
      nav('appointments', 'calendar'),
      nav('queue', 'list-ordered'),
      nav('reports', 'bar-chart-3', '/app/dashboard'),
    ],
    queue: [
      q('A-009', 'Niyonzima Jean Bosco', '54 M', 'red', 2, 'RSSB RAMA'),
      q('A-012', 'Mukamana Alice', '31 F', 'yellow', 11, 'Mutuelle'),
      q('A-014', 'Habimana Eric', '8 M', 'yellow', 9, 'Mutuelle'),
      q('A-015', 'Ingabire Diane', '27 F', 'green', 18, 'MMI'),
      q('A-016', 'Nshimiyimana Patrick', '42 M', 'green', 14, 'Cash'),
      q('A-017', 'Umutoni Grace', '63 F', 'green', 6, 'Radiant'),
      q('A-018', 'Bizimana Olivier', '19 M', 'green', 3, 'Prime'),
    ],
    counts: { waiting: 7, inProgress: 3, done: 28 },
    actions: [
      act('registerPatient', 'user-plus', true, '/app/register'),
      act('walkInTicket', 'ticket', false, '/app/register'),
      act('newInquiry', 'calendar-plus', false, '/app/appointments'),
      act('printCard', 'printer', false, '/app/patients'),
    ],
    rowAction: 'open',
  },
  nurse: {
    station: 'Triage',
    nav: [
      nav('home', 'home', '/app'),
      nav('queue', 'list-ordered'),
      nav('vitals', 'activity'),
      nav('beds', 'bed'),
      nav('tasks', 'check-square'),
    ],
    queue: [
      q('A-009', 'Niyonzima Jean Bosco', '54 M', 'red', 2, 'RSSB RAMA'),
      q('A-012', 'Mukamana Alice', '31 F', 'yellow', 11, 'Mutuelle'),
      q('A-014', 'Habimana Eric', '8 M', 'yellow', 9, 'Mutuelle'),
      q('A-015', 'Ingabire Diane', '27 F', 'green', 18, 'MMI'),
      q('A-016', 'Nshimiyimana Patrick', '42 M', 'green', 14, 'Cash'),
      q('A-017', 'Umutoni Grace', '63 F', 'green', 6, 'Radiant'),
    ],
    counts: { waiting: 6, inProgress: 1, done: 31 },
    actions: [
      act('vitals', 'activity', true, '/app/vitals'),
      act('registerPatient', 'user-plus', false, '/app/register'),
      act('injection', 'syringe', false, '/app/tasks'),
      act('dressing', 'bandage', false, '/app/tasks'),
      act('admit', 'bed', false, '/app/beds'),
    ],
    rowAction: 'call',
  },
  doctor: {
    station: 'Consultation 1',
    nav: [
      nav('home', 'home', '/app'),
      nav('queue', 'list-ordered'),
      nav('results', 'flask-conical'),
      nav('prescriptions', 'pill'),
      nav('calendar', 'calendar-days'),
    ],
    queue: [
      q('A-009', 'Niyonzima Jean Bosco', '54 M', 'red', 4, 'RSSB RAMA'),
      q('A-012', 'Mukamana Alice', '31 F', 'yellow', 19, 'Mutuelle'),
      q('A-014', 'Habimana Eric', '8 M', 'yellow', 16, 'Mutuelle'),
      q('A-015', 'Ingabire Diane', '27 F', 'green', 26, 'MMI'),
      q('A-016', 'Nshimiyimana Patrick', '42 M', 'green', 22, 'Cash'),
    ],
    counts: { waiting: 5, inProgress: 1, done: 17 },
    actions: [
      act('openNext', 'arrow-right', true, '/app/queue'),
      act('registerPatient', 'user-plus', false, '/app/register'),
      act('newPrescription', 'file-plus', false, '/app/prescriptions'),
      act('newOrder', 'clipboard-check', false, '/app/results'),
    ],
    rowAction: 'call',
  },
  cashier: {
    station: 'Cashier',
    nav: [
      nav('home', 'home', '/app'),
      nav('bills', 'receipt'),
      nav('payments', 'wallet'),
      nav('directSales', 'shopping-bag', '/app/direct-sales'),
      nav('dayClose', 'lock', '/app/day-close'),
    ],
    queue: [
      q('A-006', 'Iradukunda Sandrine', '35 F', 'green', 9, 'Cash'),
      q('A-011', 'Rukundo Kevin', '24 M', 'green', 7, 'MTN MoMo'),
      q('A-013', 'Uwase Claudine', '48 F', 'yellow', 5, 'Mutuelle'),
      q('A-010', 'Hakizimana Emmanuel', '58 M', 'green', 3, 'RSSB RAMA'),
    ],
    counts: { waiting: 4, inProgress: 1, done: 36 },
    actions: [
      act('takePayment', 'credit-card', true, '/app/payments'),
      act('directSale', 'shopping-cart', false, '/app/direct-sales'),
      act('dayClose', 'clock', false, '/app/day-close'),
    ],
    rowAction: 'open',
  },
}

export const APPOINTMENT_COUNTS = { arrived: 14, due: 9, late: 3 } as const
export const APPOINTMENTS: readonly Appointment[] = [
  {
    time: '12:30',
    name: 'Uwase Claudine',
    doctor: 'Dr. Mukamana · Consultation 1',
    status: 'late',
  },
  {
    time: '13:00',
    name: 'Hakizimana Emmanuel',
    doctor: 'Dr. Mukamana · Consultation 1',
    status: 'due',
  },
  { time: '13:00', name: 'Rukundo Kevin', doctor: 'Dr. Ndayisaba · Dental', status: 'arrived' },
  { time: '13:30', name: 'Iradukunda Sandrine', doctor: 'Ultrasound', status: 'due' },
  { time: '14:00', name: 'Umutoni Grace', doctor: 'Dr. Mukamana · Consultation 1', status: 'due' },
]
export const INQUIRIES: readonly Inquiry[] = [
  { name: 'Mukeshimana Aline', detail: 'Dental · asks for Fri 16/10 14:00 · via WhatsApp' },
  { name: 'Nsengiyumva Claude', detail: 'Ultrasound · asks for Sat 17/10 09:00 · via SMS' },
]
export const DOCTOR_INQUIRY: Inquiry = {
  name: 'Hakizimana Emmanuel',
  detail: 'Follow-up hypertension · 16/10 10:30',
}

export const NURSE_TASKS: readonly NurseTask[] = [
  { time: '12:30', task: 'Repeat vitals', patient: 'Niyonzima Jean Bosco · Bed 2', overdue: true },
  { time: '13:00', task: 'Injection · Ceftriaxone 1 g IV', patient: 'Umutoni Grace · Bed 4' },
  { time: '13:15', task: 'Dressing change', patient: 'Bizimana Olivier · Minor surgery' },
  { time: '14:00', task: 'Repeat vitals', patient: 'Habimana Eric · Bed 1' },
  { time: '15:00', task: 'Injection · Oxytocin', patient: 'Ingabire Diane · Bed 3' },
]
export const BEDS: readonly Bed[] = [
  { n: 1, who: 'Habimana E.', state: 'occupied' },
  { n: 2, who: 'Niyonzima J.', state: 'occupied' },
  { n: 3, who: 'Ingabire D.', state: 'occupied' },
  { n: 4, who: 'Umutoni G.', state: 'occupied' },
  { n: 5, who: 'Uwase C.', state: 'occupied' },
  { n: 6, state: 'free' },
  { n: 7, state: 'free' },
  { n: 8, state: 'cleaning' },
]
export const LAB_RESULTS: readonly LabResult[] = [
  {
    flag: 'critical',
    test: 'Potassium',
    name: 'Niyonzima Jean Bosco',
    detail: '6.4 mmol/L · ref 3.5–5.1 · 12:20',
  },
  {
    flag: 'abnormal',
    test: 'Haemoglobin',
    name: 'Mukamana Alice',
    detail: '9.1 g/dL · ref 12–16 · 12:05',
  },
  {
    flag: 'abnormal',
    test: 'Glucose (fasting)',
    name: 'Hakizimana Emmanuel',
    detail: '8.9 mmol/L · ref 3.9–5.6 · 11:40',
  },
  { flag: 'normal', test: 'Malaria RDT', name: 'Habimana Eric', detail: 'Negative · 11:30' },
  { flag: 'normal', test: 'Urinalysis', name: 'Ingabire Diane', detail: 'No abnormality · 11:10' },
]
export const DOCTOR_CALENDAR: readonly CalendarItem[] = [
  { time: '13:00', what: 'Hakizimana Emmanuel · follow-up' },
  { time: '14:00', what: 'Umutoni Grace · review' },
  { time: '16:00', what: 'Staff meeting · Room 2' },
]
export const OPEN_BILLS_SUMMARY = { count: 9, due: 268900 } as const
export const OPEN_BILLS: readonly OpenBill[] = [
  { name: 'Iradukunda Sandrine', station: 'Pharmacy', amount: 18300 },
  { name: 'Rukundo Kevin', station: 'Dental', amount: 45000 },
  { name: 'Uwase Claudine', station: 'Laboratory', amount: 12600 },
  { name: 'Hakizimana Emmanuel', station: 'Consultation 1', amount: 8000 },
  { name: 'Nshimiyimana Patrick', station: 'Ultrasound', amount: 25000 },
]
export const PROVISIONAL_RECEIPTS: readonly ProvisionalReceipt[] = [
  { no: 'PR-2026-0412', name: 'Bizimana Olivier', amount: 6500 },
  { no: 'PR-2026-0413', name: 'Umutoni Grace', amount: 21400 },
  { no: 'PR-2026-0414', name: 'Ingabire Diane', amount: 3000 },
]

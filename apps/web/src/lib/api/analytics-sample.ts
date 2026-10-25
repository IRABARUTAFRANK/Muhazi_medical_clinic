import { addDays, isoDate, type StaffUser } from '@mmc/shared'
import { useSession } from '@/store/session'
import { ApiError } from './errors'
import type {
  ActivityKind,
  ActivityPerson,
  ActivityRecord,
  AnalyticsAccess,
  AnalyticsDepartment,
  AnalyticsPeriod,
  AnalyticsView,
  RevenueAnalysis,
  RevenueTotals,
  StaffActivity,
  StaffActivityDetail,
  Treatment,
  VisitsAnalysis,
  VisitsTotals,
  WaitDesk,
  WaitTimeStats,
} from './analytics'

/**
 * Sample mode for the Analytics page and the manager dashboard: a small clinic that opened on
 * SAMPLE_OPENED, with about 45 visits on a weekday, fewer at the weekend. Every figure is
 * generated from the day (a seeded random), so the dashboard, the Analytics views and the drawers
 * agree with each other and stay the same from one render to the next.
 */

export const SAMPLE_OPENED = '2026-01-05'

// ------------------------------------------------------------------ seeded randomness and days

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
/** mulberry32, seeded by a string. */
function rng(seed: string): () => number {
  let a = hash(seed)
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** A standard normal draw (Box-Muller). */
const normal = (r: () => number) =>
  Math.sqrt(-2 * Math.log(Math.max(r(), 1e-9))) * Math.cos(2 * Math.PI * r())
const pick = <T>(list: readonly T[], r: () => number): T =>
  list[Math.min(list.length - 1, Math.floor(r() * list.length))]!
const r100 = (n: number) => Math.round(n / 100) * 100
const r1 = (n: number) => Math.round(n * 10) / 10

const parseDay = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y!, (m ?? 1) - 1, d ?? 1)
}
const shift = (day: string, n: number) => isoDate(addDays(parseDay(day), n))
const todayIso = () => isoDate(new Date())
/** A moment of a day, as the database sends it (ISO with time zone). */
const at = (day: string, minutes: number) => {
  const d = parseDay(day)
  d.setMinutes(Math.round(minutes))
  // today: never later than now
  const now = Date.now()
  return (d.getTime() > now ? new Date(now - (Math.round(minutes) % 30) * 60_000) : d).toISOString()
}
function ordered(p: AnalyticsPeriod): AnalyticsPeriod {
  return p.from <= p.to ? p : { from: p.to, to: p.from }
}
function daysOf(p: AnalyticsPeriod): string[] {
  const { from, to } = ordered(p)
  const out: string[] = []
  for (let d = from; d <= to; d = shift(d, 1)) out.push(d)
  return out
}
const lengthOf = (p: AnalyticsPeriod) => daysOf(p).length
function prevOf(p: AnalyticsPeriod): AnalyticsPeriod {
  const q = ordered(p)
  const len = lengthOf(q)
  return { from: shift(q.from, -len), to: shift(q.from, -1) }
}
/** Only the days the clinic was open and that are not in the future. */
const activeDays = (p: AnalyticsPeriod) => {
  const t = todayIso()
  return daysOf(p).filter((d) => d >= SAMPLE_OPENED && d <= t)
}

/** How busy a day is (1 = an ordinary weekday); today grows with the hour. */
function dayFactor(day: string): number {
  if (day < SAMPLE_OPENED || day > todayIso()) return 0
  const week = [0.28, 1.18, 1, 1.02, 0.97, 0.92, 0.58][parseDay(day).getDay()]!
  // the clinic grows a little over the year
  const growth =
    0.9 + 0.2 * Math.min(1, (parseDay(day).getTime() - parseDay(SAMPLE_OPENED).getTime()) / 3e10)
  let f = week * growth * (0.85 + 0.3 * rng(`f${day}`)())
  if (day === todayIso()) {
    const now = new Date()
    const h = now.getHours() + now.getMinutes() / 60
    f *= Math.min(1, Math.max(0.04, (h - 7) / 11))
  }
  return f
}

// ------------------------------------------------------------------ one day of the clinic

interface SampleDay {
  day: string
  visits: number
  newPatients: number
  registered: number
  byType: Record<string, number>
  cash: number
  momo: number
  airtel: number
  other: number
  payments: number
  paidVisits: number
  counterCount: number
  counterSales: number
  refundCount: number
  refunds: number
  voidedCount: number
  voided: number
  charged: number
  discountLines: number
  discounts: number
  creditNote: number
  booked: number
  kept: number
  missed: number
  pending: number
}

const dayCache = new Map<string, SampleDay>()
function sampleDay(day: string): SampleDay {
  const cached = day !== todayIso() ? dayCache.get(day) : undefined
  if (cached) return cached
  const R = rng(`d${day}`)
  const visits = Math.round(46 * dayFactor(day))
  const perVisit = 15500 + 4000 * R()
  const paidVisits = Math.round(visits * 0.93)
  const bills = r100(paidVisits * perVisit)
  const counterCount = visits ? Math.round(visits * 0.07 + 3 * R()) : 0
  const counterSales = counterCount * r100(4000 + 5000 * R())
  const total = bills + counterSales
  const momo = r100(total * (0.36 + 0.08 * R()))
  const airtel = r100(total * (0.08 + 0.05 * R()))
  const other = R() < 0.25 ? r100(total * 0.02) : 0
  const cash = total - momo - airtel - other
  const refundCount = visits && R() < 0.3 ? 1 : 0
  const voidedCount = visits && R() < 0.12 ? 1 : 0
  const newPatients = Math.round(visits * (0.28 + 0.1 * R()))
  const dental = Math.round(visits * 0.1)
  const procedure = Math.round(visits * 0.05)
  const direct = Math.round(visits * 0.07)
  const discountLines = visits ? Math.floor(R() * 3) : 0
  const booked = Math.round(visits * (0.12 + 0.06 * R()))
  const missed = Math.round(booked * 0.1 * R() * 2)
  const d: SampleDay = {
    day,
    visits,
    newPatients,
    registered: newPatients + (visits && R() < 0.3 ? 1 : 0),
    byType: visits
      ? {
          opd: visits - dental - procedure - direct,
          dental,
          procedure,
          direct_service: direct,
        }
      : {},
    cash,
    momo,
    airtel,
    other,
    payments: visits ? Math.round(paidVisits * 1.12) + counterCount : 0,
    paidVisits,
    counterCount,
    counterSales,
    refundCount,
    refunds: refundCount ? r100(2000 + 13000 * R()) : 0,
    voidedCount,
    voided: voidedCount ? r100(5000 + 25000 * R()) : 0,
    charged: r100(bills * (1.04 + 0.06 * R())),
    discountLines,
    discounts: discountLines * r100(1000 + 3000 * R()),
    creditNote: visits && R() < 0.03 ? r100(3000 + 9000 * R()) : 0,
    booked,
    kept: booked - missed - (day === todayIso() ? Math.round(booked / 3) : 0),
    missed,
    pending: day === todayIso() ? 2 : 0,
  }
  if (day !== todayIso()) dayCache.set(day, d)
  return d
}
const collectedOf = (d: SampleDay) => d.cash + d.momo + d.airtel + d.other

// ------------------------------------------------------------------ the clinic's people

const NAMES = [
  'Uwase Marie Claire',
  'Habimana Jean Bosco',
  'Mukandayisenga Odette',
  'Niyonzima Jean Baptiste',
  'Ishimwe Aline',
  'Nshimiyimana Eric',
  'Mukamana Alice',
  'Hakizimana Emmanuel',
  'Uwimana Claudine',
  'Bizimana Innocent',
  'Ingabire Solange',
  'Mugisha Patrick',
  'Nyiramana Vestine',
  'Twagirayezu Fabrice',
  'Umutoni Gisele',
  'Ndayishimiye Olivier',
  'Mukeshimana Jeanne',
  'Rukundo Didier',
  'Uwamahoro Diane',
  'Kamanzi Yves',
]
const patientOf = (seed: string) => {
  const r = rng(`p${seed}`)
  const i = Math.floor(r() * NAMES.length)
  return {
    id: `pt-${i}`,
    name: NAMES[i]!,
    file: `MMC-${String(100 + i * 37).padStart(6, '0')}`,
  }
}

export const SAMPLE_DEPARTMENTS: (AnalyticsDepartment & { share: number })[] = [
  {
    id: 'dep-opd',
    name: 'Outpatient (OPD)',
    desks: ['triage', 'consultation', 'nursing', 'fp', 'hiv'],
    share: 0.88,
  },
  { id: 'dep-dental', name: 'Dental', desks: ['dental'], share: 0.1 },
  {
    id: 'dep-lab',
    name: 'Laboratory and imaging',
    desks: ['laboratory', 'ultrasound'],
    share: 0.5,
  },
  { id: 'dep-theatre', name: 'Minor surgery', desks: ['surgery', 'circ'], share: 0.05 },
  { id: 'dep-pharmacy', name: 'Pharmacy', desks: ['pharmacy'], share: 0.7 },
]
const DESK_STATION: Record<string, string> = {
  triage: 'triage',
  consultation: 'consultation',
  nursing: 'nursing',
  fp: 'nursing',
  hiv: 'nursing',
  dental: 'dental',
  surgery: 'theatre',
  circ: 'theatre',
  laboratory: 'laboratory',
  ultrasound: 'ultrasound',
  pharmacy: 'pharmacy',
}

interface SamplePerson {
  id: string
  name: string
  role: string
  staffId: string
  departments: string[]
  /** Records per visit of the day, by kind. */
  rates: Partial<Record<ActivityKind, number>>
  /** Share of the day's payments (cashiers). */
  till?: number
  /** Has left: worked up to this day only. */
  leftOn?: string
}
const PEOPLE: SamplePerson[] = [
  {
    id: 'u-rec',
    name: 'Uwimana Josiane',
    role: 'receptionist',
    staffId: 'MMC-S-0001',
    departments: ['dep-opd'],
    rates: { registered: 0.2, charges: 0.55 },
  },
  {
    id: 'p-rec2',
    name: 'Ingabire Diane',
    role: 'receptionist',
    staffId: 'MMC-S-0007',
    departments: ['dep-opd'],
    rates: { registered: 0.13, charges: 0.35 },
  },
  {
    id: 'u-nur',
    name: 'Nyirahabimana Chantal',
    role: 'nurse',
    staffId: 'MMC-S-0002',
    departments: ['dep-opd'],
    rates: {
      vitals: 0.55,
      patientsSeen: 0.1,
      procedures: 0.04,
      tasksDone: 0.12,
      vaccinations: 0.05,
      familyPlanning: 0.03,
    },
  },
  {
    id: 'p-nur2',
    name: 'Habimana Eric',
    role: 'nurse',
    staffId: 'MMC-S-0008',
    departments: ['dep-opd', 'dep-theatre'],
    rates: {
      vitals: 0.38,
      patientsSeen: 0.08,
      procedures: 0.06,
      admissions: 0.04,
      tasksDone: 0.08,
      hivTests: 0.04,
    },
  },
  {
    id: 'u-doc',
    name: 'Dr. Mukamana Béatrice',
    role: 'doctor',
    staffId: 'MMC-S-0003',
    departments: ['dep-opd'],
    rates: {
      patientsSeen: 0.42,
      diagnoses: 0.5,
      prescriptions: 0.75,
      orders: 0.35,
      procedures: 0.02,
    },
  },
  {
    id: 'p-doc2',
    name: 'Dr. Niyonsenga Patrick',
    role: 'doctor',
    staffId: 'MMC-S-0009',
    departments: ['dep-opd', 'dep-theatre'],
    rates: {
      patientsSeen: 0.3,
      diagnoses: 0.35,
      prescriptions: 0.5,
      orders: 0.25,
      procedures: 0.03,
    },
  },
  {
    id: 'u-head',
    name: 'Dr. Ndayisaba Félix',
    role: 'doctor',
    staffId: 'MMC-S-0006',
    departments: ['dep-dental'],
    rates: {
      patientsSeen: 0.1,
      diagnoses: 0.08,
      prescriptions: 0.07,
      procedures: 0.06,
      orders: 0.01,
    },
  },
  {
    id: 'p-den2',
    name: 'Mukeshimana Sandrine',
    role: 'nurse',
    staffId: 'MMC-S-0010',
    departments: ['dep-dental'],
    rates: { patientsSeen: 0.02, procedures: 0.03, tasksDone: 0.02, vitals: 0.02 },
  },
  {
    id: 'p-lab',
    name: 'Uwase Clarisse',
    role: 'lab_tech',
    staffId: 'MMC-S-0011',
    departments: ['dep-lab'],
    rates: { results: 0.42 },
  },
  {
    id: 'p-lab2',
    name: 'Kayitare Jean',
    role: 'lab_tech',
    staffId: 'MMC-S-0012',
    departments: ['dep-lab'],
    rates: { results: 0.25 },
    leftOn: '2026-09-15',
  },
  {
    id: 'p-sono',
    name: 'Mutesi Ange',
    role: 'sonographer',
    staffId: 'MMC-S-0013',
    departments: ['dep-lab'],
    rates: { patientsSeen: 0.06, results: 0.06 },
  },
  {
    id: 'p-pha',
    name: 'Mutoni Aline',
    role: 'pharmacist',
    staffId: 'MMC-S-0014',
    departments: ['dep-pharmacy'],
    rates: { medicinesGiven: 0.7 },
  },
  {
    id: 'u-cash',
    name: 'Mugisha Samuel',
    role: 'cashier',
    staffId: 'MMC-S-0004',
    departments: [],
    rates: {},
    till: 0.6,
  },
  {
    id: 'p-cash2',
    name: 'Iradukunda Grace',
    role: 'cashier',
    staffId: 'MMC-S-0015',
    departments: [],
    rates: {},
    till: 0.4,
  },
  {
    id: 'u-mgr',
    name: 'Mugabo Théogène',
    role: 'manager',
    staffId: 'MMC-S-0005',
    departments: [],
    rates: { charges: 0.01 },
  },
]
const depName = (id: string) => SAMPLE_DEPARTMENTS.find((d) => d.id === id)?.name ?? id
const isActive = (p: SamplePerson) => !p.leftOn
const lastSignIn = (p: SamplePerson) =>
  p.leftOn ? at(shift(p.leftOn, -1), 7 * 60 + 50) : at(todayIso(), 7 * 60 + 30 + (hash(p.id) % 50))

/** One person's work on one day: n (and money) per kind. */
function personDay(
  p: SamplePerson,
  day: string,
  money: boolean,
): { kind: ActivityKind; n: number; amount: number | null }[] {
  if (p.leftOn && day >= p.leftOn) return []
  const d = sampleDay(day)
  if (!d.visits) return []
  const out: { kind: ActivityKind; n: number; amount: number | null }[] = []
  for (const [kind, rate] of Object.entries(p.rates) as [ActivityKind, number][]) {
    const n = Math.round(d.visits * rate * (0.8 + 0.4 * rng(`${p.id}${day}${kind}`)()))
    if (n > 0) out.push({ kind, n, amount: null })
  }
  // the pharmacy hands over the counter sales
  if (p.role === 'pharmacist' && money && d.counterCount)
    out.push({ kind: 'handovers', n: d.counterCount, amount: d.counterSales })
  if (p.till && money) {
    const first = p.till >= 0.5
    const total = collectedOf(d)
    const amount = first ? r100(total * p.till) : total - r100(total * (1 - p.till))
    const count = first
      ? Math.round(d.payments * p.till)
      : d.payments - Math.round(d.payments * (1 - p.till))
    if (count) out.push({ kind: 'payments', n: count, amount })
    // refunds and cancelled payments: the first cashier on even days, the other on odd ones
    const mine = (parseDay(day).getDate() % 2 === 0) === first
    if (mine && d.refundCount) out.push({ kind: 'refunds', n: d.refundCount, amount: d.refunds })
    if (mine && d.voidedCount) out.push({ kind: 'voided', n: d.voidedCount, amount: d.voided })
  }
  return out
}

// ------------------------------------------------------------------ scope

/** The sample department a head leads (by the name they head, else the dental one). */
function headDepartment(user: StaffUser | null) {
  const want = (user?.headOf ?? '').toLowerCase()
  return (
    SAMPLE_DEPARTMENTS.find((d) => want && d.name.toLowerCase().includes(want)) ??
    SAMPLE_DEPARTMENTS.find((d) => d.id === 'dep-dental')!
  )
}
const viewsFor = (desks: string[]): AnalyticsView[] => [
  'staff',
  'visits',
  'treatments',
  ...(desks.some((x) => x === 'laboratory' || x === 'ultrasound') ? (['lab'] as const) : []),
  ...(desks.includes('pharmacy') ? (['pharmacy'] as const) : []),
  ...(desks.includes('triage') ? (['triage'] as const) : []),
  ...(desks.includes('pharmacy') ? (['stock'] as const) : []),
  'waiting',
]

export function sampleAccess(user: StaffUser | null): AnalyticsAccess {
  const manager = !!user && (user.role === 'manager' || user.dashboard === 'manager')
  const strip = ({ id, name, desks }: AnalyticsDepartment) => ({ id, name, desks })
  if (manager)
    return {
      manager,
      departments: SAMPLE_DEPARTMENTS.map(strip),
      views: [
        'revenue',
        'staff',
        'visits',
        'treatments',
        'lab',
        'pharmacy',
        'triage',
        'stock',
        'waiting',
      ],
      fallback: false,
    }
  if (user?.dashboard === 'head') {
    const d = headDepartment(user)
    return { manager, departments: [strip(d)], views: viewsFor(d.desks), fallback: false }
  }
  return { manager: false, departments: [], views: [], fallback: false }
}

const notAllowed = () =>
  new ApiError('not allowed', {
    code: '42501',
    hint: null,
    kind: null,
    line: null,
    serverMessage: 'not allowed',
  })

/** As analytics_scope: the manager, everything or the department picked; a head, theirs. */
async function scope(departmentId: string | null) {
  const user = useSession.getState().user
  const manager = !!user && (user.role === 'manager' || user.dashboard === 'manager')
  if (manager) {
    const dept = departmentId
      ? (SAMPLE_DEPARTMENTS.find((d) => d.id === departmentId) ?? null)
      : null
    return { manager, dept }
  }
  if (user?.dashboard !== 'head') throw notAllowed()
  const mine = headDepartment(user)
  if (departmentId && departmentId !== mine.id) throw notAllowed()
  return { manager, dept: mine }
}
const stationsOf = (dept: AnalyticsDepartment | null): string[] | null =>
  dept ? [...new Set(dept.desks.map((d) => DESK_STATION[d]).filter((s): s is string => !!s))] : null

// ------------------------------------------------------------------ revenue

const CATEGORIES = [
  {
    id: 'cat-cons',
    group: 'consultation',
    name: 'Consultation',
    kin: 'Kwisuzumisha',
    fr: 'Consultation',
    share: 0.3,
    price: 7800,
    dept: 'dep-opd',
  },
  {
    id: 'cat-lab',
    group: 'lab',
    name: 'Laboratory',
    kin: 'Laboratwari',
    fr: 'Laboratoire',
    share: 0.2,
    price: 3200,
    dept: 'dep-lab',
  },
  {
    id: null,
    group: 'pharmacy',
    name: null,
    kin: null,
    fr: null,
    share: 0.25,
    price: 1600,
    dept: 'dep-pharmacy',
  },
  {
    id: 'cat-den',
    group: 'dental',
    name: 'Dental',
    kin: 'Amenyo',
    fr: 'Dentaire',
    share: 0.08,
    price: 12500,
    dept: 'dep-dental',
  },
  {
    id: 'cat-nur',
    group: 'nursing',
    name: 'Nursing care',
    kin: 'Ubuforomo',
    fr: 'Soins infirmiers',
    share: 0.06,
    price: 2800,
    dept: 'dep-opd',
  },
  {
    id: 'cat-img',
    group: 'imaging',
    name: 'Ultrasound',
    kin: 'Echographie',
    fr: 'Échographie',
    share: 0.06,
    price: 19000,
    dept: 'dep-lab',
  },
  {
    id: 'cat-proc',
    group: 'procedure',
    name: 'Minor surgery',
    kin: 'Kubaga gutoya',
    fr: 'Petite chirurgie',
    share: 0.035,
    price: 16000,
    dept: 'dep-theatre',
  },
  {
    id: 'cat-fp',
    group: 'other',
    name: 'Family planning',
    kin: 'Kuboneza urubyaro',
    fr: 'Planification familiale',
    share: 0.015,
    price: 2000,
    dept: null,
  },
] as const

const REFUND_REASONS = [
  'Test not done (reagent out of stock)',
  'Paid twice by MoMo',
  'Medicine returned unopened',
  'Overpaid in cash',
]
const VOID_REASONS = [
  'Wrong amount typed',
  'Wrong patient',
  'Payment recorded twice',
  'MoMo payment failed',
]
const DISCOUNT_REASONS = ['Staff family', 'Social case (approved)', 'Follow-up within 7 days', null]

function totalsOf(p: AnalyticsPeriod): RevenueTotals {
  const t = {
    collected: 0,
    refunded: 0,
    refunds: 0,
    voided: 0,
    voidedCount: 0,
    payments: 0,
    paidVisits: 0,
    counterSales: 0,
    charged: 0,
    discounts: 0,
    creditNotes: 0,
  }
  for (const day of activeDays(p)) {
    const d = sampleDay(day)
    t.collected += collectedOf(d)
    t.refunded += d.refunds
    t.refunds += d.refundCount
    t.voided += d.voided
    t.voidedCount += d.voidedCount
    t.payments += d.payments
    t.paidVisits += d.paidVisits
    t.counterSales += d.counterSales
    t.charged += d.charged
    t.discounts += d.discounts
    t.creditNotes += d.creditNote
  }
  const bills = t.collected - t.counterSales
  return {
    ...t,
    net: t.collected - t.refunded,
    bills,
    avgPerVisit: t.paidVisits ? Math.round(bills / t.paidVisits) : null,
  }
}

/** Per day: collected, refunds and net (the dashboard's Revenue by day). */
export function sampleRevenueDays(p: AnalyticsPeriod) {
  return daysOf(p).map((day) => {
    const d = sampleDay(day)
    const amount = collectedOf(d)
    return { day, amount, refunds: d.refunds, net: amount - d.refunds }
  })
}
/** The money tiles of the dashboard (collected and refunded in a period). */
export const sampleRevenueTotals = (p: AnalyticsPeriod) => totalsOf(p)

export function sampleRevenueAnalysis(period: AnalyticsPeriod): RevenueAnalysis {
  const p = ordered(period)
  const prev = prevOf(p)
  const totals = totalsOf(p)
  const all = daysOf(p)
  const dayList = all.length <= 400 ? all : activeDays(p)
  const days = dayList.map((day) => {
    const d = sampleDay(day)
    return {
      day,
      cash: d.cash,
      momo: d.momo,
      airtel: d.airtel,
      other: d.other,
      payments: d.payments,
      refunds: d.refunds,
      voided: d.voided,
      net: collectedOf(d) - d.refunds,
      visits: d.paidVisits,
      counterSales: d.counterSales,
    }
  })
  const sum = (k: 'cash' | 'momo' | 'airtel' | 'other') => days.reduce((s, d) => s + d[k], 0)
  const methods = (['cash', 'momo', 'airtel', 'other'] as const)
    .map((m) => ({ method: m === 'other' ? 'card' : m, amount: sum(m) }))
    .filter((m) => m.amount > 0)
    .sort((a, b) => b.amount - a.amount)
  const byMethod = methods.map((m) => ({
    ...m,
    count: totals.collected ? Math.round((totals.payments * m.amount) / totals.collected) : 0,
    share: totals.collected ? r1((100 * m.amount) / totals.collected) : 0,
  }))
  const counterCount = activeDays(p).reduce((s, d) => s + sampleDay(d).counterCount, 0)
  const byCategory = CATEGORIES.map((c) => {
    const charged = r100(totals.charged * c.share)
    return {
      id: c.id,
      group: c.group,
      name: c.name,
      nameKin: c.kin,
      nameFr: c.fr,
      charged,
      collectedEst: r100(totals.bills * c.share),
      lines: Math.round(charged / c.price),
    }
  }).filter((c) => c.charged > 0)
  const byDept = new Map<
    string,
    {
      id: string | null
      key: 'department' | 'pharmacy' | 'none'
      name: string | null
      charged: number
      collectedEst: number
      lines: number
    }
  >()
  for (const c of byCategory) {
    const cat = CATEGORIES.find((x) => x.id === c.id)!
    const k = cat.dept ?? 'none'
    const row = byDept.get(k) ?? {
      id: cat.dept,
      key: cat.dept ? 'department' : 'none',
      name: cat.dept ? depName(cat.dept) : null,
      charged: 0,
      collectedEst: 0,
      lines: 0,
    }
    row.charged += c.charged
    row.collectedEst += c.collectedEst
    row.lines += c.lines
    byDept.set(k, row)
  }
  const owedOpen = r100(Math.max(0, totals.charged - totals.discounts - totals.bills) * 0.4)
  const insured = Math.round(totals.paidVisits * 0.04)
  const byPayer = [
    {
      payerId: null,
      name: null,
      type: 'cash',
      bills: totals.paidVisits - insured * 2,
      patientShare: r100(totals.charged * 0.94),
      insurerShare: 0,
      paid: r100(totals.bills * 0.95),
      owed: owedOpen,
    },
    {
      payerId: 'payer-rama',
      name: 'RSSB RAMA',
      type: 'rssb_rama',
      bills: insured,
      patientShare: r100(totals.charged * 0.006),
      insurerShare: r100(totals.charged * 0.024),
      paid: r100(totals.bills * 0.03),
      owed: r100(totals.charged * 0.012),
    },
    {
      payerId: 'payer-mmi',
      name: 'MMI',
      type: 'mmi',
      bills: insured,
      patientShare: r100(totals.charged * 0.003),
      insurerShare: r100(totals.charged * 0.027),
      paid: r100(totals.bills * 0.02),
      owed: r100(totals.charged * 0.009),
    },
  ].filter((x) => x.bills > 0)
  const cashiers = PEOPLE.filter((x) => x.till)
  const byCashier = cashiers.map((c) => {
    const work = activeDays(p).flatMap((d) => personDay(c, d, true))
    const of = (k: ActivityKind) => work.filter((w) => w.kind === k)
    const closes = activeDays(p).filter((d) => of('payments').length && rng(`c${c.id}${d}`)() < 0.9)
    return {
      id: c.id,
      name: c.name,
      payments: of('payments').reduce((s, w) => s + w.n, 0),
      amount: of('payments').reduce((s, w) => s + (w.amount ?? 0), 0),
      refunds: of('refunds').reduce((s, w) => s + (w.amount ?? 0), 0),
      voided: of('voided').reduce((s, w) => s + w.n, 0),
      variance: closes.length
        ? closes.reduce((s, d) => s + (rng(`v${c.id}${d}`)() < 0.12 ? -500 : 0), 0)
        : null,
    }
  })
  const discountDays = activeDays(p).filter((d) => sampleDay(d).discountLines)
  const byReason = DISCOUNT_REASONS.map((reason, i) => {
    const ds = discountDays.filter((d) => hash(d) % DISCOUNT_REASONS.length === i)
    return {
      reason,
      lines: ds.reduce((s, d) => s + sampleDay(d).discountLines, 0),
      amount: ds.reduce((s, d) => s + sampleDay(d).discounts, 0),
    }
  })
    .filter((x) => x.lines > 0)
    .sort((a, b) => b.amount - a.amount)
  const newest = [...activeDays(p)].reverse()
  const cashierOn = (day: string) =>
    (parseDay(day).getDate() % 2 === 0 ? cashiers[0] : cashiers[1])?.name ?? null
  const refunds = newest
    .filter((d) => sampleDay(d).refundCount)
    .slice(0, 200)
    .map((day) => {
      const r = rng(`rf${day}`)
      const pt = patientOf(`rf${day}`)
      return {
        id: `rf-${day}`,
        at: at(day, 9 * 60 + r() * 480),
        amount: sampleDay(day).refunds,
        method: r() < 0.6 ? 'cash' : 'momo',
        reason: pick(REFUND_REASONS, r),
        by: cashierOn(day),
        invoiceId: `inv-${day}`,
        encounterId: `e-${day}`,
        patient: pt.name,
        fileNumber: pt.file,
      }
    })
  const creditNotes = newest
    .filter((d) => sampleDay(d).creditNote)
    .slice(0, 200)
    .map((day, i) => {
      const pt = patientOf(`cn${day}`)
      const amount = sampleDay(day).creditNote
      return {
        id: `cn-${day}`,
        at: at(day, 11 * 60 + i),
        number: `CN-2026-${String(40 - i).padStart(4, '0')}`,
        amount,
        patientAmount: amount,
        insurerAmount: 0,
        reason: 'Service charged by mistake',
        by: 'Mugabo Théogène',
        invoiceId: `inv-cn-${day}`,
        encounterId: `e-cn-${day}`,
        patient: pt.name,
        fileNumber: pt.file,
      }
    })
  const voided = newest
    .filter((d) => sampleDay(d).voidedCount)
    .slice(0, 200)
    .map((day, i) => {
      const r = rng(`vd${day}`)
      const pt = patientOf(`vd${day}`)
      const paid = 8 * 60 + r() * 420
      return {
        id: `vd-${day}`,
        at: at(day, paid + 5 + r() * 40),
        paidAt: at(day, paid),
        amount: sampleDay(day).voided,
        method: r() < 0.5 ? 'cash' : 'momo',
        reason: pick(VOID_REASONS, r),
        by: 'Mugabo Théogène',
        cashier: cashierOn(day),
        receiptNo: `R-2026-${String(9000 - i * 13).padStart(6, '0')}`,
        encounterId: `e-vd-${day}`,
        patient: pt.name,
        fileNumber: pt.file,
      }
    })
  const t = todayIso()
  const debtsTop = Array.from({ length: 10 }, (_, i) => {
    const pt = patientOf(`debt${i}`)
    const open = i < 6
    return {
      invoiceId: `inv-debt-${i}`,
      number: open ? null : `INV-2026-${String(2100 - i * 7).padStart(5, '0')}`,
      encounterId: `e-debt-${i}`,
      patient: pt.name,
      fileNumber: pt.file,
      due: r100(42000 - i * 3600),
      open,
      arrivedAt: at(shift(t, open ? 0 : -(i * 3)), 8 * 60 + i * 23),
    }
  })
  return {
    needsUpdate: false,
    from: p.from,
    to: p.to,
    prevFrom: prev.from,
    prevTo: prev.to,
    totals,
    prev: totalsOf(prev),
    days,
    byMethod,
    bySource: {
      bills: { amount: totals.bills, count: totals.payments - counterCount },
      counterSales: { amount: totals.counterSales, count: counterCount },
    },
    byCategory,
    byDepartment: [...byDept.values()].sort((a, b) => b.charged - a.charged),
    byPayer,
    byCashier,
    discounts: {
      lines: discountDays.reduce((s, d) => s + sampleDay(d).discountLines, 0),
      amount: totals.discounts,
      byReason,
    },
    refunds,
    creditNotes,
    voided,
    debts: {
      openCount: 6,
      openDue: debtsTop.filter((d) => d.open).reduce((s, d) => s + d.due, 0),
      closedCount: 4,
      closedDue: debtsTop.filter((d) => !d.open).reduce((s, d) => s + d.due, 0),
      top: debtsTop,
    },
  }
}

// ------------------------------------------------------------------ who did what

const KINDS_WORK: ActivityKind[] = [
  'registered',
  'vitals',
  'patientsSeen',
  'diagnoses',
  'prescriptions',
  'orders',
  'results',
  'procedures',
  'medicinesGiven',
  'charges',
  'admissions',
  'tasksDone',
  'vaccinations',
  'hivTests',
  'familyPlanning',
]
const KINDS_MONEY: ActivityKind[] = ['payments', 'refunds', 'voided', 'handovers']
const kindsFor = (money: boolean) => (money ? [...KINDS_WORK, ...KINDS_MONEY] : [...KINDS_WORK])
const isRecord = (k: ActivityKind) => k !== 'patientsSeen' && !KINDS_MONEY.includes(k)

/** The people of a scope (null = everyone) with their counts in a period. */
function buildStaff(p: AnalyticsPeriod, members: string[] | null, money: boolean) {
  const kinds = kindsFor(money)
  const days = activeDays(p)
  const rows: StaffActivity['days'] = []
  const people: ActivityPerson[] = []
  for (const person of PEOPLE) {
    if (members && !members.includes(person.id)) continue
    const counts: Record<string, number> = Object.fromEntries(kinds.map((k) => [k, 0]))
    let amount = 0
    for (const day of days) {
      for (const w of personDay(person, day, money)) {
        counts[w.kind] = (counts[w.kind] ?? 0) + w.n
        if (w.kind === 'payments') amount += w.amount ?? 0
        rows.push({ day, userId: person.id, kind: w.kind, n: w.n, amount: money ? w.amount : null })
      }
    }
    const any = Object.values(counts).some((n) => n > 0)
    if (!isActive(person) && !any) continue
    people.push({
      id: person.id,
      name: person.name,
      role: person.role,
      staffId: person.staffId,
      departments: person.departments.map((id) => ({ id, name: depName(id) })),
      active: isActive(person),
      lastSignIn: lastSignIn(person),
      counts,
      records: kinds.filter(isRecord).reduce((s, k) => s + (counts[k] ?? 0), 0),
      amount: money ? amount : null,
    })
  }
  people.sort((a, b) => b.records - a.records || a.name.localeCompare(b.name))
  const totals: Record<string, number> = Object.fromEntries(
    kinds.map((k) => [k, people.reduce((s, x) => s + (x.counts[k] ?? 0), 0)]),
  )
  return { kinds, people, days: rows, totals }
}

/** The dashboard's "Who did what" rows, from the same people. */
export function sampleDashboardStaff(p: AnalyticsPeriod, manager: boolean) {
  return buildStaff(p, null, manager).people.map((x) => ({
    id: x.id,
    name: x.name,
    role: x.role,
    staffId: x.staffId,
    active: x.active,
    registrations: x.counts.registered ?? 0,
    vitals: x.counts.vitals ?? 0,
    charges: x.counts.charges ?? 0,
    patients: x.counts.patientsSeen ?? 0,
    results: x.counts.results ?? 0,
    dispensed: x.counts.medicinesGiven ?? 0,
    payments: manager ? (x.counts.payments ?? 0) : null,
    collected: manager ? (x.amount ?? 0) : null,
    lastSignIn: x.lastSignIn,
  }))
}
/** The dashboard's sign-ins of the last day. */
export function sampleLogins() {
  return PEOPLE.filter(isActive)
    .slice(0, 10)
    .map((p, i) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      at: lastSignIn(p),
      reason: i === 3 ? 'wrong PIN (1 of 5)' : null,
    }))
    .sort((a, b) => b.at.localeCompare(a.at))
}

const membersOf = (dept: AnalyticsDepartment | null) =>
  dept ? PEOPLE.filter((x) => x.departments.includes(dept.id)).map((x) => x.id) : null

export async function sampleStaffActivity(
  period: AnalyticsPeriod,
  departmentId: string | null,
): Promise<StaffActivity> {
  const { manager, dept } = await scope(departmentId)
  const p = ordered(period)
  const s = buildStaff(p, membersOf(dept), manager)
  const seen = s.totals.patientsSeen ?? 0
  return {
    needsUpdate: false,
    from: p.from,
    to: p.to,
    manager,
    department: dept?.id ?? null,
    ...s,
    summary: {
      peopleActive: s.people.filter((x) => Object.values(x.counts).some((n) => n > 0)).length,
      // a visit seen by two people counts once
      patientsSeen: Math.round(seen * 0.9),
      records: s.people.reduce((n, x) => n + x.records, 0),
      collected: manager ? s.people.reduce((n, x) => n + (x.amount ?? 0), 0) : null,
    },
  }
}

const DIAGNOSES = [
  'B54 Malaria',
  'J06.9 Upper respiratory tract infection',
  'N39.0 Urinary tract infection',
  'I10 Hypertension',
  'A09 Gastroenteritis',
  'K29.7 Gastritis',
  'L08.9 Skin infection',
]
const MEDICINES = [
  'Paracetamol 500 mg tabs · 1 g three times a day',
  'Amoxicillin 500 mg caps · 500 mg three times a day',
  'Artemether-lumefantrine 20/120 mg tabs · 4 tabs twice a day',
  'ORS sachet · after each loose stool',
  'Ibuprofen 400 mg tabs · 400 mg three times a day',
]
const TESTS = [
  'Malaria RDT',
  'Full blood count',
  'Urinalysis',
  'Blood glucose',
  'Widal test',
  'Stool examination',
]
const PROCEDURES = [
  'Wound dressing',
  'Suturing',
  'Tooth extraction',
  'Incision and drainage',
  'IV cannulation',
]
const TASKS = [
  'Give IV fluids',
  'Check blood pressure again',
  'Second dose of injection',
  'Remove the drip',
]

function whatOf(kind: ActivityKind, r: () => number, day: string, i: number): string | null {
  switch (kind) {
    case 'vitals':
      return `BP ${110 + Math.floor(r() * 40)}/${70 + Math.floor(r() * 20)} · T ${(36.2 + r() * 2).toFixed(1)} °C`
    case 'patientsSeen':
      return `V-${day.replace(/-/g, '').slice(2)}-${String(i + 1).padStart(3, '0')}`
    case 'diagnoses':
      return pick(DIAGNOSES, r)
    case 'prescriptions':
      return pick(MEDICINES, r)
    case 'orders':
    case 'results':
      return pick(TESTS, r)
    case 'procedures':
      return pick(PROCEDURES, r)
    case 'medicinesGiven':
      return `${pick(MEDICINES, r).split(' · ')[0]} × ${pick([6, 10, 12, 15, 21, 24], r)}`
    case 'charges':
      return pick(['General consultation', 'Malaria RDT', 'Full blood count', 'Wound dressing'], r)
    case 'admissions':
      return `Bed ${1 + Math.floor(r() * 8)}`
    case 'tasksDone':
      return pick(TASKS, r)
    case 'vaccinations':
      return pick(['Tetanus (TT)', 'Hepatitis B', 'HPV'], r)
    case 'familyPlanning':
      return pick(['Depo-Provera', 'Implant', 'Pills'], r)
    case 'payments':
    case 'refunds':
      return pick(['cash', 'momo', 'momo', 'airtel'], r)
    case 'voided':
      return pick(VOID_REASONS, r)
    case 'handovers':
      return `CS-${day.replace(/-/g, '').slice(4)}${String(i + 1).padStart(2, '0')}`
    default:
      return null
  }
}

export async function sampleStaffActivityDetail(
  userId: string,
  period: AnalyticsPeriod,
  kind: ActivityKind | null,
  limit: number,
): Promise<StaffActivityDetail> {
  const { manager, dept } = await scope(null)
  const person = PEOPLE.find((x) => x.id === userId)
  if (!person || (!manager && dept && !person.departments.includes(dept.id))) throw notAllowed()
  const p = ordered(period)
  const kinds = kindsFor(manager)
  const counts: Record<string, number> = Object.fromEntries(kinds.map((k) => [k, 0]))
  const days: StaffActivityDetail['days'] = []
  const records: ActivityRecord[] = []
  const newest = [...activeDays(p)].reverse()
  for (const day of newest) {
    const work = personDay(person, day, manager)
    for (const w of work) {
      counts[w.kind] = (counts[w.kind] ?? 0) + w.n
      days.push({ day, kind: w.kind, n: w.n })
      if ((kind && w.kind !== kind) || records.length >= limit) continue
      for (let i = 0; i < w.n; i++) {
        const r = rng(`${person.id}${day}${w.kind}${i}`)
        const pt = patientOf(`${day}${w.kind}${i}`)
        const hidden = w.kind === 'hivTests' && !manager
        const each = w.amount != null ? r100(w.amount / w.n) : null
        records.push({
          at: at(day, 7 * 60 + 40 + r() * 600),
          kind: w.kind,
          encounterId: w.kind === 'registered' || w.kind === 'handovers' ? null : `e-${day}-${i}`,
          patientId: hidden || w.kind === 'handovers' ? null : pt.id,
          patientName: hidden || w.kind === 'handovers' ? null : pt.name,
          fileNumber: hidden || w.kind === 'handovers' ? null : pt.file,
          what: hidden ? null : whatOf(w.kind, r, day, i),
          amount: manager
            ? w.kind === 'charges'
              ? pick([8000, 2500, 5000, 3000], r)
              : each
            : null,
        })
      }
    }
  }
  records.sort((a, b) => b.at.localeCompare(a.at))
  days.sort((a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind))
  const total = kind ? (counts[kind] ?? 0) : Object.values(counts).reduce((s, n) => s + n, 0)
  const signIns = newest
    .filter(
      (d) =>
        (!person.leftOn || d < person.leftOn) &&
        sampleDay(d).visits &&
        rng(`s${person.id}${d}`)() < 0.85,
    )
    .slice(0, 200)
    .flatMap((d) => {
      const r = rng(`si${person.id}${d}`)
      const ok = { at: at(d, 7 * 60 + 25 + r() * 50), ok: true, reason: null }
      return r() < 0.07
        ? [ok, { at: at(d, 7 * 60 + 20 + r() * 4), ok: false, reason: 'wrong PIN (1 of 5)' }]
        : [ok]
    })
  let money: StaffActivityDetail['money'] = null
  if (manager) {
    const paid = newest.flatMap((d) => personDay(person, d, true).map((w) => ({ ...w, day: d })))
    const pay = paid.filter((w) => w.kind === 'payments')
    const total = pay.reduce((s, w) => s + (w.amount ?? 0), 0)
    const count = pay.reduce((s, w) => s + w.n, 0)
    money = {
      byMethod: total
        ? [
            { method: 'cash', share: 0.5 },
            { method: 'momo', share: 0.4 },
            { method: 'airtel', share: 0.1 },
          ].map((m) => ({
            method: m.method,
            count: Math.round(count * m.share),
            amount: r100(total * m.share),
          }))
        : [],
      refunds: paid
        .filter((w) => w.kind === 'refunds')
        .map((w) => {
          const pt = patientOf(`rf${w.day}`)
          return {
            at: at(w.day, 10 * 60 + 15),
            amount: w.amount ?? 0,
            method: 'cash',
            reason: pick(REFUND_REASONS, rng(`rf${w.day}`)),
            patient: pt.name,
            fileNumber: pt.file,
            encounterId: `e-${w.day}`,
          }
        }),
      voided: paid
        .filter((w) => w.kind === 'voided')
        .map((w) => ({
          at: at(w.day, 12 * 60 + 5),
          paidAt: at(w.day, 11 * 60 + 50),
          amount: w.amount ?? 0,
          method: 'cash',
          reason: pick(VOID_REASONS, rng(`vd${w.day}`)),
          by: 'Mugabo Théogène',
          patient: patientOf(`vd${w.day}`).name,
        })),
      closes: pay.map((w) => {
        const expected = r100((w.amount ?? 0) * 0.5)
        const variance = rng(`v${person.id}${w.day}`)() < 0.12 ? -500 : 0
        return { day: w.day, expected, counted: expected + variance, variance }
      }),
    }
  }
  return {
    needsUpdate: false,
    from: p.from,
    to: p.to,
    person: {
      id: person.id,
      name: person.name,
      role: person.role,
      staffId: person.staffId,
      active: isActive(person),
      lastSignIn: lastSignIn(person),
      departments: person.departments.map((id) => ({ id, name: depName(id) })),
    },
    counts,
    days,
    total,
    records: records.slice(0, limit),
    signIns,
    money,
  }
}

// ------------------------------------------------------------------ visits and treatments

const SERVICES = [
  { d: 'General consultation', cat: 'cat-cons', price: 8000, rate: 0.62 },
  { d: 'Follow-up consultation', cat: 'cat-cons', price: 4000, rate: 0.14 },
  { d: 'Specialist consultation', cat: 'cat-cons', price: 15000, rate: 0.03 },
  { d: 'Malaria RDT', cat: 'cat-lab', price: 2500, rate: 0.28 },
  { d: 'Full blood count', cat: 'cat-lab', price: 5000, rate: 0.16 },
  { d: 'Urinalysis', cat: 'cat-lab', price: 3000, rate: 0.1 },
  { d: 'Blood glucose', cat: 'cat-lab', price: 2000, rate: 0.08 },
  { d: 'Widal test', cat: 'cat-lab', price: 4000, rate: 0.05 },
  { d: 'Stool examination', cat: 'cat-lab', price: 3000, rate: 0.04 },
  { d: 'Abdominal ultrasound', cat: 'cat-img', price: 20000, rate: 0.03 },
  { d: 'Obstetric ultrasound', cat: 'cat-img', price: 18000, rate: 0.03 },
  { d: 'Injection (IM/IV)', cat: 'cat-nur', price: 1500, rate: 0.09 },
  { d: 'Wound dressing', cat: 'cat-nur', price: 3000, rate: 0.06 },
  { d: 'IV infusion', cat: 'cat-nur', price: 6000, rate: 0.03 },
  { d: 'Dental consultation', cat: 'cat-den', price: 7000, rate: 0.07 },
  { d: 'Tooth extraction', cat: 'cat-den', price: 15000, rate: 0.03 },
  { d: 'Scaling and polishing', cat: 'cat-den', price: 25000, rate: 0.01 },
  { d: 'Composite filling', cat: 'cat-den', price: 30000, rate: 0.01 },
  { d: 'Suturing', cat: 'cat-proc', price: 10000, rate: 0.02 },
  { d: 'Incision and drainage', cat: 'cat-proc', price: 15000, rate: 0.01 },
  { d: 'Circumcision', cat: 'cat-proc', price: 35000, rate: 0.008 },
  { d: 'Depo-Provera injection', cat: 'cat-fp', price: 1000, rate: 0.02 },
  { d: 'Implant insertion', cat: 'cat-fp', price: 5000, rate: 0.005 },
  { d: 'Paracetamol 500 mg tabs', cat: null, price: 500, rate: 0.35 },
  { d: 'Amoxicillin 500 mg caps', cat: null, price: 2500, rate: 0.2 },
  { d: 'Artemether-lumefantrine 20/120 mg tabs', cat: null, price: 3000, rate: 0.12 },
  { d: 'ORS sachet', cat: null, price: 300, rate: 0.06 },
] as const
const catOf = (id: string | null) => CATEGORIES.find((c) => c.id === id)

function visitTotals(p: AnalyticsPeriod, share: number): VisitsTotals {
  const t: VisitsTotals = {
    registered: 0,
    visits: 0,
    newPatients: 0,
    returning: 0,
    booked: 0,
    kept: 0,
    missed: 0,
    pending: 0,
  }
  for (const day of activeDays(p)) {
    const d = sampleDay(day)
    const v = Math.round(d.visits * share)
    const np = Math.round(d.newPatients * share)
    t.visits += v
    t.newPatients += np
    t.returning += v - np
    t.registered += Math.round(d.registered * share)
    t.booked += Math.round(d.booked * share)
    t.kept += Math.round(d.kept * share)
    t.missed += Math.round(d.missed * share)
    t.pending += Math.round(d.pending * share)
  }
  return t
}

/** Visits by service group (distinct visits, never more than the visits). */
export function sampleVisitsByGroup(p: AnalyticsPeriod) {
  const visits = visitTotals(p, 1).visits
  return CATEGORIES.map((c) => {
    const rate = SERVICES.filter((s) => s.cat === c.id).reduce((s, x) => s + x.rate, 0)
    return {
      group: c.group,
      categoryId: c.id,
      name: c.name,
      nameKin: c.kin,
      nameFr: c.fr,
      count: Math.round(visits * Math.min(0.95, rate * 0.9)),
    }
  })
    .filter((g) => g.count > 0)
    .sort((a, b) => b.count - a.count)
}

function treatmentsOf(
  p: AnalyticsPeriod,
  dept: AnalyticsDepartment | null,
  money: boolean,
): Treatment[] {
  const visits = visitTotals(p, 1).visits
  return SERVICES.filter((s) => !dept || catOf(s.cat)?.dept === dept.id)
    .map((s) => {
      const c = catOf(s.cat)
      const count = Math.round(visits * s.rate * (0.9 + 0.2 * rng(`t${s.d}${p.from}`)()))
      return {
        description: s.d,
        categoryId: s.cat,
        category: c?.name ?? null,
        categoryKin: c?.kin ?? null,
        categoryFr: c?.fr ?? null,
        count,
        amount: money ? count * s.price : null,
      }
    })
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count || a.description.localeCompare(b.description))
}
/** The dashboard's "Top treatments". */
export const sampleTopTreatments = (p: AnalyticsPeriod, manager: boolean) =>
  treatmentsOf(p, null, manager)
    .slice(0, 10)
    .map((x) => ({ name: x.description, count: x.count, amount: x.amount }))
/** The dashboard's visit tiles. */
export const sampleVisitTotals = (p: AnalyticsPeriod) => visitTotals(ordered(p), 1)

const HOURS = [0, 0, 0, 0, 0, 0, 1, 5, 11, 13, 11, 9, 6, 6, 8, 7, 5, 3, 2, 1, 0, 0, 0, 0]

export async function sampleVisitsAnalysis(
  period: AnalyticsPeriod,
  departmentId: string | null,
): Promise<VisitsAnalysis> {
  const { manager, dept } = await scope(departmentId)
  const p = ordered(period)
  const prev = prevOf(p)
  const share = dept ? (SAMPLE_DEPARTMENTS.find((d) => d.id === dept.id)?.share ?? 1) : 1
  const totals = visitTotals(p, share)
  const all = daysOf(p)
  const days = (all.length <= 400 ? all : activeDays(p)).map((day) => {
    const d = sampleDay(day)
    const visits = Math.round(d.visits * share)
    const newPatients = Math.round(d.newPatients * share)
    const byType =
      dept?.id === 'dep-dental'
        ? visits
          ? { dental: visits }
          : {}
        : Object.fromEntries(
            Object.entries(d.byType)
              .map(([k, n]) => [k, Math.round(n * share)])
              .filter(([, n]) => Number(n) > 0),
          )
    return {
      day,
      visits,
      newPatients,
      returning: visits - newPatients,
      registered: Math.round(d.registered * share),
      byType: byType as Record<string, number>,
    }
  })
  const byTypeMap = new Map<string, number>()
  for (const d of days)
    for (const [k, n] of Object.entries(d.byType)) byTypeMap.set(k, (byTypeMap.get(k) ?? 0) + n)
  const hourSum = HOURS.reduce((s, n) => s + n, 0)
  const byHour = HOURS.map((h) => Math.round((totals.visits * h) / hourSum))
  const treatments = treatmentsOf(p, dept, manager)
  // distinct visits: never more than the department's visits
  const groups = sampleVisitsByGroup(p)
    .filter((g) => !dept || catOf(g.categoryId)?.dept === dept.id)
    .map((g) => ({ ...g, count: Math.min(g.count, totals.visits) }))
  return {
    needsUpdate: false,
    from: p.from,
    to: p.to,
    manager,
    department: dept?.id ?? null,
    totals,
    prev: visitTotals(prev, share),
    prevFrom: prev.from,
    prevTo: prev.to,
    days,
    byGroup: groups,
    byType: [...byTypeMap.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    byHour,
    treatmentTotals: {
      lines: treatments.reduce((s, x) => s + x.count, 0),
      distinct: treatments.length,
      charged: manager ? treatments.reduce((s, x) => s + (x.amount ?? 0), 0) : null,
    },
    treatments: treatments.slice(0, 300),
  }
}

// ------------------------------------------------------------------ waiting times

const DESK_WAITS = [
  { station: 'triage', rate: 0.92, median: 7, sigma: 0.55 },
  { station: 'consultation', rate: 0.8, median: 22, sigma: 0.6 },
  { station: 'dental', rate: 0.1, median: 16, sigma: 0.55 },
  { station: 'theatre', rate: 0.04, median: 30, sigma: 0.5 },
  { station: 'nursing', rate: 0.18, median: 11, sigma: 0.6 },
  { station: 'laboratory', rate: 0.45, median: 14, sigma: 0.6 },
  { station: 'ultrasound', rate: 0.06, median: 26, sigma: 0.5 },
  { station: 'pharmacy', rate: 0.72, median: 8, sigma: 0.6 },
  { station: 'cashier', rate: 0.95, median: 5, sigma: 0.55 },
] as const

/** The percentile of sorted values, interpolated (as percentile_cont). */
function percentile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return r1(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo))
}
const statOf = (values: number[], excluded: number) => {
  const s = [...values].sort((a, b) => a - b)
  return { n: s.length, median: percentile(s, 0.5), p90: percentile(s, 0.9), excluded }
}

/** The waits of one desk on one day (minutes); about 1 in 120 is a data error over 12 hours. */
function waitsOn(desk: (typeof DESK_WAITS)[number], day: string) {
  const d = sampleDay(day)
  const r = rng(`w${desk.station}${day}`)
  const n = Math.round(d.visits * desk.rate * (0.85 + 0.3 * r()))
  // Mondays are slower
  const slow = parseDay(day).getDay() === 1 ? 1.2 : 1
  const ok: number[] = []
  let excluded = 0
  for (let i = 0; i < n; i++) {
    if (r() < 0.008) excluded++
    else ok.push(Math.max(0.5, desk.median * slow * Math.exp(desk.sigma * normal(r))))
  }
  return { ok, excluded }
}

export async function sampleWaitTimeStats(
  period: AnalyticsPeriod,
  departmentId: string | null,
): Promise<WaitTimeStats> {
  const { manager, dept } = await scope(departmentId)
  const p = ordered(period)
  const stations = stationsOf(dept)
  const desks = DESK_WAITS.filter((d) => !stations || stations.includes(d.station))
  const days = activeDays(p)
  const pooled: number[] = []
  let pooledExcluded = 0
  const perDay = new Map<string, number[]>()
  const now = new Date()
  const open = now.getHours() >= 7 && now.getHours() < 19
  const rows: WaitDesk[] = desks.map((desk) => {
    const all: number[] = []
    let excluded = 0
    for (const day of days) {
      const w = waitsOn(desk, day)
      all.push(...w.ok)
      excluded += w.excluded
      const list = perDay.get(day) ?? []
      list.push(...w.ok)
      perDay.set(day, list)
    }
    pooled.push(...all)
    pooledExcluded += excluded
    const s = statOf(all, excluded)
    const r = rng(`now${desk.station}${todayIso()}${now.getHours()}`)
    const waitingNow = open ? Math.round(desk.rate * 3.5 * r()) : 0
    return {
      station: desk.station,
      ...s,
      mean: all.length ? r1(all.reduce((a, b) => a + b, 0) / all.length) : null,
      waitingNow,
      longestNow: waitingNow ? Math.round(desk.median * (0.6 + 1.2 * r())) : null,
      forgotten: manager && desk.station === 'consultation' ? 1 : 0,
    }
  })
  // arrival to the first desk where the patient is seen
  const arrival: number[] = []
  let arrivalExcluded = 0
  if (
    desks.some(
      (d) => d.station === 'triage' || d.station === 'consultation' || d.station === 'dental',
    )
  ) {
    for (const day of days) {
      const r = rng(`a${day}`)
      const n = Math.round(sampleDay(day).visits * 0.95 * (dept?.id === 'dep-dental' ? 0.1 : 1))
      for (let i = 0; i < n; i++) {
        if (r() < 0.01) arrivalExcluded++
        else arrival.push(Math.max(1, 34 * Math.exp(0.5 * normal(r))))
      }
    }
  }
  const turnaround = (['laboratory', 'ultrasound'] as const)
    .filter((st) => !stations || stations.includes(st))
    .map((st) => {
      const values: number[] = []
      for (const day of days) {
        const r = rng(`ta${st}${day}`)
        const n = Math.round(sampleDay(day).visits * (st === 'laboratory' ? 0.4 : 0.05))
        for (let i = 0; i < n; i++)
          values.push((st === 'laboratory' ? 41 : 56) * Math.exp(0.5 * normal(r)))
      }
      const s = statOf(values, 0)
      return { station: st, n: s.n, median: s.median, p90: s.p90 }
    })
    .filter((x) => x.n > 0)
  const all = daysOf(p)
  return {
    needsUpdate: false,
    from: p.from,
    to: p.to,
    department: dept?.id ?? null,
    rules: { minN: 5, maxHours: 12 },
    desks: rows,
    overall: statOf(pooled, pooledExcluded),
    arrival: statOf(arrival, arrivalExcluded),
    days: (all.length <= 400 ? all : days).map((day) => {
      const s = statOf(perDay.get(day) ?? [], 0)
      return { day, n: s.n, median: s.median }
    }),
    turnaround,
  }
}

// ------------------------------------------------------------------ the dashboard's live queue

/** "Queue now" for the dashboard: waiting joined today, being seen, first in line, forgotten. */
export function sampleQueueNow() {
  const now = new Date()
  const open = now.getHours() >= 7 && now.getHours() < 19
  return DESK_WAITS.filter((d) => d.rate >= 0.1).map((desk) => {
    const r = rng(`now${desk.station}${todayIso()}${now.getHours()}`)
    const waiting = open ? Math.round(desk.rate * 3.5 * r()) : 0
    const longest = waiting ? Math.round(desk.median * (0.6 + 1.2 * r())) : null
    return {
      station: desk.station,
      waiting,
      busy: open && r() < 0.7 ? 1 : 0,
      longest,
      forgotten: desk.station === 'consultation' ? 1 : 0,
    }
  })
}

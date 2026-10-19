import type { Tone } from '../types'

export interface StatTile {
  id: 'registered' | 'waiting' | 'avgWait' | 'revenue' | 'openBills' | 'beds'
  value: string
  unitKey: 'today' | 'now' | 'min' | 'rwf' | 'bills' | 'beds'
  change: string
  /** true = good news, false = needs attention, null = neutral. */
  good: boolean | null
  /** Arrow direction; null = flat. */
  up: boolean | null
  /** Hidden for heads of station (no money rows). */
  money?: boolean
}

export const DASHBOARD_TILES: readonly StatTile[] = [
  { id: 'registered', value: '38', unitKey: 'today', change: '+4', good: true, up: true },
  { id: 'waiting', value: '11', unitKey: 'now', change: '−2', good: true, up: false },
  { id: 'avgWait', value: '18', unitKey: 'min', change: '+3 min', good: false, up: true },
  {
    id: 'revenue',
    value: '742,500',
    unitKey: 'rwf',
    change: '+6 %',
    good: true,
    up: true,
    money: true,
  },
  {
    id: 'openBills',
    value: '9',
    unitKey: 'bills',
    change: '−1',
    good: true,
    up: false,
    money: true,
  },
  { id: 'beds', value: '5 / 8', unitKey: 'beds', change: '', good: null, up: null },
]

/** Revenue per day for the 30 days ending today (RWF). */
export const REVENUE_30D: readonly number[] = [
  812000, 876500, 934000, 1012000, 688000, 402000, 790500, 845000, 901000, 1184000, 772000, 655000,
  418000, 805000, 866000, 920500, 1033000, 742000, 610000, 399000, 828000, 884000, 957000, 1102000,
  760000, 640000, 425000, 838000, 896000, 742500,
]

export interface BarDatum {
  label: string
  value: number
}
export const COLLECTIONS_TODAY: readonly BarDatum[] = [
  { label: 'Cash', value: 340400 },
  { label: 'MTN MoMo', value: 254100 },
  { label: 'Airtel Money', value: 61000 },
  { label: 'Insurer (billed)', value: 87000 },
]
export const COLLECTIONS_TOTAL = 742500
export const RECEIVABLES: readonly BarDatum[] = [
  { label: 'RSSB RAMA', value: 4860000 },
  { label: 'Mutuelle', value: 2315000 },
  { label: 'MMI', value: 1140000 },
  { label: 'Radiant', value: 760000 },
  { label: 'Prime', value: 410000 },
  { label: 'Britam', value: 285000 },
]
export const RECEIVABLES_TOTAL = 9770000
export const VISITS_BY_SERVICE: readonly BarDatum[] = [
  { label: 'Consultation', value: 412 },
  { label: 'Laboratory', value: 286 },
  { label: 'Nursing', value: 168 },
  { label: 'Dental', value: 74 },
  { label: 'HIV testing & vaccination', value: 63 },
  { label: 'Ultrasound', value: 58 },
  { label: 'Family planning', value: 41 },
  { label: 'Minor surgery', value: 19 },
  { label: 'Circumcision', value: 12 },
]
export const VISITS_TOTAL = 1133
export const WAIT_BY_STATION: readonly BarDatum[] = [
  { label: 'Reception', value: 6 },
  { label: 'Triage', value: 9 },
  { label: 'Consultation', value: 24 },
  { label: 'Laboratory', value: 31 },
  { label: 'Pharmacy', value: 12 },
  { label: 'Cashier', value: 8 },
]
export const NO_SHOW = {
  ratePct: 7.4,
  previousPct: 9.1,
  missed: 38,
  booked: 512,
  /** May → October. */
  series: [11.2, 10.4, 9.8, 8.9, 9.1, 7.4],
} as const
export const TOP_DIAGNOSES: readonly BarDatum[] = [
  { label: 'Malaria', value: 96 },
  { label: 'Upper respiratory tract infection', value: 84 },
  { label: 'Urinary tract infection', value: 61 },
  { label: 'Hypertension', value: 57 },
  { label: 'Gastroenteritis', value: 49 },
  { label: 'Peptic ulcer disease', value: 38 },
  { label: 'Type 2 diabetes', value: 33 },
  { label: 'Skin infection', value: 29 },
  { label: 'Intestinal worms', value: 26 },
  { label: 'Dental caries', value: 24 },
]
export const EXPIRING_BATCHES = { d30: 4, d60: 11, d90: 23 } as const
export const BACKUP = { lastAt: '02:00', sizeGb: 1.8, offsiteAt: '02:14', nextAt: '02:00' } as const
export interface ReorderItem {
  label: string
  qty: number
  min: number
}
export const REORDER: readonly ReorderItem[] = [
  { label: 'Amoxicillin 500 mg caps', qty: 120, min: 500 },
  { label: 'Artemether-lumefantrine 20/120', qty: 36, min: 150 },
  { label: 'Paracetamol 500 mg tabs', qty: 410, min: 1000 },
  { label: 'Malaria RDT kits', qty: 18, min: 100 },
  { label: 'Examination gloves M (boxes)', qty: 2, min: 10 },
  { label: 'ORS sachets', qty: 45, min: 200 },
]
export interface DeviceStatus {
  label: string
  detail: string
  state: 'synced' | 'syncing' | 'offline' | 'failed'
}
export const DEVICE_TONE: Record<DeviceStatus['state'], Tone> = {
  synced: 'green',
  syncing: 'blue',
  offline: 'orange',
  failed: 'red',
}
export const DEVICES: readonly DeviceStatus[] = [
  { label: 'Reception PC-1', detail: 'Synced 12:44', state: 'synced' },
  { label: 'Laboratory PC', detail: 'Synced 12:43', state: 'synced' },
  { label: 'Cashier PC', detail: 'Syncing · 2 pending', state: 'syncing' },
  { label: 'Nurse tablet 2', detail: 'Offline since 11:52 · 7 pending', state: 'offline' },
  { label: 'Consultation PC-2', detail: 'Sync failed 09:15 · needs attention', state: 'failed' },
]
export const BREAK_GLASS = {
  who: 'Dr. Mukamana Béatrice',
  when: '10:12',
  file: '00482',
  patient: 'Niyonzima J. B.',
  reason: 'emergency, patient not on my list',
} as const
export interface ChannelStat {
  label: string
  sent: number
  failed: number
}
export const CHANNELS: readonly ChannelStat[] = [
  { label: 'WhatsApp', sent: 41, failed: 2 },
  { label: 'SMS', sent: 118, failed: 5 },
  { label: 'Email', sent: 9, failed: 0 },
]
export interface ClaimDue {
  label: string
  count: number
  amount: number
}
export const CLAIMS_DUE: readonly ClaimDue[] = [
  { label: 'RSSB RAMA', count: 42, amount: 1860000 },
  { label: 'Mutuelle', count: 118, amount: 1240000 },
  { label: 'MMI', count: 9, amount: 412000 },
  { label: 'Radiant', count: 6, amount: 298000 },
  { label: 'Prime · Britam', count: 5, amount: 171000 },
]

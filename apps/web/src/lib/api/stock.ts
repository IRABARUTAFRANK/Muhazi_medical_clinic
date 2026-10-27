import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DayRange } from './lab'
import { apiError, isMissingFunction, sampleRefusal } from './errors'
import { queryClient } from '@/lib/query-client'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'

/**
 * Medicine stock: what is on hand in each store, cost and selling price, deliveries received into
 * the pharmacy, the pharmacy hand-over desk (with its store, the patient's share and the safety
 * check), the ledger, alerts, what to order and sales.
 *
 * The pharmacy is the main store (migration 0083): every delivery is received into a pharmacy
 * store (the main one by default). Room stores (a doctor's office, a ward) are supplied from it by
 * transfer notes: see rooms.ts. Walk-in counter sales: see counter-sales.ts.
 *
 * Live: stock_overview, add_stock, receive_delivery, receive_stock, deliveries, delivery_detail,
 * transfer_stock, use_stock, adjust_stock, pharmacy_queue, dispense_prescription, sell_medicine,
 * rx_not_given, return_medicine, set_main_pharmacy, set_reorder_level, stock_movements,
 * stock_alerts, reorder_suggestions, stock_sales, save_location, set_location_active,
 * pharmacy_summary. Each keeps working on a database without 0082/0083 where the old function
 * exists.
 */

export type StockLocationType = 'main_store' | 'pharmacy' | 'nursing' | 'lab' | 'theatre' | 'room'

/** Who holds a room store: a named person or a whole department (migration 0083). */
export interface StoreHolder {
  id: string
  profileId: string | null
  name: string | null
  role: string | null
  departmentId: string | null
  department: string | null
}

export interface StockLocation {
  id: string
  name: string
  type: StockLocationType
  department: string | null
  /** false: closed (no longer used); it can be opened again. */
  active?: boolean
  /** The main (receiving) pharmacy store: deliveries and hand-overs go through it by default. */
  isMain?: boolean
  /** A room store (room, nursing, lab or theatre): held by named staff or departments. */
  isRoom?: boolean
  /** I hold this store (named, or through my department). */
  held?: boolean
  holders?: StoreHolder[]
}

/** Room stores are the stores of type room, nursing, lab or theatre. */
export const ROOM_STORE_TYPES: readonly StockLocationType[] = ['room', 'nursing', 'lab', 'theatre']
export const isRoomStore = (l: Pick<StockLocation, 'type' | 'isRoom'>) =>
  l.isRoom ?? ROOM_STORE_TYPES.includes(l.type)

export interface StockItem {
  id: string
  code: string
  name: string
  strength: string | null
  unit: string | null
  /** Units in one box (deliveries counted in boxes are converted with it). */
  packSize?: number | null
  sellingPrice: number | null
  reorderLevel: number
  /** Order up to this quantity (reorder suggestions); null: not set. */
  maxLevel?: number | null
  onHand: number
  /** Units not expired, in the stores I may see. */
  usable?: number
  /** Value at cost. 0 when hidden (`costShown` false: only the pharmacy and the manager see costs). */
  costValue: number
  avgCost: number | null
  /** false: the reader may not see costs (costValue is then 0, avgCost null). */
  costShown?: boolean
  byLocation: Record<string, number>
  /**
   * Usable (not expired) units per store, when the database sends them: only these can be sent
   * to another store. Missing on an old database, where byLocation also counts expired units.
   */
  byLocationUsable?: Record<string, number>
  earliestExpiry: string | null
  /** The earliest expiry date not yet passed. */
  nextExpiry?: string | null
  expiredUnits: number
  /** Units expiring within the expiry window (30 days; not yet expired). */
  expiringUnits?: number
  /** Units on transfer notes not yet received (pharmacy and manager; null for others). */
  inTransit?: number | null
  /** Unexpired units in the open pharmacy stores (pharmacy and manager; null for others). */
  pharmacyUsable?: number | null
  /** At or below its reorder level in the pharmacy (unexpired units), as the database counts it. */
  low?: boolean
  /** A medicine or a product (supply); missing on an older database. */
  kind?: 'medicine' | 'supply' | null
  active: boolean
}
export interface StockOverview {
  locations: StockLocation[]
  items: StockItem[]
  /** The reader is the pharmacy or the manager (sees every store and the costs). */
  admin: boolean
  mainPharmacyId: string | null
  /** Stock on the way on transfer notes (pharmacy and manager only). */
  transit: { units: number; value: number; notes: number } | null
}

export interface PharmacyLine {
  requestId: string
  encounterId: string
  patientId: string
  patient: string
  file: string
  ticket: string | null
  itemId: string
  item: string
  unit: string | null
  quantity: number
  dose: string | null
  frequency: string | null
  days: number | null
  instructions: string | null
  prescriber: string | null
  prescriberId: string | null
  at: string
  /** The cash price per unit (kept as before). */
  price: number | null
  cashPrice: number | null
  /** The price on the visit's insurer list (the cash price without an insurer). */
  payerPrice: number | null
  /** false: no price, handed over free. */
  priced: boolean
  payer: string | null
  coveragePct: number
  /** What the bill will say for this line: total, insurer share and what the patient pays. */
  lineTotal: number
  insurerShare: number
  patientShare: number
  /** Usable stock in the chosen pharmacy store. */
  onHandPharmacy: number
  /** Usable stock of the medicine in the other stores. */
  onHandElsewhere: number
  /** The pharmacy store the desk works from (hand-overs take stock from it). */
  pharmacyLocationId: string | null
  locationId: string | null
  /** Expired units in the chosen store: never handed over, to write off. */
  expiredInPharmacy?: number
  /** A doctor still has the patient at their desk: the hand-over waits (MS002). */
  doctorHolds?: boolean
  // the pharmacist's check (CHK-1)
  sex: string | null
  birthDate: string | null
  ageYears: number | null
  allergies: string | null
  /** The prescribing rule of the medicine (DT, PED, GYN…), and whether the prescriber fits it. */
  prescribingRule: string | null
  prescriberSpecialty: string | null
  /** null: no rule, or a rule naming no known specialist. */
  ruleOk: boolean | null
}

/** One patient waiting at the pharmacy, with what they will pay for the medicines. */
export interface PharmacyPatient {
  encounterId: string
  patientId: string
  patient: string
  file: string
  ticket: string | null
  sex: string | null
  birthDate: string | null
  ageYears: number | null
  ageMonths: number | null
  allergies: string | null
  payer: string | null
  lines: number
  total: number
  insurerShare: number
  patientShare: number
  /** What the whole visit still owes (null on an old database). */
  balance: number | null
  doctorHolds: boolean
}

export interface PharmacyStoreChoice {
  id: string
  name: string
  isMain: boolean
}

/** The pharmacy desk: the store it works from, the lines and the patients. */
export interface PharmacyDesk {
  locationId: string | null
  /** The open pharmacy stores, the main one first (empty on an old database: no choice). */
  stores: PharmacyStoreChoice[]
  lines: PharmacyLine[]
  patients: PharmacyPatient[]
}

export type StockMovementType =
  'receipt' | 'dispense' | 'transfer' | 'adjustment' | 'return' | 'consumption'

export interface StockMovement {
  id: string
  at: string
  type: StockMovementType
  itemId?: string | null
  item: string
  quantity: number
  fromId?: string | null
  from: string | null
  toId?: string | null
  to: string | null
  batch: string | null
  expiry: string | null
  /** Pharmacy and manager only (null for others). */
  unitCost: number | null
  value?: number | null
  reason: string | null
  by: string | null
  /** The transfer note (T-… / RT-…), delivery (GRN-…) or counter sale (S-…) it belongs to. */
  transferId?: string | null
  transfer?: string | null
  delivery?: string | null
  sale?: string | null
  /** The prescription line (hand-overs, room gives, returns). */
  requestId?: string | null
}
export interface StockSales {
  items: { item: string; units: number; revenue: number; cost: number; margin: number }[]
  received: number
  consumed: number
  stockValue: number
  /** Counter sales (walk-in buyers) handed over in the period. */
  counterRevenue?: number
  /** Totals of the period: revenue, cost of what was sold, margin (revenue − cost). */
  revenue: number
  cost: number
  margin: number
}

/** A line of "Add stock" (add_stock): an item of the clinic, or a new one. */
export interface AddStockLineInput {
  itemId?: string
  newItem?: {
    name: string
    form?: string | null
    strength?: string | null
    kind: 'medicine' | 'supply'
    unit?: string | null
  }
  batchNo: string
  /** Not in the past. */
  expiry: string
  /** Units (> 0). */
  quantity: number
  /** Cost per unit (≥ 0). */
  unitCost: number
  /** The selling price per unit: sets the price of a new item, updates a changed one. */
  sellPrice?: number | null
}
export interface AddStockResult {
  lines: { itemId: string; batchId: string | null; quantity: number }[]
  totalCost: number
  /** A new selling price was not saved (the reader may not set prices). */
  priceIgnored: boolean
}

/** A line of a delivery note (receive_delivery). */
export interface DeliveryLineInput {
  /** A clinic medicine, or */
  itemId?: string
  /** a medicine of the RHIA list not yet at the clinic (added at sellingPrice). */
  refCode?: string
  batchNo?: string
  /** Required, not in the past. */
  expiry: string
  /** In boxes or in units, as `unit` says. */
  quantity: number
  unit?: 'box' | 'unit'
  /** Units in a box (for boxes; defaults to the medicine's pack size). */
  packSize?: number
  /** Cost per box or per unit, as `unit` says. */
  cost: number
  /** The cash price (a new medicine, or one without a price yet). */
  sellingPrice?: number
  /** Sample mode: the medicine's details when it is new to the clinic. */
  newMedicine?: Pick<StockItem, 'code' | 'name' | 'strength' | 'unit' | 'sellingPrice'>
}
export interface DeliveryInput {
  supplier: string
  /** The supplier's delivery note number (the same note cannot be entered twice). */
  reference?: string
  /** Not in the future; today when empty. */
  deliveredOn?: string
  /** An open pharmacy store; the main pharmacy when empty. */
  locationId?: string | null
  note?: string
  lines: DeliveryLineInput[]
}
export interface DeliveryResult {
  id: string
  /** GRN-YYMMDD-NNN */
  number: string | null
  locationId: string | null
  lines: number
  units: number
  totalCost: number
}
export interface Delivery {
  id: string
  number: string
  supplier: string | null
  reference: string | null
  deliveredOn: string | null
  receivedAt: string
  receivedBy: string | null
  store: string | null
  storeId: string | null
  note: string | null
  lines: number
  units: number
  totalCost: number
}
export interface DeliveryDetail extends Omit<Delivery, 'lines' | 'units'> {
  lines: {
    id: string
    itemId: string
    item: string
    unit: 'box' | 'unit'
    packs: number
    packSize: number
    units: number
    batchNo: string | null
    expiry: string | null
    unitCost: number
    packCost: number | null
    lineCost: number
  }[]
}

export interface StockAlerts {
  /** Pharmacy and manager only. */
  low: {
    itemId: string
    item: string
    code: string
    onHand: number
    level: number
    maxLevel: number | null
  }[]
  roomLow: {
    storeId: string
    store: string
    itemId: string
    item: string
    onHand: number
    min: number
  }[]
  /** Expiring today to +90 days. */
  expiring: {
    storeId: string
    store: string
    itemId: string
    item: string
    batchNo: string | null
    expiry: string
    quantity: number
    days: number
  }[]
  expired: {
    storeId: string
    store: string
    itemId: string
    item: string
    batchNo: string | null
    expiry: string
    quantity: number
  }[]
  /** false: the database has no stock_alerts yet (before 0083). */
  supported: boolean
}

export interface ReorderSuggestion {
  itemId: string
  item: string
  code: string
  unit: string | null
  packSize: number | null
  onHand: number
  level: number
  maxLevel: number | null
  inRooms: number
  monthlyUse: number
  suggested: number
  suggestedBoxes: number | null
  lastSupplier: string | null
  lastCost: number | null
  lastReceivedAt: string | null
  estimatedCost: number
}

/** A return (undo of a hand-over): 'bill' while the bill is open, 'credit' after it is posted. */
export interface ReturnResult {
  units: number
  mode: 'bill' | 'credit'
  creditNoteId: string | null
  /** The patient's share given back by the credit note. */
  credit: number
  /** What the visit owes now; below 0: money to give back at the cashier. */
  balance: number | null
}

// ---------------------------------------------------------------- sample mode
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

const sampleLocations: StockLocation[] = [
  { id: 'l-main', name: 'Main store (old)', type: 'main_store', department: null, active: true },
  {
    id: 'l-pharm',
    name: 'Pharmacy',
    type: 'pharmacy',
    department: null,
    active: true,
    isMain: true,
  },
  { id: 'l-nurse', name: 'Nursing room', type: 'nursing', department: 'Nursing', active: true },
  { id: 'l-cons', name: 'Dr. Mukamana’s office', type: 'room', department: null, active: true },
]
/** Who holds the sample room stores: the sample doctor holds her office. */
const sampleHolders: (StoreHolder & { locationId: string })[] = [
  {
    id: 'h-1',
    locationId: 'l-cons',
    profileId: 'u-doc',
    name: 'Dr. Mukamana Béatrice',
    role: 'doctor',
    departmentId: null,
    department: null,
  },
  {
    id: 'h-2',
    locationId: 'l-nurse',
    profileId: 'u-nur',
    name: 'Nyirahabimana Chantal',
    role: 'nurse',
    departmentId: null,
    department: null,
  },
]
const sampleItems: StockItem[] = [
  {
    id: 'it-1',
    code: 'AMOX500',
    name: 'Amoxicillin',
    strength: '500 mg',
    unit: 'cap',
    packSize: 100,
    sellingPrice: 300,
    reorderLevel: 150,
    maxLevel: 1000,
    onHand: 1240,
    costValue: 148800,
    avgCost: 120,
    byLocation: { 'l-main': 1000, 'l-pharm': 200, 'l-cons': 40 },
    earliestExpiry: '2027-06-30',
    expiredUnits: 0,
    active: true,
  },
  {
    id: 'it-2',
    code: 'PARA500',
    name: 'Paracetamol',
    strength: '500 mg',
    unit: 'tab',
    packSize: 1000,
    sellingPrice: 50,
    reorderLevel: 1000,
    maxLevel: 3000,
    onHand: 620,
    costValue: 12400,
    avgCost: 20,
    byLocation: { 'l-pharm': 500, 'l-nurse': 120 },
    earliestExpiry: '2026-12-31',
    expiredUnits: 0,
    active: true,
  },
  {
    id: 'it-3',
    code: 'AL20120',
    name: 'Artemether-lumefantrine',
    strength: '20/120 mg',
    unit: 'tab',
    packSize: 24,
    sellingPrice: 500,
    reorderLevel: 150,
    maxLevel: 480,
    onHand: 96,
    costValue: 24000,
    avgCost: 250,
    byLocation: { 'l-pharm': 96 },
    earliestExpiry: '2026-11-15',
    expiredUnits: 0,
    active: true,
  },
]
/** The batch number of each sample item (the latest added). */
const sampleBatchNo: Record<string, string> = {
  'it-1': 'B261020-001',
  'it-2': 'B260901-004',
  'it-3': 'B260715-002',
}

const line = (
  l: Pick<
    PharmacyLine,
    | 'requestId'
    | 'encounterId'
    | 'patientId'
    | 'patient'
    | 'file'
    | 'ticket'
    | 'itemId'
    | 'item'
    | 'unit'
    | 'quantity'
    | 'dose'
    | 'frequency'
    | 'days'
    | 'instructions'
    | 'prescriber'
    | 'at'
    | 'price'
    | 'sex'
    | 'birthDate'
    | 'ageYears'
    | 'allergies'
    | 'prescribingRule'
  > & { payer?: string; coveragePct?: number },
): PharmacyLine => {
  const total = Math.round((l.price ?? 0) * l.quantity)
  const pct = l.coveragePct ?? 0
  const insurer = Math.round((total * pct) / 100)
  return {
    ...l,
    prescriberId: 'u-doc',
    cashPrice: l.price,
    payerPrice: l.price,
    priced: l.price != null,
    payer: l.payer ?? null,
    coveragePct: pct,
    lineTotal: total,
    insurerShare: insurer,
    patientShare: total - insurer,
    onHandPharmacy: 0,
    onHandElsewhere: 0,
    pharmacyLocationId: 'l-pharm',
    locationId: 'l-pharm',
    expiredInPharmacy: 0,
    doctorHolds: false,
    prescriberSpecialty: null,
    ruleOk: null,
  }
}
const sampleQueue: PharmacyLine[] = [
  line({
    requestId: 'rx-1',
    encounterId: 'e-1',
    patientId: 'p-1',
    patient: 'Mukamana Alice',
    file: 'MMC-000124',
    ticket: 'A-012',
    itemId: 'it-3',
    item: 'Artemether-lumefantrine 20/120 mg',
    unit: 'tab',
    quantity: 24,
    dose: '4 tab',
    frequency: 'twice a day',
    days: 3,
    instructions: 'After food',
    prescriber: 'Dr. Mukamana Béatrice',
    at: ago(20),
    price: 500,
    sex: 'female',
    birthDate: '1991-03-14',
    ageYears: 35,
    allergies: 'Penicillin (rash)',
    prescribingRule: null,
    payer: 'RSSB (RAMA)',
    coveragePct: 85,
  }),
  line({
    requestId: 'rx-2',
    encounterId: 'e-2',
    patientId: 'p-2',
    patient: 'Habimana Eric',
    file: 'MMC-000131',
    ticket: 'A-014',
    itemId: 'it-1',
    item: 'Amoxicillin 500 mg',
    unit: 'cap',
    quantity: 21,
    dose: '1 cap',
    frequency: 'three times a day',
    days: 7,
    instructions: null,
    prescriber: 'Dr. Ndayisaba Félix',
    at: ago(8),
    price: 300,
    sex: 'male',
    birthDate: '2019-08-02',
    ageYears: 7,
    allergies: null,
    prescribingRule: 'PED',
  }),
]
const sampleMoves: StockMovement[] = [
  {
    id: 'm-1',
    at: ago(180),
    type: 'receipt',
    itemId: 'it-1',
    item: 'Amoxicillin 500 mg',
    quantity: 1000,
    from: null,
    toId: 'l-pharm',
    to: 'Pharmacy',
    batch: 'B261020-001',
    expiry: '2027-06-30',
    unitCost: 120,
    value: 120000,
    reason: 'Kigali Pharma Wholesale Ltd',
    by: 'Mugabo Théogène',
    delivery: 'GRN-261024-001',
  },
  {
    id: 'm-2',
    at: ago(120),
    type: 'transfer',
    itemId: 'it-1',
    item: 'Amoxicillin 500 mg',
    quantity: 40,
    fromId: 'l-pharm',
    from: 'Pharmacy',
    toId: 'l-cons',
    to: 'Dr. Mukamana’s office',
    batch: 'B261020-001',
    expiry: '2027-06-30',
    unitCost: 120,
    value: 4800,
    reason: null,
    by: 'Mugabo Théogène',
    transfer: 'T-261024-001',
  },
  {
    id: 'm-3',
    at: ago(50),
    type: 'dispense',
    itemId: 'it-2',
    item: 'Paracetamol 500 mg',
    quantity: 20,
    fromId: 'l-pharm',
    from: 'Pharmacy',
    to: null,
    batch: 'B260901-004',
    expiry: '2026-12-31',
    unitCost: 20,
    value: 400,
    reason: null,
    by: 'Kalisa Pascal',
  },
]
const sampleDeliveries: DeliveryDetail[] = [
  {
    id: 'grn-1',
    number: 'GRN-261024-001',
    supplier: 'Kigali Pharma Wholesale Ltd',
    reference: 'DN-55120',
    deliveredOn: ago(180).slice(0, 10),
    receivedAt: ago(180),
    receivedBy: 'Mugabo Théogène',
    store: 'Pharmacy',
    storeId: 'l-pharm',
    note: null,
    totalCost: 120000,
    lines: [
      {
        id: 'grl-1',
        itemId: 'it-1',
        item: 'Amoxicillin 500 mg',
        unit: 'box',
        packs: 10,
        packSize: 100,
        units: 1000,
        batchNo: 'B261020-001',
        expiry: '2027-06-30',
        unitCost: 120,
        packCost: 12000,
        lineCost: 120000,
      },
    ],
  },
]

/** The signed-in sample user (sample mode only). */
export const sampleUserId = () => useSession.getState().user?.id ?? null
/** Sample mode: the pharmacy desk and the manager see every store and the costs. The desks come
 *  from the sample departments (lib/api/desks, cached as ['desks', 'mine', id]); until read, the
 *  pharmacist's role, as before. */
export const sampleIsAdmin = () => {
  const u = useSession.getState().user
  if (!u || u.role === 'manager') return true
  const mine = queryClient.getQueryData<{ desks: string[] }>(['desks', 'mine', u.id])
  return mine ? mine.desks.includes('pharmacy') : (u.role as string) === 'pharmacist'
}
export const sampleIsManager = () => {
  const u = useSession.getState().user
  return !u || u.role === 'manager'
}
const sampleHolds = (locationId: string) => {
  const me = sampleUserId()
  return !!me && sampleHolders.some((h) => h.locationId === locationId && h.profileId === me)
}
const sampleHoldersOf = (locationId: string): StoreHolder[] =>
  sampleHolders
    .filter((h) => h.locationId === locationId)
    .map((h) => ({
      id: h.id,
      profileId: h.profileId,
      name: h.name,
      role: h.role,
      departmentId: h.departmentId,
      department: h.department,
    }))
const sampleUsable = (itemId: string, locationId: string) =>
  sampleItems.find((x) => x.id === itemId)?.byLocation[locationId] ?? 0
/** Moves sample units between stores (null: in or out of the clinic). */
const sampleMove = (itemId: string, from: string | null, to: string | null, quantity: number) => {
  const it = sampleItems.find((x) => x.id === itemId)
  if (!it) return
  if (from) it.byLocation[from] = (it.byLocation[from] ?? 0) - quantity
  if (to) it.byLocation[to] = (it.byLocation[to] ?? 0) + quantity
  if (!from) {
    it.onHand += quantity
    it.costValue += quantity * (it.avgCost ?? 0)
  }
  if (!to) {
    it.onHand -= quantity
    it.costValue -= quantity * (it.avgCost ?? 0)
  }
}
const sampleLabel = (itemId: string) => {
  const it = sampleItems.find((x) => x.id === itemId)
  return it ? `${it.name} ${it.strength ?? ''}`.trim() : itemId
}

/** Sample data shared with rooms.ts and counter-sales.ts (sample mode only). */
export const sampleStock = {
  locations: sampleLocations,
  holders: sampleHolders,
  items: sampleItems,
  moves: sampleMoves,
  batchNo: sampleBatchNo,
  holds: sampleHolds,
  holdersOf: sampleHoldersOf,
  usable: sampleUsable,
  move: sampleMove,
  label: sampleLabel,
  log(m: Omit<StockMovement, 'id' | 'at' | 'by' | 'batch' | 'expiry' | 'unitCost'>) {
    const it = sampleItems.find((x) => x.id === m.itemId)
    sampleMoves.unshift({
      ...m,
      id: `m-${Date.now()}-${sampleMoves.length}`,
      at: new Date().toISOString(),
      by: useSession.getState().user?.name ?? null,
      batch: (m.itemId && sampleBatchNo[m.itemId]) ?? null,
      expiry: it?.earliestExpiry ?? null,
      unitCost: it?.avgCost ?? null,
    })
  },
}

const sampleOverview = (): StockOverview => {
  const admin = sampleIsAdmin()
  const visible = sampleLocations.filter((l) => admin || sampleHolds(l.id))
  const ids = new Set(visible.map((l) => l.id))
  const today = new Date().toISOString().slice(0, 10)
  // the expiry window (setting stock.expiry_days, 30 days)
  const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
  return {
    admin,
    mainPharmacyId: 'l-pharm',
    transit: admin ? { units: 0, value: 0, notes: 0 } : null,
    locations: visible.map((l) => ({
      ...l,
      isRoom: isRoomStore(l),
      held: sampleHolds(l.id),
      holders: sampleHoldersOf(l.id),
    })),
    items: sampleItems.map((x) => {
      const byLocation = Object.fromEntries(
        Object.entries(x.byLocation).filter(([k, v]) => ids.has(k) && v !== 0),
      )
      const onHand = Object.values(byLocation).reduce((s, v) => s + v, 0)
      const pharmacy = sampleLocations
        .filter((l) => l.type === 'pharmacy' && l.active !== false)
        .reduce((s, l) => s + (x.byLocation[l.id] ?? 0), 0)
      const expiring = x.earliestExpiry && x.earliestExpiry <= soon && x.earliestExpiry >= today
      return {
        ...x,
        byLocation,
        byLocationUsable: { ...byLocation },
        onHand,
        usable: onHand,
        costValue: admin ? onHand * (x.avgCost ?? 0) : 0,
        avgCost: admin ? x.avgCost : null,
        costShown: admin,
        nextExpiry: x.earliestExpiry,
        expiringUnits: expiring ? onHand : 0,
        inTransit: admin ? 0 : null,
        pharmacyUsable: admin ? pharmacy : null,
        low: x.reorderLevel > 0 && pharmacy <= x.reorderLevel,
      }
    }),
  }
}

const sampleDesk = (locationId: string | null): PharmacyDesk => {
  const loc = locationId ?? 'l-pharm'
  const lines = sampleQueue.map((q) => {
    const it = sampleItems.find((x) => x.id === q.itemId)
    const here = it?.byLocation[loc] ?? 0
    const all = Object.values(it?.byLocation ?? {}).reduce((s, v) => s + v, 0)
    return {
      ...q,
      locationId: loc,
      pharmacyLocationId: loc,
      onHandPharmacy: here,
      onHandElsewhere: all - here,
    }
  })
  return {
    locationId: loc,
    stores: sampleLocations
      .filter((l) => l.type === 'pharmacy' && l.active !== false)
      .map((l) => ({ id: l.id, name: l.name, isMain: !!l.isMain })),
    lines,
    patients: groupPatients(lines),
  }
}

// ---------------------------------------------------------------- reading
const KEY = ['stock'] as const

const num = (v: unknown, fallback = 0): number =>
  v == null || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v)
const numOrNull = (v: unknown): number | null =>
  v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v)

/**
 * One rule everywhere (stock page, pharmacy, manager dashboard): low as the database counts it
 * (unexpired units in the pharmacy at or below the level, 0083), else a level set and reached.
 */
export const isLowStock = (i: Pick<StockItem, 'onHand' | 'reorderLevel'> & { low?: boolean }) =>
  i.low ?? (i.reorderLevel > 0 && i.onHand <= i.reorderLevel)

export function useStockOverview() {
  return useQuery({
    // another desk receives or hands over stock: keep the figures fresh
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    queryKey: [...KEY, 'overview'],
    queryFn: async (): Promise<StockOverview> => {
      if (!supabase) return sampleOverview()
      const { data, error } = await supabase.rpc('stock_overview')
      if (error) throw apiError(error)
      const d = (data ?? {}) as Partial<StockOverview> & {
        items?: (Omit<StockItem, 'costValue'> & { costValue: number | null })[]
      }
      return {
        admin: d.admin ?? true,
        mainPharmacyId: d.mainPharmacyId ?? null,
        transit: d.transit
          ? {
              units: num(d.transit.units),
              value: num(d.transit.value),
              notes: num(d.transit.notes),
            }
          : null,
        locations: (d.locations ?? [])
          .filter((l) => (l.type as string) !== 'transit')
          .map((l) => ({ ...l, holders: l.holders ?? [] })),
        items: (d.items ?? []).map((i) => ({
          ...i,
          packSize: numOrNull(i.packSize),
          sellingPrice: numOrNull(i.sellingPrice),
          reorderLevel: num(i.reorderLevel),
          maxLevel: numOrNull(i.maxLevel),
          onHand: num(i.onHand),
          usable: i.usable == null ? undefined : num(i.usable),
          costValue: num(i.costValue),
          costShown: i.costValue != null,
          avgCost: numOrNull(i.avgCost),
          byLocation: i.byLocation ?? {},
          byLocationUsable: i.byLocationUsable ?? undefined,
          expiredUnits: num(i.expiredUnits),
          expiringUnits: i.expiringUnits == null ? undefined : num(i.expiringUnits),
          inTransit: numOrNull(i.inTransit),
          pharmacyUsable: numOrNull(i.pharmacyUsable),
        })),
      }
    },
  })
}

/** The patients of the desk, from its lines (an old database sends no patient list). */
export function groupPatients(lines: readonly PharmacyLine[]): PharmacyPatient[] {
  const by = new Map<string, PharmacyPatient>()
  for (const l of lines) {
    const p = by.get(l.encounterId) ?? {
      encounterId: l.encounterId,
      patientId: l.patientId,
      patient: l.patient,
      file: l.file,
      ticket: l.ticket,
      sex: l.sex,
      birthDate: l.birthDate,
      ageYears: l.ageYears,
      ageMonths: null,
      allergies: l.allergies,
      payer: l.payer,
      lines: 0,
      total: 0,
      insurerShare: 0,
      patientShare: 0,
      balance: null,
      doctorHolds: !!l.doctorHolds,
    }
    p.lines += 1
    p.total += l.lineTotal
    p.insurerShare += l.insurerShare
    p.patientShare += l.patientShare
    by.set(l.encounterId, p)
  }
  return [...by.values()]
}

const toLine = (l: Partial<PharmacyLine> & Record<string, unknown>): PharmacyLine => {
  const quantity = num(l.quantity)
  const price = numOrNull(l.price)
  const payerPrice = l.payerPrice === undefined ? price : numOrNull(l.payerPrice)
  // an old database sends only the cash price: the line total is then the cash total
  const lineTotal = l.lineTotal == null ? Math.round((price ?? 0) * quantity) : num(l.lineTotal)
  const insurerShare = num(l.insurerShare)
  return {
    ...(l as PharmacyLine),
    quantity,
    price,
    cashPrice: l.cashPrice === undefined ? price : numOrNull(l.cashPrice),
    payerPrice,
    priced: l.priced ?? payerPrice != null,
    payer: l.payer ?? null,
    prescriberId: l.prescriberId ?? null,
    coveragePct: num(l.coveragePct),
    lineTotal,
    insurerShare,
    patientShare: l.patientShare == null ? lineTotal - insurerShare : num(l.patientShare),
    onHandPharmacy: num(l.onHandPharmacy),
    onHandElsewhere: num(l.onHandElsewhere),
    pharmacyLocationId: l.pharmacyLocationId ?? null,
    locationId: l.locationId ?? l.pharmacyLocationId ?? null,
    expiredInPharmacy: num(l.expiredInPharmacy),
    sex: l.sex ?? null,
    birthDate: l.birthDate ?? null,
    ageYears: numOrNull(l.ageYears),
    allergies: l.allergies ?? null,
    prescribingRule: l.prescribingRule ?? null,
    prescriberSpecialty: l.prescriberSpecialty ?? null,
    ruleOk: l.ruleOk ?? null,
  }
}

async function fetchPharmacyDesk(locationId: string | null): Promise<PharmacyDesk> {
  if (!supabase) return sampleDesk(locationId)
  let res = await supabase.rpc(
    'pharmacy_queue',
    locationId ? { p_location_id: locationId } : undefined,
  )
  // a database before 0082 knows no store choice: the desk works from its one pharmacy store
  if (res.error && locationId && isMissingFunction(res.error))
    res = await supabase.rpc('pharmacy_queue')
  if (res.error) throw apiError(res.error)
  const d = res.data as
    | PharmacyLine[]
    | {
        locationId: string | null
        stores?: PharmacyStoreChoice[]
        lines?: PharmacyLine[]
        patients?: PharmacyPatient[]
      }
    | null
  if (Array.isArray(d) || d == null) {
    const lines = (d ?? []).map((l) => toLine(l as PharmacyLine & Record<string, unknown>))
    return {
      locationId: lines[0]?.pharmacyLocationId ?? null,
      stores: [],
      lines,
      patients: groupPatients(lines),
    }
  }
  const lines = (d.lines ?? []).map((l) => toLine(l as PharmacyLine & Record<string, unknown>))
  return {
    locationId: d.locationId ?? null,
    stores: d.stores ?? [],
    lines,
    patients: d.patients
      ? d.patients.map((p) => ({
          ...p,
          ageYears: numOrNull(p.ageYears),
          ageMonths: numOrNull(p.ageMonths),
          lines: num(p.lines),
          total: num(p.total),
          insurerShare: num(p.insurerShare),
          patientShare: num(p.patientShare),
          balance: numOrNull(p.balance),
          doctorHolds: !!p.doctorHolds,
        }))
      : groupPatients(lines),
  }
}

const deskQuery = (locationId: string | null) => ({
  queryKey: [...KEY, 'pharmacy', locationId] as const,
  refetchInterval: 20_000,
  queryFn: () => fetchPharmacyDesk(locationId),
})

/**
 * The pharmacy desk from a store (null: the main pharmacy): the stores to choose from, the lines
 * waiting with the patient's share and the safety check, and the patients with their totals.
 */
export function usePharmacyDesk(locationId: string | null = null) {
  return useQuery(deskQuery(locationId))
}

/** The lines waiting at the pharmacy (the desk's lines; same cache as usePharmacyDesk). */
export function usePharmacyQueue(locationId: string | null = null) {
  return useQuery({ ...deskQuery(locationId), select: (d: PharmacyDesk) => d.lines })
}

/** The ledger of a period, for a medicine and/or a store (holders: their stores only). */
export function useStockMovements(
  from: string,
  to: string,
  itemId: string | null,
  locationId: string | null = null,
) {
  return useQuery({
    queryKey: [...KEY, 'moves', from, to, itemId, locationId],
    queryFn: async (): Promise<StockMovement[]> => {
      if (!supabase)
        return sampleMoves.filter(
          (m) =>
            (!itemId || m.itemId === itemId) &&
            (!locationId || m.fromId === locationId || m.toId === locationId),
        )
      const args: Record<string, unknown> = { p_from: from, p_to: to, p_item_id: itemId }
      // only when asked, so a database before 0083 (three arguments) still answers
      if (locationId) args.p_location_id = locationId
      const { data, error } = await supabase.rpc('stock_movements', args)
      if (error) throw apiError(error)
      return ((data ?? []) as StockMovement[]).map((m) => ({
        ...m,
        quantity: num(m.quantity),
        unitCost: numOrNull(m.unitCost),
        value: numOrNull(m.value),
      }))
    },
  })
}

export function useStockSales(from: string, to: string) {
  return useQuery({
    queryKey: [...KEY, 'sales', from, to],
    queryFn: async (): Promise<StockSales> => {
      if (!supabase)
        return {
          items: [
            {
              item: 'Artemether-lumefantrine 20/120 mg',
              units: 96,
              revenue: 48000,
              cost: 24000,
              margin: 24000,
            },
            { item: 'Amoxicillin 500 mg', units: 63, revenue: 18900, cost: 7560, margin: 11340 },
            { item: 'Paracetamol 500 mg', units: 140, revenue: 7000, cost: 2800, margin: 4200 },
          ],
          received: 148800,
          consumed: 4800,
          stockValue: 185200,
          counterRevenue: 3500,
          revenue: 73900,
          cost: 34360,
          margin: 39540,
        }
      const { data, error } = await supabase.rpc('stock_sales', { p_from: from, p_to: to })
      if (error) throw apiError(error)
      const d = data as Partial<StockSales>
      const items = (d.items ?? []).map((x) => ({
        item: x.item,
        units: num(x.units),
        revenue: num(x.revenue),
        cost: num(x.cost),
        margin: num(x.margin),
      }))
      // the period's totals, from the lines when the database sends none
      const revenue = d.revenue == null ? items.reduce((s, x) => s + x.revenue, 0) : num(d.revenue)
      const cost = d.cost == null ? items.reduce((s, x) => s + x.cost, 0) : num(d.cost)
      return {
        items,
        received: num(d.received),
        consumed: num(d.consumed),
        stockValue: num(d.stockValue),
        counterRevenue: d.counterRevenue == null ? undefined : num(d.counterRevenue),
        revenue,
        cost,
        margin: d.margin == null ? revenue - cost : num(d.margin),
      }
    },
  })
}

/** Low (pharmacy), low in room stores, expiring (today to +90 days) and expired, by store. */
export function useStockAlerts() {
  return useQuery({
    queryKey: [...KEY, 'alerts'],
    refetchInterval: 120_000,
    queryFn: async (): Promise<StockAlerts> => {
      if (!supabase) {
        const o = sampleOverview()
        return {
          supported: true,
          low: o.admin
            ? o.items
                .filter((i) => i.low)
                .map((i) => ({
                  itemId: i.id,
                  item: `${i.name} ${i.strength ?? ''}`.trim(),
                  code: i.code,
                  onHand: i.pharmacyUsable ?? 0,
                  level: i.reorderLevel,
                  maxLevel: i.maxLevel ?? null,
                }))
            : [],
          roomLow: [],
          expiring: o.items
            .filter((i) => (i.expiringUnits ?? 0) > 0)
            .flatMap((i) =>
              Object.entries(i.byLocation).map(([storeId, quantity]) => ({
                storeId,
                store: sampleLocations.find((l) => l.id === storeId)?.name ?? '',
                itemId: i.id,
                item: `${i.name} ${i.strength ?? ''}`.trim(),
                batchNo: sampleBatchNo[i.id] ?? null,
                expiry: i.earliestExpiry!,
                quantity,
                days: Math.round((new Date(i.earliestExpiry!).getTime() - Date.now()) / 86_400_000),
              })),
            ),
          expired: [],
        }
      }
      const { data, error } = await supabase.rpc('stock_alerts')
      if (error) {
        if (isMissingFunction(error))
          return { supported: false, low: [], roomLow: [], expiring: [], expired: [] }
        throw apiError(error)
      }
      const d = (data ?? {}) as Partial<StockAlerts>
      return {
        supported: true,
        low: (d.low ?? []).map((x) => ({
          ...x,
          onHand: num(x.onHand),
          level: num(x.level),
          maxLevel: numOrNull(x.maxLevel),
        })),
        roomLow: (d.roomLow ?? []).map((x) => ({ ...x, onHand: num(x.onHand), min: num(x.min) })),
        expiring: (d.expiring ?? []).map((x) => ({
          ...x,
          quantity: num(x.quantity),
          days: num(x.days),
        })),
        expired: (d.expired ?? []).map((x) => ({ ...x, quantity: num(x.quantity) })),
      }
    },
  })
}

/** What to order (pharmacy and manager): up to the maximum, with the last supplier and cost. */
export function useReorderSuggestions(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'reorder'],
    enabled,
    queryFn: async (): Promise<ReorderSuggestion[]> => {
      if (!supabase)
        return sampleOverview()
          .items.filter((i) => i.low)
          .map((i) => {
            const onHand = i.pharmacyUsable ?? 0
            const suggested = Math.max(0, (i.maxLevel ?? i.reorderLevel * 2) - onHand)
            const pack = i.packSize ?? null
            return {
              itemId: i.id,
              item: `${i.name} ${i.strength ?? ''}`.trim(),
              code: i.code,
              unit: i.unit,
              packSize: pack,
              onHand,
              level: i.reorderLevel,
              maxLevel: i.maxLevel ?? null,
              inRooms: Object.entries(i.byLocation)
                .filter(([k]) => k === 'l-cons' || k === 'l-nurse')
                .reduce((s, [, v]) => s + v, 0),
              monthlyUse: 120,
              suggested,
              suggestedBoxes: pack && pack > 1 ? Math.ceil(suggested / pack) : null,
              lastSupplier: 'Kigali Pharma Wholesale Ltd',
              lastCost: i.avgCost,
              lastReceivedAt: ago(60 * 24 * 12),
              estimatedCost: Math.round(suggested * (i.avgCost ?? 0)),
            }
          })
      const { data, error } = await supabase.rpc('reorder_suggestions')
      if (error) {
        if (isMissingFunction(error)) return []
        throw apiError(error)
      }
      return ((data ?? []) as ReorderSuggestion[]).map((r) => ({
        ...r,
        packSize: numOrNull(r.packSize),
        onHand: num(r.onHand),
        level: num(r.level),
        maxLevel: numOrNull(r.maxLevel),
        inRooms: num(r.inRooms),
        monthlyUse: num(r.monthlyUse),
        suggested: num(r.suggested),
        suggestedBoxes: numOrNull(r.suggestedBoxes),
        lastCost: numOrNull(r.lastCost),
        estimatedCost: num(r.estimatedCost),
      }))
    },
  })
}

/** Deliveries received in a period (pharmacy and manager); default the last 30 days. */
export function useDeliveries(period?: DayRange | null) {
  return useQuery({
    queryKey: [...KEY, 'deliveries', period?.from ?? null, period?.to ?? null],
    queryFn: async (): Promise<Delivery[]> => {
      if (!supabase)
        return sampleDeliveries.map(({ lines, ...d }) => ({
          ...d,
          lines: lines.length,
          units: lines.reduce((s, l) => s + l.units, 0),
        }))
      const { data, error } = await supabase.rpc(
        'deliveries',
        period ? { p_from: period.from, p_to: period.to } : undefined,
      )
      if (error) {
        if (isMissingFunction(error)) return []
        throw apiError(error)
      }
      return ((data ?? []) as Delivery[]).map((d) => ({
        ...d,
        lines: num(d.lines),
        units: num(d.units),
        totalCost: num(d.totalCost),
      }))
    },
  })
}

/** One delivery note, line by line (boxes, units, batch, expiry, costs). */
export function useDeliveryDetail(id: string | null) {
  return useQuery({
    queryKey: [...KEY, 'delivery', id],
    enabled: !!id,
    queryFn: async (): Promise<DeliveryDetail | null> => {
      if (!supabase) return sampleDeliveries.find((d) => d.id === id) ?? null
      const { data, error } = await supabase.rpc('delivery_detail', { p_id: id })
      if (error) throw apiError(error)
      if (!data) return null
      const d = data as DeliveryDetail
      return {
        ...d,
        totalCost: num(d.totalCost),
        lines: (d.lines ?? []).map((l) => ({
          ...l,
          packs: num(l.packs),
          packSize: num(l.packSize, 1),
          units: num(l.units),
          unitCost: num(l.unitCost),
          packCost: numOrNull(l.packCost),
          lineCost: num(l.lineCost),
        })),
      }
    },
  })
}

// ---------------------------------------------------------------- actions
export function useStockActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEY })
    void qc.invalidateQueries({ queryKey: ['visit'] })
    void qc.invalidateQueries({ queryKey: ['queue'] })
  }
  /** Receiving can add a medicine to the clinic (from the RHIA list): the lists follow. */
  const refreshAll = () => {
    refresh()
    void qc.invalidateQueries({ queryKey: ['catalogue'] })
  }
  /** A return can leave money to give back: the cashier's figures follow. */
  const refreshMoney = () => {
    refresh()
    void qc.invalidateQueries({ queryKey: ['finance'] })
    void qc.invalidateQueries({ queryKey: ['home'] })
  }
  const call = async (fn: string, args: Record<string, unknown>) => {
    if (!supabase) return null
    const { data, error } = await supabase.rpc(fn, args)
    if (error) throw apiError(error)
    return data
  }
  const sampleNewMedicine = (
    itemId: string,
    m: Pick<StockItem, 'code' | 'name' | 'strength' | 'unit' | 'sellingPrice'>,
    unitCost: number,
    expiry: string | null,
  ) => {
    if (sampleItems.some((x) => x.id === itemId)) return
    sampleItems.push({
      ...m,
      id: itemId,
      packSize: null,
      reorderLevel: 0,
      maxLevel: null,
      onHand: 0,
      costValue: 0,
      avgCost: unitCost,
      byLocation: {},
      earliestExpiry: expiry,
      expiredUnits: 0,
      active: true,
    })
  }

  /** One medicine received into a store (receive_stock; pharmacy stores, or the lab's own). */
  const receive = useMutation({
    mutationFn: (i: {
      itemId: string
      locationId: string
      quantity: number
      unitCost: number
      batchNo?: string
      expiry?: string
      supplier?: string
      /** A medicine just added to the clinic (from the RHIA list): sample mode lists it. */
      newMedicine?: Pick<StockItem, 'code' | 'name' | 'strength' | 'unit' | 'sellingPrice'>
    }) => {
      if (!supabase) {
        if (i.newMedicine) sampleNewMedicine(i.itemId, i.newMedicine, i.unitCost, i.expiry ?? null)
        sampleMove(i.itemId, null, i.locationId, i.quantity)
        return Promise.resolve(null)
      }
      return call('receive_stock', {
        p_item_id: i.itemId,
        p_location_id: i.locationId,
        p_quantity: i.quantity,
        p_unit_cost: i.unitCost,
        p_batch_no: i.batchNo?.trim() || null,
        p_expiry: i.expiry || null,
        p_supplier: i.supplier?.trim() || null,
      })
    },
    onSuccess: refreshAll,
  })

  /**
   * A whole delivery note into the pharmacy (GRN-YYMMDD-NNN): several medicines, in boxes or
   * units, each with its batch, expiry and cost. An old database (before 0083) receives the
   * clinic's medicines one by one with receive_stock.
   */
  const receiveDelivery = useMutation({
    mutationFn: async (i: DeliveryInput): Promise<DeliveryResult> => {
      const lines = i.lines.map((l) => ({
        itemId: l.itemId ?? null,
        refCode: l.refCode ?? null,
        batchNo: l.batchNo?.trim() || null,
        expiry: l.expiry,
        quantity: l.quantity,
        unit: l.unit ?? 'unit',
        packSize: l.unit === 'box' ? (l.packSize ?? null) : null,
        cost: l.cost,
        sellingPrice: l.sellingPrice ?? null,
      }))
      const unitsOf = (l: DeliveryLineInput) =>
        l.unit === 'box' ? l.quantity * (l.packSize ?? 1) : l.quantity
      const unitCostOf = (l: DeliveryLineInput) =>
        l.unit === 'box' ? l.cost / Math.max(1, l.packSize ?? 1) : l.cost
      if (!supabase) {
        const loc = i.locationId ?? 'l-pharm'
        let units = 0
        let total = 0
        const id = `grn-${Date.now()}`
        const detail: DeliveryDetail = {
          id,
          number: `GRN-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${String(sampleDeliveries.length + 1).padStart(3, '0')}`,
          supplier: i.supplier.trim(),
          reference: i.reference?.trim() || null,
          deliveredOn: i.deliveredOn ?? new Date().toISOString().slice(0, 10),
          receivedAt: new Date().toISOString(),
          receivedBy: useSession.getState().user?.name ?? null,
          store: sampleLocations.find((l) => l.id === loc)?.name ?? null,
          storeId: loc,
          note: i.note?.trim() || null,
          totalCost: 0,
          lines: [],
        }
        for (const [k, l] of i.lines.entries()) {
          const itemId = l.itemId ?? `it-${(l.refCode ?? 'new').toLowerCase()}`
          if (l.newMedicine) sampleNewMedicine(itemId, l.newMedicine, unitCostOf(l), l.expiry)
          const u = unitsOf(l)
          const it = sampleItems.find((x) => x.id === itemId)
          if (it && l.unit === 'box' && l.packSize && !it.packSize) it.packSize = l.packSize
          sampleMove(itemId, null, loc, u)
          sampleStock.log({
            type: 'receipt',
            itemId,
            item: sampleLabel(itemId),
            quantity: u,
            from: null,
            toId: loc,
            to: detail.store,
            reason: detail.supplier,
            delivery: detail.number,
          })
          units += u
          total += l.cost * l.quantity
          detail.lines.push({
            id: `${id}-${k}`,
            itemId,
            item: sampleLabel(itemId),
            unit: l.unit ?? 'unit',
            packs: l.quantity,
            packSize: l.unit === 'box' ? (l.packSize ?? 1) : 1,
            units: u,
            batchNo: l.batchNo?.toUpperCase() ?? null,
            expiry: l.expiry,
            unitCost: unitCostOf(l),
            packCost: l.unit === 'box' ? l.cost : null,
            lineCost: l.cost * l.quantity,
          })
        }
        detail.totalCost = total
        sampleDeliveries.unshift(detail)
        return {
          id,
          number: detail.number,
          locationId: loc,
          lines: i.lines.length,
          units,
          totalCost: total,
        }
      }
      const { data, error } = await supabase.rpc('receive_delivery', {
        p_supplier: i.supplier.trim(),
        p_reference: i.reference?.trim() || null,
        p_lines: lines,
        p_delivered_on: i.deliveredOn || null,
        p_location_id: i.locationId ?? null,
        p_note: i.note?.trim() || null,
      })
      if (!error) {
        const d = data as DeliveryResult
        return {
          ...d,
          lines: num(d.lines),
          units: num(d.units),
          totalCost: num(d.totalCost),
        }
      }
      if (!isMissingFunction(error) || !i.locationId) throw apiError(error)
      // before 0083: one receipt per line (clinic medicines only)
      let units = 0
      let total = 0
      for (const l of i.lines) {
        if (!l.itemId) throw apiError({ message: 'line: choose a medicine of the clinic' })
        await call('receive_stock', {
          p_item_id: l.itemId,
          p_location_id: i.locationId,
          p_quantity: unitsOf(l),
          p_unit_cost: unitCostOf(l),
          p_batch_no: l.batchNo?.trim() || null,
          p_expiry: l.expiry || null,
          p_supplier: [i.supplier.trim(), i.reference?.trim()].filter(Boolean).join(' · '),
        })
        units += unitsOf(l)
        total += l.cost * l.quantity
      }
      return {
        id: '',
        number: null,
        locationId: i.locationId,
        lines: i.lines.length,
        units,
        totalCost: total,
      }
    },
    onSuccess: refreshAll,
  })

  /**
   * Stock added to the pharmacy (add_stock; another store: the manager only): one line per
   * batch, each an item of the clinic or a new one (created at its selling price), with its batch
   * number, expiry date (not in the past), units, cost per unit and selling price. No supplier,
   * no delivery note: the date is today.
   */
  const addStock = useMutation({
    mutationFn: async (i: {
      lines: AddStockLineInput[]
      locationId?: string | null
      note?: string
    }): Promise<AddStockResult> => {
      if (!supabase) {
        const loc = i.locationId ?? 'l-pharm'
        const today = new Date().toISOString().slice(0, 10)
        const out: AddStockResult = { lines: [], totalCost: 0, priceIgnored: false }
        for (const l of i.lines) {
          if (l.expiry < today) throw sampleRefusal('expiredDate', '22023')
          const batch = l.batchNo.trim().toUpperCase()
          const known = l.itemId ? sampleItems.find((x) => x.id === l.itemId) : undefined
          if (known && sampleBatchNo[known.id] === batch && known.earliestExpiry !== l.expiry)
            throw sampleRefusal('batchExpiry', '22023')
          let itemId = l.itemId
          if (!itemId && l.newItem) {
            itemId = `it-new-${Date.now()}-${out.lines.length}`
            sampleNewMedicine(
              itemId,
              {
                code: l.newItem.name.slice(0, 8).toUpperCase().replace(/\s+/g, ''),
                name: l.newItem.name.trim(),
                strength: l.newItem.strength?.trim() || null,
                unit: l.newItem.unit?.trim() || null,
                sellingPrice: l.sellPrice ?? null,
              },
              l.unitCost,
              l.expiry,
            )
            const it = sampleItems.find((x) => x.id === itemId)
            if (it) it.kind = l.newItem.kind
          }
          if (!itemId) continue
          const it = sampleItems.find((x) => x.id === itemId)
          if (it) {
            if (l.sellPrice != null) it.sellingPrice = l.sellPrice
            if (!it.earliestExpiry || l.expiry < it.earliestExpiry) it.earliestExpiry = l.expiry
            sampleBatchNo[itemId] = batch
          }
          sampleMove(itemId, null, loc, l.quantity)
          sampleStock.log({
            type: 'receipt',
            itemId,
            item: sampleLabel(itemId),
            quantity: l.quantity,
            from: null,
            toId: loc,
            to: sampleLocations.find((x) => x.id === loc)?.name ?? null,
            reason: i.note?.trim() || null,
          })
          out.lines.push({ itemId, batchId: `b-${itemId}`, quantity: l.quantity })
          out.totalCost += l.quantity * l.unitCost
        }
        return out
      }
      const { data, error } = await supabase.rpc('add_stock', {
        p_lines: i.lines.map((l) => ({
          item_id: l.itemId ?? null,
          new_item: l.newItem
            ? {
                name: l.newItem.name.trim(),
                form: l.newItem.form?.trim() || null,
                strength: l.newItem.strength?.trim() || null,
                kind: l.newItem.kind,
                unit: l.newItem.unit?.trim() || null,
              }
            : null,
          batch_no: l.batchNo.trim(),
          expiry: l.expiry,
          quantity: l.quantity,
          unit_cost: l.unitCost,
          sell_price: l.sellPrice ?? null,
        })),
        p_location_id: i.locationId ?? null,
        p_note: i.note?.trim() || null,
      })
      if (error) throw apiError(error)
      const d = (data ?? {}) as Record<string, unknown>
      const lines = (Array.isArray(d.lines) ? d.lines : []) as Record<string, unknown>[]
      const flag = (o: Record<string, unknown>) =>
        !!(o.price_ignored ?? o.priceIgnored ?? o.price_not_changed ?? o.priceNotChanged)
      return {
        lines: lines.map((l) => ({
          itemId: String(l.item_id ?? l.itemId ?? ''),
          batchId: (l.batch_id ?? l.batchId ?? null) as string | null,
          quantity: num(l.quantity),
        })),
        totalCost: num(d.total_cost ?? d.totalCost),
        priceIgnored: flag(d) || lines.some(flag),
      }
    },
    onSuccess: refreshAll,
  })

  /** Between pharmacy stores, or from the old main store to the pharmacy (room stores: notes). */
  const transfer = useMutation({
    mutationFn: (i: {
      itemId: string
      from: string
      to: string
      quantity: number
      reason?: string
    }) => {
      if (!supabase) {
        sampleMove(i.itemId, i.from, i.to, i.quantity)
        return Promise.resolve(null)
      }
      return call('transfer_stock', {
        p_item_id: i.itemId,
        p_from_location_id: i.from,
        p_to_location_id: i.to,
        p_quantity: i.quantity,
        p_reason: i.reason?.trim() || null,
      })
    },
    onSuccess: refresh,
  })
  /** A write-off (expired, damaged, used at a desk): a reason of at least 3 characters. */
  const use = useMutation({
    mutationFn: (i: { itemId: string; locationId: string; quantity: number; reason?: string }) => {
      if (!supabase) {
        sampleMove(i.itemId, i.locationId, null, i.quantity)
        return Promise.resolve(null)
      }
      return call('use_stock', {
        p_item_id: i.itemId,
        p_location_id: i.locationId,
        p_quantity: i.quantity,
        p_encounter_id: null,
        p_reason: i.reason?.trim() || null,
      })
    },
    onSuccess: refresh,
  })
  /**
   * Hand a prescription line over from a pharmacy store (null: the main pharmacy). Refused while
   * the doctor still has the patient (MS002) or when the bill is closed (MS001).
   */
  const dispense = useMutation({
    mutationFn: async (
      i: string | { requestId: string; locationId?: string | null },
    ): Promise<{ charged: boolean; dispenseId: string | null; locationId: string | null }> => {
      const requestId = typeof i === 'string' ? i : i.requestId
      const locationId = typeof i === 'string' ? null : (i.locationId ?? null)
      if (!supabase) {
        const at = sampleQueue.findIndex((x) => x.requestId === requestId)
        const q = sampleQueue[at]
        if (q?.doctorHolds) throw sampleRefusal('doctorHolds', 'MS002')
        if (q) {
          const loc = locationId ?? 'l-pharm'
          if (sampleUsable(q.itemId, loc) < q.quantity) throw sampleRefusal('short', '23514')
          sampleMove(q.itemId, loc, null, q.quantity)
          sampleQueue.splice(at, 1)
        }
        return { charged: q?.priced ?? true, dispenseId: `d-${Date.now()}`, locationId }
      }
      const args: Record<string, unknown> = { p_medication_request_id: requestId }
      args.p_location_id = locationId
      const d = (await call('dispense_prescription', args)) as {
        charged?: boolean
        dispenseId?: string
        locationId?: string
      } | null
      return {
        charged: !!d?.charged,
        dispenseId: d?.dispenseId ?? null,
        locationId: d?.locationId ?? locationId,
      }
    },
    onSuccess: refreshMoney,
  })
  /** The main (receiving) pharmacy store (manager). */
  const setMainPharmacy = useMutation({
    mutationFn: async (locationId: string) => {
      if (!supabase) {
        for (const l of sampleLocations) l.isMain = l.id === locationId
        return
      }
      await call('set_main_pharmacy', { p_location_id: locationId })
    },
    onSuccess: refresh,
  })
  /**
   * A pharmacy or main store (the pharmacy or the manager). Room stores are made by the manager
   * with rooms.ts (save_room_store) so their holders are set too; 'main_store' can no longer be
   * created (22023 no_main_store), only renamed.
   */
  const saveLocation = useMutation({
    mutationFn: (i: {
      id?: string
      name: string
      type: StockLocationType
      departmentId: string | null
    }) => {
      if (!supabase) {
        if (i.id) {
          const l = sampleLocations.find((x) => x.id === i.id)
          if (l) l.name = i.name.trim()
        } else {
          if (i.type === 'main_store') throw sampleRefusal('noMainStore', '22023')
          sampleLocations.push({
            id: `l-${Math.random().toString(36).slice(2, 7)}`,
            name: i.name.trim(),
            type: i.type,
            department: null,
            active: true,
          })
        }
        return Promise.resolve(null)
      }
      return call('save_location', {
        p_id: i.id ?? null,
        p_name: i.name.trim(),
        p_type: i.type,
        p_department_id: i.departmentId,
      })
    },
    onSuccess: refresh,
  })
  // The pharmacy cannot hand it over (out of stock, bought elsewhere…): the doctor is told.
  const notGiven = useMutation({
    mutationFn: async (i: { requestId: string; reason: string }) => {
      if (!supabase) {
        const at = sampleQueue.findIndex((x) => x.requestId === i.requestId)
        if (at >= 0) sampleQueue.splice(at, 1)
        return
      }
      await call('rx_not_given', { p_medication_request_id: i.requestId, p_reason: i.reason })
    },
    onSuccess: refresh,
  })
  // The pharmacy sells a medicine to a patient on a visit (it joins the visit's bill; the patient
  // pays at the end). A walk-in buyer without a visit: counter-sales.ts.
  const sell = useMutation({
    mutationFn: async (i: {
      encounterId: string
      itemId: string
      quantity: number
      instructions?: string
      locationId?: string | null
    }): Promise<{
      charged: boolean
      requestId: string | null
      dispenseId: string | null
      locationId: string | null
    }> => {
      if (!supabase) {
        const loc = i.locationId ?? 'l-pharm'
        if (sampleUsable(i.itemId, loc) < i.quantity) throw sampleRefusal('short', '23514')
        sampleMove(i.itemId, loc, null, i.quantity)
        return { charged: true, requestId: null, dispenseId: null, locationId: loc }
      }
      const args: Record<string, unknown> = {
        p_encounter_id: i.encounterId,
        p_item_id: i.itemId,
        p_quantity: i.quantity,
        p_instructions: i.instructions?.trim() || null,
      }
      // only when chosen, so a database before 0082 (four arguments) still sells
      if (i.locationId) args.p_location_id = i.locationId
      const d = (await call('sell_medicine', args)) as {
        charged?: boolean
        requestId?: string
        dispenseId?: string
        locationId?: string
      } | null
      return {
        charged: !!d?.charged,
        requestId: d?.requestId ?? null,
        dispenseId: d?.dispenseId ?? null,
        locationId: d?.locationId ?? i.locationId ?? null,
      }
    },
    onSuccess: refresh,
  })
  /**
   * The quantity at which the medicine shows as low (0: never), and optionally the quantity to
   * order up to (`maxLevel`: null/undefined leaves it, 0 clears it; above the level).
   */
  const setReorderLevel = useMutation({
    mutationFn: async (i: { itemId: string; level: number; maxLevel?: number | null }) => {
      if (!supabase) {
        const it = sampleItems.find((x) => x.id === i.itemId)
        if (it) {
          it.reorderLevel = i.level
          if (i.maxLevel != null) it.maxLevel = i.maxLevel || null
        }
        return null
      }
      const args: Record<string, unknown> = { p_item_id: i.itemId, p_level: i.level }
      if (i.maxLevel != null) args.p_max_level = i.maxLevel
      const { data, error } = await supabase.rpc('set_reorder_level', args)
      if (!error) return data
      // before 0083 there is no maximum: keep the level
      if (i.maxLevel != null && isMissingFunction(error))
        return call('set_reorder_level', { p_item_id: i.itemId, p_level: i.level })
      throw apiError(error)
    },
    onSuccess: refresh,
  })
  /** The shelf was counted: the store's stock becomes that count (difference kept with its reason). */
  const adjust = useMutation({
    mutationFn: (i: { itemId: string; locationId: string; counted: number; reason: string }) => {
      if (!supabase) {
        const before = sampleUsable(i.itemId, i.locationId)
        sampleMove(i.itemId, i.locationId, null, before - i.counted)
        return Promise.resolve(null)
      }
      return call('adjust_stock', {
        p_item_id: i.itemId,
        p_location_id: i.locationId,
        p_counted: i.counted,
        p_reason: i.reason.trim(),
      })
    },
    onSuccess: refresh,
  })
  /**
   * A store no longer used is closed (empty, no note on the way); it can be opened again. Room
   * stores: the manager; pharmacy and main stores: the pharmacy or the manager.
   */
  const setLocationActive = useMutation({
    mutationFn: async (i: { id: string; active: boolean }) => {
      if (!supabase) {
        const l = sampleLocations.find((x) => x.id === i.id)
        if (l) {
          if (!i.active && sampleItems.some((x) => (x.byLocation[l.id] ?? 0) > 0))
            throw sampleRefusal('storeHasStock', '23514')
          l.active = i.active
        }
        return null
      }
      return call('set_location_active', { p_id: i.id, p_active: i.active })
    },
    onSuccess: refresh,
  })
  /**
   * A hand-over undone. Bill still open: off the bill, waiting at the pharmacy again. Bill
   * posted: a credit note gives the patient's share back (balance below 0: money to give back
   * at the cashier) and the line shows as returned.
   */
  const returnMedicine = useMutation({
    mutationFn: async (i: { requestId: string; reason: string }): Promise<ReturnResult> => {
      if (!supabase) return { units: 0, mode: 'bill', creditNoteId: null, credit: 0, balance: null }
      const d = (await call('return_medicine', {
        p_medication_request_id: i.requestId,
        p_reason: i.reason.trim(),
      })) as Partial<ReturnResult> | null
      return {
        units: num(d?.units),
        mode: d?.mode === 'credit' ? 'credit' : 'bill',
        creditNoteId: d?.creditNoteId ?? null,
        credit: num(d?.credit),
        balance: numOrNull(d?.balance),
      }
    },
    onSuccess: refreshMoney,
  })
  return {
    returnMedicine,
    addStock,
    receive,
    receiveDelivery,
    transfer,
    use,
    dispense,
    notGiven,
    sell,
    saveLocation,
    setMainPharmacy,
    setReorderLevel,
    adjust,
    setLocationActive,
  }
}

/** The pharmacy desk's figures (migration 0056; counter sales and room stores from 0083). */
export interface PharmacySummary {
  lines: number
  patients: number
  dispensedToday: number
  patientsServedToday: number
  notGivenToday: number
  salesToday: number
  topToday: { item: string; count: number }[]
  notGiven: { item: string; patient: string; reason: string | null; at: string }[]
  /** Counter sales handed over in the period, and their total. */
  counterSales?: number
  counterSalesTotal?: number
  /** Counter sales waiting for payment at the cashier / paid and waiting to be handed over. */
  counterToPay?: number
  counterToHandOver?: number
  /** Refill requests open, return notes to confirm, transfer notes on the way. */
  refillsOpen?: number
  returnsToConfirm?: number
  notesOnTheWay?: number
}

export function usePharmacySummary(period?: DayRange | null) {
  return useQuery({
    queryKey: [...KEY, 'pharmacy-summary', period?.from, period?.to],
    refetchInterval: 30_000,
    queryFn: async (): Promise<PharmacySummary> => {
      if (!supabase)
        return {
          lines: sampleQueue.length,
          patients: new Set(sampleQueue.map((q) => q.encounterId)).size,
          dispensedToday: 23,
          patientsServedToday: 14,
          notGivenToday: 1,
          salesToday: 41600,
          topToday: [
            { item: 'Amoxicillin 500 mg', count: 6 },
            { item: 'Paracetamol 500 mg', count: 5 },
            { item: 'Artemether-lumefantrine 20/120 mg', count: 4 },
          ],
          notGiven: [
            {
              item: 'Ciprofloxacin 500 mg',
              patient: 'Habimana Eric',
              reason: 'Out of stock',
              at: ago(50),
            },
          ],
          counterSales: 2,
          counterSalesTotal: 3500,
          counterToPay: 1,
          counterToHandOver: 0,
          refillsOpen: 1,
          returnsToConfirm: 0,
          notesOnTheWay: 0,
        }
      const { data, error } = await supabase.rpc(
        'pharmacy_summary',
        period ? { p_from: period.from, p_to: period.to } : undefined,
      )
      if (error) throw apiError(error)
      const d = (data ?? {}) as PharmacySummary
      const opt = (v: unknown) => (v == null ? undefined : num(v))
      return {
        ...d,
        salesToday: num(d.salesToday),
        topToday: d.topToday ?? [],
        notGiven: d.notGiven ?? [],
        counterSales: opt(d.counterSales),
        counterSalesTotal: opt(d.counterSalesTotal),
        counterToPay: opt(d.counterToPay),
        counterToHandOver: opt(d.counterToHandOver),
        refillsOpen: opt(d.refillsOpen),
        returnsToConfirm: opt(d.returnsToConfirm),
        notesOnTheWay: opt(d.notesOnTheWay),
      }
    },
  })
}

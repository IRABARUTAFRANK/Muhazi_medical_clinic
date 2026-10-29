import { addDays, isoDate } from '@mmc/shared'
import type { ReportContext, ReportPeriod } from '@/lib/reports/defs/types'
import { reportCall } from './reports-options'
import { sampleStock } from './stock'

/**
 * The report centre's stock and pharmacy reports (migration 0112): one database function per
 * report, which checks the rights again (the manager and the pharmacy desk: every store and the
 * costs; a store holder: their stores, never the costs). In sample mode the rows come from the
 * sample stock of lib/api/stock (and a few more sample medicines), within the same rights.
 *
 * Stock is in pieces everywhere; each row carries the piece word and the pack (size and word) so
 * the report shows the packs beside the pieces.
 */

export type ItemKind = 'medicine' | 'supply'

/** How a medicine is packed: the piece word, the pieces in one pack, the pack word. */
export interface Packed {
  unit: string | null
  packSize: number | null
  packUnit: string | null
}

export interface StockStore {
  id: string
  name: string
  type: string
  isRoom: boolean
  isMain: boolean
  active: boolean
}

export interface StockOnHandRow extends Packed {
  itemId: string
  code: string
  name: string
  strength: string | null
  form: string | null
  kind: ItemKind | null
  /** The therapeutic group (ATC), when known. */
  group: string | null
  storeId: string | null
  /** null: all the person's stores together. */
  store: string | null
  onHand: number
  usable: number
  expired: number
  expiring: number
  nextExpiry: string | null
  /** The reorder level (pharmacy) or the store's minimum (room store). */
  level: number | null
  low: boolean
  price: number | null
  /** At cost: the manager and the pharmacy desk only (null for others). */
  costValue: number | null
  /** The usable pieces at today's selling price. */
  sellValue: number
}

export type SoldChannel = 'handover' | 'here' | 'walkin'
export interface StockSoldRow extends Packed {
  itemId: string
  code: string
  name: string
  kind: ItemKind | null
  group: string | null
  /** Only when the rows are split by channel and store. */
  channel: SoldChannel | null
  storeId: string | null
  store: string | null
  pieces: number
  handover: number
  here: number
  walkin: number
  times: number
  revenue: number
  cost: number | null
  margin: number | null
}

export type MovementKind =
  | 'received'
  | 'transfer'
  | 'dispensed'
  | 'sold'
  | 'returned'
  | 'given_here'
  | 'written_off'
  | 'count'
export const MOVEMENT_KINDS: readonly MovementKind[] = [
  'received',
  'transfer',
  'dispensed',
  'sold',
  'returned',
  'given_here',
  'written_off',
  'count',
]
export interface StockMovementRow extends Packed {
  id: string
  at: string
  kind: MovementKind
  itemId: string
  code: string
  name: string
  batch: string | null
  expiry: string | null
  from: string | null
  to: string | null
  quantity: number
  /** With a store chosen: + in, − out. */
  change: number | null
  reason: string | null
  /** T-…, RT-…, GRN-…, S-… */
  document: string | null
  by: string | null
  unitCost: number | null
  value: number | null
}

export interface StockDeliveryRow extends Packed {
  id: string
  at: string
  deliveredOn: string | null
  number: string | null
  reference: string | null
  supplier: string | null
  storeId: string | null
  store: string | null
  itemId: string
  code: string
  name: string
  /** Packs as typed on the delivery (boxes), when counted in packs. */
  packs: number | null
  batch: string | null
  expiry: string | null
  pieces: number
  unitCost: number | null
  lineCost: number | null
  by: string | null
}

export type TransferStatus = 'in_transit' | 'received' | 'cancelled'
export interface StockTransferRow extends Packed {
  id: string
  number: string
  direction: 'to_room' | 'to_pharmacy'
  status: TransferStatus
  at: string
  from: string
  to: string
  itemId: string
  code: string
  name: string
  batch: string | null
  pieces: number
  received: number | null
  costValue: number | null
  sellValue: number | null
  sentBy: string | null
  receivedBy: string | null
  receivedAt: string | null
}

export type ExpiryStatus = 'expired' | 'soon' | 'ok'
export interface StockExpiryRow extends Packed {
  itemId: string
  code: string
  name: string
  kind: ItemKind | null
  batch: string | null
  storeId: string
  store: string
  expiry: string
  daysLeft: number
  status: ExpiryStatus
  pieces: number
  costValue: number | null
  sellValue: number | null
}

export interface StockToOrderRow extends Packed {
  itemId: string
  code: string
  name: string
  kind: ItemKind | null
  /** 'pharmacy': all the open pharmacy stores; 'room': one room store (a refill). */
  scope: 'pharmacy' | 'room'
  storeId: string | null
  store: string | null
  onHand: number
  level: number
  suggested: number
  monthlyUse: number | null
  lastSupplier: string | null
  lastCost: number | null
  estimatedCost: number | null
}

export type WriteOffKind = 'written_off' | 'count' | 'lost'
export interface StockWriteOffRow extends Packed {
  id: string
  at: string
  kind: WriteOffKind
  itemId: string
  code: string
  name: string
  batch: string | null
  storeId: string | null
  store: string | null
  /** − out of the store, + into it (a count found more). */
  quantity: number
  reason: string | null
  costValue: number | null
  by: string | null
}

export interface StockOutsideRow {
  name: string
  itemId: string | null
  code: string | null
  inClinic: boolean
  unit: string | null
  times: number
  quantity: number
  patients: number
  prescribers: string | null
  lastAt: string | null
  notGiven: number
}

// ---------------------------------------------------------------- who reads what

/** The manager and the pharmacy desk: every store and the money at cost. */
export const stockAdmin = (ctx: ReportContext) => ctx.isManager || ctx.canDesk('pharmacy')
/** A stock reader: the manager, the pharmacy desk, a store holder (their stores). */
export const stockReader = (ctx: ReportContext) => stockAdmin(ctx) || ctx.holdsStore

// ---------------------------------------------------------------- calling the database

const arrayOf = <T>(d: unknown): T[] => (Array.isArray(d) ? (d as T[]) : [])
const rpcRows = async <T>(fn: string, args: Record<string, unknown>): Promise<T[]> =>
  arrayOf<T>(await reportCall(fn, args))

const storesCache = new Map<string, { at: number; value: Promise<StockStore[]> }>()

/** The stores this person may report on (asked once a minute). */
export function stockStores(ctx: ReportContext): Promise<StockStore[]> {
  if (ctx.sample) return Promise.resolve(sampleStores(ctx))
  const hit = storesCache.get(ctx.user.id)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  const value = (async () => {
    const d = (await reportCall('report_stock_options', {})) as { stores?: unknown } | null
    return arrayOf<StockStore>(d?.stores)
  })()
  storesCache.set(ctx.user.id, { at: Date.now(), value })
  value.catch(() => storesCache.delete(ctx.user.id))
  return value
}

export interface OnHandArgs {
  store: string | null
  byStore: boolean
  days: number | null
}
export const loadStockOnHand = (a: OnHandArgs, ctx: ReportContext) =>
  ctx.sample
    ? Promise.resolve(sampleOnHand(a, ctx))
    : rpcRows<StockOnHandRow>('report_stock_on_hand', {
        p_location_id: a.store,
        p_by_store: a.byStore,
        p_days: a.days,
      })

export interface SoldArgs {
  period: ReportPeriod
  store: string | null
  channel: SoldChannel | null
  split: boolean
}
export const loadStockSold = (a: SoldArgs, ctx: ReportContext) =>
  ctx.sample
    ? Promise.resolve(sampleSold(a, ctx))
    : rpcRows<StockSoldRow>('report_stock_sold', {
        p_from: a.period.from,
        p_to: a.period.to,
        p_location_id: a.store,
        p_channel: a.channel,
        p_split: a.split,
      })

export interface PeriodStoreArgs {
  period: ReportPeriod
  store: string | null
}
export const loadStockMovements = (
  a: PeriodStoreArgs & { kind: MovementKind | null },
  ctx: ReportContext,
) =>
  ctx.sample
    ? Promise.resolve(sampleMovements(a, ctx))
    : rpcRows<StockMovementRow>('report_stock_movements', {
        p_from: a.period.from,
        p_to: a.period.to,
        p_location_id: a.store,
        p_type: a.kind,
      })

export const loadStockDeliveries = (a: PeriodStoreArgs, ctx: ReportContext) =>
  ctx.sample
    ? Promise.resolve(sampleDeliveries(a, ctx))
    : rpcRows<StockDeliveryRow>('report_stock_deliveries', {
        p_from: a.period.from,
        p_to: a.period.to,
        p_location_id: a.store,
      })

export const loadStockTransfers = (
  a: PeriodStoreArgs & { status: TransferStatus | null },
  ctx: ReportContext,
) =>
  ctx.sample
    ? Promise.resolve(sampleTransfers(a, ctx))
    : rpcRows<StockTransferRow>('report_stock_transfers', {
        p_from: a.period.from,
        p_to: a.period.to,
        p_location_id: a.store,
        p_status: a.status,
      })

export interface ExpiryArgs {
  store: string | null
  within: number | null
  expiredOnly: boolean
}
export const loadStockExpiry = (a: ExpiryArgs, ctx: ReportContext) =>
  ctx.sample
    ? Promise.resolve(sampleExpiry(a, ctx))
    : rpcRows<StockExpiryRow>('report_stock_expiry', {
        p_location_id: a.store,
        p_within: a.within,
        p_expired_only: a.expiredOnly,
      })

export const loadStockToOrder = (a: { store: string | null }, ctx: ReportContext) =>
  ctx.sample
    ? Promise.resolve(sampleToOrder(a, ctx))
    : rpcRows<StockToOrderRow>('report_stock_to_order', { p_location_id: a.store })

export const loadStockWriteOffs = (a: PeriodStoreArgs, ctx: ReportContext) =>
  ctx.sample
    ? Promise.resolve(sampleWriteOffs(a, ctx))
    : rpcRows<StockWriteOffRow>('report_stock_write_offs', {
        p_from: a.period.from,
        p_to: a.period.to,
        p_location_id: a.store,
      })

export const loadStockOutside = (a: { period: ReportPeriod }, ctx: ReportContext) =>
  ctx.sample
    ? Promise.resolve(sampleOutside(a))
    : rpcRows<StockOutsideRow>('report_stock_outside', {
        p_from: a.period.from,
        p_to: a.period.to,
      })

// ---------------------------------------------------------------- sample mode

interface SampleItem extends Packed {
  id: string
  code: string
  name: string
  strength: string | null
  form: string | null
  kind: ItemKind
  group: string | null
  price: number
  packPrice: number | null
  cost: number
  level: number
  /** Pieces per store. */
  by: Record<string, number>
  expiry: string
  batch: string
  /** Pieces handed over / given here / sold to walk-in buyers on an ordinary day. */
  perDay: [number, number, number]
}

const today = () => isoDate(new Date())
const shift = (iso: string, days: number) => isoDate(addDays(new Date(`${iso}T12:00:00`), days))

/** The sample medicines: the four of the stock page, and a few more. */
function sampleItems(): SampleItem[] {
  const t = today()
  const base: SampleItem[] = sampleStock.items.map((it, i) => ({
    id: it.id,
    code: it.code,
    name: `${it.name}${it.strength ? ` ${it.strength}` : ''}`,
    strength: it.strength,
    form: null,
    kind: it.kind ?? 'medicine',
    group: null,
    unit: it.unit,
    packSize: it.packSize && it.packSize >= 2 ? it.packSize : null,
    packUnit: it.packUnit ?? null,
    price: it.sellingPrice ?? 0,
    packPrice: it.saleMode && it.saleMode !== 'piece' ? (it.packPrice ?? null) : null,
    cost: it.avgCost ?? 0,
    level: it.reorderLevel,
    by: { ...it.byLocation },
    expiry: it.earliestExpiry ?? shift(t, 365),
    batch: sampleStock.batchNo[it.id] ?? `B-${i + 1}`,
    perDay: [[6, 1, 2][i % 3]!, i === 0 ? 1 : 0, [3, 4, 1][i % 3]!],
  }))
  const more: SampleItem[] = [
    {
      id: 'it-r1',
      code: 'MET500',
      name: 'Metformin 500 mg',
      strength: '500 mg',
      form: 'tablet',
      kind: 'medicine',
      group: 'A10',
      unit: 'tab',
      packSize: 28,
      packUnit: 'box',
      price: 40,
      packPrice: 1000,
      cost: 18,
      level: 280,
      by: { 'l-pharm': 196 },
      expiry: shift(t, 52),
      batch: 'B260512-003',
      perDay: [9, 0, 2],
    },
    {
      id: 'it-r2',
      code: 'ORS',
      name: 'Oral rehydration salts',
      strength: null,
      form: 'sachet',
      kind: 'medicine',
      group: 'A07',
      unit: 'sachet',
      packSize: 50,
      packUnit: 'carton',
      price: 200,
      packPrice: null,
      cost: 90,
      level: 50,
      by: { 'l-pharm': 230, 'l-nurse': 20 },
      expiry: shift(t, 25),
      batch: 'B260301-011',
      perDay: [4, 2, 1],
    },
    {
      id: 'it-r3',
      code: 'CEF1G',
      name: 'Ceftriaxone 1 g',
      strength: '1 g',
      form: 'vial',
      kind: 'medicine',
      group: 'J01',
      unit: 'vial',
      packSize: 10,
      packUnit: 'box',
      price: 1800,
      packPrice: null,
      cost: 950,
      level: 20,
      by: { 'l-pharm': 14, 'l-cons': 6 },
      expiry: shift(t, -5),
      batch: 'B250911-002',
      perDay: [1, 1, 0],
    },
    {
      id: 'it-r4',
      code: 'GLOVE-M',
      name: 'Examination gloves (M)',
      strength: null,
      form: null,
      kind: 'supply',
      group: null,
      unit: 'pair',
      packSize: 50,
      packUnit: 'box',
      price: 150,
      packPrice: null,
      cost: 60,
      level: 100,
      by: { 'l-pharm': 400, 'l-nurse': 75 },
      expiry: shift(t, 700),
      batch: 'G260101-001',
      perDay: [0, 6, 0],
    },
  ]
  return [...base, ...more]
}

const sampleAdmin = (ctx: ReportContext) => stockAdmin(ctx)
/** The stores this sample person may see. */
function sampleVisible(ctx: ReportContext): Set<string> {
  if (sampleAdmin(ctx)) return new Set(sampleStock.locations.map((l) => l.id))
  return new Set(
    sampleStock.holders.filter((h) => h.profileId === ctx.user.id).map((h) => h.locationId),
  )
}
const storeName = (id: string | null | undefined) =>
  sampleStock.locations.find((l) => l.id === id)?.name ?? null
const isRoom = (id: string) => {
  const l = sampleStock.locations.find((x) => x.id === id)
  return !!l && !['pharmacy', 'main_store'].includes(l.type)
}

function sampleStores(ctx: ReportContext): StockStore[] {
  const seen = sampleVisible(ctx)
  return sampleStock.locations
    .filter((l) => seen.has(l.id))
    .map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type,
      isRoom: isRoom(l.id),
      isMain: !!l.isMain,
      active: l.active !== false,
    }))
}

const sellValue = (it: SampleItem, q: number) =>
  it.packPrice != null && it.packSize
    ? Math.floor(q / it.packSize) * it.packPrice + (q % it.packSize) * it.price
    : q * it.price
const packed = (it: SampleItem): Packed => ({
  unit: it.unit,
  packSize: it.packSize,
  packUnit: it.packUnit,
})

function sampleOnHand(a: OnHandArgs, ctx: ReportContext): StockOnHandRow[] {
  const admin = sampleAdmin(ctx)
  const seen = sampleVisible(ctx)
  const split = a.byStore || !!a.store || !admin
  const t = today()
  const soon = shift(t, a.days ?? 30)
  const out: StockOnHandRow[] = []
  for (const it of sampleItems()) {
    const stores = Object.entries(it.by).filter(
      ([id, q]) => q !== 0 && seen.has(id) && (!a.store || id === a.store),
    )
    const groups: [string | null, number][] = split
      ? stores
      : [[null, stores.reduce((s, [, q]) => s + q, 0)]]
    for (const [storeId, onHand] of groups) {
      if (!onHand && !(admin && it.level > 0)) continue
      const expired = it.expiry < t ? onHand : 0
      const usable = onHand - expired
      const pharmacy = it.by['l-pharm'] ?? 0
      out.push({
        itemId: it.id,
        code: it.code,
        name: it.name,
        strength: it.strength,
        form: it.form,
        kind: it.kind,
        group: it.group,
        ...packed(it),
        storeId,
        store: storeName(storeId),
        onHand,
        usable,
        expired,
        expiring: it.expiry >= t && it.expiry <= soon ? onHand : 0,
        nextExpiry: it.expiry >= t ? it.expiry : null,
        level: storeId && isRoom(storeId) ? null : it.level || null,
        low:
          storeId && isRoom(storeId)
            ? false
            : it.level > 0 && (storeId ? usable : pharmacy) <= it.level,
        price: it.price,
        costValue: admin ? onHand * it.cost : null,
        sellValue: sellValue(it, usable),
      })
    }
  }
  return out
}

/** The days of the period, at most a year (the sample is generated per day). */
const daysOf = (p: ReportPeriod) => {
  const from = Date.parse(`${p.from}T00:00:00Z`)
  const to = Date.parse(`${p.to}T00:00:00Z`)
  return Math.min(366, Math.max(1, Math.round((to - from) / 86_400_000) + 1))
}

function sampleSold(a: SoldArgs, ctx: ReportContext): StockSoldRow[] {
  const admin = sampleAdmin(ctx)
  const seen = sampleVisible(ctx)
  const days = daysOf(a.period)
  const out: StockSoldRow[] = []
  for (const it of sampleItems()) {
    const [h, g, w] = it.perDay
    // hand-overs and walk-in sales from the pharmacy; "given here" from the doctor's office
    const parts: { channel: SoldChannel; storeId: string; pieces: number }[] = [
      { channel: 'handover' as const, storeId: 'l-pharm', pieces: h * days },
      {
        channel: 'here' as const,
        storeId: it.by['l-nurse'] ? 'l-nurse' : 'l-cons',
        pieces: g * days,
      },
      { channel: 'walkin' as const, storeId: 'l-pharm', pieces: w * days },
    ].filter(
      (p) =>
        p.pieces > 0 &&
        seen.has(p.storeId) &&
        (!a.store || p.storeId === a.store) &&
        (!a.channel || p.channel === a.channel),
    )
    if (!parts.length) continue
    const row = (ps: typeof parts, split: boolean): StockSoldRow => {
      const pieces = ps.reduce((s, p) => s + p.pieces, 0)
      const revenue = ps.reduce((s, p) => s + sellValue(it, p.pieces), 0)
      const cost = pieces * it.cost
      const stores = [...new Set(ps.map((p) => p.storeId))]
      const by = (c: SoldChannel) =>
        ps.filter((p) => p.channel === c).reduce((s, p) => s + p.pieces, 0)
      return {
        itemId: it.id,
        code: it.code,
        name: it.name,
        kind: it.kind,
        group: it.group,
        ...packed(it),
        channel: split ? ps[0]!.channel : null,
        storeId: stores.length === 1 ? stores[0]! : null,
        store: stores.length === 1 ? storeName(stores[0]) : null,
        pieces,
        handover: by('handover'),
        here: by('here'),
        walkin: by('walkin'),
        times: Math.max(1, Math.round(pieces / 7)),
        revenue,
        cost: admin ? cost : null,
        margin: admin ? revenue - cost : null,
      }
    }
    if (a.split) for (const p of parts) out.push(row([p], true))
    else out.push(row(parts, false))
  }
  return out.sort((x, y) => y.revenue - x.revenue)
}

/** A time inside the period: `back` days before its end (never before its start). */
const inPeriod = (p: ReportPeriod, back: number, hour: number) => {
  const day = shift(p.to, -back) < p.from ? p.from : shift(p.to, -back)
  return `${day}T${String(hour).padStart(2, '0')}:15:00+02:00`
}

const STAFF = {
  pharmacist: 'Mutoni Aline',
  manager: 'Mugabo Théogène',
  doctor: 'Dr. Mukamana Béatrice',
  nurse: 'Nyirahabimana Chantal',
}

function sampleMovements(
  a: PeriodStoreArgs & { kind: MovementKind | null },
  ctx: ReportContext,
): StockMovementRow[] {
  const admin = sampleAdmin(ctx)
  const seen = sampleVisible(ctx)
  const items = sampleItems()
  const rows: { row: StockMovementRow; fromId: string | null; toId: string | null }[] = []
  let n = 0
  const add = (
    it: SampleItem,
    kind: MovementKind,
    from: string | null,
    to: string | null,
    quantity: number,
    back: number,
    extra: Partial<StockMovementRow> = {},
  ) => {
    n++
    rows.push({
      fromId: from,
      toId: to,
      row: {
        id: `sm-${n}`,
        at: inPeriod(a.period, back, 8 + (n % 9)),
        kind,
        itemId: it.id,
        code: it.code,
        name: it.name,
        ...packed(it),
        batch: it.batch,
        expiry: it.expiry,
        from: storeName(from),
        to: storeName(to),
        quantity,
        change: null,
        reason: null,
        document: null,
        by: kind === 'given_here' ? STAFF.doctor : STAFF.pharmacist,
        unitCost: admin ? it.cost : null,
        value: admin ? quantity * it.cost : null,
        ...extra,
      },
    })
  }
  items.forEach((it, i) => {
    add(it, 'received', null, 'l-pharm', (it.packSize ?? 10) * 10, 20 + i, {
      document: `GRN-2610${10 + i}-001`,
      reason: 'Kigali Pharma Wholesale Ltd',
    })
    if (it.perDay[0]) add(it, 'dispensed', 'l-pharm', null, it.perDay[0] * 3, 3 + (i % 4))
    if (it.perDay[2])
      add(it, 'sold', 'l-pharm', null, it.perDay[2] * 2, 1 + (i % 3), {
        document: `S-2610${20 + i}-00${i + 1}`,
      })
  })
  const amox = items[0]!
  const ors = items.find((x) => x.id === 'it-r2')!
  const cef = items.find((x) => x.id === 'it-r3')!
  add(amox, 'transfer', 'l-pharm', 'l-cons', 40, 6, { document: 'T-261024-001' })
  add(amox, 'given_here', 'l-cons', null, 7, 2)
  add(ors, 'given_here', 'l-nurse', null, 4, 1, { by: STAFF.nurse })
  add(cef, 'written_off', 'l-pharm', null, 3, 4, { reason: 'Expired', by: STAFF.manager })
  add(ors, 'count', 'l-pharm', null, 2, 5, { reason: 'Monthly count' })
  add(amox, 'returned', null, 'l-pharm', 7, 2, { reason: 'Patient allergic' })
  return rows
    .filter(({ row, fromId, toId }) => {
      const mine = [fromId, toId].some((id) => id != null && seen.has(id))
      const store = !a.store || fromId === a.store || toId === a.store
      return mine && store && (!a.kind || row.kind === a.kind)
    })
    .map(({ row, toId }) => ({
      ...row,
      change: a.store ? (toId === a.store ? row.quantity : -row.quantity) : null,
    }))
    .sort((x, y) => y.at.localeCompare(x.at))
}

function sampleDeliveries(a: PeriodStoreArgs, ctx: ReportContext): StockDeliveryRow[] {
  const admin = sampleAdmin(ctx)
  const seen = sampleVisible(ctx)
  if (!seen.has('l-pharm') || (a.store && a.store !== 'l-pharm')) return []
  const suppliers = [
    'Kigali Pharma Wholesale Ltd',
    'Abacus Pharma (Rwanda)',
    'Medical Supplies Ltd',
  ]
  return sampleItems().map((it, i) => {
    const packs = it.packSize ? 10 : null
    const pieces = (it.packSize ?? 1) * (packs ?? 60)
    return {
      id: `sd-${i}`,
      at: inPeriod(a.period, 12 + (i % 5) * 2, 10),
      deliveredOn: shift(a.period.to, -(12 + (i % 5) * 2)),
      number: `GRN-2610${10 + (i % 5)}-00${1 + (i % 2)}`,
      reference: `DN-${55100 + i * 7}`,
      supplier: suppliers[i % suppliers.length]!,
      storeId: 'l-pharm',
      store: storeName('l-pharm'),
      itemId: it.id,
      code: it.code,
      name: it.name,
      ...packed(it),
      packs,
      batch: it.batch,
      expiry: it.expiry,
      pieces,
      unitCost: admin ? it.cost : null,
      lineCost: admin ? pieces * it.cost : null,
      by: STAFF.pharmacist,
    }
  })
}

function sampleTransfers(
  a: PeriodStoreArgs & { status: TransferStatus | null },
  ctx: ReportContext,
): StockTransferRow[] {
  if (!sampleAdmin(ctx)) return []
  const items = sampleItems()
  const notes: { n: string; to: string; status: TransferStatus; back: number; ids: string[] }[] = [
    { n: 'T-261003-001', to: 'l-cons', status: 'received', back: 20, ids: ['it-1', 'it-r3'] },
    {
      n: 'T-261015-002',
      to: 'l-nurse',
      status: 'received',
      back: 12,
      ids: ['it-2', 'it-r2', 'it-r4'],
    },
    { n: 'T-261027-001', to: 'l-cons', status: 'in_transit', back: 1, ids: ['it-1'] },
  ]
  const out: StockTransferRow[] = []
  for (const note of notes) {
    if (a.status && note.status !== a.status) continue
    if (a.store && a.store !== 'l-pharm' && a.store !== note.to) continue
    for (const id of note.ids) {
      const it = items.find((x) => x.id === id)!
      const pieces = (it.packSize ?? 10) * 2
      out.push({
        id: `${note.n}-${id}`,
        number: note.n,
        direction: 'to_room',
        status: note.status,
        at: inPeriod(a.period, note.back, 9),
        from: storeName('l-pharm')!,
        to: storeName(note.to)!,
        itemId: it.id,
        code: it.code,
        name: it.name,
        ...packed(it),
        batch: it.batch,
        pieces,
        received: note.status === 'received' ? pieces : null,
        costValue: pieces * it.cost,
        sellValue: sellValue(it, pieces),
        sentBy: STAFF.pharmacist,
        receivedBy: note.status === 'received' ? STAFF.doctor : null,
        receivedAt: note.status === 'received' ? inPeriod(a.period, note.back - 1, 11) : null,
      })
    }
  }
  return out
}

function sampleExpiry(a: ExpiryArgs, ctx: ReportContext): StockExpiryRow[] {
  const admin = sampleAdmin(ctx)
  const seen = sampleVisible(ctx)
  const t = today()
  const out: StockExpiryRow[] = []
  for (const it of sampleItems()) {
    for (const [storeId, q] of Object.entries(it.by)) {
      if (q <= 0 || !seen.has(storeId) || (a.store && storeId !== a.store)) continue
      const daysLeft = Math.round(
        (Date.parse(`${it.expiry}T00:00:00Z`) - Date.parse(`${t}T00:00:00Z`)) / 86_400_000,
      )
      if (a.expiredOnly && daysLeft >= 0) continue
      if (a.within != null && daysLeft > a.within) continue
      out.push({
        itemId: it.id,
        code: it.code,
        name: it.name,
        kind: it.kind,
        ...packed(it),
        batch: it.batch,
        storeId,
        store: storeName(storeId)!,
        expiry: it.expiry,
        daysLeft,
        status: daysLeft < 0 ? 'expired' : daysLeft <= 30 ? 'soon' : 'ok',
        pieces: q,
        costValue: admin ? q * it.cost : null,
        sellValue: sellValue(it, q),
      })
    }
  }
  return out.sort((x, y) => x.expiry.localeCompare(y.expiry))
}

function sampleToOrder(a: { store: string | null }, ctx: ReportContext): StockToOrderRow[] {
  if (!sampleAdmin(ctx)) return []
  if (a.store && a.store !== 'l-pharm') return []
  return sampleItems()
    .filter((it) => it.level > 0 && (it.by['l-pharm'] ?? 0) <= it.level)
    .map((it) => {
      const onHand = it.by['l-pharm'] ?? 0
      const use = Math.round((it.perDay[0] + it.perDay[2]) * 30)
      const suggested = Math.max(0, Math.max(it.level * 2, use * 2) - onHand)
      return {
        itemId: it.id,
        code: it.code,
        name: it.name,
        kind: it.kind,
        ...packed(it),
        scope: 'pharmacy' as const,
        storeId: null,
        store: null,
        onHand,
        level: it.level,
        suggested,
        monthlyUse: use,
        lastSupplier: 'Kigali Pharma Wholesale Ltd',
        lastCost: it.cost,
        estimatedCost: suggested * it.cost,
      }
    })
}

function sampleWriteOffs(a: PeriodStoreArgs, ctx: ReportContext): StockWriteOffRow[] {
  const admin = sampleAdmin(ctx)
  const seen = sampleVisible(ctx)
  const items = sampleItems()
  const pick = (id: string) => items.find((x) => x.id === id)!
  const list: [SampleItem, WriteOffKind, string, number, string, number][] = [
    [pick('it-r3'), 'written_off', 'l-pharm', -3, 'Expired', 4],
    [pick('it-r2'), 'count', 'l-pharm', -2, 'Monthly count', 5],
    [pick('it-2'), 'count', 'l-nurse', 4, 'Found in the drawer at the count', 9],
    [pick('it-1'), 'lost', 'l-cons', -2, 'Lost on the way (T-261003-001): box damaged', 19],
    [pick('it-r4'), 'written_off', 'l-nurse', -10, 'Torn', 2],
  ]
  return list
    .filter(([, , store]) => seen.has(store) && (!a.store || store === a.store))
    .map(([it, kind, store, quantity, reason, back], i) => ({
      id: `sw-${i}`,
      at: inPeriod(a.period, back, 16),
      kind,
      itemId: it.id,
      code: it.code,
      name: it.name,
      ...packed(it),
      batch: it.batch,
      storeId: store,
      store: storeName(store),
      quantity,
      reason,
      costValue: admin ? quantity * it.cost : null,
      by: isRoom(store) ? STAFF.nurse : STAFF.pharmacist,
    }))
}

function sampleOutside(a: { period: ReportPeriod }): StockOutsideRow[] {
  const days = daysOf(a.period)
  const k = Math.max(1, Math.round(days / 7))
  return [
    {
      name: 'Amoxicillin + clavulanic acid 625 mg',
      itemId: null,
      code: 'J01CR02',
      inClinic: false,
      unit: 'tab',
      times: 3 * k,
      quantity: 42 * k,
      patients: 3 * k,
      prescribers: 'Dr. Mukamana Béatrice, Dr. Niyonsenga Patrick',
      lastAt: inPeriod(a.period, 1, 10),
      notGiven: 0,
    },
    {
      name: 'Artemether-lumefantrine 20/120 mg',
      itemId: 'it-3',
      code: 'AL20120',
      inClinic: true,
      unit: 'tab',
      times: 2 * k,
      quantity: 48 * k,
      patients: 2 * k,
      prescribers: 'Dr. Mukamana Béatrice',
      lastAt: inPeriod(a.period, 2, 15),
      notGiven: 2 * k,
    },
    {
      name: 'Salbutamol inhaler 100 µg',
      itemId: null,
      code: null,
      inClinic: false,
      unit: null,
      times: k,
      quantity: k,
      patients: k,
      prescribers: 'Dr. Ndayisaba Félix',
      lastAt: inPeriod(a.period, 4, 9),
      notGiven: 0,
    },
  ]
}

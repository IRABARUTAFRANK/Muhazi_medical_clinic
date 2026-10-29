import i18n from '@/i18n'
import { keyOptions, matches, searchText, selected, switchedOn } from '@/lib/api/reports-options'
import {
  loadStockDeliveries,
  loadStockExpiry,
  loadStockMovements,
  loadStockOnHand,
  loadStockOutside,
  loadStockSold,
  loadStockToOrder,
  loadStockTransfers,
  loadStockWriteOffs,
  MOVEMENT_KINDS,
  stockAdmin,
  stockReader,
  stockStores,
  type MovementKind,
  type Packed,
  type SoldChannel,
  type StockDeliveryRow,
  type StockExpiryRow,
  type StockMovementRow,
  type StockOnHandRow,
  type StockOutsideRow,
  type StockSoldRow,
  type StockToOrderRow,
  type StockTransferRow,
  type StockWriteOffRow,
  type TransferStatus,
  type WriteOffKind,
} from '@/lib/api/reports-stock'
import { packsText } from '@/pages/stock/stock-util'
import type {
  AnyReportDef,
  ReportColumnDef,
  ReportContext,
  ReportFigureDef,
  ReportFilterDef,
  ReportFilterValues,
  ReportGroupDef,
  ReportValue,
} from './types'

/**
 * The stock and pharmacy reports (migration 0112): what the clinic holds, what was sold or given
 * in any period, the ledger, deliveries, transfers, expiry, what to order, write-offs and the
 * medicines bought outside. Stock is in pieces; every report shows the packs beside them
 * ("503 tab" · "25 boxes of 20 + 3"). The money at cost (cost value, cost of goods, margin) is
 * offered to the manager and the pharmacy desk only; their database functions send it to nobody
 * else.
 */

const P = 'reports.stock'

// ---------------------------------------------------------------- words of the cells

/** A word of a cell in the person's language (the English until the language files have it). */
export const w = (key: string, en: string, vars: Record<string, unknown> = {}): string =>
  String(i18n.t(key, { defaultValue: en, ...vars }))

/** "25 boxes of 20 + 3" (null when the item has no pack or fewer pieces than one pack). */
export function packsOf(p: Packed, pieces: number | null | undefined): string | null {
  if (pieces == null || !p.packSize || p.packSize < 2) return null
  const text = packsText(i18n.t, Math.abs(pieces), p.packSize, p.packUnit)
  return text ? (pieces < 0 ? `– ${text}` : text) : null
}
/** "box of 20", "pack of 10", null for pieces only. */
export const packOf = (p: Packed): string | null =>
  p.packSize && p.packSize >= 2
    ? w(`${P}.packOf`, '{{word}} of {{size}}', {
        word: p.packUnit?.trim() || w(`${P}.pack`, 'pack'),
        size: p.packSize,
      })
    : null
const allStores = () => w(`${P}.allStores`, 'All stores')
const kindWord = (k: string | null | undefined) =>
  k === 'supply' ? w(`${P}.kind.supply`, 'Supplies') : w(`${P}.kind.medicine`, 'Medicines')
const yesNoGroup = (v: boolean, yes: string, yesEn: string, no: string, noEn: string) =>
  v ? w(yes, yesEn) : w(no, noEn)
const num = (v: string | null) => (v != null && v !== '' && !isNaN(Number(v)) ? Number(v) : null)
const sum = <R>(rows: R[], f: (r: R) => number | null | undefined) =>
  rows.reduce((s, r) => s + (Number(f(r)) || 0), 0)

// ---------------------------------------------------------------- shared pieces

/** The manager and the pharmacy desk: the money at cost. */
const admin = (ctx: ReportContext) => stockAdmin(ctx)

const periodFilter = (d: 'today' | 'week' | 'month' = 'month'): ReportFilterDef => ({
  key: 'period',
  label: `${P}.f.period`,
  kind: 'period',
  default: d,
})
const storeFilter: ReportFilterDef = {
  key: 'store',
  label: `${P}.f.store`,
  kind: 'select',
  loadOptions: async (ctx) => (await stockStores(ctx)).map((s) => ({ value: s.id, label: s.name })),
}
const kindFilter: ReportFilterDef = {
  key: 'kind',
  label: `${P}.f.kind`,
  kind: 'select',
  options: keyOptions(`${P}.kind`, ['medicine', 'supply']),
}
const searchFilter: ReportFilterDef = {
  key: 'search',
  label: `${P}.f.search`,
  kind: 'text',
  placeholder: `${P}.f.searchHint`,
}

/** The common columns of a medicine row. */
function itemColumns<R extends Packed & { code: string | null; name: string }>(
  nameDefault = true,
): ReportColumnDef<R>[] {
  return [
    { key: 'code', label: `${P}.col.code`, nowrap: true, value: (r) => r.code },
    { key: 'name', label: `${P}.col.medicine`, default: nameDefault, value: (r) => r.name },
    { key: 'unit', label: `${P}.col.unit`, value: (r) => r.unit },
    { key: 'pack', label: `${P}.col.pack`, value: (r) => packOf(r) },
  ]
}
const money = <R>(
  key: string,
  label: string,
  value: (r: R) => ReportValue,
  o: { default?: boolean; atCost?: boolean } = {},
): ReportColumnDef<R> => ({
  key,
  label,
  kind: 'money',
  total: 'sum',
  default: o.default,
  value,
  ...(o.atCost ? { allowed: admin } : {}),
})
const count = <R>(
  key: string,
  label: string,
  value: (r: R) => ReportValue,
  isDefault = false,
): ReportColumnDef<R> => ({ key, label, kind: 'number', total: 'sum', default: isDefault, value })

const searchRows = <R extends { name: string; code?: string | null }>(
  rows: R[],
  f: ReportFilterValues,
  more: (r: R) => (string | null | undefined)[] = () => [],
) => {
  const q = searchText(f)
  return q ? rows.filter((r) => matches(q, r.name, r.code, ...more(r))) : rows
}
const byKind = <R extends { kind: string | null }>(rows: R[], f: ReportFilterValues) => {
  const k = selected(f, 'kind')
  return k ? rows.filter((r) => (r.kind ?? 'medicine') === k) : rows
}
const storeGroup = <R extends { store: string | null }>(): ReportGroupDef<R> => ({
  key: 'store',
  label: `${P}.g.store`,
  heading: `${P}.col.store`,
  value: (r) => r.store ?? allStores(),
})
const kindGroup = <R extends { kind: string | null }>(): ReportGroupDef<R> => ({
  key: 'kind',
  label: `${P}.g.kind`,
  heading: `${P}.col.kind`,
  value: (r) => kindWord(r.kind),
})
const fig = (label: string, value: number, unit?: string): ReportFigureDef => ({
  label: `${P}.fig.${label}`,
  value,
  unit,
})
const moneyFig = <R>(rows: R[], label: string, f: (r: R) => number | null) =>
  rows.some((r) => f(r) != null) ? [fig(label, Math.round(sum(rows, f)), 'RWF')] : []

// ---------------------------------------------------------------- 1 · stock on hand

const onHand: AnyReportDef = {
  id: 'stock.onHand',
  group: 'stock',
  title: `${P}.onHand.title`,
  description: `${P}.onHand.description`,
  code: 'STK',
  allowed: stockReader,
  filters: [
    storeFilter,
    { key: 'byStore', label: `${P}.f.byStore`, kind: 'toggle', hint: `${P}.f.byStoreHint` },
    kindFilter,
    { key: 'lowOnly', label: `${P}.f.lowOnly`, kind: 'toggle' },
    {
      key: 'expiring',
      label: `${P}.f.expiring`,
      kind: 'select',
      options: keyOptions(`${P}.days`, ['30', '60', '90']),
    },
    searchFilter,
  ],
  columns: [
    ...itemColumns<StockOnHandRow>(),
    { key: 'strength', label: `${P}.col.strength`, value: (r) => r.strength },
    { key: 'form', label: `${P}.col.form`, value: (r) => r.form },
    { key: 'kind', label: `${P}.col.kind`, value: (r) => kindWord(r.kind) },
    { key: 'category', label: `${P}.col.category`, nowrap: true, value: (r) => r.group },
    { key: 'store', label: `${P}.col.store`, default: true, value: (r) => r.store ?? allStores() },
    count('onHand', `${P}.col.onHand`, (r) => r.onHand, true),
    { key: 'packs', label: `${P}.col.packs`, default: true, value: (r) => packsOf(r, r.onHand) },
    count('usable', `${P}.col.usable`, (r) => r.usable),
    count('expired', `${P}.col.expired`, (r) => r.expired),
    count('expiring', `${P}.col.expiring`, (r) => r.expiring),
    {
      key: 'nextExpiry',
      label: `${P}.col.nextExpiry`,
      kind: 'date',
      default: true,
      value: (r) => r.nextExpiry,
    },
    { key: 'level', label: `${P}.col.level`, kind: 'number', value: (r) => r.level },
    {
      key: 'low',
      label: `${P}.col.low`,
      kind: 'yesno',
      total: 'count',
      default: true,
      value: (r) => r.low,
    },
    { key: 'price', label: `${P}.col.price`, kind: 'money', value: (r) => r.price },
    money('costValue', `${P}.col.costValue`, (r: StockOnHandRow) => r.costValue, {
      default: true,
      atCost: true,
    }),
    money('sellValue', `${P}.col.sellValue`, (r: StockOnHandRow) => r.sellValue, { default: true }),
  ],
  async load(f, ctx) {
    let rows = await loadStockOnHand(
      {
        store: selected(f, 'store'),
        byStore: switchedOn(f, 'byStore'),
        days: num(selected(f, 'expiring')),
      },
      ctx,
    )
    rows = byKind(rows, f)
    if (switchedOn(f, 'lowOnly')) rows = rows.filter((r) => r.low)
    if (selected(f, 'expiring')) rows = rows.filter((r) => r.expiring > 0 || r.expired > 0)
    return searchRows(rows, f, (r) => [r.group, r.form])
  },
  figures: (rows: StockOnHandRow[]) => [
    fig('medicines', new Set(rows.filter((r) => r.onHand > 0).map((r) => r.itemId)).size),
    fig(
      'pieces',
      sum(rows, (r) => r.onHand),
    ),
    fig('low', rows.filter((r) => r.low).length),
    ...moneyFig(rows, 'costValue', (r) => r.costValue),
    fig('sellValue', Math.round(sum(rows, (r) => r.sellValue)), 'RWF'),
  ],
  groups: [
    storeGroup<StockOnHandRow>(),
    kindGroup<StockOnHandRow>(),
    {
      key: 'low',
      label: `${P}.g.low`,
      heading: `${P}.col.low`,
      value: (r: StockOnHandRow) =>
        yesNoGroup(r.low, `${P}.lowYes`, 'Low: to order', `${P}.lowNo`, 'Enough'),
    },
    {
      key: 'category',
      label: `${P}.g.category`,
      heading: `${P}.col.category`,
      value: (r: StockOnHandRow) => r.group ?? '',
    },
  ],
  defaultSort: { key: 'name', dir: 'asc' },
  countLabel: `${P}.count.lines`,
  notes: [`${P}.onHand.note1`, `${P}.onHand.note2`, `${P}.onHand.note3`],
}

// ---------------------------------------------------------------- 2 · medicines sold and given

const channelWord = (c: SoldChannel | null) =>
  c === 'handover'
    ? w(`${P}.channel.handover`, 'Pharmacy hand-over')
    : c === 'here'
      ? w(`${P}.channel.here`, 'Given here')
      : c === 'walkin'
        ? w(`${P}.channel.walkin`, 'Walk-in sale')
        : w(`${P}.channel.all`, 'All channels')

const sold: AnyReportDef = {
  id: 'pharmacy.sold',
  group: 'pharmacy',
  title: `${P}.sold.title`,
  description: `${P}.sold.description`,
  code: 'SLD',
  allowed: stockReader,
  filters: [
    periodFilter('month'),
    storeFilter,
    {
      key: 'channel',
      label: `${P}.f.channel`,
      kind: 'select',
      options: keyOptions(`${P}.channel`, ['handover', 'here', 'walkin']),
    },
    { key: 'split', label: `${P}.f.split`, kind: 'toggle', hint: `${P}.f.splitHint` },
    kindFilter,
    searchFilter,
  ],
  columns: [
    ...itemColumns<StockSoldRow>(),
    { key: 'store', label: `${P}.col.store`, value: (r) => r.store ?? allStores() },
    { key: 'channel', label: `${P}.col.channel`, value: (r) => channelWord(r.channel) },
    count('pieces', `${P}.col.pieces`, (r: StockSoldRow) => r.pieces, true),
    { key: 'packs', label: `${P}.col.packs`, default: true, value: (r) => packsOf(r, r.pieces) },
    count('toVisits', `${P}.col.toVisits`, (r: StockSoldRow) => r.handover + r.here, true),
    count('handover', `${P}.col.handover`, (r: StockSoldRow) => r.handover),
    count('here', `${P}.col.here`, (r: StockSoldRow) => r.here),
    count('walkin', `${P}.col.walkin`, (r: StockSoldRow) => r.walkin, true),
    count('times', `${P}.col.times`, (r: StockSoldRow) => r.times),
    money('revenue', `${P}.col.revenue`, (r: StockSoldRow) => r.revenue, { default: true }),
    money('cost', `${P}.col.cogs`, (r: StockSoldRow) => r.cost, { default: true, atCost: true }),
    money('margin', `${P}.col.margin`, (r: StockSoldRow) => r.margin, {
      default: true,
      atCost: true,
    }),
    {
      key: 'marginPct',
      label: `${P}.col.marginPct`,
      kind: 'percent',
      allowed: admin,
      value: (r) => (r.margin != null && r.revenue > 0 ? (r.margin / r.revenue) * 100 : null),
    },
  ],
  async load(f, ctx) {
    const ch = selected(f, 'channel')
    const rows = await loadStockSold(
      {
        period: f.period,
        store: selected(f, 'store'),
        channel: ch === 'handover' || ch === 'here' || ch === 'walkin' ? ch : null,
        split: switchedOn(f, 'split'),
      },
      ctx,
    )
    return searchRows(byKind(rows, f), f, (r) => [r.group])
  },
  figures: (rows: StockSoldRow[]) => [
    fig('medicines', new Set(rows.map((r) => r.itemId)).size),
    fig(
      'pieces',
      sum(rows, (r) => r.pieces),
    ),
    fig('revenue', Math.round(sum(rows, (r) => r.revenue)), 'RWF'),
    ...moneyFig(rows, 'cogs', (r) => r.cost),
    ...moneyFig(rows, 'margin', (r) => r.margin),
  ],
  groups: [
    {
      key: 'channel',
      label: `${P}.g.channel`,
      heading: `${P}.col.channel`,
      value: (r: StockSoldRow) => channelWord(r.channel),
    },
    storeGroup<StockSoldRow>(),
    kindGroup<StockSoldRow>(),
  ],
  defaultSort: { key: 'revenue', dir: 'desc' },
  countLabel: `${P}.count.medicines`,
  notes: [`${P}.sold.note1`, `${P}.sold.note2`, `${P}.sold.note3`, `${P}.sold.note4`],
}

// ---------------------------------------------------------------- 3 · stock movements

const movementWord = (k: MovementKind) =>
  w(
    `${P}.move.${k}`,
    {
      received: 'Received',
      transfer: 'Transfer',
      dispensed: 'Handed over',
      sold: 'Sold (walk-in)',
      returned: 'Returned',
      given_here: 'Given here',
      written_off: 'Written off',
      count: 'Count correction',
    }[k],
  )

const movements: AnyReportDef = {
  id: 'stock.movements',
  group: 'stock',
  title: `${P}.movements.title`,
  description: `${P}.movements.description`,
  code: 'MOV',
  allowed: stockReader,
  filters: [
    periodFilter('week'),
    storeFilter,
    {
      key: 'type',
      label: `${P}.f.type`,
      kind: 'select',
      options: keyOptions(`${P}.move`, MOVEMENT_KINDS),
    },
    searchFilter,
  ],
  columns: [
    {
      key: 'at',
      label: `${P}.col.at`,
      kind: 'datetime',
      default: true,
      value: (r: StockMovementRow) => r.at,
    },
    ...itemColumns<StockMovementRow>(),
    { key: 'batch', label: `${P}.col.batch`, nowrap: true, value: (r) => r.batch },
    { key: 'kind', label: `${P}.col.movement`, default: true, value: (r) => movementWord(r.kind) },
    { key: 'from', label: `${P}.col.from`, default: true, value: (r) => r.from },
    { key: 'to', label: `${P}.col.to`, default: true, value: (r) => r.to },
    {
      key: 'quantity',
      label: `${P}.col.quantity`,
      kind: 'number',
      default: true,
      value: (r) => r.quantity,
    },
    { key: 'packs', label: `${P}.col.packs`, value: (r) => packsOf(r, r.quantity) },
    count('change', `${P}.col.change`, (r: StockMovementRow) => r.change),
    { key: 'reason', label: `${P}.col.reason`, default: true, value: (r) => r.reason },
    { key: 'document', label: `${P}.col.document`, nowrap: true, value: (r) => r.document },
    { key: 'by', label: `${P}.col.by`, default: true, value: (r) => r.by },
    {
      key: 'unitCost',
      label: `${P}.col.unitCost`,
      kind: 'money',
      allowed: admin,
      value: (r) => r.unitCost,
    },
    {
      key: 'value',
      label: `${P}.col.valueAtCost`,
      kind: 'money',
      allowed: admin,
      value: (r) => r.value,
    },
  ],
  async load(f, ctx) {
    const t = selected(f, 'type')
    const rows = await loadStockMovements(
      {
        period: f.period,
        store: selected(f, 'store'),
        kind: t && (MOVEMENT_KINDS as readonly string[]).includes(t) ? (t as MovementKind) : null,
      },
      ctx,
    )
    return searchRows(rows, f, (r) => [r.batch, r.document, r.reason])
  },
  figures: (rows: StockMovementRow[]) => {
    const of = (...k: MovementKind[]) =>
      sum(
        rows.filter((r) => k.includes(r.kind)),
        (r) => r.quantity,
      )
    return [
      fig('movements', rows.length),
      fig('received', of('received')),
      fig('toPatients', of('dispensed', 'sold', 'given_here')),
      fig('writtenOff', of('written_off')),
    ]
  },
  groups: [
    {
      key: 'kind',
      label: `${P}.g.movement`,
      heading: `${P}.col.movement`,
      value: (r: StockMovementRow) => movementWord(r.kind),
    },
    {
      key: 'name',
      label: `${P}.g.medicine`,
      heading: `${P}.col.medicine`,
      value: (r: StockMovementRow) => r.name,
    },
    {
      key: 'by',
      label: `${P}.g.by`,
      heading: `${P}.col.by`,
      value: (r: StockMovementRow) => r.by ?? '',
    },
  ],
  defaultSort: { key: 'at', dir: 'desc' },
  countLabel: `${P}.count.movements`,
  notes: [`${P}.movements.note1`, `${P}.movements.note2`],
  wide: true,
}

// ---------------------------------------------------------------- 4 · deliveries received

const deliveries: AnyReportDef = {
  id: 'stock.deliveries',
  group: 'stock',
  title: `${P}.deliveries.title`,
  description: `${P}.deliveries.description`,
  code: 'DLV',
  allowed: (ctx) => admin(ctx) || (ctx.holdsStore && ctx.can('stock.write')),
  filters: [periodFilter('month'), storeFilter, searchFilter],
  columns: [
    {
      key: 'at',
      label: `${P}.col.receivedOn`,
      kind: 'date',
      default: true,
      value: (r: StockDeliveryRow) => r.at,
    },
    { key: 'number', label: `${P}.col.grn`, nowrap: true, default: true, value: (r) => r.number },
    { key: 'reference', label: `${P}.col.deliveryNote`, nowrap: true, value: (r) => r.reference },
    { key: 'supplier', label: `${P}.col.supplier`, default: true, value: (r) => r.supplier },
    { key: 'store', label: `${P}.col.store`, value: (r) => r.store },
    ...itemColumns<StockDeliveryRow>(),
    { key: 'batch', label: `${P}.col.batch`, nowrap: true, default: true, value: (r) => r.batch },
    {
      key: 'expiry',
      label: `${P}.col.expiry`,
      kind: 'date',
      default: true,
      value: (r) => r.expiry,
    },
    count('pieces', `${P}.col.pieces`, (r: StockDeliveryRow) => r.pieces, true),
    { key: 'packs', label: `${P}.col.packs`, value: (r) => packsOf(r, r.pieces) },
    {
      key: 'unitCost',
      label: `${P}.col.unitCost`,
      kind: 'money',
      allowed: admin,
      value: (r) => r.unitCost,
    },
    money('lineCost', `${P}.col.lineCost`, (r: StockDeliveryRow) => r.lineCost, {
      default: true,
      atCost: true,
    }),
    { key: 'by', label: `${P}.col.receivedBy`, value: (r) => r.by },
  ],
  async load(f, ctx) {
    const rows = await loadStockDeliveries({ period: f.period, store: selected(f, 'store') }, ctx)
    return searchRows(rows, f, (r) => [r.supplier, r.number, r.reference, r.batch])
  },
  figures: (rows: StockDeliveryRow[]) => [
    fig('deliveries', new Set(rows.map((r) => r.number ?? r.id)).size),
    fig('lines', rows.length),
    fig(
      'pieces',
      sum(rows, (r) => r.pieces),
    ),
    ...moneyFig(rows, 'deliveredCost', (r) => r.lineCost),
  ],
  groups: [
    {
      key: 'supplier',
      label: `${P}.g.supplier`,
      heading: `${P}.col.supplier`,
      value: (r: StockDeliveryRow) => r.supplier ?? '',
    },
    {
      key: 'number',
      label: `${P}.g.delivery`,
      heading: `${P}.col.grn`,
      value: (r: StockDeliveryRow) => r.number ?? '',
    },
    storeGroup<StockDeliveryRow>(),
  ],
  defaultSort: { key: 'at', dir: 'desc' },
  countLabel: `${P}.count.lines`,
  notes: [`${P}.deliveries.note1`, `${P}.deliveries.note2`],
  wide: true,
}

// ---------------------------------------------------------------- 5 · transfers to stores

const transferStatusWord = (s: TransferStatus) =>
  w(
    `${P}.transfer.${s}`,
    { in_transit: 'On the way', received: 'Received', cancelled: 'Cancelled' }[s],
  )

const transfers: AnyReportDef = {
  id: 'stock.transfers',
  group: 'stock',
  title: `${P}.transfers.title`,
  description: `${P}.transfers.description`,
  code: 'TRF',
  allowed: admin,
  filters: [
    periodFilter('month'),
    storeFilter,
    {
      key: 'status',
      label: `${P}.f.status`,
      kind: 'select',
      options: keyOptions(`${P}.transfer`, ['in_transit', 'received', 'cancelled']),
    },
    searchFilter,
  ],
  columns: [
    {
      key: 'number',
      label: `${P}.col.note`,
      nowrap: true,
      default: true,
      value: (r: StockTransferRow) => r.number,
    },
    { key: 'at', label: `${P}.col.sentOn`, kind: 'date', value: (r) => r.at },
    { key: 'from', label: `${P}.col.from`, value: (r) => r.from },
    { key: 'to', label: `${P}.col.to`, default: true, value: (r) => r.to },
    ...itemColumns<StockTransferRow>(),
    { key: 'batch', label: `${P}.col.batch`, nowrap: true, value: (r) => r.batch },
    count('pieces', `${P}.col.pieces`, (r: StockTransferRow) => r.pieces, true),
    { key: 'packs', label: `${P}.col.packs`, default: true, value: (r) => packsOf(r, r.pieces) },
    count('received', `${P}.col.receivedQty`, (r: StockTransferRow) => r.received),
    money('costValue', `${P}.col.costValue`, (r: StockTransferRow) => r.costValue, {
      default: true,
      atCost: true,
    }),
    money('sellValue', `${P}.col.sellValue`, (r: StockTransferRow) => r.sellValue, {
      default: true,
    }),
    {
      key: 'status',
      label: `${P}.col.status`,
      default: true,
      value: (r) => transferStatusWord(r.status),
    },
    { key: 'sentBy', label: `${P}.col.sentBy`, value: (r) => r.sentBy },
    { key: 'receivedBy', label: `${P}.col.receivedBy`, value: (r) => r.receivedBy },
    {
      key: 'receivedAt',
      label: `${P}.col.receivedAt`,
      kind: 'datetime',
      value: (r) => r.receivedAt,
    },
  ],
  async load(f, ctx) {
    const s = selected(f, 'status')
    const rows = await loadStockTransfers(
      {
        period: f.period,
        store: selected(f, 'store'),
        status: s === 'in_transit' || s === 'received' || s === 'cancelled' ? s : null,
      },
      ctx,
    )
    return searchRows(rows, f, (r) => [r.number, r.to, r.batch])
  },
  figures: (rows: StockTransferRow[]) => [
    fig('notes', new Set(rows.map((r) => r.number)).size),
    fig(
      'pieces',
      sum(rows, (r) => r.pieces),
    ),
    ...moneyFig(rows, 'costValue', (r) => r.costValue),
    fig('sellValue', Math.round(sum(rows, (r) => r.sellValue)), 'RWF'),
  ],
  groups: [
    {
      key: 'number',
      label: `${P}.g.note`,
      heading: `${P}.col.note`,
      value: (r: StockTransferRow) => r.number,
    },
    { key: 'to', label: `${P}.g.to`, heading: `${P}.col.to`, value: (r: StockTransferRow) => r.to },
    {
      key: 'status',
      label: `${P}.g.status`,
      heading: `${P}.col.status`,
      value: (r: StockTransferRow) => transferStatusWord(r.status),
    },
  ],
  defaultSort: { key: 'number', dir: 'desc' },
  countLabel: `${P}.count.lines`,
  notes: [`${P}.transfers.note1`, `${P}.transfers.note2`],
  wide: true,
}

// ---------------------------------------------------------------- 6 · expiring and expired

const expiryWord = (s: StockExpiryRow['status']) =>
  w(`${P}.expiry.${s}`, { expired: 'Expired', soon: 'Expires soon', ok: 'Later' }[s])

const expiry: AnyReportDef = {
  id: 'stock.expiry',
  group: 'stock',
  title: `${P}.expiry.title`,
  description: `${P}.expiry.description`,
  code: 'EXP',
  allowed: stockReader,
  filters: [
    storeFilter,
    {
      key: 'within',
      label: `${P}.f.within`,
      kind: 'select',
      default: '90',
      options: keyOptions(`${P}.days`, ['30', '60', '90', '180']),
    },
    { key: 'expiredOnly', label: `${P}.f.expiredOnly`, kind: 'toggle' },
    kindFilter,
    searchFilter,
  ],
  columns: [
    ...itemColumns<StockExpiryRow>(),
    { key: 'batch', label: `${P}.col.batch`, nowrap: true, default: true, value: (r) => r.batch },
    { key: 'store', label: `${P}.col.store`, default: true, value: (r) => r.store },
    {
      key: 'expiry',
      label: `${P}.col.expiry`,
      kind: 'date',
      default: true,
      value: (r) => r.expiry,
    },
    {
      key: 'daysLeft',
      label: `${P}.col.daysLeft`,
      kind: 'number',
      default: true,
      value: (r) => r.daysLeft,
    },
    { key: 'status', label: `${P}.col.status`, default: true, value: (r) => expiryWord(r.status) },
    count('pieces', `${P}.col.pieces`, (r: StockExpiryRow) => r.pieces, true),
    { key: 'packs', label: `${P}.col.packs`, value: (r) => packsOf(r, r.pieces) },
    money('costValue', `${P}.col.costValue`, (r: StockExpiryRow) => r.costValue, {
      default: true,
      atCost: true,
    }),
    money('sellValue', `${P}.col.sellValue`, (r: StockExpiryRow) => r.sellValue),
  ],
  async load(f, ctx) {
    const rows = await loadStockExpiry(
      {
        store: selected(f, 'store'),
        within: switchedOn(f, 'expiredOnly') ? null : num(selected(f, 'within')),
        expiredOnly: switchedOn(f, 'expiredOnly'),
      },
      ctx,
    )
    return searchRows(byKind(rows, f), f, (r) => [r.batch])
  },
  figures: (rows: StockExpiryRow[]) => [
    fig('batches', rows.length),
    fig(
      'expiredPieces',
      sum(
        rows.filter((r) => r.status === 'expired'),
        (r) => r.pieces,
      ),
    ),
    fig(
      'soonPieces',
      sum(
        rows.filter((r) => r.status !== 'expired'),
        (r) => r.pieces,
      ),
    ),
    ...moneyFig(rows, 'atRisk', (r) => r.costValue),
  ],
  groups: [
    {
      key: 'status',
      label: `${P}.g.status`,
      heading: `${P}.col.status`,
      value: (r: StockExpiryRow) => expiryWord(r.status),
      order: (r: StockExpiryRow) => ({ expired: 0, soon: 1, ok: 2 })[r.status],
    },
    {
      key: 'store',
      label: `${P}.g.store`,
      heading: `${P}.col.store`,
      value: (r: StockExpiryRow) => r.store,
    },
  ],
  defaultSort: { key: 'expiry', dir: 'asc' },
  countLabel: `${P}.count.batches`,
  notes: [`${P}.expiry.note1`, `${P}.expiry.note2`],
}

// ---------------------------------------------------------------- 7 · what to order

const toOrderStore = (r: StockToOrderRow) =>
  r.scope === 'pharmacy' ? w(`${P}.pharmacyAll`, 'Pharmacy (all stores)') : (r.store ?? '')

const toOrder: AnyReportDef = {
  id: 'stock.toOrder',
  group: 'stock',
  title: `${P}.toOrder.title`,
  description: `${P}.toOrder.description`,
  code: 'ORD',
  allowed: admin,
  filters: [storeFilter, kindFilter, searchFilter],
  columns: [
    ...itemColumns<StockToOrderRow>(),
    { key: 'store', label: `${P}.col.store`, default: true, value: (r) => toOrderStore(r) },
    count('onHand', `${P}.col.usable`, (r: StockToOrderRow) => r.onHand, true),
    { key: 'level', label: `${P}.col.level`, kind: 'number', default: true, value: (r) => r.level },
    { key: 'monthlyUse', label: `${P}.col.monthlyUse`, kind: 'number', value: (r) => r.monthlyUse },
    count('suggested', `${P}.col.suggested`, (r: StockToOrderRow) => r.suggested, true),
    {
      key: 'suggestedPacks',
      label: `${P}.col.suggestedPacks`,
      default: true,
      value: (r) => packsOf(r, r.suggested),
    },
    { key: 'lastSupplier', label: `${P}.col.lastSupplier`, value: (r) => r.lastSupplier },
    {
      key: 'lastCost',
      label: `${P}.col.lastCost`,
      kind: 'money',
      default: true,
      allowed: admin,
      value: (r) => r.lastCost,
    },
    money('estimatedCost', `${P}.col.estimatedCost`, (r: StockToOrderRow) => r.estimatedCost, {
      default: true,
      atCost: true,
    }),
  ],
  async load(f, ctx) {
    const rows = await loadStockToOrder({ store: selected(f, 'store') }, ctx)
    return searchRows(byKind(rows, f), f, (r) => [r.store, r.lastSupplier])
  },
  figures: (rows: StockToOrderRow[]) => [
    fig('medicines', rows.length),
    fig(
      'toOrderPieces',
      sum(rows, (r) => r.suggested),
    ),
    ...moneyFig(rows, 'estimatedCost', (r) => r.estimatedCost),
  ],
  groups: [
    {
      key: 'store',
      label: `${P}.g.store`,
      heading: `${P}.col.store`,
      value: (r: StockToOrderRow) => toOrderStore(r),
      order: (r: StockToOrderRow) => (r.scope === 'pharmacy' ? '0' : `1${r.store ?? ''}`),
    },
    kindGroup<StockToOrderRow>(),
    {
      key: 'supplier',
      label: `${P}.g.supplier`,
      heading: `${P}.col.lastSupplier`,
      value: (r: StockToOrderRow) => r.lastSupplier ?? '',
    },
  ],
  defaultGroup: { key: 'store' },
  defaultSort: { key: 'name', dir: 'asc' },
  countLabel: `${P}.count.medicines`,
  notes: [`${P}.toOrder.note1`, `${P}.toOrder.note2`],
}

// ---------------------------------------------------------------- 8 · write-offs and count differences

const writeOffWord = (k: WriteOffKind) =>
  w(
    `${P}.writeOff.${k}`,
    { written_off: 'Written off', count: 'Count difference', lost: 'Lost on the way' }[k],
  )

const writeOffs: AnyReportDef = {
  id: 'stock.writeOffs',
  group: 'stock',
  title: `${P}.writeOffs.title`,
  description: `${P}.writeOffs.description`,
  code: 'WOF',
  allowed: stockReader,
  filters: [
    periodFilter('month'),
    storeFilter,
    {
      key: 'type',
      label: `${P}.f.type`,
      kind: 'select',
      options: keyOptions(`${P}.writeOff`, ['written_off', 'count', 'lost']),
    },
    searchFilter,
  ],
  columns: [
    {
      key: 'at',
      label: `${P}.col.at`,
      kind: 'datetime',
      default: true,
      value: (r: StockWriteOffRow) => r.at,
    },
    ...itemColumns<StockWriteOffRow>(),
    { key: 'batch', label: `${P}.col.batch`, nowrap: true, value: (r) => r.batch },
    { key: 'store', label: `${P}.col.store`, default: true, value: (r) => r.store },
    { key: 'kind', label: `${P}.col.type`, default: true, value: (r) => writeOffWord(r.kind) },
    count('quantity', `${P}.col.quantitySigned`, (r: StockWriteOffRow) => r.quantity, true),
    { key: 'packs', label: `${P}.col.packs`, value: (r) => packsOf(r, r.quantity) },
    { key: 'reason', label: `${P}.col.reason`, default: true, value: (r) => r.reason },
    money('costValue', `${P}.col.costValue`, (r: StockWriteOffRow) => r.costValue, {
      default: true,
      atCost: true,
    }),
    { key: 'by', label: `${P}.col.by`, default: true, value: (r) => r.by },
  ],
  async load(f, ctx) {
    const t = selected(f, 'type')
    const rows = await loadStockWriteOffs({ period: f.period, store: selected(f, 'store') }, ctx)
    return searchRows(t ? rows.filter((r) => r.kind === t) : rows, f, (r) => [r.reason, r.batch])
  },
  figures: (rows: StockWriteOffRow[]) => [
    fig('lines', rows.length),
    fig(
      'piecesOut',
      -sum(
        rows.filter((r) => r.quantity < 0),
        (r) => r.quantity,
      ),
    ),
    fig(
      'piecesIn',
      sum(
        rows.filter((r) => r.quantity > 0),
        (r) => r.quantity,
      ),
    ),
    ...moneyFig(rows, 'lossValue', (r) => r.costValue),
  ],
  groups: [
    {
      key: 'kind',
      label: `${P}.g.type`,
      heading: `${P}.col.type`,
      value: (r: StockWriteOffRow) => writeOffWord(r.kind),
    },
    storeGroup<StockWriteOffRow>(),
    {
      key: 'name',
      label: `${P}.g.medicine`,
      heading: `${P}.col.medicine`,
      value: (r: StockWriteOffRow) => r.name,
    },
  ],
  defaultSort: { key: 'at', dir: 'desc' },
  countLabel: `${P}.count.lines`,
  notes: [`${P}.writeOffs.note1`, `${P}.writeOffs.note2`],
  wide: true,
}

// ---------------------------------------------------------------- 9 · bought outside

const outside: AnyReportDef = {
  id: 'pharmacy.outside',
  group: 'pharmacy',
  title: `${P}.outside.title`,
  description: `${P}.outside.description`,
  code: 'OUT',
  allowed: admin,
  filters: [periodFilter('month'), searchFilter],
  columns: [
    {
      key: 'name',
      label: `${P}.col.medicine`,
      default: true,
      value: (r: StockOutsideRow) => r.name,
    },
    { key: 'code', label: `${P}.col.code`, nowrap: true, value: (r) => r.code },
    {
      key: 'inClinic',
      label: `${P}.col.inClinic`,
      kind: 'yesno',
      total: 'count',
      default: true,
      value: (r) => r.inClinic,
    },
    count('times', `${P}.col.prescriptions`, (r: StockOutsideRow) => r.times, true),
    count('quantity', `${P}.col.quantity`, (r: StockOutsideRow) => r.quantity, true),
    { key: 'unit', label: `${P}.col.unit`, value: (r) => r.unit },
    count('patients', `${P}.col.patients`, (r: StockOutsideRow) => r.patients, true),
    count('notGiven', `${P}.col.noneInPharmacy`, (r: StockOutsideRow) => r.notGiven, true),
    {
      key: 'prescribers',
      label: `${P}.col.prescribers`,
      default: true,
      value: (r) => r.prescribers,
    },
    { key: 'lastAt', label: `${P}.col.lastAt`, kind: 'date', value: (r) => r.lastAt },
  ],
  async load(f, ctx) {
    const rows = await loadStockOutside({ period: f.period }, ctx)
    return searchRows(rows, f, (r) => [r.prescribers])
  },
  figures: (rows: StockOutsideRow[]) => [
    fig('medicines', rows.length),
    fig(
      'prescriptions',
      sum(rows, (r) => r.times),
    ),
    fig('notInList', rows.filter((r) => !r.inClinic).length),
    fig(
      'noneInPharmacy',
      sum(rows, (r) => r.notGiven),
    ),
  ],
  groups: [
    {
      key: 'inClinic',
      label: `${P}.g.inClinic`,
      heading: `${P}.col.inClinic`,
      value: (r: StockOutsideRow) =>
        yesNoGroup(
          r.inClinic,
          `${P}.inList`,
          'On the clinic’s list',
          `${P}.notInList`,
          'Not on the clinic’s list',
        ),
    },
  ],
  defaultSort: { key: 'times', dir: 'desc' },
  countLabel: `${P}.count.medicines`,
  notes: [`${P}.outside.note1`, `${P}.outside.note2`],
}

/** The stock reports (report centre). */
export const STOCK_REPORTS: AnyReportDef[] = [
  onHand,
  sold,
  movements,
  deliveries,
  transfers,
  expiry,
  toOrder,
  writeOffs,
  outside,
]

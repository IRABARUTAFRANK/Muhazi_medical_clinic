import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { availableColumns, buildModel, defaultChoices } from '@/lib/reports/run'
import { CLINICAL_REPORTS } from './clinical'
import { packOf, packsOf, STOCK_REPORTS } from './stock'
import type { AnyReportDef, ReportContext, ReportFilterValues } from './types'

/** A sample-mode reader: the manager, the pharmacist, a store holder… */
function sampleCtx(o: {
  id?: string
  role?: string
  manager?: boolean
  head?: boolean
  desks?: string[]
  can?: string[]
  holdsStore?: boolean
  clinical?: boolean
}): ReportContext {
  return {
    user: {
      id: o.id ?? 'u-mgr',
      username: 'x',
      name: 'Sample',
      role: (o.role ?? 'manager') as never,
    },
    isManager: !!o.manager,
    isHead: !!o.head,
    can: (f) => (o.can ?? []).includes(f),
    canDesk: (d) => (o.desks ?? []).includes(d),
    holdsStore: !!o.holdsStore,
    clinical: !!o.clinical,
    sample: true,
  }
}
const MANAGER = sampleCtx({ manager: true, clinical: true })
const PHARMACIST = sampleCtx({ id: 'p-pha', role: 'pharmacist', desks: ['pharmacy'] })
/** The sample doctor holds her office (l-cons). */
const HOLDER = sampleCtx({ id: 'u-doc', role: 'doctor', holdsStore: true, clinical: true })
const RECEPTION = sampleCtx({ id: 'u-rec', role: 'receptionist', desks: ['reception'] })

function filtersOf(def: AnyReportDef, extra: Record<string, unknown> = {}): ReportFilterValues {
  const to = new Date().toISOString().slice(0, 10)
  const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10)
  const values: Record<string, unknown> = {
    period: { range: 'month', from, to, label: `${from} – ${to}` },
  }
  for (const f of def.filters) {
    if (f.kind === 'period') continue
    values[f.key] = f.default ?? (f.kind === 'toggle' ? false : f.kind === 'multi' ? [] : '')
  }
  return { ...values, ...extra } as ReportFilterValues
}

/** Runs a report as someone: its rows, the columns they may choose, the default model. */
async function run(def: AnyReportDef, ctx: ReportContext, extra: Record<string, unknown> = {}) {
  const rows = await def.load(filtersOf(def, extra), ctx)
  const columns = availableColumns(def.columns, ctx)
  const choices = defaultChoices(def, columns)
  const model = buildModel({ def, rows, columns, choices, t: i18n.t.bind(i18n) as never })
  return { rows, columns, choices, model }
}
const byId = (id: string) => [...STOCK_REPORTS, ...CLINICAL_REPORTS].find((d) => d.id === id)!

describe('stock and clinical report definitions', () => {
  const all = [...STOCK_REPORTS, ...CLINICAL_REPORTS]

  it('have unique ids, column keys and filter keys, sensible defaults and i18n keys', () => {
    expect(STOCK_REPORTS).toHaveLength(9)
    expect(CLINICAL_REPORTS).toHaveLength(6)
    expect(new Set(all.map((d) => d.id)).size).toBe(all.length)
    for (const d of all) {
      const keys = d.columns.map((c) => c.key)
      expect(new Set(keys).size, d.id).toBe(keys.length)
      expect(new Set(d.filters.map((f) => f.key)).size, d.id).toBe(d.filters.length)
      const shown = d.columns.filter((c) => c.default).length
      expect(shown, d.id).toBeGreaterThanOrEqual(5)
      expect(shown, d.id).toBeLessThanOrEqual(9)
      expect(d.title).toMatch(/^reports\.(stock|clinical)\./)
      for (const c of d.columns)
        expect(c.label, `${d.id}.${c.key}`).toMatch(/^reports\.(stock|clinical)\./)
      for (const g of d.groups ?? []) expect(keys.length && g.label).toMatch(/^reports\./)
      expect(['stock', 'pharmacy', 'clinical', 'lab', 'reception']).toContain(d.group)
    }
  })

  it('run in sample mode for the manager: rows, totals, figures, groups', async () => {
    for (const d of all) {
      const { rows, model } = await run(d, MANAGER)
      expect(rows.length, d.id).toBeGreaterThan(0)
      expect(model.count).toBe(rows.length)
      for (const g of d.groups ?? []) for (const r of rows) expect(typeof g.value(r)).toBe('string')
      for (const f of d.figures?.(rows, filtersOf(d)) ?? [])
        expect(Number.isFinite(f.value), `${d.id} ${f.label}`).toBe(true)
      // a summed column's total is the sum of its cells
      model.columns.forEach((c, i) => {
        if (c.total !== 'sum') return
        const cells = model.rows.flatMap((r) => (r.kind === 'row' ? [Number(r.cells[i]) || 0] : []))
        expect(model.totals[i], `${d.id}.${c.key}`).toBeCloseTo(
          cells.reduce((s, n) => s + n, 0),
          5,
        )
      })
    }
  })
})

describe('stock reports', () => {
  it('stock on hand: the manager sees every store and the costs, the holder her store only', async () => {
    const def = byId('stock.onHand')
    const mgr = await run(def, MANAGER, { byStore: true })
    expect(new Set(mgr.rows.map((r) => r.storeId)).size).toBeGreaterThan(2)
    expect(mgr.columns.some((c) => c.key === 'costValue')).toBe(true)
    expect(mgr.rows.every((r) => r.costValue != null)).toBe(true)
    const mine = await run(def, HOLDER)
    expect(mine.rows.length).toBeGreaterThan(0)
    expect(mine.rows.every((r) => r.storeId === 'l-cons' && r.costValue == null)).toBe(true)
    expect(mine.columns.some((c) => c.key === 'costValue')).toBe(false)
    // all stores together: one row per medicine, the total = the pieces of every store
    const together = await run(def, MANAGER)
    const onHand = together.model.columns.findIndex((c) => c.key === 'onHand')
    expect(together.model.totals[onHand]).toBe(mgr.rows.reduce((s, r) => s + r.onHand, 0))
    // filters: low only, a kind, a search
    const low = await run(def, MANAGER, { lowOnly: true })
    expect(low.rows.every((r) => r.low)).toBe(true)
    const supplies = await run(def, MANAGER, { kind: 'supply' })
    expect(supplies.rows.length).toBeGreaterThan(0)
    expect(supplies.rows.every((r) => r.kind === 'supply')).toBe(true)
    expect(
      (await run(def, MANAGER, { search: 'amox' })).rows.every((r) => /amox/i.test(r.name)),
    ).toBe(true)
  })

  it('medicines sold: channels add up, money at cost for the manager and the pharmacy only', async () => {
    const def = byId('pharmacy.sold')
    const { rows, model } = await run(def, PHARMACIST)
    for (const r of rows) expect(r.handover + r.here + r.walkin).toBe(r.pieces)
    expect(rows.every((r) => r.margin === r.revenue - (r.cost ?? 0))).toBe(true)
    expect(model.columns.map((c) => c.key)).toEqual([
      'name',
      'pieces',
      'packs',
      'toVisits',
      'walkin',
      'revenue',
      'cost',
      'margin',
    ])
    const split = await run(def, MANAGER, { split: true, channel: 'walkin' })
    expect(split.rows.every((r) => r.channel === 'walkin' && r.walkin === r.pieces)).toBe(true)
    const holder = await run(def, HOLDER)
    expect(holder.columns.some((c) => c.key === 'margin' || c.key === 'cost')).toBe(false)
    expect(holder.rows.every((r) => r.cost == null && r.handover === 0)).toBe(true)
  })

  it('who may run what: transfers, what to order and bought outside are the pharmacy’s and the manager’s', () => {
    const ids = (ctx: ReportContext) => STOCK_REPORTS.filter((d) => d.allowed(ctx)).map((d) => d.id)
    expect(ids(MANAGER)).toHaveLength(9)
    expect(ids(PHARMACIST)).toHaveLength(9)
    expect(ids(HOLDER)).toEqual([
      'stock.onHand',
      'pharmacy.sold',
      'stock.movements',
      'stock.expiry',
      'stock.writeOffs',
    ])
    expect(ids(RECEPTION)).toEqual([])
  })

  it('packs beside the pieces', () => {
    const tab = { unit: 'tab', packSize: 20, packUnit: 'box' }
    expect(packsOf(tab, 503)).toMatch(/25.*20.*3/)
    expect(packsOf(tab, -40)).toMatch(/^– 2/)
    expect(packsOf({ unit: 'bottle', packSize: null, packUnit: null }, 12)).toBeNull()
    expect(packOf(tab)).toMatch(/box.*20/)
  })

  it('movements with a store: the change column adds up to the net change', async () => {
    const def = byId('stock.movements')
    const { rows } = await run(def, MANAGER, { store: 'l-pharm' })
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(Math.abs(r.change)).toBe(r.quantity)
  })
})

import i18next from 'i18next'
import { resources } from '@mmc/shared/i18n'
import { CLINIC_PROFILE } from '@mmc/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import type { TFn } from '@/lib/doc-style'
import { buildWorkbook, reportHtml } from '@/lib/report'
import type { ReportContext, ReportDef, ReportFilterValues } from './defs/types'
import {
  buildModel,
  buildReport,
  cleanChoices,
  defaultChoices,
  filterLines,
  totalFor,
  type ReportChoices,
} from './run'

let t: TFn
beforeAll(async () => {
  const i = i18next.createInstance()
  await i.init({ lng: 'en', resources, interpolation: { escapeValue: false } })
  t = (key, vars) => i.t(key, vars ?? {}) as string
})

interface Pay {
  no: string
  method: string
  amount: number | null
  at: string
  insured: boolean
  cashier: string
}
const rows: Pay[] = [
  {
    no: 'R-3',
    method: 'Cash',
    amount: 1000,
    at: '2026-10-02T08:00:00Z',
    insured: true,
    cashier: 'A',
  },
  {
    no: 'R-1',
    method: 'MoMo',
    amount: 3000,
    at: '2026-10-01T08:00:00Z',
    insured: false,
    cashier: 'B',
  },
  {
    no: 'R-2',
    method: 'Cash',
    amount: 2000,
    at: '2026-10-03T08:00:00Z',
    insured: false,
    cashier: 'A',
  },
  {
    no: 'R-4',
    method: 'Card',
    amount: null,
    at: '2026-10-04T08:00:00Z',
    insured: true,
    cashier: '',
  },
]
const def: ReportDef<Pay> = {
  id: 'test.payments',
  group: 'finance',
  title: 'Payments',
  description: 'Every payment',
  code: 'PAY',
  countLabel: 'Payments',
  allowed: () => true,
  filters: [
    { key: 'period', label: 'Period', kind: 'period' },
    {
      key: 'method',
      label: 'Method',
      kind: 'multi',
      options: [
        { value: 'cash', label: 'Cash' },
        { value: 'momo', label: 'MTN MoMo' },
      ],
    },
    { key: 'cashier', label: 'Cashier', kind: 'select' },
    { key: 'q', label: 'Search', kind: 'text' },
  ],
  columns: [
    { key: 'no', label: 'Receipt', default: true, total: 'count', value: (r) => r.no },
    { key: 'method', label: 'Method', default: true, value: (r) => r.method },
    {
      key: 'amount',
      label: 'Amount',
      kind: 'money',
      default: true,
      total: 'sum',
      value: (r) => r.amount,
    },
    { key: 'avg', label: 'Average', kind: 'money', total: 'avg', value: (r) => r.amount },
    { key: 'at', label: 'When', kind: 'datetime', value: (r) => r.at },
    { key: 'insured', label: 'Insured', kind: 'yesno', total: 'count', value: (r) => r.insured },
    { key: 'cashier', label: 'Cashier', value: (r) => r.cashier },
    { key: 'secret', label: 'Secret', sensitive: true, value: () => 'x' },
  ],
  groups: [
    { key: 'method', label: 'By method', heading: 'Method', value: (r) => r.method },
    { key: 'cashier', label: 'By cashier', value: (r) => r.cashier },
  ],
  defaultSort: { key: 'at', dir: 'asc' },
  load: async () => rows,
}
const choices = (c: Partial<ReportChoices>): ReportChoices => ({
  ...defaultChoices(def as never, def.columns as never),
  ...c,
})
const model = (c: Partial<ReportChoices>) =>
  buildModel({ def: def as never, rows, columns: def.columns, choices: choices(c), t })
const values: ReportFilterValues = {
  period: {
    range: 'custom',
    from: '2026-10-01',
    to: '2026-10-28',
    label: '01/10/2026 – 28/10/2026',
  },
  method: ['cash', 'momo'],
  cashier: '',
  q: '',
}
const ctx = { clinical: false } as ReportContext

describe('report centre: totals', () => {
  it('sums, counts the non-empty values (Yes for a Yes/No column) and averages', () => {
    expect(totalFor('sum', 'money', [1000, 2000, null, '500'])).toBe(3500)
    expect(totalFor('count', 'text', ['a', '', null, 'b', undefined])).toBe(2)
    expect(totalFor('count', 'yesno', [true, false, true, null])).toBe(2)
    expect(totalFor('avg', 'money', [1000, 3000, null])).toBe(2000)
    expect(totalFor('avg', 'money', [null])).toBeNull()
    expect(totalFor(undefined, 'money', [1])).toBeNull()
  })

  it('gives the totals row of the chosen columns, in their order', () => {
    const m = model({ columns: ['amount', 'no', 'avg', 'insured', 'method'] })
    expect(m.columns.map((c) => c.key)).toEqual(['amount', 'no', 'avg', 'insured', 'method'])
    expect(m.totals).toEqual([6000, 4, 2000, 2, null])
    expect(m.count).toBe(4)
  })
})

describe('report centre: columns and sort', () => {
  it('keeps the chosen order and drops unknown or stale columns from saved choices', () => {
    const c = cleanChoices(
      { columns: ['method', 'gone', 'no', 'method'], group: 'nope', totals: 'top' },
      def as never,
      def.columns as never,
    )
    expect(c.columns).toEqual(['method', 'no'])
    expect(c.group).toBeNull()
    expect(c.totals).toBe('top')
  })

  it('sorts by a column, both ways, with empty values last', () => {
    const up = model({ columns: ['no', 'amount'], sort: { key: 'amount', dir: 'asc' } })
    expect(up.rows.map((r) => (r.kind === 'row' ? r.cells[0] : ''))).toEqual([
      'R-3',
      'R-2',
      'R-1',
      'R-4',
    ])
    const down = model({ columns: ['no', 'amount'], sort: { key: 'amount', dir: 'desc' } })
    expect(down.rows.map((r) => (r.kind === 'row' ? r.cells[0] : ''))).toEqual([
      'R-1',
      'R-2',
      'R-3',
      'R-4',
    ])
    const byNo = model({ columns: ['no'], sort: { key: 'no', dir: 'asc' } })
    expect(byNo.rows.map((r) => (r.kind === 'row' ? r.cells[0] : ''))).toEqual([
      'R-1',
      'R-2',
      'R-3',
      'R-4',
    ])
  })
})

describe('report centre: groups', () => {
  it('prints each group with its heading, its rows and its subtotal; "not stated" last', () => {
    const m = model({
      columns: ['no', 'amount'],
      group: 'cashier',
      mode: 'details',
      sort: { key: 'no', dir: 'asc' },
    })
    expect(m.groups).toBe(3)
    expect(m.rows.map((r) => r.kind)).toEqual([
      'group',
      'row',
      'row',
      'subtotal',
      'group',
      'row',
      'subtotal',
      'group',
      'row',
      'subtotal',
    ])
    const sub = m.rows[3]!
    expect(sub.kind === 'subtotal' && sub.cells).toEqual([2, 3000])
    const last = m.rows[7]!
    expect(last.kind === 'group' && last.label).toBe('Not stated')
    expect(m.totals).toEqual([4, 6000])
  })

  it('summarises one row per group, with the count and a weighted average in the total', () => {
    const m = model({
      columns: ['no', 'amount', 'avg', 'method'],
      group: 'method',
      mode: 'summary',
      sort: { key: '__count', dir: 'desc' },
    })
    expect(m.summary).toBe(true)
    expect(m.columns.map((c) => c.key)).toEqual(['__group', '__count', 'no', 'amount', 'avg'])
    expect(m.columns[0]!.label).toBe('Method')
    const cells = m.rows.map((r) => (r.kind === 'row' ? r.cells : []))
    expect(cells[0]).toEqual(['Cash', 2, 2, 3000, 1500])
    expect(m.totals).toEqual([null, 4, 4, 6000, 2000])
  })
})

describe('report centre: the printed report', () => {
  it('prints the filters line, the group headings, the subtotals and the totals on top', () => {
    const m = model({ columns: ['no', 'amount'], group: 'method', totals: 'top' })
    const r = buildReport({
      def: def as never,
      model: m,
      values,
      filters: filterLines({ def: def as never, values, options: {}, ctx, t }),
      totals: 'top',
      clinic: CLINIC_PROFILE,
      user: { name: 'Mugabo' },
      t,
    })
    expect(r.code).toBe('PAY')
    expect(r.periodKey).toBe('20261001-20261028')
    expect(r.orientation).toBe('portrait')
    const html = reportHtml(
      { ...r, letterhead: { ...r.letterhead!, legalName: 'Clinic', logoUrl: 'x' } as never },
      { autoPrint: false },
    )
    expect(html).toContain('Method: Cash, MTN MoMo · Cashier: All')
    expect(html).toContain('<tr class="grp">')
    expect(html).toContain('<tr class="total sub">')
    expect(html).toContain('<tbody class="tt"><tr class="total grand">')
    expect(html).toContain('RPT-PAY-20261001-20261028')
  })

  it('prints a report without a period "as of" the moment printed, numbered by the print date', async () => {
    const moment = { ...def, filters: def.filters.filter((f) => f.kind !== 'period') }
    const m = model({ columns: ['no', 'amount'] })
    const r = buildReport({
      def: moment as never,
      model: m,
      values,
      filters: [],
      totals: 'bottom',
      clinic: CLINIC_PROFILE,
      user: { name: 'Mugabo' },
      t,
      printedAt: new Date('2026-10-29T10:15:00Z'),
    })
    expect(r.asOf).toBe(true)
    expect(r.periodKey).toBe('20261029')
    expect(r.period).toBe('29/10/2026 12:15')
    const html = reportHtml({ ...r, letterhead: { legalName: 'C', logoUrl: 'x' } as never })
    expect(html).toContain('As of 29/10/2026 12:15')
    expect(html).not.toContain('Period:')
    expect(html).toContain('RPT-PAY-20261029')
    const wb = await buildWorkbook({ ...r, letterhead: { legalName: 'C' } as never })
    const ws = wb.worksheets.find((s) => s.name !== 'Summary')!
    expect(ws.getCell(3, 1).value).toBe('As of 29/10/2026 12:15')
  })

  it('prints only the chosen filters, then "Other filters: all", when a report has many', () => {
    const many = {
      ...def,
      filters: [
        def.filters[0]!,
        ...['a', 'b', 'c', 'd'].map((k) => ({
          key: k,
          label: k.toUpperCase(),
          kind: 'select' as const,
          options: [{ value: 'x', label: 'Ex' }],
        })),
      ],
    }
    const lines = filterLines({
      def: many as never,
      values: { ...values, a: '', b: 'x', c: '', d: '' },
      options: {},
      ctx,
      t,
    })
    expect(lines).toEqual([
      { label: 'B', value: 'Ex' },
      { label: 'Other filters', value: 'All' },
    ])
  })

  it('writes Excel with the totals above the header, SUBTOTAL formulas and frozen panes', async () => {
    const m = model({ columns: ['no', 'method', 'amount'], group: 'method', totals: 'both' })
    const r = buildReport({
      def: def as never,
      model: m,
      values,
      filters: [],
      totals: 'both',
      clinic: CLINIC_PROFILE,
      user: { name: 'Mugabo' },
      t,
    })
    const wb = await buildWorkbook({ ...r, letterhead: { legalName: 'Clinic' } as never })
    const ws = wb.worksheets.find((s) => s.name !== 'Summary')!
    // row 6 the totals, row 7 the header, data from row 8
    expect(ws.getCell(6, 3).value).toMatchObject({ formula: 'SUBTOTAL(9,C8:C17)', result: 6000 })
    expect(ws.getCell(7, 1).value).toBe('Receipt')
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 7 })
    // first group: Card (one row), its subtotal on row 10
    expect(String(ws.getCell(8, 1).value)).toContain('Card')
    expect(ws.getCell(10, 3).value).toMatchObject({ formula: 'SUBTOTAL(9,C9:C9)' })
    // the bottom total after the last subtotal
    expect(ws.getCell(18, 3).value).toMatchObject({ formula: 'SUBTOTAL(9,C8:C17)' })
  })

  it('prints a wide table in landscape and hides sensitive columns from non-clinical readers', async () => {
    const { availableColumns } = await import('./run')
    expect(availableColumns(def.columns, ctx).some((c) => c.key === 'secret')).toBe(false)
    expect(
      availableColumns(def.columns, { clinical: true } as ReportContext).some(
        (c) => c.key === 'secret',
      ),
    ).toBe(true)
    const m = model({
      columns: ['no', 'method', 'amount', 'avg', 'at', 'insured', 'cashier', 'secret'],
    })
    const r = buildReport({
      def: def as never,
      model: m,
      values,
      filters: [],
      totals: 'bottom',
      clinic: CLINIC_PROFILE,
      user: { name: 'Mugabo' },
      t,
    })
    expect(r.orientation).toBe('landscape')
    const html = reportHtml({ ...r, letterhead: { legalName: 'C', logoUrl: 'x' } as never })
    expect(html).toContain('size: A4 landscape')
    expect(html).not.toContain('class="rs wide')
  })
})

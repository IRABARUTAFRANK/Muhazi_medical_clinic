import i18next from 'i18next'
import { resources } from '@mmc/shared/i18n'
import { beforeAll, describe, expect, it } from 'vitest'
import { kigaliToday } from '@/lib/clock'
import { FINANCE_REPORTS } from '@/lib/reports/defs/finance'
import { STAFF_REPORTS } from '@/lib/reports/defs/staff'
import type { ReportContext, ReportFilterValues } from '@/lib/reports/defs/types'
import { useSession } from '@/store/session'
import {
  loadBills,
  loadCashCounts,
  loadCharges,
  loadDebts,
  loadPayments,
  loadRefunds,
} from './reports-finance'
import { loadEmployees } from './reports-staff'

/** The finance and staff reports in sample mode: the rows agree with each other, the filters and
 *  rights apply, and every word of the definitions exists in English. */

const today = kigaliToday()
const daysBefore = (n: number) =>
  new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10)
const period = (from: string, to = today) => ({ range: 'custom' as const, from, to, label: '' })
const values = (o: Partial<ReportFilterValues> = {}): ReportFilterValues => ({
  period: period(daysBefore(30)),
  ...o,
})
const manager: ReportContext = {
  user: {
    id: 'u-mgr',
    username: 't.mugabo',
    name: 'Mugabo Théogène',
    role: 'manager',
    dashboard: 'manager',
  },
  isManager: true,
  isHead: false,
  can: () => true,
  canDesk: () => true,
  holdsStore: false,
  clinical: true,
  sample: true,
}
/** Takes payments only (no billing.read). */
const taker: ReportContext = {
  ...manager,
  user: { id: 'u-cash', username: 's.mugisha', name: 'Mugisha Samuel', role: 'cashier' },
  isManager: false,
  can: (f) => f === 'payment.take',
  canDesk: () => false,
}
const head: ReportContext = {
  ...manager,
  user: {
    id: 'u-head',
    username: 'f.ndayisaba',
    name: 'Dr. Ndayisaba Félix',
    role: 'doctor',
    dashboard: 'head',
    headOf: 'Dental',
  },
  isManager: false,
  isHead: true,
  can: () => false,
  canDesk: () => false,
}

describe('finance reports (sample)', () => {
  it('revenue: net = amount − given back; filters and own payments', async () => {
    const all = await loadPayments(values(), manager)
    expect(all.length).toBeGreaterThan(50)
    for (const p of all) expect(p.net).toBe(p.amount - p.refunded)
    const cash = await loadPayments(values({ method: ['cash'] }), manager)
    expect(cash.length).toBeGreaterThan(0)
    expect(cash.every((p) => p.method === 'cash')).toBe(true)
    const mine = await loadPayments(values(), taker)
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((p) => p.cashierId === 'u-cash')).toBe(true)
  })

  it('bills: the lines add up to the bill; unpaid bills are the bills left to pay', async () => {
    const f = values({ period: period(daysBefore(20), daysBefore(1)) })
    const [bills, lines, debts] = await Promise.all([
      loadBills(f, manager),
      loadCharges(f, manager),
      loadDebts(f, manager),
    ])
    const byVisit = new Map<string, number>()
    for (const l of lines.filter((x) => x.source === 'bill'))
      byVisit.set(l.encounterId!, (byVisit.get(l.encounterId!) ?? 0) + l.total)
    for (const b of bills) expect(byVisit.get(b.encounterId!)).toBe(b.total)
    expect(debts.length).toBeGreaterThan(0)
    for (const d of debts) {
      const b = bills.find((x) => x.encounterId === d.encounterId)!
      expect(d.due).toBeGreaterThan(0)
      expect(b.balance).toBe(d.due)
    }
  })

  it('cash counts: expected = the day’s payments less refunds, per cashier and method', async () => {
    const f = values({ period: period(daysBefore(10), daysBefore(1)) })
    const [counts, pays, refunds] = await Promise.all([
      loadCashCounts(f, manager),
      loadPayments(f, manager),
      loadRefunds(f, manager),
    ])
    expect(counts.length).toBeGreaterThan(0)
    for (const c of counts) {
      const of = <T extends { at: string; cashierId: string | null; method: string }>(xs: T[]) =>
        xs.filter(
          (x) =>
            x.at.slice(0, 10) === c.day && x.cashierId === c.cashierId && x.method === c.method,
        )
      const want =
        of(pays).reduce((s, p) => s + p.amount, 0) - of(refunds).reduce((s, r) => s + r.amount, 0)
      expect(c.expected).toBe(want)
      expect(c.difference).toBe(c.counted - c.expected)
    }
  })

  it('revenue by service: a head sees their department only', async () => {
    const lines = await loadCharges(values(), head)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => l.departmentId === 'dep-dental')).toBe(true)
  })

  it('employees: a head sees their department, without phone or e-mail', async () => {
    const all = await loadEmployees(values(), manager)
    const mine = await loadEmployees(values(), head)
    expect(all.some((e) => e.phone)).toBe(true)
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.length).toBeLessThan(all.length)
    expect(mine.every((e) => !e.phone && !e.email && !e.username)).toBe(true)
    expect(mine.every((e) => e.departments.some((d) => d.id === 'dep-dental'))).toBe(true)
  })
})

describe('finance and staff report definitions', () => {
  let exists: (key: string) => boolean
  beforeAll(async () => {
    // the staff activity sample reads who is signed in
    useSession.setState({ user: manager.user })
    const i = i18next.createInstance()
    await i.init({ lng: 'en', resources, interpolation: { escapeValue: false } })
    exists = (key) => i.exists(key)
  })

  it('every word is an English text, every report runs and gives its figures', async () => {
    const missing: string[] = []
    const need = (key: string | undefined, where: string) => {
      if (key && !exists(key)) missing.push(`${where}: ${key}`)
    }
    for (const def of [...FINANCE_REPORTS, ...STAFF_REPORTS]) {
      need(def.title, def.id)
      need(def.description, def.id)
      need(def.countLabel, def.id)
      for (const n of def.notes ?? []) need(n, def.id)
      for (const c of def.columns) need(c.label, `${def.id} column ${c.key}`)
      for (const g of def.groups ?? []) need(g.label, `${def.id} group ${g.key}`)
      for (const f of def.filters) {
        need(f.label, `${def.id} filter ${f.key}`)
        need(f.hint, `${def.id} filter ${f.key}`)
        need(f.placeholder, `${def.id} filter ${f.key}`)
        for (const o of f.options ?? []) if (o.labelIsKey) need(o.label, `${def.id} ${f.key}`)
      }
      const f = values()
      const rows = await def.load(f, manager)
      expect(Array.isArray(rows)).toBe(true)
      for (const fig of def.figures?.(rows, f) ?? []) {
        need(fig.label, `${def.id} figure`)
        if (fig.unit && fig.unit !== 'RWF') need(fig.unit, `${def.id} figure unit`)
        expect(Number.isFinite(fig.value)).toBe(true)
      }
      // a cell of every column, on the first rows
      for (const r of rows.slice(0, 5)) for (const c of def.columns) c.value(r)
    }
    expect(missing).toEqual([])
    const ids = [...FINANCE_REPORTS, ...STAFF_REPORTS].map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

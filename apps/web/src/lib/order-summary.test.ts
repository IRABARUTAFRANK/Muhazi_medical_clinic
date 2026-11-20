import { describe, expect, it } from 'vitest'
import { restOfBox, summarizeOrder, type OrderSummaryInput } from './order-summary'
import { sixStepsOfVisit, type SixStepsSource } from './six-steps-report'

const drug = (p: Partial<OrderSummaryInput>): OrderSummaryInput => ({
  kind: 'drug',
  here: 0,
  home: 0,
  stockUnits: 120,
  pack: null,
  cashPrice: 200,
  service: false,
  servicePrice: null,
  actCount: 1,
  ...p,
})
const box10 = { size: 10, mode: 'both' as const, packPrice: 1500, packUnit: 'box' }

describe('the box above Send: what the order will do (0193)', () => {
  it('2 here + the rest of the box at home: one box at the box price', () => {
    const s = summarizeOrder(drug({ here: 2, home: 8, pack: box10 }))
    expect(s).toMatchObject({ pieces: 10, amount: 1500, packs: 1, tone: 'ok', left: 120 })
  })
  it('more than the stock holds is short (Send blocked)', () => {
    expect(summarizeOrder(drug({ here: 200 })).tone).toBe('short')
  })
  it('a box-only medicine not in whole boxes: the next whole number', () => {
    const s = summarizeOrder(
      drug({ here: 2, home: 5, pack: { ...box10, mode: 'pack', packPrice: 1000 } }),
    )
    expect(s).toMatchObject({ tone: 'wholePacks', nextWhole: 10 })
  })
  it('no price: nothing on the bill; an act written by hand: not billed', () => {
    expect(summarizeOrder(drug({ here: 1, cashPrice: null })).tone).toBe('noPrice')
    expect(summarizeOrder(drug({ kind: 'act', service: false })).tone).toBe('typed')
    expect(
      summarizeOrder(drug({ kind: 'act', service: true, servicePrice: 1000, actCount: 3 })),
    ).toMatchObject({ tone: 'ok', amount: 3000 })
  })
  it('the rest of the box after the pieces given here', () => {
    expect(restOfBox(2, 10)).toBe(8)
    expect(restOfBox(0, 10)).toBe(10)
    expect(restOfBox(10, 10)).toBeNull()
    expect(restOfBox(2, null)).toBeNull()
  })
})

/** The words of the report do not matter here: the key and its numbers are returned. */
const t = (key: string, v?: Record<string, unknown>) =>
  v ? `${key}(${Object.values(v).join(',')})` : key
type Order = NonNullable<SixStepsSource['nurseOrders']>[number]
const order = (p: Partial<Order>): Order => ({
  text: 'Amoxicillin 500 mg',
  kind: 'drug',
  dose: null,
  route: null,
  frequency: null,
  dosesPlanned: 1,
  given: 0,
  notGiven: 0,
  status: 'open',
  ...p,
})

describe('the printed step 6: an order carried out once (0193)', () => {
  it('prints its parts and who gave it; an older order keeps its times', () => {
    const r = sixStepsOfVisit(
      {
        diagnoses: [],
        nurseOrders: [
          order({
            quantity: 2,
            unit: 'cap',
            dose: '1 g',
            homeQuantity: 8,
            homeDays: 3,
            status: 'done',
            given: 1,
            doses: [{ given: true, by: 'Nurse A', at: '2026-11-20T08:52:00Z' }],
          }),
          order({ text: 'Old', dosesPlanned: 3, given: 1 }),
          order({ text: 'Cancelled', status: 'cancelled' }),
        ],
      },
      t,
    ).nurseOrders
    expect(r).toHaveLength(2)
    expect(r?.[0]?.how).toContain('nurseOrders.partHere(2,cap)')
    expect(r?.[0]?.how).toContain('nurseOrders.partHome(8,cap)')
    expect(r?.[0]?.status).toMatch(/^nurseOrders\.givenBy\(Nurse A,/)
    expect(r?.[1]?.how).toContain('nurseOrders.times(3)')
  })
})

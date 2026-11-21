import { describe, expect, it } from 'vitest'
import { canUndoOrder, type NurseOrder, type NurseOrderDose } from './api/nurse-orders'
import { hereLine, undoBody, undoMessage } from './order-words'

/** The words do not matter here: the key and its values are returned. */
const t = (key: string, v?: Record<string, unknown>) =>
  v ? `${key}(${Object.values(v).join(',')})` : key

const dose = (p: Partial<NurseOrderDose> = {}): NurseOrderDose => ({
  id: 'd1',
  n: 1,
  given: true,
  at: new Date().toISOString(),
  recordedAt: new Date().toISOString(),
  by: 'Nurse A',
  byId: 'u-a',
  note: null,
  charged: true,
  onBill: true,
  ...p,
})
const order = (p: Partial<NurseOrder>): NurseOrder => ({
  id: 'o1',
  encounterId: 'e1',
  kind: 'drug',
  text: 'Amoxicillin 500 mg',
  serviceId: null,
  service: null,
  itemId: 'i1',
  item: 'Amoxicillin 500 mg',
  quantity: 2,
  dose: null,
  route: null,
  frequency: null,
  dosesPlanned: 1,
  given: 1,
  notGiven: 0,
  assignedTo: null,
  assignedName: null,
  status: 'done',
  notes: null,
  at: new Date().toISOString(),
  by: 'Dr B',
  byId: 'u-doc',
  endedAt: null,
  endedBy: null,
  endReason: null,
  mine: false,
  doses: [dose({ quantity: 2 })],
  unit: 'cap',
  ...p,
})
const w = { endsOrder: false, visitOver: false, billClosed: false, by: 'Nurse A', when: 'today' }

describe('Undo of an order of step 6 (0193)', () => {
  it('speaks of the bill only when a time is on it', () => {
    expect(undoBody(t, order({}), w)).toContain('nurseOrders.undoBack(2,cap)')
    const notBilled = order({ doses: [dose({ quantity: 2, onBill: false, charged: false })] })
    expect(undoBody(t, notBilled, { ...w, billClosed: true })).toContain(
      'nurseOrders.undoBackStock(2,cap)',
    )
    expect(undoBody(t, notBilled, { ...w, billClosed: true })).not.toContain(
      'nurseOrders.undoCredit',
    )
    // a written act (not in the price list): Done by, and nothing comes off the bill
    const typed = order({ kind: 'act', doses: [dose({ onBill: false, charged: false })] })
    const body = undoBody(t, typed, w)
    expect(body).toContain('nurseOrders.undoDoneBy(Nurse A,today)')
    expect(body).toContain('nurseOrders.undoNotOnBill')
    expect(body).not.toContain('undoBackAct')
  })
  it('an order already over stays so', () => {
    expect(undoBody(t, order({ status: 'cancelled' }), { ...w, endsOrder: true })).toContain(
      'nurseOrders.undoStays',
    )
    expect(undoBody(t, order({ status: 'done' }), w)).toContain('nurseOrders.undoReopens')
  })
  it('says the credit note’s whole amount, with the insurer’s part', () => {
    const o = order({})
    const split = undoMessage(t, o, {
      mode: 'credit',
      creditNoteId: 'cn',
      credit: 225,
      creditTotal: 1500,
      creditInsurer: 1275,
    })
    expect(split).toMatch(/^nurseOrders\.undoneCreditSplit\(/)
    expect(split).toContain('1,500')
    const cash = undoMessage(t, o, {
      mode: 'credit',
      creditNoteId: 'cn',
      credit: 50,
      creditTotal: 50,
      creditInsurer: 0,
    })
    expect(cash).toMatch(/^nurseOrders\.undoneCredit\(/)
    expect(undoMessage(t, o, { mode: 'bill', units: 2, removed: 0 })).toMatch(/undoneStock/)
    expect(undoMessage(t, o, { mode: 'bill', units: 0, removed: 1 })).toMatch(/undoneBill/)
    expect(undoMessage(t, o, { mode: 'bill', units: 0, removed: 0 })).toMatch(/undonePlain/)
    expect(undoMessage(t, o, { mode: 'bill', units: 2, removed: 1 })).toMatch(
      /^nurseOrders\.undone\(/,
    )
  })
  it('is never offered on a database without 0193 (times without an id)', () => {
    expect(canUndoOrder(order({}), 'u-mgr', true)).toBe(true)
    expect(canUndoOrder(order({ doses: [dose({ id: undefined })] }), 'u-mgr', true)).toBe(false)
    expect(canUndoOrder(order({ status: 'cancelled' }), 'u-mgr', true)).toBe(false)
    expect(canUndoOrder(order({}), 'u-a', false)).toBe(true)
    expect(canUndoOrder(order({}), 'u-b', false)).toBe(false)
  })
  it('keeps the “how often” a screen of before 0193 sent', () => {
    expect(hereLine(t, order({ dose: '1 g', frequency: 'TDS' }))).toContain(
      'clinical.frequencies.TDS',
    )
  })
})

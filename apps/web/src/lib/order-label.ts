import type { DispenseLabel } from './dispense-label'
import type { NurseOrder, NurseOrderDose } from './api/nurse-orders'

/**
 * The dispensing label (70 × 40 mm) of a medicine taken home through an order of step 6 (0193):
 * the take-home part handed over, how to take it, and the batch it really came from (the earliest
 * expiry of the time given). Null when nothing went home.
 */
export function orderLabel(o: NurseOrder, d?: NurseOrderDose | null): DispenseLabel | null {
  const quantity = Number(d?.homeQuantity ?? o.homeQuantity ?? 0)
  if (o.kind !== 'drug' || !(quantity > 0)) return null
  const b = d?.batches?.[0]
  return {
    item: o.text,
    quantity,
    unit: o.unit ?? null,
    packSize: o.packSize ?? null,
    dose: o.homeDose ?? null,
    frequency: o.homeFrequency ?? null,
    days: o.homeDays ?? null,
    instructions: o.homeInstructions ?? null,
    batchNo: b?.batchNo ?? null,
    expiry: b?.expiry ?? null,
  }
}

/** The time whose label is printed: the latest given. */
export const labelDose = (o: NurseOrder): NurseOrderDose | null =>
  [...o.doses].reverse().find((d) => d.given && Number(d.homeQuantity ?? 0) > 0) ?? null

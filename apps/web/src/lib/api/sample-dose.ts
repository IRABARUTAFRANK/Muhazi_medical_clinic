import type { ItemDose } from '@/lib/dose'

/**
 * Sample mode (no database), 0198: what one piece holds for the sample medicines, and the pieces
 * opened for a part. Shared by the medicines list, the order form's items and the stock screens.
 *   it-2 Paracetamol 500 mg: set (500 mg a tablet, halves, share of the piece price);
 *   it-6 Cough syrup: set (bottle of 100 ml, by the ml, 20 RWF a ml);
 *   it-1 Amoxicillin 500 mg capsule, it-4 Ciprofloxacin, it-5 Ibuprofen: read from the name;
 *   it-3 Artemether-lumefantrine 20/120 mg: a combination sold by the box (nothing read, whole).
 */
const at = '2026-11-20T08:30:00Z'
const blank: ItemDose = {
  doseAmount: null,
  doseUnit: null,
  dosePer: null,
  dosePerUnit: null,
  contentAmount: null,
  contentUnit: null,
  partMode: null,
  partModeNow: null,
  partPriceRule: 'share',
  halfPrice: null,
  quarterPrice: null,
  measurePrice: null,
  doseSetAt: null,
}

export const sampleItemDoses: Record<string, ItemDose> = {
  'it-1': { ...blank, partModeNow: 'whole' },
  'it-2': { ...blank, doseAmount: 500, doseUnit: 'mg', partModeNow: 'half', doseSetAt: at },
  'it-3': { ...blank, partModeNow: 'whole' },
  'it-4': { ...blank, partModeNow: 'half' },
  'it-5': { ...blank, partModeNow: 'half' },
  'it-6': {
    ...blank,
    contentAmount: 100,
    contentUnit: 'ml',
    partMode: 'measure',
    partModeNow: 'measure',
    partPriceRule: 'set',
    measurePrice: 20,
    doseSetAt: at,
  },
}

/** The 0198 columns of a sample medicine (a copy, as the database would answer). */
export const sampleDoseOf = (itemId: string): ItemDose =>
  ({ ...(sampleItemDoses[itemId] ?? blank) }) satisfies ItemDose

/** A piece opened for a part (open_pieces, 0198). */
export interface OpenPiece {
  id: string
  itemId: string
  item: string
  storeId: string
  store: string | null
  /** What is left of it, of one piece (0 < left ≤ 1). */
  left: number
  /** The database's words for it ("½ tablet", "95 ml"). */
  leftText: string
  batchNo: string | null
  expiry: string | null
  openedAt: string
  openedBy: string | null
}

export const sampleOpenPieces: OpenPiece[] = [
  {
    id: 'op-1',
    itemId: 'it-2',
    item: 'Paracetamol 500 mg',
    storeId: 'l-pharm',
    store: 'Pharmacy',
    left: 0.5,
    leftText: '½ tab',
    batchNo: 'B260901-004',
    expiry: '2026-12-31',
    openedAt: '2026-11-24T06:10:00Z',
    openedBy: 'Nyirahabimana Chantal',
  },
  {
    id: 'op-2',
    itemId: 'it-6',
    item: 'Cough syrup 100 ml',
    storeId: 'l-pharm',
    store: 'Pharmacy',
    left: 0.95,
    leftText: '95 ml',
    batchNo: 'B261001-007',
    expiry: '2027-03-31',
    openedAt: '2026-11-23T14:40:00Z',
    openedBy: 'Nyirahabimana Chantal',
  },
]

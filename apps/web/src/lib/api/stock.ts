import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DayRange } from './lab'
import { supabase } from '@/lib/supabase'

/**
 * Medicine stock: what is on hand in each store, cost and selling price, receiving, sending
 * stock to a department or a doctor's office, the pharmacy hand-over queue, the ledger and
 * sales. Live: stock_overview, receive_stock, transfer_stock, use_stock, pharmacy_queue,
 * dispense_prescription, stock_movements, stock_sales, save_location.
 */

export interface StockLocation {
  id: string
  name: string
  type: 'main_store' | 'pharmacy' | 'nursing' | 'lab' | 'theatre'
  department: string | null
  /** false: closed (no longer used). */
  active?: boolean
}
export interface StockItem {
  id: string
  code: string
  name: string
  strength: string | null
  unit: string | null
  sellingPrice: number | null
  reorderLevel: number
  onHand: number
  costValue: number
  avgCost: number | null
  byLocation: Record<string, number>
  earliestExpiry: string | null
  expiredUnits: number
  active: boolean
}
export interface StockOverview {
  locations: StockLocation[]
  items: StockItem[]
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
  at: string
  price: number | null
  onHandPharmacy: number
  /** Expired units in the pharmacy store: never handed over, to write off (migration 0057). */
  expiredInPharmacy?: number
  /** A doctor still has the patient at their desk. */
  doctorHolds?: boolean
}
export interface StockMovement {
  id: string
  at: string
  type: 'receipt' | 'dispense' | 'transfer' | 'adjustment' | 'return' | 'consumption'
  item: string
  quantity: number
  from: string | null
  to: string | null
  batch: string | null
  expiry: string | null
  unitCost: number | null
  reason: string | null
  by: string | null
}
export interface StockSales {
  items: { item: string; units: number; revenue: number; cost: number; margin: number }[]
  received: number
  consumed: number
  stockValue: number
}

// ---------------------------------------------------------------- sample mode
const sampleLocations: StockLocation[] = [
  { id: 'l-main', name: 'Main store', type: 'main_store', department: null },
  { id: 'l-pharm', name: 'Pharmacy', type: 'pharmacy', department: null },
  { id: 'l-nurse', name: 'Nursing', type: 'nursing', department: null },
  { id: 'l-cons', name: 'Consultation 1 office', type: 'nursing', department: 'Consultation' },
]
const sampleItems: StockItem[] = [
  {
    id: 'it-1',
    code: 'AMOX500',
    name: 'Amoxicillin',
    strength: '500 mg',
    unit: 'cap',
    sellingPrice: 300,
    reorderLevel: 500,
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
    sellingPrice: 50,
    reorderLevel: 1000,
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
    sellingPrice: 500,
    reorderLevel: 150,
    onHand: 96,
    costValue: 24000,
    avgCost: 250,
    byLocation: { 'l-pharm': 96 },
    earliestExpiry: '2026-11-15',
    expiredUnits: 0,
    active: true,
  },
]
const sampleQueue: PharmacyLine[] = [
  {
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
    at: new Date(Date.now() - 20 * 60_000).toISOString(),
    price: 500,
    onHandPharmacy: 96,
  },
  {
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
    at: new Date(Date.now() - 8 * 60_000).toISOString(),
    price: 300,
    onHandPharmacy: 200,
  },
]
const sampleMoves: StockMovement[] = [
  {
    id: 'm-1',
    at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    type: 'receipt',
    item: 'Amoxicillin 500 mg',
    quantity: 1000,
    from: null,
    to: 'Main store',
    batch: 'B261020-001',
    expiry: '2027-06-30',
    unitCost: 120,
    reason: 'Kigali Pharma Wholesale Ltd',
    by: 'Mugabo Théogène',
  },
  {
    id: 'm-2',
    at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    type: 'transfer',
    item: 'Amoxicillin 500 mg',
    quantity: 40,
    from: 'Main store',
    to: 'Consultation 1 office',
    batch: 'B261020-001',
    expiry: '2027-06-30',
    unitCost: 120,
    reason: null,
    by: 'Mugabo Théogène',
  },
  {
    id: 'm-3',
    at: new Date(Date.now() - 50 * 60_000).toISOString(),
    type: 'dispense',
    item: 'Paracetamol 500 mg',
    quantity: 20,
    from: 'Pharmacy',
    to: null,
    batch: 'B260901-004',
    expiry: '2026-12-31',
    unitCost: 20,
    reason: null,
    by: 'Kalisa Pascal',
  },
]

const KEY = ['stock'] as const

/** One rule everywhere (stock page, pharmacy, manager dashboard): a level is set and reached. */
export const isLowStock = (i: Pick<StockItem, 'onHand' | 'reorderLevel'>) =>
  i.reorderLevel > 0 && i.onHand <= i.reorderLevel

export function useStockOverview() {
  return useQuery({
    // another desk receives or hands over stock: keep the figures fresh
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    queryKey: [...KEY, 'overview'],
    queryFn: async (): Promise<StockOverview> => {
      if (!supabase) return { locations: sampleLocations, items: sampleItems }
      const { data, error } = await supabase.rpc('stock_overview')
      if (error) throw new Error(error.message)
      const d = data as StockOverview
      return {
        locations: d.locations ?? [],
        items: (d.items ?? []).map((i) => ({
          ...i,
          sellingPrice: i.sellingPrice == null ? null : Number(i.sellingPrice),
          onHand: Number(i.onHand ?? 0),
          costValue: Number(i.costValue ?? 0),
          avgCost: i.avgCost == null ? null : Number(i.avgCost),
          expiredUnits: Number(i.expiredUnits ?? 0),
        })),
      }
    },
  })
}

export function usePharmacyQueue() {
  return useQuery({
    queryKey: [...KEY, 'pharmacy'],
    refetchInterval: 20_000,
    queryFn: async (): Promise<PharmacyLine[]> => {
      if (!supabase) return sampleQueue
      const { data, error } = await supabase.rpc('pharmacy_queue')
      if (error) throw new Error(error.message)
      return ((data ?? []) as PharmacyLine[]).map((l) => ({
        ...l,
        quantity: Number(l.quantity),
        price: l.price == null ? null : Number(l.price),
        onHandPharmacy: Number(l.onHandPharmacy ?? 0),
        expiredInPharmacy: Number(l.expiredInPharmacy ?? 0),
      }))
    },
  })
}

export function useStockMovements(from: string, to: string, itemId: string | null) {
  return useQuery({
    queryKey: [...KEY, 'moves', from, to, itemId],
    queryFn: async (): Promise<StockMovement[]> => {
      if (!supabase) return sampleMoves
      const { data, error } = await supabase.rpc('stock_movements', {
        p_from: from,
        p_to: to,
        p_item_id: itemId,
      })
      if (error) throw new Error(error.message)
      return ((data ?? []) as StockMovement[]).map((m) => ({
        ...m,
        quantity: Number(m.quantity),
        unitCost: m.unitCost == null ? null : Number(m.unitCost),
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
        }
      const { data, error } = await supabase.rpc('stock_sales', { p_from: from, p_to: to })
      if (error) throw new Error(error.message)
      const d = data as StockSales
      return {
        items: (d.items ?? []).map((x) => ({
          item: x.item,
          units: Number(x.units),
          revenue: Number(x.revenue),
          cost: Number(x.cost),
          margin: Number(x.margin),
        })),
        received: Number(d.received ?? 0),
        consumed: Number(d.consumed ?? 0),
        stockValue: Number(d.stockValue ?? 0),
      }
    },
  })
}

export function useStockActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEY })
    void qc.invalidateQueries({ queryKey: ['visit'] })
    void qc.invalidateQueries({ queryKey: ['queue'] })
  }
  const call = async (fn: string, args: Record<string, unknown>) => {
    if (!supabase) return null
    const { data, error } = await supabase.rpc(fn, args)
    if (error) throw new Error(error.message)
    return data
  }
  const receive = useMutation({
    mutationFn: (i: {
      itemId: string
      locationId: string
      quantity: number
      unitCost: number
      batchNo?: string
      expiry?: string
      supplier?: string
    }) => {
      if (!supabase) {
        const it = sampleItems.find((x) => x.id === i.itemId)
        if (it) {
          it.onHand += i.quantity
          it.costValue += i.quantity * i.unitCost
          it.byLocation[i.locationId] = (it.byLocation[i.locationId] ?? 0) + i.quantity
        }
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
    onSuccess: refresh,
  })
  const transfer = useMutation({
    mutationFn: (i: {
      itemId: string
      from: string
      to: string
      quantity: number
      reason?: string
    }) => {
      if (!supabase) {
        const it = sampleItems.find((x) => x.id === i.itemId)
        if (it) {
          it.byLocation[i.from] = (it.byLocation[i.from] ?? 0) - i.quantity
          it.byLocation[i.to] = (it.byLocation[i.to] ?? 0) + i.quantity
        }
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
  const use = useMutation({
    mutationFn: (i: { itemId: string; locationId: string; quantity: number; reason?: string }) => {
      if (!supabase) return Promise.resolve(null)
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
  const dispense = useMutation({
    mutationFn: async (requestId: string): Promise<{ charged: boolean }> => {
      if (!supabase) {
        const i = sampleQueue.findIndex((x) => x.requestId === requestId)
        if (i >= 0) sampleQueue.splice(i, 1)
        return { charged: true }
      }
      const d = (await call('dispense_prescription', {
        p_medication_request_id: requestId,
        p_location_id: null,
      })) as {
        charged: boolean
      }
      return { charged: !!d?.charged }
    },
    onSuccess: refresh,
  })
  const saveLocation = useMutation({
    mutationFn: (i: {
      id?: string
      name: string
      type: StockLocation['type']
      departmentId: string | null
    }) => {
      if (!supabase) {
        sampleLocations.push({
          id: `l-${Math.random().toString(36).slice(2, 7)}`,
          name: i.name,
          type: i.type,
          department: null,
        })
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
  // The pharmacy sells a medicine to a patient in the clinic without a prescription.
  const sell = useMutation({
    mutationFn: async (i: {
      encounterId: string
      itemId: string
      quantity: number
      instructions?: string
    }) => {
      if (!supabase) return { charged: true }
      const d = (await call('sell_medicine', {
        p_encounter_id: i.encounterId,
        p_item_id: i.itemId,
        p_quantity: i.quantity,
        p_instructions: i.instructions?.trim() || null,
      })) as { charged?: boolean }
      return { charged: !!d?.charged }
    },
    onSuccess: refresh,
  })
  /** The quantity at which the medicine shows as low (0: never). */
  const setReorderLevel = useMutation({
    mutationFn: (i: { itemId: string; level: number }) =>
      call('set_reorder_level', { p_item_id: i.itemId, p_level: i.level }),
    onSuccess: refresh,
  })
  /** The shelf was counted: the store's stock becomes that count (difference kept with its reason). */
  const adjust = useMutation({
    mutationFn: (i: { itemId: string; locationId: string; counted: number; reason: string }) =>
      call('adjust_stock', {
        p_item_id: i.itemId,
        p_location_id: i.locationId,
        p_counted: i.counted,
        p_reason: i.reason.trim(),
      }),
    onSuccess: refresh,
  })
  /** A store no longer used is closed (once empty); it can be opened again. */
  const setLocationActive = useMutation({
    mutationFn: (i: { id: string; active: boolean }) =>
      call('set_location_active', { p_id: i.id, p_active: i.active }),
    onSuccess: refresh,
  })
  /** A hand-over undone: back to the store, off the bill, waiting at the pharmacy again. */
  const returnMedicine = useMutation({
    mutationFn: (i: { requestId: string; reason: string }) =>
      call('return_medicine', { p_medication_request_id: i.requestId, p_reason: i.reason.trim() }),
    onSuccess: refresh,
  })
  return {
    returnMedicine,
    receive,
    transfer,
    use,
    dispense,
    notGiven,
    sell,
    saveLocation,
    setReorderLevel,
    adjust,
    setLocationActive,
  }
}

/** The pharmacy desk's figures (migration 0056). */
export interface PharmacySummary {
  lines: number
  patients: number
  dispensedToday: number
  patientsServedToday: number
  notGivenToday: number
  salesToday: number
  topToday: { item: string; count: number }[]
  notGiven: { item: string; patient: string; reason: string | null; at: string }[]
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
              at: new Date(Date.now() - 50 * 60_000).toISOString(),
            },
          ],
        }
      const { data, error } = await supabase.rpc(
        'pharmacy_summary',
        period ? { p_from: period.from, p_to: period.to } : undefined,
      )
      if (error) throw new Error(error.message)
      const d = (data ?? {}) as PharmacySummary
      return {
        ...d,
        salesToday: Number(d.salesToday ?? 0),
        topToday: d.topToday ?? [],
        notGiven: d.notGiven ?? [],
      }
    },
  })
}

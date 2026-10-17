import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Triage } from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import type { Station } from '@/lib/api/visits'

/**
 * One visit on a station screen: who the patient is, the vitals from triage, who pays, and the
 * running bill (treatments with discounts and the patient / insurer split).
 * Live: `queue_board`, `visit_vitals`, `visit_bill`, `visit_charges`, `add_charge`,
 * `void_charge`, `set_visit_payer`, `finish_station`. Sample: in-memory stand-ins.
 */

export interface VisitHeader {
  encounterId: string
  patientId: string
  fileNumber: string
  name: string
  ageSex: string
  triage: Triage | null
  ticket: string
  /** Open queue entries (stations the patient is currently expected at). */
  stations: Station[]
}

export interface Vital {
  code: string
  value: number
  unit: string | null
  at: string
}

export interface Charge {
  id: string
  description: string
  quantity: number
  unitPrice: number
  listPrice: number
  discountPct: number
  discountReason: string | null
  coveragePct: number
  patientShare: number
  insurerShare: number
  office: Station
  enteredBy: string | null
  createdAt: string
}

export interface VisitBill {
  invoiceId: string | null
  status: 'draft' | 'posted' | 'credited' | null
  payerId: string | null
  payerName: string | null
  total: number
  patientShare: number
  insurerShare: number
  charges: Charge[]
}

const EMPTY_BILL: VisitBill = {
  invoiceId: null,
  status: null,
  payerId: null,
  payerName: null,
  total: 0,
  patientShare: 0,
  insurerShare: 0,
  charges: [],
}

// ---------------------------------------------------------------- sample mode
const sampleBills = new Map<string, VisitBill>()
const sampleBill = (encounterId: string): VisitBill => {
  let b = sampleBills.get(encounterId)
  if (!b) {
    b = { ...EMPTY_BILL, invoiceId: `inv-${encounterId}`, status: 'draft', charges: [] }
    sampleBills.set(encounterId, b)
  }
  return b
}
const recompute = (b: VisitBill) => {
  b.total = b.charges.reduce((s, c) => s + Math.round(c.unitPrice * c.quantity), 0)
  b.insurerShare = b.charges.reduce((s, c) => s + c.insurerShare, 0)
  b.patientShare = b.total - b.insurerShare
}

// ---------------------------------------------------------------- header + vitals
interface BoardRow {
  encounter_id: string
  patient_id: string
  file_number: string
  surname: string
  given_names: string
  sex: 'female' | 'male' | 'other' | 'unknown'
  birth_date: string | null
  triage_level: Triage | null
  ticket_no: string
  station: Station
  finished_at: string | null
}
const ageOf = (birth: string | null): string => {
  if (!birth) return '—'
  const b = new Date(birth)
  const now = new Date()
  let years = now.getFullYear() - b.getFullYear()
  if (now < new Date(now.getFullYear(), b.getMonth(), b.getDate())) years -= 1
  return years >= 2
    ? String(years)
    : `${Math.max(0, (now.getFullYear() - b.getFullYear()) * 12 + now.getMonth() - b.getMonth())}m`
}
const sexLetter = { female: 'F', male: 'M', other: '', unknown: '' } as const

export function useVisitHeader(encounterId: string) {
  return useQuery({
    queryKey: ['visit', encounterId, 'header'],
    queryFn: async (): Promise<VisitHeader | null> => {
      if (!supabase) {
        return {
          encounterId,
          patientId: 'p-sample',
          fileNumber: 'MMC-000124',
          name: 'Mukamana Alice',
          ageSex: '31 F',
          triage: 'yellow',
          ticket: 'A-012',
          stations: ['consultation'],
        }
      }
      const { data, error } = await supabase
        .from('queue_board')
        .select('*')
        .eq('encounter_id', encounterId)
        .order('queued_at')
      if (error) throw new Error(error.message)
      const rows = data as BoardRow[]
      const r = rows[0]
      if (!r) return null
      return {
        encounterId,
        patientId: r.patient_id,
        fileNumber: r.file_number,
        name: `${r.surname} ${r.given_names}`,
        ageSex: `${ageOf(r.birth_date)} ${sexLetter[r.sex]}`.trim(),
        triage: r.triage_level,
        ticket: r.ticket_no,
        stations: rows.filter((x) => !x.finished_at).map((x) => x.station),
      }
    },
  })
}

export function useVisitVitals(encounterId: string) {
  return useQuery({
    queryKey: ['visit', encounterId, 'vitals'],
    queryFn: async (): Promise<Vital[]> => {
      if (!supabase) {
        return [
          { code: 'bp_sys', value: 128, unit: 'mmHg', at: new Date().toISOString() },
          { code: 'bp_dia', value: 84, unit: 'mmHg', at: new Date().toISOString() },
          { code: 'temp', value: 38.2, unit: '°C', at: new Date().toISOString() },
          { code: 'pulse', value: 96, unit: 'bpm', at: new Date().toISOString() },
        ]
      }
      const { data, error } = await supabase
        .from('visit_vitals')
        .select('code, value_num, unit, effective_at')
        .eq('encounter_id', encounterId)
      if (error) throw new Error(error.message)
      return (
        data as {
          code: string
          value_num: number | string
          unit: string | null
          effective_at: string
        }[]
      ).map((v) => ({
        code: v.code,
        value: Number(v.value_num),
        unit: v.unit,
        at: v.effective_at,
      }))
    },
  })
}

// ---------------------------------------------------------------- bill
interface BillRow {
  invoice_id: string
  status: 'draft' | 'posted' | 'credited'
  payer_id: string | null
  payer_name: string | null
  total: number | string
  patient_share: number | string
  insurer_share: number | string
}
interface ChargeRow {
  id: string
  description: string
  quantity: number | string
  unit_price: number | string
  list_price: number | string | null
  discount_pct: number | string
  discount_reason: string | null
  coverage_pct: number | string
  patient_share: number | string
  insurer_share: number | string
  office: Station
  entered_by_name: string | null
  created_at: string
}

export function useVisitBill(encounterId: string) {
  return useQuery({
    queryKey: ['visit', encounterId, 'bill'],
    queryFn: async (): Promise<VisitBill> => {
      if (!supabase) return { ...sampleBill(encounterId) }
      const [{ data: bill, error: be }, { data: lines, error: le }] = await Promise.all([
        supabase.from('visit_bill').select('*').eq('encounter_id', encounterId).maybeSingle(),
        supabase
          .from('visit_charges')
          .select('*')
          .eq('encounter_id', encounterId)
          .order('created_at'),
      ])
      if (be) throw new Error(be.message)
      if (le) throw new Error(le.message)
      const b = bill as BillRow | null
      return {
        invoiceId: b?.invoice_id ?? null,
        status: b?.status ?? null,
        payerId: b?.payer_id ?? null,
        payerName: b?.payer_name ?? null,
        total: Number(b?.total ?? 0),
        patientShare: Number(b?.patient_share ?? 0),
        insurerShare: Number(b?.insurer_share ?? 0),
        charges: ((lines ?? []) as ChargeRow[]).map((c) => ({
          id: c.id,
          description: c.description,
          quantity: Number(c.quantity),
          unitPrice: Number(c.unit_price),
          listPrice: Number(c.list_price ?? c.unit_price),
          discountPct: Number(c.discount_pct),
          discountReason: c.discount_reason,
          coveragePct: Number(c.coverage_pct),
          patientShare: Number(c.patient_share),
          insurerShare: Number(c.insurer_share),
          office: c.office,
          enteredBy: c.entered_by_name,
          createdAt: c.created_at,
        })),
      }
    },
  })
}

// ---------------------------------------------------------------- actions
export interface AddChargeInput {
  encounterId: string
  office: Station
  serviceId: string
  /** Sample mode needs the description and price; live mode resolves them in the database. */
  description?: string
  listPrice?: number
  quantity: number
  discountPct: number
  discountReason?: string
  coveragePct?: number
}

export function useBillingActions(encounterId: string) {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['visit', encounterId] })
    void qc.invalidateQueries({ queryKey: ['queue'] })
  }

  const addCharge = useMutation({
    mutationFn: async (input: AddChargeInput) => {
      if (!supabase) {
        const b = sampleBill(encounterId)
        const unit = Math.round(((input.listPrice ?? 0) * (100 - input.discountPct)) / 100)
        const total = Math.round(unit * input.quantity)
        const insurer = Math.round((total * (input.coveragePct ?? 0)) / 100)
        b.charges.push({
          id: `c-${Math.random().toString(36).slice(2, 8)}`,
          description: input.description ?? input.serviceId,
          quantity: input.quantity,
          unitPrice: unit,
          listPrice: input.listPrice ?? 0,
          discountPct: input.discountPct,
          discountReason: input.discountReason ?? null,
          coveragePct: input.coveragePct ?? 0,
          patientShare: total - insurer,
          insurerShare: insurer,
          office: input.office,
          enteredBy: null,
          createdAt: new Date().toISOString(),
        })
        recompute(b)
        return
      }
      const { error } = await supabase.rpc('add_charge', {
        p_encounter_id: encounterId,
        p_office: input.office,
        p_service_id: input.serviceId,
        p_item_id: null,
        p_quantity: input.quantity,
        p_manual_price: null,
        p_manual_reason: null,
        p_performed_by: null,
        p_entered_for: null,
        p_source_type: null,
        p_source_id: null,
        p_discount_pct: input.discountPct,
        p_discount_reason: input.discountReason?.trim() || null,
      })
      if (error) throw new Error(error.message)
    },
    onSuccess: refresh,
  })

  const voidCharge = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      if (!supabase) {
        const b = sampleBill(encounterId)
        b.charges = b.charges.filter((c) => c.id !== id)
        recompute(b)
        return
      }
      const { error } = await supabase.rpc('void_charge', { p_line_id: id, p_reason: reason })
      if (error) throw new Error(error.message)
    },
    onSuccess: refresh,
  })

  const setPayer = useMutation({
    mutationFn: async ({
      payerId,
      memberNumber,
      payerName,
      coveragePct,
    }: {
      payerId: string | null
      memberNumber?: string
      payerName?: string
      coveragePct?: number
    }) => {
      if (!supabase) {
        const b = sampleBill(encounterId)
        b.payerId = payerId
        b.payerName = payerId ? (payerName ?? null) : null
        for (const c of b.charges) {
          const total = Math.round(c.unitPrice * c.quantity)
          c.coveragePct = payerId ? (coveragePct ?? 0) : 0
          c.insurerShare = Math.round((total * c.coveragePct) / 100)
          c.patientShare = total - c.insurerShare
        }
        recompute(b)
        return
      }
      const { error } = await supabase.rpc('set_visit_payer', {
        p_encounter_id: encounterId,
        p_payer_id: payerId,
        p_member_number: memberNumber?.trim() || null,
      })
      if (error) throw new Error(error.message)
    },
    onSuccess: refresh,
  })

  const finishStation = useMutation({
    mutationFn: async ({ station, next }: { station: Station; next: Station | null }) => {
      if (!supabase) return
      const { error } = await supabase.rpc('finish_station', {
        p_encounter_id: encounterId,
        p_station: station,
        p_next: next,
      })
      if (error) throw new Error(error.message)
    },
    onSuccess: refresh,
  })

  return { addCharge, voidCharge, setPayer, finishStation }
}

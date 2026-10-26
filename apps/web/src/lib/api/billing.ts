import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Triage } from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import type { Sex, Station } from '@/lib/api/visits'
import { apiError } from './errors'

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
  /** yyyy-mm-dd, for the documents (age printed in words). */
  birthDate?: string | null
  sex?: Sex
  triage: Triage | null
  ticket: string
  /** Open queue entries (stations the patient is currently expected at). */
  stations: Station[]
  /** A finished visit, shown read-only (when and by whom it was closed). */
  closed?: boolean
  closedAt?: string | null
  /** Why the patient left without paying (the manager's reason). */
  leftReason?: string | null
}

export interface Vital {
  code: string
  value: number
  unit: string | null
  /** When it was measured (may be earlier than when it was typed). */
  at: string
  /** Who measured (the nurse) and who typed it in, when known. */
  measuredBy?: string | null
  enteredBy?: string | null
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
  /** What the patient still owes (patient share minus payments). */
  balance: number
  paid: number
  /** Money given back (an overpaid bill, 0064). */
  refunded?: number
  /** Last payment: when and by whom (the green "paid" mark). */
  settledAt?: string | null
  settledBy?: string | null
  /** The invoice number (INV-YYYY-NNNNNN), once the bill has one. */
  invoiceNo?: string | null
  /** The patient's insurance member number for this visit (0084; null for cash or before). */
  memberNo?: string | null
  /** The insurer's cover in percent (the plan; 0084). */
  coveragePct?: number | null
  /** The latest payment, for a reprinted receipt (0084; null before or when nothing is paid). */
  lastPayment?: LastPayment | null
  charges: Charge[]
}

/** The latest payment of a visit's bill. */
export interface LastPayment {
  /** RCT-YYYY-NNNNNN. */
  receiptNo: string | null
  /** The method code (cash, momo, airtel, card…): the receipt translates it. */
  method: string | null
  amount: number
  reference: string | null
  at: string | null
  cashier: string | null
}

const EMPTY_BILL: VisitBill = {
  invoiceId: null,
  status: null,
  payerId: null,
  payerName: null,
  total: 0,
  patientShare: 0,
  insurerShare: 0,
  balance: 0,
  paid: 0,
  charges: [],
}

// ---------------------------------------------------------------- sample mode
const sampleBills = new Map<string, VisitBill>()
let sampleReceiptSeq = 0
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
  b.balance = b.patientShare - b.paid
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
    // another desk works on the same visit: keep it fresh while open
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<VisitHeader | null> => {
      if (!supabase) {
        return {
          encounterId,
          patientId: 'p-sample',
          fileNumber: 'MMC-000124',
          name: 'Mukamana Alice',
          ageSex: '31 F',
          birthDate: '1995-03-12',
          sex: 'female',
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
      if (error) throw apiError(error)
      const rows = data as BoardRow[]
      const r = rows[0]
      if (!r) {
        // Not in the queue board: the visit is finished. Load it directly, read-only.
        const { data: e, error: e2 } = await supabase
          .from('encounter')
          .select(
            'id, status, closed_at, left_reason, triage_level, patient:patient_id(id, file_number, surname, given_names, sex, birth_date)',
          )
          .eq('id', encounterId)
          .maybeSingle()
        if (e2) throw new Error(e2.message)
        if (!e) return null
        const p = (Array.isArray(e.patient) ? e.patient[0] : e.patient) as {
          id: string
          file_number: string
          surname: string
          given_names: string
          sex: BoardRow['sex']
          birth_date: string | null
        } | null
        if (!p) return null
        const { data: first } = await supabase
          .from('queue_entry')
          .select('ticket_no')
          .eq('encounter_id', encounterId)
          .order('created_at')
          .limit(1)
        return {
          encounterId,
          patientId: p.id,
          fileNumber: p.file_number,
          name: `${p.surname} ${p.given_names}`,
          ageSex: `${ageOf(p.birth_date)} ${sexLetter[p.sex]}`.trim(),
          birthDate: p.birth_date,
          sex: p.sex,
          triage: (e.triage_level as Triage | null) ?? null,
          ticket: (first?.[0] as { ticket_no: string } | undefined)?.ticket_no ?? '—',
          stations: [],
          closed: e.status !== 'open',
          closedAt: e.closed_at as string | null,
          leftReason: (e.left_reason as string | null) ?? null,
        }
      }
      return {
        encounterId,
        patientId: r.patient_id,
        fileNumber: r.file_number,
        name: `${r.surname} ${r.given_names}`,
        ageSex: `${ageOf(r.birth_date)} ${sexLetter[r.sex]}`.trim(),
        birthDate: r.birth_date,
        sex: r.sex,
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
    // another desk works on the same visit: keep it fresh while open
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    enabled: encounterId !== '',
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
        .select('code, value_num, unit, effective_at, measured_by, entered_by')
        .eq('encounter_id', encounterId)
      if (error) throw apiError(error)
      return (
        data as {
          code: string
          value_num: number | string
          unit: string | null
          effective_at: string
          measured_by: string | null
          entered_by: string | null
        }[]
      ).map((v) => ({
        code: v.code,
        value: Number(v.value_num),
        unit: v.unit,
        at: v.effective_at,
        measuredBy: v.measured_by,
        enteredBy: v.entered_by,
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
  balance: number | string | null
  paid: number | string | null
  refunded?: number | string | null
  number: string | null
  settled_at?: string | null
  settled_by?: string | null
  /** 0084 (absent before). */
  member_no?: string | null
  coverage_pct?: number | string | null
  receipt_no?: string | null
  receipt_method?: string | null
  receipt_amount?: number | string | null
  receipt_reference?: string | null
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
    // another desk works on the same visit: keep it fresh while open
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
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
        balance: Number(b?.balance ?? b?.patient_share ?? 0),
        paid: Number(b?.paid ?? 0),
        refunded: Number(b?.refunded ?? 0),
        settledAt: b?.settled_at ?? null,
        settledBy: b?.settled_by ?? null,
        invoiceNo: b?.number ?? null,
        memberNo: b?.member_no ?? null,
        coveragePct: b?.coverage_pct == null ? null : Number(b.coverage_pct),
        lastPayment:
          b && b.receipt_amount != null
            ? {
                receiptNo: b.receipt_no ?? null,
                method: b.receipt_method ?? null,
                amount: Number(b.receipt_amount),
                reference: b.receipt_reference ?? null,
                at: b.settled_at ?? null,
                cashier: b.settled_by ?? null,
              }
            : null,
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
  /** A treatment, or a medicine / supply (one of the two). */
  serviceId?: string
  itemId?: string
  /** Sample mode needs the description and price; live mode resolves them in the database. */
  description?: string
  listPrice?: number
  quantity: number
  discountPct: number
  discountReason?: string
  /** A different price per unit (allowed when the treatment permits it, or for the manager). */
  manualPrice?: number | null
  coveragePct?: number
}

export function useBillingActions(encounterId: string) {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['visit', encounterId] })
    void qc.invalidateQueries({ queryKey: ['queue'] })
    // who may work on the visit and where it goes change with it
    void qc.invalidateQueries({ queryKey: ['access', encounterId] })
    void qc.invalidateQueries({ queryKey: ['routing', encounterId] })
  }

  const addCharge = useMutation({
    mutationFn: async (input: AddChargeInput) => {
      if (!supabase) {
        const b = sampleBill(encounterId)
        const unit =
          input.manualPrice != null
            ? input.manualPrice
            : Math.round(((input.listPrice ?? 0) * (100 - input.discountPct)) / 100)
        const total = Math.round(unit * input.quantity)
        const insurer = Math.round((total * (input.coveragePct ?? 0)) / 100)
        b.charges.push({
          id: `c-${Math.random().toString(36).slice(2, 8)}`,
          description: input.description ?? input.serviceId ?? input.itemId ?? '',
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
        p_service_id: input.serviceId ?? null,
        p_item_id: input.itemId ?? null,
        p_quantity: input.quantity,
        p_manual_price: input.manualPrice ?? null,
        p_manual_reason: input.manualPrice != null ? input.discountReason?.trim() || null : null,
        p_performed_by: null,
        p_entered_for: null,
        p_source_type: null,
        p_source_id: null,
        p_discount_pct: input.manualPrice != null ? 0 : input.discountPct,
        p_discount_reason: input.manualPrice != null ? null : input.discountReason?.trim() || null,
      })
      if (error) throw apiError(error)
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
      if (error) throw apiError(error)
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
        b.memberNo = payerId ? memberNumber?.trim() || null : null
        b.coveragePct = payerId ? (coveragePct ?? null) : null
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
      if (error) throw apiError(error)
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
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })

  /** Several desks at once: the patient waits at each, the first doctor free takes them. */
  const sendTo = useMutation({
    mutationFn: async ({ station, next }: { station: Station; next: Station[] }) => {
      if (!supabase) return
      const { error } = await supabase.rpc('send_to_stations', {
        p_encounter_id: encounterId,
        p_station: station,
        p_next: next,
      })
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })

  const takePayment = useMutation({
    mutationFn: async ({
      method,
      amount,
      reference,
      phone,
    }: {
      method: 'cash' | 'momo' | 'airtel'
      amount: number
      reference?: string
      phone?: string
    }): Promise<{
      balance: number
      number: string | null
      status: string
      /** The visit ended with this payment (nothing else left to do). */
      closed: boolean
      receipt: string | null
    }> => {
      if (!supabase) {
        const b = sampleBill(encounterId)
        b.paid += amount
        recompute(b)
        if (b.balance <= 0) b.status = 'posted'
        if (b.balance <= 0) b.invoiceNo = 'INV-2026-000001'
        const receipt = `RCT-2026-${String(++sampleReceiptSeq).padStart(6, '0')}`
        b.lastPayment = {
          receiptNo: receipt,
          method,
          amount,
          reference: reference?.trim() || null,
          at: new Date().toISOString(),
          cashier: null,
        }
        b.settledAt = b.lastPayment.at
        return {
          balance: b.balance,
          number: b.balance <= 0 ? 'INV-2026-000001' : null,
          status: b.status ?? 'draft',
          closed: b.balance <= 0,
          receipt,
        }
      }
      const { data, error } = await supabase.rpc('take_payment', {
        p_encounter_id: encounterId,
        p_method: method,
        p_amount: amount,
        p_reference: reference?.trim() || null,
        p_payer_phone: phone?.trim() || null,
      })
      if (error) throw apiError(error)
      const r = data as {
        balance: number | string
        number: string | null
        status: string
        closed?: boolean
        receipt?: string | null
      }
      return {
        balance: Number(r.balance),
        number: r.number,
        status: r.status,
        closed: !!r.closed,
        receipt: r.receipt ?? null,
      }
    },
    onSuccess: () => {
      refresh()
      void qc.invalidateQueries({ queryKey: ['home'] })
      void qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })

  /** Give back what an overpaid bill holds (a charge removed after payment). */
  const refund = useMutation({
    mutationFn: async (i: {
      method: 'cash' | 'momo' | 'airtel'
      amount: number
      reason: string
      reference?: string
    }) => {
      if (!supabase) {
        const b = sampleBill(encounterId)
        b.paid -= i.amount
        recompute(b)
        return
      }
      const { error } = await supabase.rpc('refund_payment', {
        p_encounter_id: encounterId,
        p_amount: i.amount,
        p_method: i.method,
        p_reason: i.reason,
        p_reference: i.reference?.trim() || null,
      })
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })
  return { addCharge, voidCharge, setPayer, finishStation, sendTo, takePayment, refund }
}

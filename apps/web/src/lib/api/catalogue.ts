import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CategoryId } from '@mmc/shared'
import { supabase } from '@/lib/supabase'

/**
 * The manager's catalogue: treatments (what the clinic treats, the cash price, the discount a
 * clinician may give), insurers the clinic works with and what each covers.
 * Live: `catalogue_services`, `insurer_plans`, `upsert_service`, `set_service_price`,
 * `upsert_payer`. Sample: in-memory lists.
 */

/** `service_group` enum of the database. */
export const SERVICE_GROUPS = [
  'consultation',
  'dental',
  'lab',
  'imaging',
  'procedure',
  'nursing',
  'bed',
  'registration',
  'pharmacy',
  'other',
] as const
export type ServiceGroup = (typeof SERVICE_GROUPS)[number]

/** `payer_type` enum, without cash. */
export const PAYER_TYPES = ['rssb_rama', 'cbhi', 'mmi', 'private', 'employer'] as const
export type PayerType = (typeof PAYER_TYPES)[number]

export interface Treatment {
  id: string
  code: string
  nameEn: string
  nameKin: string | null
  nameFr: string | null
  group: ServiceGroup
  bookingCategory: CategoryId | null
  cashPrice: number | null
  /** Insurer-specific prices by payer id. */
  payerPrices: Record<string, number>
  maxDiscountPct: number
  allowManualPrice: boolean
  active: boolean
}

export interface TreatmentInput {
  id?: string
  code?: string
  nameEn: string
  nameKin?: string
  nameFr?: string
  group: ServiceGroup
  bookingCategory?: CategoryId | null
  cashPrice: number
  maxDiscountPct: number
  allowManualPrice: boolean
  active: boolean
  /** Insurer prices to set with the treatment; empty string = use the cash price. */
  payerPrices?: Record<string, string>
}

export interface Insurer {
  id: string
  code: string
  name: string
  type: PayerType
  active: boolean
  planId: string | null
  coveragePct: number
  /** Per-group overrides, e.g. {"dental": 50}. */
  pctByGroup: Partial<Record<ServiceGroup, number>>
}

export interface InsurerInput {
  id?: string
  code?: string
  name: string
  type: PayerType
  coveragePct: number
  pctByGroup: Partial<Record<ServiceGroup, number>>
  active: boolean
}

// ---------------------------------------------------------------- sample data
const sampleTreatments: Treatment[] = [
  {
    id: 't-1',
    code: 'CONS-GEN',
    nameEn: 'General consultation',
    nameKin: 'Gusuzuma',
    nameFr: 'Consultation générale',
    group: 'consultation',
    bookingCategory: 'consultation',
    cashPrice: 8000,
    payerPrices: {},
    maxDiscountPct: 10,
    allowManualPrice: false,
    active: true,
  },
  {
    id: 't-2',
    code: 'TRT-0001',
    nameEn: 'Malaria treatment (uncomplicated)',
    nameKin: 'Kuvura malariya',
    nameFr: 'Traitement du paludisme simple',
    group: 'consultation',
    bookingCategory: null,
    cashPrice: 12000,
    payerPrices: {},
    maxDiscountPct: 20,
    allowManualPrice: false,
    active: true,
  },
  {
    id: 't-3',
    code: 'LAB-MRDT',
    nameEn: 'Malaria RDT',
    nameKin: null,
    nameFr: 'TDR paludisme',
    group: 'lab',
    bookingCategory: 'laboratory',
    cashPrice: 2500,
    payerPrices: {},
    maxDiscountPct: 0,
    allowManualPrice: false,
    active: true,
  },
  {
    id: 't-4',
    code: 'DEN-EXT',
    nameEn: 'Tooth extraction',
    nameKin: 'Gukura iryinyo',
    nameFr: 'Extraction dentaire',
    group: 'dental',
    bookingCategory: 'dental',
    cashPrice: 15000,
    payerPrices: {},
    maxDiscountPct: 10,
    allowManualPrice: false,
    active: true,
  },
]
const sampleInsurers: Insurer[] = [
  {
    id: 'i-1',
    code: 'RAMA',
    name: 'RSSB RAMA',
    type: 'rssb_rama',
    active: false,
    planId: 'pl-1',
    coveragePct: 85,
    pctByGroup: {},
  },
  {
    id: 'i-2',
    code: 'CBHI',
    name: 'Mutuelle de Santé (CBHI)',
    type: 'cbhi',
    active: false,
    planId: 'pl-2',
    coveragePct: 90,
    pctByGroup: {},
  },
]

// ---------------------------------------------------------------- treatments
interface ServiceRow {
  id: string
  code: string
  name_en: string
  name_kin: string | null
  name_fr: string | null
  service_group: ServiceGroup
  booking_category: CategoryId | null
  allow_manual_price: boolean
  max_discount_pct: number | string
  active: boolean
  cash_price: number | string | null
  payer_prices: Record<string, number | string> | null
}

const TREATMENTS = ['catalogue', 'treatments'] as const

export function useTreatments(onlyActive = false) {
  return useQuery({
    queryKey: [...TREATMENTS, onlyActive],
    queryFn: async (): Promise<Treatment[]> => {
      if (!supabase) return sampleTreatments.filter((t) => !onlyActive || t.active)
      let q = supabase
        .from('catalogue_services')
        .select('*')
        .order('service_group')
        .order('name_en')
      if (onlyActive) q = q.eq('active', true)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return (data as ServiceRow[]).map((r) => ({
        id: r.id,
        code: r.code,
        nameEn: r.name_en,
        nameKin: r.name_kin,
        nameFr: r.name_fr,
        group: r.service_group,
        bookingCategory: r.booking_category,
        cashPrice: r.cash_price == null ? null : Number(r.cash_price),
        payerPrices: Object.fromEntries(
          Object.entries(r.payer_prices ?? {}).map(([k, v]) => [k, Number(v)]),
        ),
        maxDiscountPct: Number(r.max_discount_pct),
        allowManualPrice: r.allow_manual_price,
        active: r.active,
      }))
    },
  })
}

// ---------------------------------------------------------------- insurers
interface InsurerRow {
  id: string
  code: string
  name: string
  type: PayerType
  active: boolean
  plan_id: string | null
  coverage_pct: number | string | null
  pct_by_group: Record<string, number | string> | null
}

const INSURERS = ['catalogue', 'insurers'] as const

export function useInsurers(onlyActive = false) {
  return useQuery({
    queryKey: [...INSURERS, onlyActive],
    queryFn: async (): Promise<Insurer[]> => {
      if (!supabase) return sampleInsurers.filter((i) => !onlyActive || i.active)
      let q = supabase.from('insurer_plans').select('*').order('name')
      if (onlyActive) q = q.eq('active', true)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return (data as InsurerRow[]).map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        type: r.type,
        active: r.active,
        planId: r.plan_id,
        coveragePct: Number(r.coverage_pct ?? 0),
        pctByGroup: Object.fromEntries(
          Object.entries(r.pct_by_group ?? {}).map(([k, v]) => [k, Number(v)]),
        ) as Partial<Record<ServiceGroup, number>>,
      }))
    },
  })
}

// ---------------------------------------------------------------- manager actions
export function useCatalogueActions() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['catalogue'] })

  const saveTreatment = useMutation({
    mutationFn: async (input: TreatmentInput): Promise<string> => {
      if (!supabase) {
        const existing = input.id ? sampleTreatments.find((t) => t.id === input.id) : undefined
        const t: Treatment = {
          id: existing?.id ?? `t-${Math.random().toString(36).slice(2, 8)}`,
          code:
            input.code ||
            existing?.code ||
            `TRT-${String(sampleTreatments.length + 1).padStart(4, '0')}`,
          nameEn: input.nameEn,
          nameKin: input.nameKin || null,
          nameFr: input.nameFr || null,
          group: input.group,
          bookingCategory: input.bookingCategory ?? null,
          cashPrice: input.cashPrice,
          payerPrices: Object.fromEntries(
            Object.entries(input.payerPrices ?? {})
              .filter(([, v]) => v.trim() !== '')
              .map(([k, v]) => [k, Number(v)]),
          ),
          maxDiscountPct: input.maxDiscountPct,
          allowManualPrice: input.allowManualPrice,
          active: input.active,
        }
        if (existing) Object.assign(existing, t)
        else sampleTreatments.push(t)
        return t.id
      }
      const { data, error } = await supabase.rpc('upsert_service', {
        p_id: input.id ?? null,
        p_name_en: input.nameEn.trim(),
        p_group: input.group,
        p_cash_price: input.cashPrice,
        p_name_kin: input.nameKin?.trim() || null,
        p_name_fr: input.nameFr?.trim() || null,
        p_max_discount_pct: input.maxDiscountPct,
        p_allow_manual: input.allowManualPrice,
        p_active: input.active,
        p_code: input.code?.trim() || null,
        p_booking_category: input.bookingCategory ?? null,
      })
      if (error) throw new Error(error.message)
      const id = String(data)
      for (const [payerId, price] of Object.entries(input.payerPrices ?? {})) {
        const { error: pe } = await supabase.rpc('set_service_price', {
          p_service_id: id,
          p_payer_id: payerId,
          p_price: price.trim() === '' ? null : Number(price),
        })
        if (pe) throw new Error(pe.message)
      }
      return id
    },
    onSuccess: refresh,
  })

  const saveInsurer = useMutation({
    mutationFn: async (input: InsurerInput): Promise<string> => {
      if (!supabase) {
        const existing = input.id ? sampleInsurers.find((i) => i.id === input.id) : undefined
        const i: Insurer = {
          id: existing?.id ?? `i-${Math.random().toString(36).slice(2, 8)}`,
          code:
            input.code || existing?.code || input.name.replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
          name: input.name,
          type: input.type,
          active: input.active,
          planId: existing?.planId ?? 'pl-new',
          coveragePct: input.coveragePct,
          pctByGroup: input.pctByGroup,
        }
        if (existing) Object.assign(existing, i)
        else sampleInsurers.push(i)
        return i.id
      }
      const { data, error } = await supabase.rpc('upsert_payer', {
        p_id: input.id ?? null,
        p_name: input.name.trim(),
        p_type: input.type,
        p_coverage_pct: input.coveragePct,
        p_pct_by_group: input.pctByGroup,
        p_active: input.active,
        p_code: input.code?.trim() || null,
      })
      if (error) throw new Error(error.message)
      return String(data)
    },
    onSuccess: refresh,
  })

  /** Removes a treatment from every list; bills that already used it keep their lines. */
  const deleteTreatment = useMutation({
    mutationFn: async (id: string) => {
      if (!supabase) {
        const i = sampleTreatments.findIndex((t) => t.id === id)
        if (i >= 0) sampleTreatments.splice(i, 1)
        return
      }
      const { error } = await supabase.rpc('delete_service', { p_id: id })
      if (error) throw new Error(error.message)
    },
    onSuccess: refresh,
  })

  /** Shows or hides a treatment at the visit screen without opening the form. */
  const setTreatmentActive = useMutation({
    mutationFn: async ({ treatment, active }: { treatment: Treatment; active: boolean }) => {
      if (!supabase) {
        const x = sampleTreatments.find((t) => t.id === treatment.id)
        if (x) x.active = active
        return
      }
      const { error } = await supabase.rpc('upsert_service', {
        p_id: treatment.id,
        p_name_en: treatment.nameEn,
        p_group: treatment.group,
        p_cash_price: treatment.cashPrice ?? 0,
        p_name_kin: treatment.nameKin,
        p_name_fr: treatment.nameFr,
        p_max_discount_pct: treatment.maxDiscountPct,
        p_allow_manual: treatment.allowManualPrice,
        p_active: active,
        p_code: treatment.code,
        p_booking_category: treatment.bookingCategory,
      })
      if (error) throw new Error(error.message)
    },
    onSuccess: refresh,
  })

  const deleteInsurer = useMutation({
    mutationFn: async (id: string) => {
      if (!supabase) {
        const i = sampleInsurers.findIndex((x) => x.id === id)
        if (i >= 0) sampleInsurers.splice(i, 1)
        return
      }
      const { error } = await supabase.rpc('delete_payer', { p_id: id })
      if (error) throw new Error(error.message)
    },
    onSuccess: refresh,
  })

  /** Raise or lower every cash price (or one group) at once. Returns how many changed. */
  const adjustPrices = useMutation({
    mutationFn: async (input: {
      group: ServiceGroup | null
      mode: 'multiply' | 'percent' | 'amount'
      value: number
      round: number
    }): Promise<number> => {
      if (!supabase) {
        let n = 0
        for (const t of sampleTreatments) {
          if (t.cashPrice == null || t.cashPrice <= 0) continue
          if (input.group && t.group !== input.group) continue
          const raw =
            input.mode === 'multiply'
              ? t.cashPrice * input.value
              : input.mode === 'percent'
                ? (t.cashPrice * (100 + input.value)) / 100
                : t.cashPrice + input.value
          const next = Math.max(0, Math.round(raw / input.round) * input.round)
          if (next !== t.cashPrice) {
            t.cashPrice = next
            n++
          }
        }
        return n
      }
      const { data, error } = await supabase.rpc('adjust_prices', {
        p_group: input.group,
        p_mode: input.mode,
        p_value: input.value,
        p_round: input.round,
      })
      if (error) throw new Error(error.message)
      return Number(data)
    },
    onSuccess: refresh,
  })

  return {
    saveTreatment,
    saveInsurer,
    deleteTreatment,
    setTreatmentActive,
    deleteInsurer,
    adjustPrices,
  }
}

/**
 * A treatment's name in the interface language: Kinyarwanda or French when the manager entered
 * one, otherwise the English name (which is always there).
 */
export function treatmentName(x: Pick<Treatment, 'nameEn' | 'nameKin' | 'nameFr'>, lang: string) {
  if (lang.startsWith('rw') || lang.startsWith('kin')) return x.nameKin || x.nameEn
  if (lang.startsWith('fr')) return x.nameFr || x.nameEn
  return x.nameEn
}

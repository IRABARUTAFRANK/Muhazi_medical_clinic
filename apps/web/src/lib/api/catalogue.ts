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

/** How the treatments of a category behave (fixed): charged on the visit, orderable lab test,
 *  orderable imaging test, or bed stay (built in). */
export const CATEGORY_KINDS = ['treatment', 'lab', 'imaging', 'bed'] as const
export type CategoryKind = (typeof CATEGORY_KINDS)[number]

/** A treatment category the clinic manages itself (Prices → Categories). */
export interface Category {
  id: string
  nameEn: string
  nameKin: string | null
  nameFr: string | null
  kind: CategoryKind
  /** The former fixed group it started as (null = one the clinic created). */
  baseGroup: ServiceGroup | null
}

/** The internal group of a category's treatments, derived the same way as in the database. */
export function groupOfCategory(c: Pick<Category, 'kind' | 'baseGroup'>): ServiceGroup {
  if (c.kind !== 'treatment') return c.kind
  return c.baseGroup && !['lab', 'imaging', 'bed'].includes(c.baseGroup) ? c.baseGroup : 'other'
}

/** The category's name in the interface language (English when not given). */
export function categoryName(c: Pick<Category, 'nameEn' | 'nameKin' | 'nameFr'>, lang: string) {
  return (lang === 'rw' ? c.nameKin : lang === 'fr' ? c.nameFr : null) || c.nameEn
}

const BUILT_IN: [ServiceGroup, string, string, string, CategoryKind][] = [
  [
    'consultation',
    'Consultation & treatments',
    'Gusuzuma no kuvura',
    'Consultation et traitements',
    'treatment',
  ],
  ['dental', 'Dental', 'Amenyo', 'Dentaire', 'treatment'],
  ['lab', 'Laboratory', 'Ibizamini', 'Laboratoire', 'lab'],
  ['imaging', 'Ultrasound / imaging', 'Ekografi / amafoto', 'Échographie / imagerie', 'imaging'],
  [
    'procedure',
    'Minor surgery & procedures',
    "Kubaga byoroheje n'ibindi bikorwa",
    'Petite chirurgie et actes',
    'treatment',
  ],
  ['nursing', 'Nursing care', 'Kwita ku barwayi', 'Soins infirmiers', 'treatment'],
  ['bed', 'Beds & observation', 'Ibitanda no gukurikiranwa', 'Lits et observation', 'bed'],
  ['registration', 'Registration', 'Kwandikwa', 'Enregistrement', 'treatment'],
  ['pharmacy', 'Pharmacy', 'Farumasi', 'Pharmacie', 'treatment'],
  ['other', 'Other', 'Ibindi', 'Autre', 'treatment'],
]
/** The ten starting categories: sample mode, and a database before migration 0049. Their ids
 *  carry the group ("group:lab") so nothing is sent to functions that do not exist yet. */
const builtInCategories = (): Category[] =>
  BUILT_IN.map(([g, nameEn, nameKin, nameFr, kind]) => ({
    id: `group:${g}`,
    nameEn,
    nameKin,
    nameFr,
    kind,
    baseGroup: g,
  }))
/** "group:lab" → "lab"; a real category id → null. */
export const builtInGroup = (categoryId: string): ServiceGroup | null =>
  categoryId.startsWith('group:') ? (categoryId.slice(6) as ServiceGroup) : null

const sampleCategories: Category[] = builtInCategories()
const CATEGORIES = ['catalogue', 'categories'] as const

export function useCategories() {
  return useQuery({
    queryKey: CATEGORIES,
    queryFn: async (): Promise<Category[]> => {
      if (!supabase) return [...sampleCategories]
      const { data, error } = await supabase
        .from('service_category')
        .select('id, name_en, name_kin, name_fr, kind, base_group')
        .is('deleted_at', null)
        .order('sort')
        .order('name_en')
      if (error) return builtInCategories()
      return (
        data as {
          id: string
          name_en: string
          name_kin: string | null
          name_fr: string | null
          kind: CategoryKind
          base_group: ServiceGroup | null
        }[]
      ).map((r) => ({
        id: r.id,
        nameEn: r.name_en,
        nameKin: r.name_kin,
        nameFr: r.name_fr,
        kind: r.kind,
        baseGroup: r.base_group,
      }))
    },
  })
}

export function useCategoryActions() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['catalogue'] })
  const save = useMutation({
    mutationFn: async (input: {
      id?: string
      nameEn: string
      nameKin?: string
      nameFr?: string
      kind: CategoryKind
    }): Promise<string> => {
      if (!supabase) {
        const existing = input.id ? sampleCategories.find((c) => c.id === input.id) : undefined
        if (
          sampleCategories.some(
            (c) =>
              c.id !== input.id && c.nameEn.toLowerCase() === input.nameEn.trim().toLowerCase(),
          )
        )
          throw new Error('a category with this name already exists')
        const c: Category = {
          id: existing?.id ?? `cat-${Math.random().toString(36).slice(2, 8)}`,
          nameEn: input.nameEn.trim(),
          nameKin: input.nameKin?.trim() || null,
          nameFr: input.nameFr?.trim() || null,
          kind: input.kind,
          baseGroup: existing?.baseGroup ?? null,
        }
        if (existing) Object.assign(existing, c)
        else sampleCategories.push(c)
        for (const t of sampleTreatments) if (t.categoryId === c.id) t.group = groupOfCategory(c)
        return c.id
      }
      const { data, error } = await supabase.rpc('save_category', {
        p_id: input.id ?? null,
        p_name_en: input.nameEn.trim(),
        p_name_kin: input.nameKin?.trim() || null,
        p_name_fr: input.nameFr?.trim() || null,
        p_kind: input.kind,
      })
      if (error) throw new Error(error.message)
      return String(data)
    },
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: async (id: string) => {
      if (!supabase) {
        const n = sampleTreatments.filter((t) => t.categoryId === id).length
        if (n > 0) throw new Error(`this category still has ${n} treatment(s)`)
        const i = sampleCategories.findIndex((c) => c.id === id)
        if (i >= 0) sampleCategories.splice(i, 1)
        return
      }
      const { error } = await supabase.rpc('delete_category', { p_id: id })
      if (error) throw new Error(error.message)
    },
    onSuccess: refresh,
  })
  return { save, remove }
}

/** `payer_type` enum, without cash. */
export const PAYER_TYPES = ['rssb_rama', 'cbhi', 'mmi', 'private', 'employer'] as const
export type PayerType = (typeof PAYER_TYPES)[number]

export interface Treatment {
  id: string
  code: string
  nameEn: string
  nameKin: string | null
  nameFr: string | null
  /** Internal group, derived from the category (tests, beds, insurers rely on it). */
  group: ServiceGroup
  /** The clinic's category ("group:lab" for a starting category before migration 0049). */
  categoryId: string
  bookingCategory: CategoryId | null
  cashPrice: number | null
  /** Insurer-specific prices by payer id. */
  payerPrices: Record<string, number>
  maxDiscountPct: number
  allowManualPrice: boolean
  active: boolean
  /** Main department (the first of departmentIds; null = none yet). */
  departmentId: string | null
  departmentName: string | null
  /** Every department that gives this treatment (empty = none yet). */
  departmentIds: string[]
  departmentNames: string[]
}

export interface TreatmentInput {
  id?: string
  code?: string
  nameEn: string
  nameKin?: string
  nameFr?: string
  group: ServiceGroup
  /** The category chosen (its group is passed as `group`). */
  categoryId?: string
  bookingCategory?: CategoryId | null
  cashPrice: number
  maxDiscountPct: number
  allowManualPrice: boolean
  active: boolean
  /** Insurer prices to set with the treatment; empty string = use the cash price. */
  payerPrices?: Record<string, string>
  /** Departments that give it (first = main); undefined = leave as they are. */
  departmentIds?: string[]
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
    categoryId: 'group:consultation',
    bookingCategory: 'consultation',
    cashPrice: 8000,
    payerPrices: {},
    maxDiscountPct: 10,
    allowManualPrice: false,
    active: true,
    departmentId: null,
    departmentName: null,
    departmentIds: [],
    departmentNames: [],
  },
  {
    id: 't-2',
    code: 'TRT-0001',
    nameEn: 'Malaria treatment (uncomplicated)',
    nameKin: 'Kuvura malariya',
    nameFr: 'Traitement du paludisme simple',
    group: 'consultation',
    categoryId: 'group:consultation',
    bookingCategory: null,
    cashPrice: 12000,
    payerPrices: {},
    maxDiscountPct: 20,
    allowManualPrice: false,
    active: true,
    departmentId: null,
    departmentName: null,
    departmentIds: [],
    departmentNames: [],
  },
  {
    id: 't-3',
    code: 'LAB-MRDT',
    nameEn: 'Malaria RDT',
    nameKin: null,
    nameFr: 'TDR paludisme',
    group: 'lab',
    categoryId: 'group:lab',
    bookingCategory: 'laboratory',
    cashPrice: 2500,
    payerPrices: {},
    maxDiscountPct: 0,
    allowManualPrice: false,
    active: true,
    departmentId: null,
    departmentName: null,
    departmentIds: [],
    departmentNames: [],
  },
  {
    id: 't-4',
    code: 'DEN-EXT',
    nameEn: 'Tooth extraction',
    nameKin: 'Gukura iryinyo',
    nameFr: 'Extraction dentaire',
    group: 'dental',
    categoryId: 'group:dental',
    bookingCategory: 'dental',
    cashPrice: 15000,
    payerPrices: {},
    maxDiscountPct: 10,
    allowManualPrice: false,
    active: true,
    departmentId: null,
    departmentName: null,
    departmentIds: [],
    departmentNames: [],
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
  department_id?: string | null
  department_name?: string | null
  department_ids?: string[] | null
  department_names?: string[] | null
  category_id?: string | null
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
        categoryId: r.category_id ?? `group:${r.service_group}`,
        bookingCategory: r.booking_category,
        cashPrice: r.cash_price == null ? null : Number(r.cash_price),
        payerPrices: Object.fromEntries(
          Object.entries(r.payer_prices ?? {}).map(([k, v]) => [k, Number(v)]),
        ),
        maxDiscountPct: Number(r.max_discount_pct),
        allowManualPrice: r.allow_manual_price,
        active: r.active,
        departmentId: r.department_id ?? null,
        departmentName: r.department_name ?? null,
        // Before migration 0048 only the main department exists.
        departmentIds: r.department_ids ?? (r.department_id ? [r.department_id] : []),
        departmentNames: r.department_names ?? (r.department_name ? [r.department_name] : []),
      }))
    },
  })
}

/** What each treatment was billed between two days: count and amount, by service id. */
export type ServiceBilling = Record<string, { count: number; amount: number }>

export function useServiceBilling(from: string, to: string) {
  return useQuery({
    queryKey: ['catalogue', 'billing', from, to],
    queryFn: async (): Promise<ServiceBilling> => {
      if (!supabase)
        return Object.fromEntries(
          sampleTreatments.map((t, i) => [
            t.id,
            { count: 3 + i * 4, amount: (3 + i * 4) * (t.cashPrice ?? 0) },
          ]),
        )
      const { data, error } = await supabase.rpc('service_billing', { p_from: from, p_to: to })
      if (error) throw new Error(error.message)
      return Object.fromEntries(
        Object.entries(
          (data ?? {}) as Record<string, { count: number; amount: number | string }>,
        ).map(([k, v]) => [k, { count: Number(v.count), amount: Number(v.amount) }]),
      )
    },
    staleTime: 60_000,
  })
}

// ---------------------------------------------------------------- manager tools
export function useCatalogueTools() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['catalogue'] })
  const bulkAdd = useMutation({
    mutationFn: async (input: {
      departmentId: string | null
      items: {
        name_en: string
        name_kin?: string
        name_fr?: string
        price: number
        group: ServiceGroup
        /** A category the clinic created (omit for a starting one). */
        category?: string
      }[]
    }): Promise<number> => {
      if (!supabase) {
        for (const x of input.items)
          sampleTreatments.push({
            id: `t-${Math.random().toString(36).slice(2, 8)}`,
            code: `TRT-${String(sampleTreatments.length + 1).padStart(4, '0')}`,
            nameEn: x.name_en,
            nameKin: x.name_kin || null,
            nameFr: x.name_fr || null,
            group: x.group,
            categoryId: x.category ?? `group:${x.group}`,
            bookingCategory: null,
            cashPrice: x.price,
            payerPrices: {},
            maxDiscountPct: 0,
            allowManualPrice: false,
            active: true,
            departmentId: input.departmentId,
            departmentName: null,
            departmentIds: input.departmentId ? [input.departmentId] : [],
            departmentNames: [],
          })
        return input.items.length
      }
      const { data, error } = await supabase.rpc('bulk_add_services', {
        p_department_id: input.departmentId,
        p_items: input.items,
      })
      if (error) throw new Error(error.message)
      return Number(data)
    },
    onSuccess: refresh,
  })
  const moveGroup = useMutation({
    mutationFn: async (input: {
      group: ServiceGroup
      departmentId: string | null
    }): Promise<number> => {
      if (!supabase) {
        let n = 0
        for (const t of sampleTreatments)
          if (t.group === input.group) {
            t.departmentId = input.departmentId
            t.departmentIds = input.departmentId ? [input.departmentId] : []
            n++
          }
        return n
      }
      const { data, error } = await supabase.rpc('move_group_to_department', {
        p_group: input.group,
        p_department_id: input.departmentId,
      })
      if (error) throw new Error(error.message)
      return Number(data)
    },
    onSuccess: refresh,
  })
  const deleteAll = useMutation({
    mutationFn: async (): Promise<number> => {
      if (!supabase) {
        const n = sampleTreatments.length
        sampleTreatments.splice(0, n)
        return n
      }
      const { data, error } = await supabase.rpc('delete_all_services')
      if (error) throw new Error(error.message)
      return Number(data)
    },
    onSuccess: refresh,
  })
  /** Every treatment of a category into a department. */
  const moveCategory = useMutation({
    mutationFn: async (input: {
      categoryId: string
      departmentId: string | null
    }): Promise<number> => {
      const group = builtInGroup(input.categoryId)
      if (!supabase || group) {
        if (!supabase) {
          let n = 0
          for (const t of sampleTreatments)
            if (t.categoryId === input.categoryId) {
              t.departmentId = input.departmentId
              t.departmentIds = input.departmentId ? [input.departmentId] : []
              n++
            }
          return n
        }
        return moveGroup.mutateAsync({ group: group!, departmentId: input.departmentId })
      }
      const { data, error } = await supabase.rpc('move_category_to_department', {
        p_category_id: input.categoryId,
        p_department_id: input.departmentId,
      })
      if (error) throw new Error(error.message)
      return Number(data)
    },
    onSuccess: refresh,
  })
  return { bulkAdd, moveGroup, moveCategory, deleteAll }
}

// ---------------------------------------------------------------- medicines and supplies
export interface Medicine {
  id: string
  code: string
  name: string
  strength: string | null
  form: string | null
  unit: string | null
  cashPrice: number | null
  active: boolean
}
const sampleMedicines: Medicine[] = [
  {
    id: 'it-1',
    code: 'AMOX500',
    name: 'Amoxicillin',
    strength: '500 mg',
    form: 'capsule',
    unit: 'cap',
    cashPrice: 300,
    active: true,
  },
  {
    id: 'it-2',
    code: 'PARA500',
    name: 'Paracetamol',
    strength: '500 mg',
    form: 'tablet',
    unit: 'tab',
    cashPrice: 50,
    active: true,
  },
  {
    id: 'it-3',
    code: 'AL20120',
    name: 'Artemether-lumefantrine',
    strength: '20/120 mg',
    form: 'tablet',
    unit: 'tab',
    cashPrice: 500,
    active: true,
  },
]
const MEDS = ['catalogue', 'medicines'] as const

/** Every medicine and supply (also the hidden ones), with the cash price. */
export function useMedicines() {
  return useQuery({
    queryKey: MEDS,
    queryFn: async (): Promise<Medicine[]> => {
      if (!supabase) return sampleMedicines
      const { data, error } = await supabase
        .from('items_catalogue')
        .select('id, code, name_generic, strength, form, unit, cash_price, active')
        .order('name_generic')
      if (error) throw new Error(error.message)
      return (
        data as {
          id: string
          code: string
          name_generic: string
          strength: string | null
          form: string | null
          unit: string | null
          cash_price: number | string | null
          active: boolean
        }[]
      ).map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name_generic,
        strength: r.strength,
        form: r.form,
        unit: r.unit,
        cashPrice: r.cash_price == null ? null : Number(r.cash_price),
        active: r.active,
      }))
    },
  })
}

export function useMedicineActions() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['catalogue'] })
  const save = useMutation({
    mutationFn: async (m: {
      id?: string
      name: string
      strength: string
      form: string
      unit: string
      price: number
      active: boolean
    }): Promise<string> => {
      if (!supabase) {
        const existing = m.id ? sampleMedicines.find((x) => x.id === m.id) : undefined
        const row: Medicine = {
          id: existing?.id ?? `it-${Math.random().toString(36).slice(2, 8)}`,
          code: existing?.code ?? `MED-${String(sampleMedicines.length + 1).padStart(4, '0')}`,
          name: m.name.trim(),
          strength: m.strength.trim() || null,
          form: m.form.trim() || null,
          unit: m.unit.trim() || null,
          cashPrice: m.price,
          active: m.active,
        }
        if (existing) Object.assign(existing, row)
        else sampleMedicines.push(row)
        return row.id
      }
      const { data, error } = await supabase.rpc('upsert_item', {
        p_id: m.id ?? null,
        p_name: m.name.trim(),
        p_price: m.price,
        p_strength: m.strength.trim() || null,
        p_form: m.form.trim() || null,
        p_unit: m.unit.trim() || null,
        p_active: m.active,
        p_code: null,
      })
      if (error) throw new Error(error.message)
      return String(data)
    },
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: async (id: string) => {
      if (!supabase) {
        const i = sampleMedicines.findIndex((x) => x.id === id)
        if (i >= 0) sampleMedicines.splice(i, 1)
        return
      }
      const { error } = await supabase.rpc('delete_item', { p_id: id })
      if (error) throw new Error(error.message)
    },
    onSuccess: refresh,
  })
  return { save, remove }
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
          categoryId: input.categoryId ?? `group:${input.group}`,
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
          departmentId:
            input.departmentIds !== undefined
              ? (input.departmentIds[0] ?? null)
              : (existing?.departmentId ?? null),
          departmentName: null,
          departmentIds: input.departmentIds ?? existing?.departmentIds ?? [],
          departmentNames: [],
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
      if (input.categoryId && !builtInGroup(input.categoryId)) {
        const { error: ce } = await supabase.rpc('set_service_category', {
          p_service_id: id,
          p_category_id: input.categoryId,
        })
        if (ce) throw new Error(ce.message)
      }
      if (input.departmentIds !== undefined) {
        const { error: de } = await supabase.rpc('set_service_departments', {
          p_service_id: id,
          p_department_ids: input.departmentIds,
        })
        if (de && /set_service_departments/.test(de.message)) {
          // Database without migration 0048 yet: only the main department can be kept.
          const { error: one } = await supabase.rpc('set_service_department', {
            p_service_id: id,
            p_department_id: input.departmentIds[0] ?? null,
          })
          if (one) throw new Error(one.message)
        } else if (de) throw new Error(de.message)
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
      /** A category id ("group:x" for a starting one before migration 0049); null = all. */
      category: string | null
      mode: 'multiply' | 'percent' | 'amount'
      value: number
      round: number
    }): Promise<number> => {
      if (!supabase) {
        let n = 0
        for (const t of sampleTreatments) {
          if (t.cashPrice == null || t.cashPrice <= 0) continue
          if (input.category && t.categoryId !== input.category) continue
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
      const group = input.category ? builtInGroup(input.category) : null
      const { data, error } = await supabase.rpc('adjust_prices', {
        p_group: group,
        p_mode: input.mode,
        p_value: input.value,
        p_round: input.round,
        ...(input.category && !group ? { p_category_id: input.category } : {}),
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

import i18n from '@/i18n'
import { supabase } from '@/lib/supabase'
import type { ReportContext, ReportFilterValues, ReportOption } from '@/lib/reports/defs/types'
import { ApiError, apiError, isMissingFunction } from './errors'
import { sampleAccess } from './analytics-sample'

/**
 * Shared pieces of the report centre's finance and staff loaders (migration 0111):
 *
 * - reportRpc: one report function, its rows; a database older than 0111 gives a clear
 *   "needs the latest database update" error instead of a raw PGRST202.
 * - reportFilterOptions: report_filter_options() once per person (cashiers, staff,
 *   departments, insurers, stores, categories), within their rights; sample choices in sample
 *   mode.
 * - the filter readers (select, multi, text, toggle) and a search over several fields.
 */

// ------------------------------------------------------------------ calling a report function

/** Calls a database function for a report: its answer, or a clear error when the database is
 *  older than the function (PGRST202). */
export async function reportCall(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await supabase!.rpc(fn, args)
  if (error) {
    if (isMissingFunction(error))
      throw new ApiError(i18n.t('financeReports.needsUpdate'), {
        code: 'PGRST202',
        hint: null,
        kind: null,
        line: null,
        serverMessage: error.message ?? fn,
      })
    throw apiError(error)
  }
  return data
}

/** Calls a report function (0111) and returns its `rows` (and the whole answer). */
export async function reportRpc<T = Record<string, unknown>>(
  fn: string,
  args: Record<string, unknown>,
): Promise<{ rows: T[]; data: Record<string, unknown> }> {
  const d = ((await reportCall(fn, args)) ?? {}) as Record<string, unknown>
  return { rows: (Array.isArray(d.rows) ? d.rows : []) as T[], data: d }
}

// ------------------------------------------------------------------ the filters' choices

export interface ReportFilterChoices {
  cashiers: { id: string; name: string }[]
  staff: { id: string; name: string; role: string; active: boolean }[]
  departments: { id: string; name: string }[]
  insurers: { id: string; name: string }[]
  stores: { id: string; name: string; roomStore: boolean }[]
  categories: { id: string; key: string; nameEn: string; nameKin: string; nameFr: string }[]
}

const EMPTY: ReportFilterChoices = {
  cashiers: [],
  staff: [],
  departments: [],
  insurers: [],
  stores: [],
  categories: [],
}

/** Sample mode: the clinic of the analytics sample. */
export const SAMPLE_CHOICES: ReportFilterChoices = {
  cashiers: [
    { id: 'p-cash2', name: 'Iradukunda Grace' },
    { id: 'u-cash', name: 'Mugisha Samuel' },
    { id: 'p-pha', name: 'Mutoni Aline' },
  ],
  staff: [],
  departments: [],
  insurers: [
    { id: 'payer-mmi', name: 'MMI' },
    { id: 'payer-mutuelle', name: 'Mutuelle de Santé' },
    { id: 'payer-rama', name: 'RSSB RAMA' },
  ],
  stores: [
    { id: 'store-pharmacy', name: 'Pharmacy', roomStore: false },
    { id: 'store-dental', name: 'Dental room', roomStore: true },
  ],
  categories: [
    {
      id: 'cat-cons',
      key: 'consultation',
      nameEn: 'Consultation',
      nameKin: 'Gusuzumwa',
      nameFr: 'Consultation',
    },
    {
      id: 'cat-lab',
      key: 'laboratory',
      nameEn: 'Laboratory',
      nameKin: 'Laboratwari',
      nameFr: 'Laboratoire',
    },
    {
      id: 'cat-img',
      key: 'imaging',
      nameEn: 'Ultrasound',
      nameKin: 'Ekografi',
      nameFr: 'Échographie',
    },
    {
      id: 'cat-nur',
      key: 'nursing',
      nameEn: 'Nursing care',
      nameKin: 'Ubuforomo',
      nameFr: 'Soins infirmiers',
    },
    { id: 'cat-den', key: 'dental', nameEn: 'Dental', nameKin: 'Amenyo', nameFr: 'Dentaire' },
    {
      id: 'cat-sur',
      key: 'procedure',
      nameEn: 'Minor surgery',
      nameKin: 'Kubaga gutoya',
      nameFr: 'Petite chirurgie',
    },
  ],
}

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

const cache = new Map<string, { at: number; value: Promise<ReportFilterChoices> }>()
const FRESH_MS = 5 * 60_000

/** The filters' choices for this person (asked once every five minutes). */
export function reportFilterOptions(ctx: ReportContext): Promise<ReportFilterChoices> {
  if (ctx.sample) return Promise.resolve(sampleChoices(ctx))
  const key = ctx.user.id
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.value
  const value = (async (): Promise<ReportFilterChoices> => {
    const { data, error } = await supabase!.rpc('report_filter_options')
    if (error) {
      if (isMissingFunction(error)) return EMPTY
      throw apiError(error)
    }
    const d = (data ?? {}) as Record<string, unknown>
    return {
      cashiers: list(d.cashiers),
      staff: list(d.staff),
      departments: list(d.departments),
      insurers: list(d.insurers),
      stores: list(d.stores),
      categories: list(d.categories),
    }
  })()
  cache.set(key, { at: Date.now(), value })
  value.catch(() => cache.delete(key))
  return value
}

function sampleChoices(ctx: ReportContext): ReportFilterChoices {
  const access = sampleAccess(ctx.user)
  const all = ctx.isManager || ctx.can('billing.read')
  return {
    ...SAMPLE_CHOICES,
    cashiers: all
      ? SAMPLE_CHOICES.cashiers
      : SAMPLE_CHOICES.cashiers.filter((c) => c.id === ctx.user.id),
    departments: access.departments.map(({ id, name }) => ({ id, name })),
  }
}

/** The category's name in the person's language. */
export const categoryName = (c: {
  nameEn?: string | null
  nameKin?: string | null
  nameFr?: string | null
}) => {
  const lang = i18n.language
  return (lang === 'rw' ? c.nameKin : lang === 'fr' ? c.nameFr : c.nameEn) || c.nameEn || ''
}

/** Options of id and name, already in words. */
export const toOptions = (xs: { id: string; name: string }[]): ReportOption[] =>
  xs.map((x) => ({ value: x.id, label: x.name }))

/** Options whose label is an i18n key. */
export const keyOptions = (prefix: string, values: readonly string[]): ReportOption[] =>
  values.map((v) => ({ value: v, label: `${prefix}.${v}`, labelIsKey: true }))

// ------------------------------------------------------------------ reading the filters

/** A select filter's value ('' or missing = all). */
export const selected = (f: ReportFilterValues, key: string): string | null => {
  const v = f[key]
  return typeof v === 'string' && v !== '' ? v : null
}
/** A multi filter's values (empty = all). */
export const chosen = (f: ReportFilterValues, key: string): string[] => {
  const v = f[key]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}
/** A toggle filter. */
export const switchedOn = (f: ReportFilterValues, key: string): boolean => f[key] === true
/** A text filter, trimmed and lower case ('' = none). */
export const searchText = (f: ReportFilterValues, key = 'search'): string => {
  const v = f[key]
  return typeof v === 'string' ? v.trim().toLowerCase() : ''
}
/** Does any of the fields contain the search words (every word somewhere)? */
export const matches = (q: string, ...fields: (string | null | undefined)[]): boolean => {
  if (!q) return true
  const hay = fields.filter(Boolean).join(' ').toLowerCase()
  return q.split(/\s+/).every((w) => hay.includes(w))
}
/** Keeps the row when the multi filter is empty or holds the value. */
export const inChosen = (values: string[], v: string | null | undefined) =>
  !values.length || (v != null && values.includes(v))

// ------------------------------------------------------------------ who may read the money

/** The pharmacy desk (or the pharmacist) takes the money of its walk-in sales
 *  (pharmacy_takes_money in the database). */
export const pharmacyTakesMoney = (ctx: ReportContext) =>
  ctx.canDesk('pharmacy') || ctx.user.role === 'pharmacist' || ctx.user.dbRole === 'pharmacist'

/** Reads every bill and payment: the manager and billing.read (the cashier, reception). */
export const readsAllMoney = (ctx: ReportContext) => ctx.isManager || ctx.can('billing.read')

/** Sees payments, refunds and cash counts: everyone's (readsAllMoney) or their own. */
export const seesMoney = (ctx: ReportContext) =>
  readsAllMoney(ctx) || ctx.can('payment.take') || pharmacyTakesMoney(ctx)

/** The departments this person heads in sample mode (null: every department). */
export const sampleScopeDepartments = (ctx: ReportContext): string[] | null =>
  readsAllMoney(ctx) ? null : sampleAccess(ctx.user).departments.map((d) => d.id)

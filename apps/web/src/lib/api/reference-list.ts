import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { ReferenceRowInput } from '@/lib/reference-file'
import { sampleReference } from './catalogue'
import i18n from '@/i18n'
import { apiError, isMissingFunction } from './errors'
import { sampleStock } from './stock'

/**
 * The official medicine list (RHIA / RSSB), one version per upload: the manager uploads each new
 * list; the old ones are kept. Its price is the insurers' tariff (insurers that follow the list
 * price medicines from it); the clinic's cash price stays its own.
 * Live: `reference_lists`, `import_reference_list` (dry run = the preview), the clinic's
 * medicines that left the list (`item.reference_removed_at`). Sample: in memory.
 */

export interface ReferenceList {
  id: string
  name: string
  /** yyyy-mm-dd */
  effectiveFrom: string
  rows: number
  uploadedAt: string | null
  /** null: loaded with the system. */
  uploadedBy: string | null
  status: 'current' | 'past'
  /** The list prices follow today (a list starting later is current but not yet in effect). */
  inEffect: boolean
}

export interface ReferenceChange {
  code: string
  generic: string
  presentation: string | null
  old: number | null
  new: number | null
  /** The clinic has a medicine with this code. */
  inClinic: boolean
}
export interface ReferenceRemoved {
  code: string
  generic: string
  presentation: string | null
  inClinic: boolean
}
/** no_code, bad_code, no_generic, bad_price, duplicate, not_a_row */
export interface ReferenceRowError {
  row: number
  code: string
  value: string | null
  message: string
}

/** What import_reference_list answers: the preview (dry run) or what was stored. */
export interface ReferencePreview {
  dryRun: boolean
  id: string | null
  name: string
  effectiveFrom: string
  /** Rows sent / rows kept. */
  total: number
  rows: number
  new: number
  changed: ReferenceChange[]
  removed: ReferenceRemoved[]
  unchanged: number
  errors: ReferenceRowError[]
  current: { name: string; effectiveFrom: string; rows: number } | null
  itemsFlagged: number
  itemsBack: number
}

const KEY = ['catalogue', 'reference-lists'] as const
const NOT_ON_LIST = ['catalogue', 'not-on-list'] as const

// ---------------------------------------------------------------- sample mode
const sampleLists: ReferenceList[] = [
  {
    id: 'rl-june-2026',
    name: 'RHIA June 2026',
    effectiveFrom: '2026-06-01',
    rows: sampleReference.length,
    uploadedAt: null,
    uploadedBy: null,
    status: 'current',
    inEffect: true,
  },
]
/** Codes that left the list (sample): the stock items with these codes are flagged. */
const sampleGone = new Set<string>()

function samplePreview(
  name: string,
  effectiveFrom: string,
  input: ReferenceRowInput[],
  dryRun: boolean,
): ReferencePreview {
  const errors: ReferenceRowError[] = []
  const kept = new Map<string, ReferenceRowInput & { price: number | null }>()
  for (const r of input) {
    const err = !r.code
      ? 'no_code'
      : !r.generic.trim()
        ? 'no_generic'
        : r.price != null && (typeof r.price !== 'number' || r.price < 0)
          ? 'bad_price'
          : kept.has(r.code)
            ? 'duplicate'
            : null
    if (err) errors.push({ row: r.row, code: err, value: r.code || null, message: err })
    else kept.set(r.code, { ...r, price: r.price == null ? null : Math.round(r.price as number) })
  }
  const current = sampleLists.find((l) => l.status === 'current') ?? null
  const old = new Map(sampleReference.map((r) => [r.code, r]))
  const clinic = new Set(sampleStock.items.map((i) => i.code))
  const changed: ReferenceChange[] = []
  let added = 0
  let unchanged = 0
  for (const r of kept.values()) {
    const o = old.get(r.code)
    if (!o) added++
    else if ((o.price ?? null) !== r.price)
      changed.push({
        code: r.code,
        generic: r.generic,
        presentation: r.presentation,
        old: o.price,
        new: r.price,
        inClinic: clinic.has(r.code),
      })
    else unchanged++
  }
  const removed = sampleReference
    .filter((r) => !kept.has(r.code))
    .map((r) => ({
      code: r.code,
      generic: r.generic,
      presentation: r.presentation,
      inClinic: clinic.has(r.code),
    }))
  let flagged = 0
  if (!dryRun) {
    for (const l of sampleLists) {
      l.status = 'past'
      l.inEffect = false
    }
    sampleLists.unshift({
      id: `rl-${Date.now()}`,
      name,
      effectiveFrom,
      rows: kept.size,
      uploadedAt: new Date().toISOString(),
      uploadedBy: 'You',
      status: 'current',
      inEffect: effectiveFrom <= new Date().toISOString().slice(0, 10),
    })
    if (!sampleLists[0]!.inEffect && sampleLists[1]) sampleLists[1].inEffect = true
    for (const r of removed) {
      if (r.inClinic && !sampleGone.has(r.code)) flagged++
      sampleGone.add(r.code)
    }
    for (const code of kept.keys()) sampleGone.delete(code)
    sampleReference.splice(
      0,
      sampleReference.length,
      ...[...kept.values()].map((r) => ({
        code: r.code,
        generic: r.generic,
        presentation: r.presentation,
        rule: r.rule,
        unit: r.unit,
        price: r.price,
        group: r.group,
      })),
    )
  }
  return {
    dryRun,
    id: dryRun ? null : sampleLists[0]!.id,
    name,
    effectiveFrom,
    total: input.length,
    rows: kept.size,
    new: added,
    changed,
    removed,
    unchanged,
    errors,
    current: current
      ? { name: current.name, effectiveFrom: current.effectiveFrom, rows: current.rows }
      : null,
    itemsFlagged: flagged,
    itemsBack: 0,
  }
}

// ---------------------------------------------------------------- reading
const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v))

function toPreview(d: Record<string, unknown>): ReferencePreview {
  const list = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : [])
  const cur = d.current as Record<string, unknown> | null
  return {
    dryRun: d.dryRun !== false,
    id: (d.id as string | null) ?? null,
    name: String(d.name ?? ''),
    effectiveFrom: String(d.effectiveFrom ?? ''),
    total: Number(d.total ?? 0),
    rows: Number(d.rows ?? 0),
    new: Number(d.new ?? 0),
    changed: list<Record<string, unknown>>(d.changed).map((c) => ({
      code: String(c.code),
      generic: String(c.generic ?? ''),
      presentation: (c.presentation as string | null) ?? null,
      old: num(c.old),
      new: num(c.new),
      inClinic: !!c.inClinic,
    })),
    removed: list<Record<string, unknown>>(d.removed).map((c) => ({
      code: String(c.code),
      generic: String(c.generic ?? ''),
      presentation: (c.presentation as string | null) ?? null,
      inClinic: !!c.inClinic,
    })),
    unchanged: Number(d.unchanged ?? 0),
    errors: list<Record<string, unknown>>(d.errors).map((e) => ({
      row: Number(e.row ?? 0),
      code: String(e.code ?? ''),
      value: (e.value as string | null) ?? null,
      message: String(e.message ?? ''),
    })),
    current: cur
      ? {
          name: String(cur.name ?? ''),
          effectiveFrom: String(cur.effectiveFrom ?? ''),
          rows: Number(cur.rows ?? 0),
        }
      : null,
    itemsFlagged: Number(d.itemsFlagged ?? 0),
    itemsBack: Number(d.itemsBack ?? 0),
  }
}

/** The uploaded lists: the current one first, then the past ones. */
export function useReferenceLists(enabled = true) {
  return useQuery({
    queryKey: KEY,
    enabled,
    queryFn: async (): Promise<ReferenceList[]> => {
      if (!supabase) return sampleLists.map((l) => ({ ...l }))
      const { data, error } = await supabase.rpc('reference_lists')
      // the website can run ahead of the database (0098 not applied yet): say so plainly
      if (error && isMissingFunction(error)) throw new Error(i18n.t('analytics.needsUpdate'))
      if (error) throw apiError(error)
      return ((data ?? []) as Record<string, unknown>[]).map((l) => ({
        id: String(l.id),
        name: String(l.name ?? ''),
        effectiveFrom: String(l.effectiveFrom ?? ''),
        rows: Number(l.rows ?? 0),
        uploadedAt: (l.uploadedAt as string | null) ?? null,
        uploadedBy: (l.uploadedBy as string | null) ?? null,
        status: l.status === 'past' ? 'past' : 'current',
        inEffect: !!l.inEffect,
      }))
    },
  })
}

/**
 * The clinic's medicines whose code is no longer on the current official list (no insurer list
 * price): their item ids. Empty on a database without the list versions.
 */
export function useNotOnList(enabled = true) {
  return useQuery({
    queryKey: NOT_ON_LIST,
    enabled,
    staleTime: 600_000,
    queryFn: async (): Promise<Set<string>> => {
      if (!supabase)
        return new Set(sampleStock.items.filter((i) => sampleGone.has(i.code)).map((i) => i.id))
      const { data, error } = await supabase
        .from('item')
        .select('id')
        .not('reference_removed_at', 'is', null)
        .is('deleted_at', null)
      // an older database (no column) or a reader without the catalogue: nothing to flag
      if (error) return new Set<string>()
      return new Set(((data ?? []) as { id: string }[]).map((r) => r.id))
    },
  })
}

// ---------------------------------------------------------------- the upload
export interface ReferenceImportInput {
  name: string
  /** yyyy-mm-dd */
  effectiveFrom: string
  rows: ReferenceRowInput[]
}

/** The rows as import_reference_list reads them. */
const payload = (rows: ReferenceRowInput[]) =>
  rows.map((r) => ({
    row: r.row,
    code: r.code,
    generic: r.generic,
    presentation: r.presentation,
    prescribing_rule: r.rule,
    unit: r.unit,
    price: r.price,
    atc_group: r.group,
  }))

async function runImport(i: ReferenceImportInput, dryRun: boolean): Promise<ReferencePreview> {
  if (!supabase) {
    return samplePreview(i.name.trim(), i.effectiveFrom, i.rows, dryRun)
  }
  const { data, error } = await supabase.rpc('import_reference_list', {
    p_name: i.name.trim(),
    p_effective: i.effectiveFrom,
    p_rows: payload(i.rows),
    p_dry_run: dryRun,
  })
  if (error) throw apiError(error)
  return toPreview((data ?? {}) as Record<string, unknown>)
}

/** Check a list (the preview, nothing stored) and use it (stored as the current list). */
export function useReferenceImport() {
  const qc = useQueryClient()
  const check = useMutation({ mutationFn: (i: ReferenceImportInput) => runImport(i, true) })
  const apply = useMutation({
    mutationFn: (i: ReferenceImportInput) => runImport(i, false),
    onSuccess: () => {
      // the lists, the reference search, the flags on the medicines, the stock's prices
      void qc.invalidateQueries({ queryKey: ['catalogue'] })
      void qc.invalidateQueries({ queryKey: ['stock'] })
    },
  })
  return { check, apply }
}

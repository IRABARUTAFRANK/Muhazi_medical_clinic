import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import i18n from '@/i18n'
import { apiError, isMissingFunction } from './errors'
import {
  sampleInsurers,
  sampleMedicines,
  sampleReference,
  sampleTreatments,
  type ServiceGroup,
} from './catalogue'

/**
 * An insurer's tariff: what it pays for each treatment and medicine (its own price list, the
 * official medicine list when it follows it, or the clinic's cash price), the coverage of each
 * line and the patient / insurer split, the lists uploaded so far, and the upload itself.
 * Live: `insurer_tariff_rows`, `set_insurer_price`, `import_price_list` (dry run = the preview),
 * `start_insurer_tariff`. Sample: an in-memory MMI tariff.
 */

/**
 * Where a price comes from: the insurer's own list, an official / published list, the cash price,
 * none; 'excluded': the insurer's exception says it does not cover the line; 'preauth': it covers
 * it only with its approval (0134).
 */
export type PriceSource = 'tariff' | 'reference' | 'cash' | 'none' | 'excluded' | 'preauth'

/** What to do with a line the insurer has no price for (payer.not_listed_rule). */
export const NOT_LISTED_RULES = ['cash_covered', 'not_covered', 'ask'] as const
export type NotListedRule = (typeof NOT_LISTED_RULES)[number]

export interface TariffRow {
  kind: 'service' | 'item'
  id: string
  code: string
  name: string
  nameFr: string | null
  nameKin: string | null
  group: ServiceGroup
  categoryId: string | null
  cashPrice: number | null
  /** The price the insurer pays on (null: no price at all). */
  price: number | null
  source: PriceSource
  /** The coverage of this line in percent (0 when the rule is not_covered and there is no price). */
  coveragePct: number
  insurerShare: number | null
  patientShare: number | null
  /** The 'ask' rule applies: the line is confirmed with the insurer before it is charged. */
  ask: boolean
  /** 0134: covered only with the insurer's approval (asked before it is charged). */
  preauth?: boolean
  /** 0134: the line's code on the published lists, the list that prices it, the insurer's exception. */
  listCode?: string | null
  list?: string | null
  lineNote?: string | null
  exception?: {
    cover: 'covered' | 'not_covered' | 'preauth'
    price: number | null
    note: string | null
  } | null
}

export interface TariffList {
  id: string
  name: string
  /** yyyy-mm-dd */
  effectiveFrom: string
  effectiveTo: string | null
  rows: number
  createdAt: string | null
  createdBy: string | null
  inEffect: boolean
  future: boolean
}

export interface InsurerTariff {
  payerId: string
  code: string
  name: string
  notListedRule: NotListedRule
  followsReferenceList: boolean
  coveragePct: number
  pctByGroup: Partial<Record<ServiceGroup, number>>
  rows: TariffRow[]
  lists: TariffList[]
}

/** One line of an uploaded tariff, as the file reader hands it over. */
export interface TariffLineInput {
  row: number
  kind: 'service' | 'item' | null
  code: string | null
  name: string | null
  /** A number, or the text as written when it is not one (the database says which row). */
  price: number | string | null
}

/** not_found, ambiguous, bad_price, no_name, duplicate, not_a_row */
export interface TariffUnmatched {
  row: number
  kind: string | null
  code: string | null
  name: string | null
  price: string | null
  reason: string
}

/** What import_price_list answers: the preview (dry run) or what was stored. */
export interface TariffPreview {
  dryRun: boolean
  id: string | null
  payerId: string
  name: string
  effectiveFrom: string
  total: number
  matched: number
  unmatched: TariffUnmatched[]
  new: number
  changed: number
  unchanged: number
  previous: { name: string; effectiveFrom: string; rows: number } | null
  closed: number
  replaced: number
}

export interface TariffImportInput {
  payerId: string
  name: string
  /** yyyy-mm-dd */
  effectiveFrom: string
  lines: TariffLineInput[]
}

const KEY = ['catalogue', 'insurer-tariff'] as const

/** The tariff line of a treatment or a medicine (undefined: not in the tariff, or none loaded). */
export function tariffLine(
  tariff: InsurerTariff | null | undefined,
  pick: { serviceId?: string | null; itemId?: string | null },
): TariffRow | undefined {
  if (!tariff) return undefined
  if (pick.serviceId)
    return tariff.rows.find((r) => r.kind === 'service' && r.id === pick.serviceId)
  if (pick.itemId) return tariff.rows.find((r) => r.kind === 'item' && r.id === pick.itemId)
  return undefined
}

// ---------------------------------------------------------------- sample mode
/** The sample insurers' own prices (MMI has a small tariff), keyed "service:<id>" / "item:<id>". */
const samplePrices = new Map<string, Map<string, number>>([
  [
    'i-3',
    new Map([
      ['service:t-1', 6000],
      ['service:t-2', 10000],
      ['service:t-4', 12000],
      ['item:it-1', 250],
    ]),
  ],
])
const sampleLists = new Map<string, TariffList[]>([
  [
    'i-3',
    [
      {
        id: 'pl-mmi-2026',
        name: 'MMI tariff 2026',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        rows: 4,
        createdAt: '2026-01-05T09:00:00.000Z',
        createdBy: 'Mugabo Théogène',
        inEffect: true,
        future: false,
      },
    ],
  ],
])
const today = () => new Date().toISOString().slice(0, 10)
const sampleKey = (p: { serviceId?: string | null; itemId?: string | null }) =>
  p.serviceId ? `service:${p.serviceId}` : `item:${p.itemId ?? ''}`

function sampleTariff(payerId: string): InsurerTariff {
  const ins = sampleInsurers.find((i) => i.id === payerId)
  if (!ins) throw new Error(i18n.t('apiErrors.notFound'))
  const prices = samplePrices.get(payerId) ?? new Map<string, number>()
  const pct = (group: ServiceGroup) => ins.pctByGroup[group] ?? ins.coveragePct
  const line = (
    kind: 'service' | 'item',
    id: string,
    code: string,
    name: string,
    nameFr: string | null,
    nameKin: string | null,
    group: ServiceGroup,
    categoryId: string | null,
    cashPrice: number | null,
  ): TariffRow => {
    const own = prices.get(`${kind}:${id}`)
    const ref =
      own == null && kind === 'item' && ins.followsReferenceList
        ? (sampleReference.find((r) => r.code === code)?.price ?? null)
        : null
    const price = own ?? ref ?? cashPrice
    const source: PriceSource =
      own != null ? 'tariff' : ref != null ? 'reference' : price != null ? 'cash' : 'none'
    const covered = source === 'cash' && ins.notListedRule === 'not_covered' ? 0 : pct(group)
    const insurer = price == null ? null : Math.round((price * covered) / 100)
    return {
      kind,
      id,
      code,
      name,
      nameFr,
      nameKin,
      group,
      categoryId,
      cashPrice,
      price,
      source,
      coveragePct: covered,
      insurerShare: insurer,
      patientShare: price == null || insurer == null ? null : price - insurer,
      ask: source === 'cash' && ins.notListedRule === 'ask',
    }
  }
  return {
    payerId,
    code: ins.code,
    name: ins.name,
    notListedRule: ins.notListedRule,
    followsReferenceList: ins.followsReferenceList,
    coveragePct: ins.coveragePct,
    pctByGroup: ins.pctByGroup,
    rows: [
      ...sampleTreatments
        .filter((x) => x.active)
        .map((x) =>
          line(
            'service',
            x.id,
            x.code,
            x.nameEn,
            x.nameFr,
            x.nameKin,
            x.group,
            x.categoryId,
            x.cashPrice,
          ),
        ),
      ...sampleMedicines
        .filter((m) => m.active)
        .map((m) =>
          line(
            'item',
            m.id,
            m.code,
            [m.name, m.strength].filter(Boolean).join(' '),
            null,
            null,
            'pharmacy',
            null,
            m.cashPrice,
          ),
        ),
    ],
    lists: (sampleLists.get(payerId) ?? []).map((l) => ({ ...l })),
  }
}

/** Sample mode: the tariff's current list, made today when there is none. */
function sampleCurrentList(payerId: string, name: string): TariffList {
  const lists = sampleLists.get(payerId) ?? []
  let cur = lists.find((l) => l.inEffect)
  if (!cur) {
    cur = {
      id: `pl-${Date.now()}`,
      name,
      effectiveFrom: today(),
      effectiveTo: null,
      rows: 0,
      createdAt: new Date().toISOString(),
      createdBy: 'You',
      inEffect: true,
      future: false,
    }
    lists.unshift(cur)
    sampleLists.set(payerId, lists)
  }
  return cur
}

const norm = (s: string | null | undefined) =>
  (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()

/** Sample mode: the lines matched to the sample treatments and medicines, like the database does. */
function sampleImport(i: TariffImportInput, dryRun: boolean): TariffPreview {
  const ins = sampleInsurers.find((x) => x.id === i.payerId)
  if (!ins) throw new Error(i18n.t('apiErrors.notFound'))
  const prices = samplePrices.get(i.payerId) ?? new Map<string, number>()
  const matched = new Map<string, number>()
  const unmatched: TariffUnmatched[] = []
  for (const l of i.lines) {
    const bad = (reason: string) =>
      unmatched.push({
        row: l.row,
        kind: l.kind,
        code: l.code,
        name: l.name,
        price: l.price == null ? null : String(l.price),
        reason,
      })
    if (typeof l.price !== 'number' || l.price < 0) {
      bad('bad_price')
      continue
    }
    const code = (l.code ?? '').replace(/\s+/g, '').toUpperCase()
    const name = norm(l.name)
    let key: string | null = null
    if (l.kind !== 'item') {
      const s =
        sampleTreatments.find((x) => code && x.code.toUpperCase() === code) ??
        sampleTreatments.find(
          (x) =>
            name &&
            (norm(x.nameEn) === name || norm(x.nameFr) === name || norm(x.nameKin) === name),
        )
      if (s) key = `service:${s.id}`
    }
    if (!key && l.kind !== 'service') {
      const m =
        sampleMedicines.find((x) => code && x.code.toUpperCase() === code) ??
        sampleMedicines.find(
          (x) => name && (norm(x.name) === name || norm(`${x.name} ${x.strength ?? ''}`) === name),
        )
      if (m) key = `item:${m.id}`
    }
    if (!key) bad(!code && !name ? 'no_name' : 'not_found')
    else if (matched.has(key)) bad('duplicate')
    else matched.set(key, Math.round(l.price))
  }
  let added = 0
  let changed = 0
  let unchanged = 0
  for (const [k, p] of matched) {
    const cur = prices.get(k)
    if (cur == null) added++
    else if (cur !== p) changed++
    else unchanged++
  }
  const lists = sampleLists.get(i.payerId) ?? []
  const previous = lists.find((l) => l.inEffect) ?? null
  let closed = 0
  let replaced = 0
  let id: string | null = null
  if (!dryRun) {
    if (matched.size === 0) throw new Error(i18n.t('prices.tariff.err.noneMatched'))
    for (const l of lists) {
      if (l.effectiveFrom < i.effectiveFrom) {
        if (!l.effectiveTo || l.effectiveTo >= i.effectiveFrom) closed++
        l.effectiveTo = l.effectiveTo && l.effectiveTo < i.effectiveFrom ? l.effectiveTo : null
        l.inEffect = false
        l.future = false
      }
    }
    const kept = lists.filter((l) => l.effectiveFrom < i.effectiveFrom)
    replaced = lists.length - kept.length
    id = `pl-${Date.now()}`
    const inEffect = i.effectiveFrom <= today()
    kept.unshift({
      id,
      name: i.name,
      effectiveFrom: i.effectiveFrom,
      effectiveTo: null,
      rows: matched.size,
      createdAt: new Date().toISOString(),
      createdBy: 'You',
      inEffect,
      future: !inEffect,
    })
    if (!inEffect && kept[1]) kept[1].inEffect = true
    sampleLists.set(i.payerId, kept)
    // the sample prices follow the new list at once
    samplePrices.set(i.payerId, matched)
  }
  return {
    dryRun,
    id,
    payerId: i.payerId,
    name: i.name,
    effectiveFrom: i.effectiveFrom,
    total: i.lines.length,
    matched: matched.size,
    unmatched,
    new: added,
    changed,
    unchanged,
    previous: previous
      ? { name: previous.name, effectiveFrom: previous.effectiveFrom, rows: previous.rows }
      : null,
    closed,
    replaced,
  }
}

// ---------------------------------------------------------------- reading
const num = (v: unknown): number | null =>
  v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v)
const str = (v: unknown): string | null => (v == null ? null : String(v))

const SOURCES: readonly PriceSource[] = [
  'tariff',
  'reference',
  'cash',
  'none',
  'excluded',
  'preauth',
]
const COVERS = ['covered', 'not_covered', 'preauth'] as const

/** One line as the database gives it (insurer_tariff_rows, payer_lines), every source kept. */
function toTariffRow(r: Record<string, unknown>): TariffRow {
  const ex = r.exception as Record<string, unknown> | null | undefined
  return {
    kind: r.kind === 'item' ? 'item' : 'service',
    id: String(r.id),
    code: String(r.code ?? ''),
    name: String(r.name ?? ''),
    nameFr: str(r.nameFr),
    nameKin: str(r.nameKin),
    group: String(r.group ?? 'other') as ServiceGroup,
    categoryId: str(r.categoryId),
    cashPrice: num(r.cashPrice),
    price: num(r.price),
    // excluded / preauth: the insurer's exception (0134) — said on the visit as such
    source: SOURCES.includes(r.source as PriceSource) ? (r.source as PriceSource) : 'none',
    coveragePct: num(r.coveragePct) ?? 0,
    insurerShare: num(r.insurerShare),
    patientShare: num(r.patientShare),
    ask: !!r.ask,
    preauth: !!r.preauth,
    listCode: str(r.listCode),
    list: str(r.list),
    lineNote: str(r.lineNote),
    exception:
      ex && COVERS.includes(ex.cover as (typeof COVERS)[number])
        ? {
            cover: ex.cover as (typeof COVERS)[number],
            price: num(ex.price),
            note: str(ex.note),
          }
        : null,
  }
}

function toTariff(d: Record<string, unknown>): InsurerTariff {
  const list = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : [])
  return {
    payerId: String(d.payerId ?? ''),
    code: String(d.code ?? ''),
    name: String(d.name ?? ''),
    notListedRule: (NOT_LISTED_RULES as readonly string[]).includes(String(d.notListedRule))
      ? (d.notListedRule as NotListedRule)
      : 'cash_covered',
    followsReferenceList: !!d.followsReferenceList,
    coveragePct: num(d.coveragePct) ?? 0,
    pctByGroup: Object.fromEntries(
      Object.entries((d.pctByGroup ?? {}) as Record<string, unknown>).map(([k, v]) => [
        k,
        Number(v),
      ]),
    ) as Partial<Record<ServiceGroup, number>>,
    rows: list<Record<string, unknown>>(d.rows).map(toTariffRow),
    lists: list<Record<string, unknown>>(d.lists).map((l) => ({
      id: String(l.id),
      name: String(l.name ?? ''),
      effectiveFrom: String(l.effectiveFrom ?? ''),
      effectiveTo: str(l.effectiveTo),
      rows: num(l.rows) ?? 0,
      createdAt: str(l.createdAt),
      createdBy: str(l.createdBy),
      inEffect: !!l.inEffect,
      future: !!l.future,
    })),
  }
}

function toPreview(d: Record<string, unknown>): TariffPreview {
  const list = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : [])
  const prev = d.previous as Record<string, unknown> | null
  return {
    dryRun: d.dryRun !== false,
    id: str(d.id),
    payerId: String(d.payerId ?? ''),
    name: String(d.name ?? ''),
    effectiveFrom: String(d.effectiveFrom ?? ''),
    total: num(d.total) ?? 0,
    matched: num(d.matched) ?? 0,
    unmatched: list<Record<string, unknown>>(d.unmatched).map((u) => ({
      row: num(u.row) ?? 0,
      kind: str(u.kind),
      code: str(u.code),
      name: str(u.name),
      price: str(u.price),
      reason: String(u.reason ?? 'not_found'),
    })),
    new: num(d.new) ?? 0,
    changed: num(d.changed) ?? 0,
    unchanged: num(d.unchanged) ?? 0,
    previous: prev
      ? {
          name: String(prev.name ?? ''),
          effectiveFrom: String(prev.effectiveFrom ?? ''),
          rows: num(prev.rows) ?? 0,
        }
      : null,
    closed: num(d.closed) ?? 0,
    replaced: num(d.replaced) ?? 0,
  }
}

// ---------------------------------------------------------------- the hooks
/** The insurer's tariff: every treatment and medicine with its prices and split, and the lists. */
export function useInsurerTariff(payerId: string | null | undefined) {
  return useQuery({
    queryKey: [...KEY, payerId ?? ''],
    enabled: !!payerId,
    staleTime: 60_000,
    queryFn: async (): Promise<InsurerTariff> => {
      if (!supabase) return sampleTariff(payerId!)
      const { data, error } = await supabase.rpc('insurer_tariff_rows', { p_payer: payerId })
      // the website can run ahead of the database (0115 not applied yet): say so plainly
      if (error && isMissingFunction(error)) throw new Error(i18n.t('analytics.needsUpdate'))
      if (error) throw apiError(error)
      return toTariff((data ?? {}) as Record<string, unknown>)
    },
  })
}

/**
 * What the insurer pays for the treatments and medicines on screen (0140: payer_lines): the same
 * lines as its whole table, only those asked — the treatment chosen on a visit, the tests offered,
 * the medicines prescribed. A database before 0140: read from the whole table.
 */
export function usePayerLines(
  payerId: string | null | undefined,
  serviceIds: readonly string[],
  itemIds: readonly string[] = [],
) {
  const services = [...new Set(serviceIds)].sort()
  const items = [...new Set(itemIds)].sort()
  return useQuery({
    queryKey: [...KEY, payerId ?? '', 'lines', services.join(','), items.join(',')],
    enabled: !!payerId && services.length + items.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<TariffRow[]> => {
      const wanted = (r: TariffRow) =>
        r.kind === 'service' ? services.includes(r.id) : items.includes(r.id)
      if (!supabase) return sampleTariff(payerId!).rows.filter(wanted)
      const { data, error } = await supabase.rpc('payer_lines', {
        p_payer: payerId,
        p_services: services,
        p_items: items,
      })
      if (error && isMissingFunction(error)) {
        const whole = await supabase.rpc('insurer_tariff_rows', { p_payer: payerId })
        if (whole.error) throw apiError(whole.error)
        return toTariff((whole.data ?? {}) as Record<string, unknown>).rows.filter(wanted)
      }
      if (error) throw apiError(error)
      return (Array.isArray(data) ? (data as Record<string, unknown>[]) : []).map(toTariffRow)
    },
  })
}

/** The line of a treatment or a medicine among those read (undefined: not read yet, or none). */
export function payerLine(
  rows: readonly TariffRow[] | null | undefined,
  pick: { serviceId?: string | null; itemId?: string | null },
): TariffRow | undefined {
  if (!rows) return undefined
  if (pick.serviceId) return rows.find((r) => r.kind === 'service' && r.id === pick.serviceId)
  if (pick.itemId) return rows.find((r) => r.kind === 'item' && r.id === pick.itemId)
  return undefined
}

/** The lines as import_price_list reads them. */
const payload = (lines: TariffLineInput[]) =>
  lines.map((l) => ({ row: l.row, kind: l.kind, code: l.code, name: l.name, price: l.price }))

async function runImport(i: TariffImportInput, dryRun: boolean): Promise<TariffPreview> {
  if (!supabase) return sampleImport(i, dryRun)
  const { data, error } = await supabase.rpc('import_price_list', {
    p_payer: i.payerId,
    p_name: i.name.trim(),
    p_effective_from: i.effectiveFrom,
    p_lines: payload(i.lines),
    p_dry_run: dryRun,
  })
  if (error) throw apiError(error)
  return toPreview((data ?? {}) as Record<string, unknown>)
}

/** Manager: one price by hand, the upload (check, then use) and a new list from a date. */
export function useInsurerTariffActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['catalogue'] })
    // the visit screens show the split of the lines to come
    void qc.invalidateQueries({ queryKey: ['visit'] })
    void qc.invalidateQueries({ queryKey: ['pharmacy'] })
  }

  const setPrice = useMutation({
    mutationFn: async (i: {
      payerId: string
      serviceId?: string | null
      itemId?: string | null
      price: number | null
    }): Promise<void> => {
      if (!supabase) {
        const prices = samplePrices.get(i.payerId) ?? new Map<string, number>()
        const key = sampleKey(i)
        if (i.price == null) prices.delete(key)
        else prices.set(key, Math.round(i.price))
        samplePrices.set(i.payerId, prices)
        const ins = sampleInsurers.find((x) => x.id === i.payerId)
        const cur = sampleCurrentList(i.payerId, `${ins?.name ?? ''} tariff`)
        cur.rows = prices.size
        return
      }
      const { error } = await supabase.rpc('set_insurer_price', {
        p_payer: i.payerId,
        p_service_id: i.serviceId ?? null,
        p_item_id: i.itemId ?? null,
        p_price: i.price,
      })
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })

  const check = useMutation({ mutationFn: (i: TariffImportInput) => runImport(i, true) })
  const apply = useMutation({
    mutationFn: (i: TariffImportInput) => runImport(i, false),
    onSuccess: refresh,
  })

  const startList = useMutation({
    mutationFn: async (i: {
      payerId: string
      name: string
      effectiveFrom: string
      copy: boolean
    }): Promise<void> => {
      if (!supabase) {
        const lists = sampleLists.get(i.payerId) ?? []
        for (const l of lists) {
          if (l.effectiveFrom < i.effectiveFrom) {
            l.inEffect = false
            l.future = false
          }
        }
        const kept = lists.filter((l) => l.effectiveFrom < i.effectiveFrom)
        const prices = samplePrices.get(i.payerId) ?? new Map<string, number>()
        if (!i.copy) prices.clear()
        const inEffect = i.effectiveFrom <= today()
        kept.unshift({
          id: `pl-${Date.now()}`,
          name: i.name.trim(),
          effectiveFrom: i.effectiveFrom,
          effectiveTo: null,
          rows: prices.size,
          createdAt: new Date().toISOString(),
          createdBy: 'You',
          inEffect,
          future: !inEffect,
        })
        if (!inEffect && kept[1]) kept[1].inEffect = true
        sampleLists.set(i.payerId, kept)
        return
      }
      const { error } = await supabase.rpc('start_insurer_tariff', {
        p_payer: i.payerId,
        p_name: i.name.trim(),
        p_from: i.effectiveFrom,
        p_copy: i.copy,
      })
      if (error) throw apiError(error)
    },
    onSuccess: refresh,
  })

  return { setPrice, check, apply, startList }
}

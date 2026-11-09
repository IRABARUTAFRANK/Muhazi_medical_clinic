import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import i18n from '@/i18n'
import type { PriceListColumn, PriceListLineInput } from '@/lib/price-list-file'
import { payerBodyOf, sampleInsurers } from './catalogue'
import { apiError, isMissingFunction } from './errors'

/**
 * Published price lists (0134): the tariffs of treatments and of medicines the Ministry of
 * Health, RSSB / RHIA and the insurers publish. Each list has versions (one per upload, the old
 * ones kept), price columns ("RAMA; MMI", "Private Insurances", "Polyclinic"…), the insurers that
 * follow it (each with its column, in an order) and the insurers' exceptions on its lines (not
 * covered, covered with the insurer's approval, its own price, a note).
 * Live: `tariff_books`, `import_tariff` (dry run = the check), `tariff_lines`, `save_tariff_line`,
 * `remove_tariff_line`, `set_payer_tariff`, `save_tariff_exception`, `link_tariff_service`,
 * `save_tariff_book`, `remove_tariff_book` (0136: a list taken away with what it made). Sample: in
 * memory.
 */

export type ListKind = 'treatments' | 'medicines'
/**
 * Whose list: 'clinic' — the Ministry of Health's, for the whole clinic (private patients pay its
 * private column; a list of treatments makes every line a treatment of the clinic); 'insurer' —
 * one insurer's own tariff (that insurer follows it at once); 'reference' — another publisher's
 * list that insurers may choose to follow.
 */
export type ListScope = 'clinic' | 'insurer' | 'reference'
export const SCOPES: ListScope[] = ['clinic', 'insurer', 'reference']
export type Cover = 'covered' | 'not_covered' | 'preauth'
export const COVERS: Cover[] = ['covered', 'not_covered', 'preauth']

export interface ImportSummary {
  total: number
  rows: number
  new: number
  changedLines: number
  changes: number
  removed: number
  unchanged: number
  errors: number
  warnings: number
  byCode: number
  byName: number
  instructions: {
    payer: string
    notCovered: number
    preauth: number
    notes: number
    keptTyped: number
    dropped: number
  } | null
  previous: { name: string; effectiveFrom: string; rows: number } | null
}

export interface PriceListVersion {
  id: string
  name: string
  /** yyyy-mm-dd */
  effectiveFrom: string
  rows: number
  status: 'current' | 'past'
  columns: PriceListColumn[]
  uploadedAt: string | null
  uploadedBy: string | null
  fileName: string | null
  notes: string | null
  summary: Partial<ImportSummary> | null
  instructionsPayer: string | null
  /** The version prices follow today. */
  inEffect: boolean
  /** Lines changed or added by hand. */
  edited: number
  removedLines: number
}

export interface PriceListFollower {
  payerId: string
  payer: string
  column: string
  priority: number
  /** Who runs the insurer (RSSB for RAMA and Mutuelle de santé), 0137. */
  body: string | null
}

export interface PriceListBook {
  id: string
  name: string
  publisher: string
  kind: ListKind
  payerId: string | null
  payer: string | null
  /**
   * An insurer's own list: who runs its insurer (0137). RSSB: the list is the list of every RSSB
   * scheme (RAMA and Mutuelle de santé): they all follow it, pay its column and get its instructions.
   */
  payerBody: string | null
  scope: ListScope
  /** A clinic-wide list: the column private patients pay. */
  privateColumn: string | null
  /** A clinic-wide list: its order among the clinic-wide lists (smallest first). */
  priority: number
  versions: PriceListVersion[]
  followers: PriceListFollower[]
  exceptions: number
  /** The clinic's treatments or medicines on the version in use. */
  linked: number
  /** A clinic-wide list: the clinic's treatments / medicines on it priced by the clinic itself. */
  ownPriced: number
}

export interface PriceChange {
  code: string
  name: string
  column: string
  label: string
  old: number | null
  new: number | null
}
export interface RowProblem {
  row: number
  /** no_code, bad_code, no_name, duplicate, not_a_row · zero_price, bad_price, no_price */
  code: string
  value: string | null
  name?: string | null
  line?: string
  column?: string | null
}
export interface ClinicMatch {
  code: string
  name?: string
  id: string
  clinicName: string
  active?: boolean
}
export interface InsurerCheck {
  payer: string
  code: string
  name: string
  own?: number | null
  list?: number | null
  cover?: Cover
  price?: number | null
  note?: string | null
}
export interface InstructionLine {
  code: string
  name: string
  note: string
  cover: Cover
  typed: boolean
}

/** What import_tariff answers: the check (dry run) or what was stored. */
export interface PriceListPreview {
  dryRun: boolean
  bookId: string | null
  versionId: string | null
  book: {
    name: string
    publisher: string
    kind: ListKind
    isNew: boolean
    scope: ListScope
    privateColumn: string | null
    payerColumn: string | null
    /** An insurer's own list: that insurer. */
    payer: string | null
  }
  name: string
  effectiveFrom: string
  columns: PriceListColumn[]
  total: number
  rows: number
  new: number
  newLines: { code: string; name: string; prices: Record<string, number | null> }[]
  changedLines: number
  changes: number
  changed: PriceChange[]
  removed: number
  removedLines: { code: string; name: string; inClinic: boolean }[]
  unchanged: number
  renamed: { code: string; old: string; new: string }[]
  edited: { code: string; name: string; editedBy: string | null; added: boolean }[]
  columnsAdded: PriceListColumn[]
  columnsGone: PriceListColumn[]
  errors: RowProblem[]
  errorCount: number
  warnings: RowProblem[]
  warningCount: number
  clinic: {
    byCode: ClinicMatch[]
    byName: ClinicMatch[]
    gone: ClinicMatch[]
    linked: number
    /** A clinic-wide list of treatments: the lines that become new treatments of the clinic. */
    toCreate: number
    toCreateByCategory: { category: string; count: number }[]
    created: number
    /** The clinic's own prices that differ from the list's private price (the clinic's stay). */
    ownPrices: {
      id: string
      kind: 'service' | 'item'
      name: string
      code: string
      own: number
      list: number | null
    }[]
    ownPriceCount: number
  }
  /** Lines without a code, found by their name. */
  names: {
    byList: number
    byClinic: number
    notFound: { row: number; name: string; code: string }[]
    notFoundCount: number
  }
  followers: {
    payerId: string
    payer: string
    column: string
    label: string | null
    found: boolean
  }[]
  checks: {
    exceptionsOnRemoved: InsurerCheck[]
    ownPrices: InsurerCheck[]
    exceptionPrices: InsurerCheck[]
  }
  instructions: {
    payerId: string
    payer: string
    notCovered: number
    preauth: number
    notes: number
    keptTyped: number
    dropped: number
    follows: boolean
    lines: InstructionLine[]
  } | null
  current: { name: string; effectiveFrom: string; rows: number } | null
}

export interface PriceListImportInput {
  /** A new version of this list; null: a new list (book). */
  bookId: string | null
  book: {
    name: string
    publisher: string
    kind: ListKind
    scope: ListScope
    payerId: string | null
    privateColumn: string | null
    payerColumn: string | null
  } | null
  /** A new version of an existing list: its private / insurer column for this version. */
  settings?: { privateColumn: string | null; payerColumn: string | null } | null
  name: string
  /** yyyy-mm-dd */
  effectiveFrom: string
  columns: PriceListColumn[]
  lines: PriceListLineInput[]
  /** The file's instructions are this insurer's exceptions. */
  instructionsPayerId: string | null
  fileName: string | null
  notes: string[]
}

export interface LineException {
  cover: Cover
  price: number | null
  note: string | null
  source: 'typed' | 'upload'
}
export interface PriceListLine {
  code: string
  name: string
  detail: string | null
  section: string | null
  altCode: string | null
  unit: string | null
  prices: Record<string, number | null>
  note: string | null
  row: number | null
  edited: boolean
  editedAt: string | null
  editedBy: string | null
  original: { added?: boolean; prices?: Record<string, number | null>; name?: string } | null
  removed: boolean
  clinic: {
    id: string
    kind: 'service' | 'item'
    name: string
    active: boolean
    /** Linked by hand or by name on this list (not by its own code). */
    linked: boolean
    /** The clinic's own price (null: it takes the list's price). */
    ownPrice: number | null
  }[]
  exception: LineException | null
}
export interface LinesPage {
  versionId: string
  kind: ListKind
  total: number
  sections: string[]
  lines: PriceListLine[]
}

const KEY = ['catalogue', 'price-lists'] as const

const notReady = () => new Error(i18n.t('analytics.needsUpdate'))

// ---------------------------------------------------------------- sample mode
interface SampleBook extends Omit<PriceListBook, 'versions'> {
  versions: (PriceListVersion & { lines: PriceListLine[] })[]
}
const sampleBooks: SampleBook[] = []
const sampleExceptions = new Map<string, LineException & { bookId: string | null }>()
const exKey = (payerId: string, code: string) => `${payerId}|${code}`
const normCode = (s: string) => s.replace(/\s+/g, '').toUpperCase()
const numberOf = (v: number | string | null | undefined): number | null => {
  if (v == null) return null
  if (typeof v === 'number') return Math.round(v)
  const t = v.replace(/[\s,]/g, '')
  return /^\d+(\.\d+)?$/.test(t) ? Math.round(Number(t)) : null
}
const coverOf = (note: string | null): Cover => {
  if (!note) return 'covered'
  if (
    /^\s*n\.?\s*c\.?\s*($|[^a-z])/i.test(note) ||
    /not\s+(re-?\s*)?imburs|not\s+covered|non\s+(couvert|rembours)|excluded|included\s+in/i.test(
      note,
    )
  )
    return 'not_covered'
  if (/pre-?\s*auth|approval|prior\s+auth|accord\s+pr/i.test(note)) return 'preauth'
  return 'covered'
}

function samplePreview(i: PriceListImportInput, dryRun: boolean): PriceListPreview {
  const book = i.bookId ? sampleBooks.find((b) => b.id === i.bookId) : null
  const cur = book?.versions.find((v) => v.status === 'current') ?? null
  const errors: RowProblem[] = []
  const warnings: RowProblem[] = []
  const kept = new Map<string, PriceListLine>()
  for (const l of i.lines) {
    const code =
      normCode(l.code) ||
      (l.name.trim()
        ? `L-${Math.abs(
            [...l.name.toLowerCase()].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7),
          )
            .toString(16)
            .toUpperCase()
            .padStart(8, '0')
            .slice(0, 8)}`
        : '')
    const err = !code ? 'no_code' : !l.name.trim() ? 'no_name' : kept.has(code) ? 'duplicate' : null
    if (err) {
      errors.push({ row: l.row, code: err, value: l.code || null, name: l.name })
      continue
    }
    const prices: Record<string, number | null> = {}
    let any = false
    for (const c of i.columns) {
      const raw = l.prices[c.key]
      const n = numberOf(raw)
      if (raw != null && raw !== '' && n == null)
        warnings.push({
          row: l.row,
          code: 'bad_price',
          value: String(raw),
          line: code,
          name: l.name,
          column: c.key,
        })
      if (n === 0)
        warnings.push({
          row: l.row,
          code: 'zero_price',
          value: '0',
          line: code,
          name: l.name,
          column: c.key,
        })
      if (n != null) any = true
      prices[c.key] = n
    }
    if (!any)
      warnings.push({
        row: l.row,
        code: 'no_price',
        value: null,
        line: code,
        name: l.name,
        column: null,
      })
    kept.set(code, {
      code,
      name: l.name.trim(),
      detail: l.detail,
      section: l.section,
      altCode: l.altCode,
      unit: l.unit,
      prices,
      note: l.note,
      row: l.row,
      edited: false,
      editedAt: null,
      editedBy: null,
      original: null,
      removed: false,
      clinic: [],
      exception: null,
    })
  }
  const old = new Map((cur?.lines ?? []).filter((l) => !l.removed).map((l) => [l.code, l]))
  const changed: PriceChange[] = []
  let unchanged = 0
  const newLines: PriceListPreview['newLines'] = []
  for (const l of kept.values()) {
    const o = old.get(l.code)
    if (!o) {
      newLines.push({ code: l.code, name: l.name, prices: l.prices })
      continue
    }
    let same = true
    for (const c of i.columns) {
      if (!cur?.columns.some((x) => x.key === c.key)) continue
      if ((o.prices[c.key] ?? null) !== (l.prices[c.key] ?? null)) {
        same = false
        changed.push({
          code: l.code,
          name: l.name,
          column: c.key,
          label: c.label,
          old: o.prices[c.key] ?? null,
          new: l.prices[c.key] ?? null,
        })
      }
    }
    if (same) unchanged++
  }
  const removedLines = [...old.values()]
    .filter((l) => !kept.has(l.code))
    .map((l) => ({ code: l.code, name: l.name, inClinic: false }))
  const payer = i.instructionsPayerId
  const notes = [...kept.values()].filter((l) => l.note)
  const instructions = payer
    ? {
        payerId: payer,
        payer: sampleInsurers.find((x) => x.id === payer)?.name ?? payer,
        notCovered: notes.filter((l) => coverOf(l.note) === 'not_covered').length,
        preauth: notes.filter((l) => coverOf(l.note) === 'preauth').length,
        notes: notes.filter((l) => coverOf(l.note) === 'covered').length,
        keptTyped: notes.filter(
          (l) => sampleExceptions.get(exKey(payer, l.code))?.source === 'typed',
        ).length,
        dropped: 0,
        follows: !!book?.followers.some((f) => f.payerId === payer),
        lines: notes.map((l) => ({
          code: l.code,
          name: l.name,
          note: l.note!,
          cover: coverOf(l.note),
          typed: sampleExceptions.get(exKey(payer, l.code))?.source === 'typed',
        })),
      }
    : null
  const changedLines = new Set(changed.map((c) => c.code)).size
  let bookId = book?.id ?? null
  let versionId: string | null = null
  if (!dryRun) {
    let b = book
    if (!b) {
      const scope = i.book!.scope
      const insurer =
        scope === 'insurer' ? sampleInsurers.find((x) => x.id === i.book!.payerId) : null
      // RSSB's list: every RSSB scheme follows it (0137)
      const body = insurer ? payerBodyOf(insurer.type) : null
      const owners = insurer
        ? [
            insurer,
            ...(body
              ? sampleInsurers.filter((x) => x.id !== insurer.id && payerBodyOf(x.type) === body)
              : []),
          ]
        : []
      b = {
        id: `pl-${sampleBooks.length + 1}`,
        name: i.book!.name.trim(),
        publisher: i.book!.publisher.trim(),
        kind: i.book!.kind,
        payerId: insurer?.id ?? null,
        payer: insurer?.name ?? null,
        payerBody: body,
        scope,
        privateColumn: scope === 'clinic' ? i.book!.privateColumn : null,
        priority: 10 * (sampleBooks.filter((x) => x.scope === 'clinic').length + 1),
        versions: [],
        followers: owners.map((x) => ({
          payerId: x.id,
          payer: x.name,
          column: i.book!.payerColumn ?? i.columns[0]!.key,
          priority: 0,
          body: payerBodyOf(x.type),
        })),
        exceptions: 0,
        linked: 0,
        ownPriced: 0,
      }
      sampleBooks.push(b)
    } else if (b.scope === 'clinic' && i.settings?.privateColumn) {
      b.privateColumn = i.settings.privateColumn
    }
    for (const v of b.versions) v.status = 'past'
    versionId = `${b.id}-v${b.versions.length + 1}`
    b.versions.unshift({
      id: versionId,
      name: i.name.trim(),
      effectiveFrom: i.effectiveFrom,
      rows: kept.size,
      status: 'current',
      columns: i.columns,
      uploadedAt: new Date().toISOString(),
      uploadedBy: 'Sample manager',
      fileName: i.fileName,
      notes: i.notes.join('\n') || null,
      summary: {
        rows: kept.size,
        new: newLines.length,
        changedLines,
        removed: removedLines.length,
      },
      instructionsPayer: payer,
      inEffect: true,
      edited: 0,
      removedLines: 0,
      lines: [...kept.values()],
    })
    for (const v of b.versions.slice(1)) v.inEffect = false
    // RSSB's list: the file's instructions are the exceptions of every RSSB scheme that follows it
    const instructed = sampleInsurers.find((x) => x.id === payer)
    const sharers =
      payer && b.payerBody && payerBodyOf(instructed?.type) === b.payerBody
        ? [
            payer,
            ...b.followers
              .filter((f) => f.body === b.payerBody && f.payerId !== payer)
              .map((f) => f.payerId),
          ]
        : payer
          ? [payer]
          : []
    for (const who of sharers)
      for (const l of notes) {
        const k = exKey(who, l.code)
        if (sampleExceptions.get(k)?.source === 'typed') continue
        sampleExceptions.set(k, {
          cover: coverOf(l.note),
          price: null,
          note: l.note,
          source: 'upload',
          bookId: b.id,
        })
      }
    b.exceptions = [...sampleExceptions.values()].filter((e) => e.bookId === b.id).length
    bookId = b.id
  }
  return {
    dryRun,
    bookId,
    versionId,
    book: {
      name: book?.name ?? i.book?.name ?? '',
      publisher: book?.publisher ?? i.book?.publisher ?? '',
      kind: book?.kind ?? i.book?.kind ?? 'treatments',
      isNew: !book,
      scope: book?.scope ?? i.book?.scope ?? 'reference',
      privateColumn: book?.privateColumn ?? i.book?.privateColumn ?? null,
      payerColumn: i.book?.payerColumn ?? null,
      payer:
        book?.payer ??
        (i.book?.scope === 'insurer'
          ? (sampleInsurers.find((x) => x.id === i.book?.payerId)?.name ?? null)
          : null),
    },
    name: i.name.trim(),
    effectiveFrom: i.effectiveFrom,
    columns: i.columns,
    total: i.lines.length,
    rows: kept.size,
    new: newLines.length,
    newLines: newLines.slice(0, 500),
    changedLines,
    changes: changed.length,
    changed,
    removed: removedLines.length,
    removedLines,
    unchanged,
    renamed: [],
    edited: [],
    columnsAdded: cur ? i.columns.filter((c) => !cur.columns.some((x) => x.key === c.key)) : [],
    columnsGone: cur ? cur.columns.filter((c) => !i.columns.some((x) => x.key === c.key)) : [],
    errors,
    errorCount: errors.length,
    warnings,
    warningCount: warnings.length,
    clinic: {
      byCode: [],
      byName: [],
      gone: [],
      linked: 0,
      toCreate: 0,
      toCreateByCategory: [],
      created: 0,
      ownPrices: [],
      ownPriceCount: 0,
    },
    names: {
      byList: 0,
      byClinic: 0,
      notFound: [...kept.values()]
        .filter((l) => l.code.startsWith('L-'))
        .map((l) => ({ row: l.row ?? 0, name: l.name, code: l.code })),
      notFoundCount: [...kept.values()].filter((l) => l.code.startsWith('L-')).length,
    },
    followers: (book?.followers ?? []).map((f) => ({
      payerId: f.payerId,
      payer: f.payer,
      column: f.column,
      label: i.columns.find((c) => c.key === f.column)?.label ?? null,
      found: i.columns.some((c) => c.key === f.column),
    })),
    checks: { exceptionsOnRemoved: [], ownPrices: [], exceptionPrices: [] },
    instructions,
    current: cur ? { name: cur.name, effectiveFrom: cur.effectiveFrom, rows: cur.rows } : null,
  }
}

// ---------------------------------------------------------------- reading
const toVersion = (v: Record<string, unknown>): PriceListVersion => ({
  id: String(v.id),
  name: String(v.name ?? ''),
  effectiveFrom: String(v.effectiveFrom ?? ''),
  rows: Number(v.rows ?? 0),
  status: v.status === 'past' ? 'past' : 'current',
  columns: Array.isArray(v.columns) ? (v.columns as PriceListColumn[]) : [],
  uploadedAt: (v.uploadedAt as string | null) ?? null,
  uploadedBy: (v.uploadedBy as string | null) ?? null,
  fileName: (v.fileName as string | null) ?? null,
  notes: (v.notes as string | null) ?? null,
  summary: (v.summary as Partial<ImportSummary> | null) ?? null,
  instructionsPayer: (v.instructionsPayer as string | null) ?? null,
  inEffect: !!v.inEffect,
  edited: Number(v.edited ?? 0),
  removedLines: Number(v.removedLines ?? 0),
})

/** Every published list, with its versions (newest first) and the insurers that follow it. */
export function usePriceLists(enabled = true) {
  return useQuery({
    queryKey: KEY,
    enabled,
    queryFn: async (): Promise<PriceListBook[]> => {
      if (!supabase)
        return sampleBooks.map((b) => ({
          ...b,
          versions: b.versions.map(({ lines, ...v }) => ({
            ...v,
            edited: lines.filter((l) => l.edited && !l.removed).length,
            removedLines: lines.filter((l) => l.removed).length,
          })),
          followers: [...b.followers],
        }))
      const { data, error } = await supabase.rpc('tariff_books')
      // the website can run ahead of the database (0134 not applied yet): say so plainly
      if (error && isMissingFunction(error)) throw notReady()
      if (error) throw apiError(error)
      return ((data ?? []) as Record<string, unknown>[]).map((b) => ({
        id: String(b.id),
        name: String(b.name ?? ''),
        publisher: String(b.publisher ?? ''),
        kind: b.kind === 'medicines' ? 'medicines' : 'treatments',
        payerId: (b.payerId as string | null) ?? null,
        payer: (b.payer as string | null) ?? null,
        payerBody: (b.payerBody as string | null) ?? null,
        // before 0135 every list is one insurers may follow
        scope: b.scope === 'clinic' || b.scope === 'insurer' ? b.scope : 'reference',
        privateColumn: (b.privateColumn as string | null) ?? null,
        priority: Number(b.priority ?? 100),
        versions: ((b.versions ?? []) as Record<string, unknown>[]).map(toVersion),
        followers: ((b.followers ?? []) as Record<string, unknown>[]).map((f) => ({
          payerId: String(f.payerId),
          payer: String(f.payer ?? ''),
          column: String(f.column ?? ''),
          priority: Number(f.priority ?? 0),
          body: (f.body as string | null) ?? null,
        })),
        exceptions: Number(b.exceptions ?? 0),
        linked: Number(b.linked ?? 0),
        ownPriced: Number(b.ownPriced ?? 0),
      }))
    },
  })
}

export interface LinesQuery {
  versionId: string
  search: string
  payerId: string | null
  section: string | null
  limit: number
}

/** The lines of one version, a page at a time, with one insurer's exceptions. */
export function usePriceListLines(q: LinesQuery | null) {
  return useQuery({
    queryKey: [...KEY, 'lines', q],
    enabled: !!q,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<LinesPage> => {
      const query = q!
      if (!supabase) {
        const book = sampleBooks.find((b) => b.versions.some((v) => v.id === query.versionId))
        const v = book?.versions.find((x) => x.id === query.versionId)
        const s = query.search.trim().toLowerCase()
        const hit = (v?.lines ?? []).filter(
          (l) =>
            (!query.section || l.section === query.section) &&
            (!s || l.code.toLowerCase().includes(s) || l.name.toLowerCase().includes(s)),
        )
        return {
          versionId: query.versionId,
          kind: book?.kind ?? 'treatments',
          total: hit.length,
          sections: [
            ...new Set((v?.lines ?? []).map((l) => l.section).filter((x): x is string => !!x)),
          ].sort(),
          lines: hit.slice(0, query.limit).map((l) => {
            const e = query.payerId ? sampleExceptions.get(exKey(query.payerId, l.code)) : undefined
            return {
              ...l,
              exception: e
                ? { cover: e.cover, price: e.price, note: e.note, source: e.source }
                : null,
            }
          }),
        }
      }
      const { data, error } = await supabase.rpc('tariff_lines', {
        p_version: query.versionId,
        p_search: query.search.trim() || null,
        p_payer: query.payerId,
        p_section: query.section,
        p_limit: query.limit,
        p_offset: 0,
      })
      if (error && isMissingFunction(error)) throw notReady()
      if (error) throw apiError(error)
      const d = (data ?? {}) as Record<string, unknown>
      return {
        versionId: String(d.versionId ?? query.versionId),
        kind: d.kind === 'medicines' ? 'medicines' : 'treatments',
        total: Number(d.total ?? 0),
        sections: (d.sections as string[] | null) ?? [],
        lines: ((d.lines ?? []) as PriceListLine[]).map((l) => ({
          ...l,
          prices: l.prices ?? {},
          clinic: l.clinic ?? [],
          exception: l.exception ?? null,
        })),
      }
    },
  })
}

// ---------------------------------------------------------------- the upload
const linesPayload = (lines: PriceListLineInput[]) =>
  lines.map((l) => ({
    row: l.row,
    code: l.code,
    name: l.name,
    detail: l.detail,
    section: l.section,
    altCode: l.altCode,
    unit: l.unit,
    note: l.note,
    prices: l.prices,
  }))

async function runImport(i: PriceListImportInput, dryRun: boolean): Promise<PriceListPreview> {
  if (!supabase) return samplePreview(i, dryRun)
  const { data, error } = await supabase.rpc('import_tariff', {
    p_book_id: i.bookId,
    p_book:
      i.book ??
      (i.settings
        ? { privateColumn: i.settings.privateColumn, payerColumn: i.settings.payerColumn }
        : null),
    p_name: i.name.trim(),
    p_from: i.effectiveFrom,
    // the column's sheet and title are for the screen only
    p_columns: i.columns.map(({ key, label }) => ({ key, label })),
    p_lines: linesPayload(i.lines),
    p_instructions_payer: i.instructionsPayerId,
    p_file_name: i.fileName,
    p_notes: i.notes.join('\n') || null,
    p_dry_run: dryRun,
  })
  if (error && isMissingFunction(error)) throw notReady()
  if (error) throw apiError(error)
  const d = (data ?? {}) as PriceListPreview
  return {
    ...d,
    newLines: d.newLines ?? [],
    changed: d.changed ?? [],
    removedLines: d.removedLines ?? [],
    renamed: d.renamed ?? [],
    edited: d.edited ?? [],
    columnsAdded: d.columnsAdded ?? [],
    columnsGone: d.columnsGone ?? [],
    errors: d.errors ?? [],
    warnings: d.warnings ?? [],
    clinic: {
      byCode: d.clinic?.byCode ?? [],
      byName: d.clinic?.byName ?? [],
      gone: d.clinic?.gone ?? [],
      linked: d.clinic?.linked ?? 0,
      toCreate: d.clinic?.toCreate ?? 0,
      toCreateByCategory: d.clinic?.toCreateByCategory ?? [],
      created: d.clinic?.created ?? 0,
      ownPrices: d.clinic?.ownPrices ?? [],
      ownPriceCount: d.clinic?.ownPriceCount ?? 0,
    },
    names: {
      byList: d.names?.byList ?? 0,
      byClinic: d.names?.byClinic ?? 0,
      notFound: d.names?.notFound ?? [],
      notFoundCount: d.names?.notFoundCount ?? 0,
    },
    followers: d.followers ?? [],
    checks: {
      exceptionsOnRemoved: d.checks?.exceptionsOnRemoved ?? [],
      ownPrices: d.checks?.ownPrices ?? [],
      exceptionPrices: d.checks?.exceptionPrices ?? [],
    },
  }
}

/** Check a list (nothing stored) and keep it (the version in use from its date). */
export function usePriceListImport() {
  const qc = useQueryClient()
  const check = useMutation({ mutationFn: (i: PriceListImportInput) => runImport(i, true) })
  const apply = useMutation({
    mutationFn: (i: PriceListImportInput) => runImport(i, false),
    onSuccess: () => {
      // the lists, the insurers' tariffs, the treatments linked by name
      void qc.invalidateQueries({ queryKey: ['catalogue'] })
    },
  })
  return { check, apply }
}

// ---------------------------------------------------------------- changes by hand
/** What taking a list away did (remove_tariff_book). */
export interface BookRemoved {
  name: string
  /** The insurers that stopped following it. */
  followers: string[]
  exceptions: number
  links: number
  /** Treatments made from it, never used: deleted. */
  deleted: number
  /** Treatments made from it, already used: hidden. */
  hidden: number
  /** The clinic's own prices of those treatments that went. */
  ownPrices: number
  /** The clinic's own treatments / medicines it priced: today's price kept as their own. */
  kept: number
}

export interface SaveLineInput {
  versionId: string
  code: string
  name: string
  prices: Record<string, number | null>
  note: string | null
  section: string | null
  unit: string | null
  detail: string | null
  isNew: boolean
}

async function rpc(name: string, args: Record<string, unknown>) {
  const { error } = await supabase!.rpc(name, args)
  if (error && isMissingFunction(error)) throw notReady()
  if (error) throw apiError(error)
}

/** Change or add a line, take one out (or back), follow a list, an exception, a treatment's code. */
export function usePriceListActions() {
  const qc = useQueryClient()
  const done = () => void qc.invalidateQueries({ queryKey: ['catalogue'] })
  const sampleVersion = (id: string) => {
    for (const b of sampleBooks) {
      const v = b.versions.find((x) => x.id === id)
      if (v) return { b, v }
    }
    throw new Error(i18n.t('apiErrors.notFound'))
  }
  const saveLine = useMutation({
    mutationFn: async (i: SaveLineInput) => {
      if (!supabase) {
        const { v } = sampleVersion(i.versionId)
        const code = normCode(i.code)
        const old = v.lines.find((l) => l.code === code)
        if (i.isNew && old) throw new Error(i18n.t('prices.lists.err.codeTaken'))
        const line: PriceListLine = {
          ...(old ?? {
            code,
            altCode: null,
            row: null,
            removed: false,
            clinic: [],
            exception: null,
          }),
          code,
          name: i.name.trim(),
          prices: i.prices,
          note: i.note,
          section: i.section,
          unit: i.unit,
          detail: i.detail,
          edited: true,
          editedAt: new Date().toISOString(),
          editedBy: 'Sample manager',
          original: old
            ? (old.original ?? { name: old.name, prices: old.prices })
            : { added: true },
        } as PriceListLine
        if (old) v.lines[v.lines.indexOf(old)] = line
        else {
          v.lines.push(line)
          v.rows++
        }
        return
      }
      await rpc('save_tariff_line', {
        p_version: i.versionId,
        p_code: i.code,
        p_name: i.name,
        p_prices: i.prices,
        p_note: i.note,
        p_section: i.section,
        p_unit: i.unit,
        p_detail: i.detail,
        p_new: i.isNew,
      })
    },
    onSuccess: done,
  })
  const removeLine = useMutation({
    mutationFn: async (i: { versionId: string; code: string; restore: boolean }) => {
      if (!supabase) {
        const { v } = sampleVersion(i.versionId)
        const l = v.lines.find((x) => x.code === i.code)
        if (!l) return
        if (!i.restore && l.original?.added) v.lines.splice(v.lines.indexOf(l), 1)
        else l.removed = !i.restore
        return
      }
      await rpc('remove_tariff_line', {
        p_version: i.versionId,
        p_code: i.code,
        p_restore: i.restore,
      })
    },
    onSuccess: done,
  })
  const follow = useMutation({
    mutationFn: async (i: {
      payerId: string
      payer: string
      bookId: string
      column: string | null
      priority: number | null
    }) => {
      if (!supabase) {
        const b = sampleBooks.find((x) => x.id === i.bookId)!
        b.followers = b.followers.filter((f) => f.payerId !== i.payerId)
        if (i.column)
          b.followers.push({
            payerId: i.payerId,
            payer: i.payer,
            column: i.column,
            priority: i.priority ?? 10,
            body: payerBodyOf(sampleInsurers.find((x) => x.id === i.payerId)?.type),
          })
        return
      }
      await rpc('set_payer_tariff', {
        p_payer: i.payerId,
        p_book: i.bookId,
        p_column: i.column,
        p_priority: i.priority,
      })
    },
    onSuccess: done,
  })
  const saveException = useMutation({
    mutationFn: async (i: {
      payerId: string
      code: string
      cover: Cover
      price: number | null
      note: string | null
      bookId: string | null
    }) => {
      if (!supabase) {
        const k = exKey(i.payerId, i.code)
        if (i.cover === 'covered' && i.price == null && !i.note) sampleExceptions.delete(k)
        else
          sampleExceptions.set(k, {
            cover: i.cover,
            price: i.price,
            note: i.note,
            source: 'typed',
            bookId: i.bookId,
          })
        return
      }
      await rpc('save_tariff_exception', {
        p_payer: i.payerId,
        p_code: i.code,
        p_cover: i.cover,
        p_price: i.price,
        p_note: i.note,
        p_book: i.bookId,
      })
    },
    onSuccess: done,
  })
  const saveBook = useMutation({
    mutationFn: async (i: { id: string; name: string; publisher: string; remove: boolean }) => {
      if (!supabase) {
        const b = sampleBooks.find((x) => x.id === i.id)!
        if (i.remove) {
          if (b.followers.length) throw new Error(i18n.t('prices.lists.err.followed'))
          sampleBooks.splice(sampleBooks.indexOf(b), 1)
        } else {
          b.name = i.name.trim()
          b.publisher = i.publisher.trim()
        }
        return
      }
      await rpc('save_tariff_book', {
        p_id: i.id,
        p_name: i.name,
        p_publisher: i.publisher,
        p_delete: i.remove,
      })
    },
    onSuccess: done,
  })
  /**
   * The list goes completely (0136): its insurers stop following it, its exceptions and links go,
   * the treatments it made are deleted (hidden when already used), the clinic's own treatments it
   * priced keep today's price as their own.
   */
  const removeBook = useMutation({
    mutationFn: async (bookId: string): Promise<BookRemoved> => {
      if (!supabase) {
        const b = sampleBooks.find((x) => x.id === bookId)
        if (!b) throw new Error(i18n.t('apiErrors.notFound'))
        sampleBooks.splice(sampleBooks.indexOf(b), 1)
        return {
          name: b.name,
          followers: b.followers.map((f) => f.payer),
          exceptions: 0,
          links: 0,
          deleted: b.kind === 'treatments' ? b.linked : 0,
          hidden: 0,
          ownPrices: 0,
          kept: 0,
        }
      }
      const { data, error } = await supabase.rpc('remove_tariff_book', { p_id: bookId })
      if (error && isMissingFunction(error)) throw notReady()
      if (error) throw apiError(error)
      return data as BookRemoved
    },
    onSuccess: done,
  })
  /** The clinic's own prices of those treatments / medicines go: the list's price applies (all: null). */
  const applyListPrices = useMutation({
    mutationFn: async (i: { bookId: string; ids: string[] | null }): Promise<number> => {
      if (!supabase) return i.ids?.length ?? 0
      const { data, error } = await supabase.rpc('use_list_prices', {
        p_book: i.bookId,
        p_ids: i.ids,
      })
      if (error && isMissingFunction(error)) throw notReady()
      if (error) throw apiError(error)
      return Number(data ?? 0)
    },
    onSuccess: done,
  })
  /** This line of the list is that treatment / medicine of the clinic (or no longer: unlink). */
  /** 0145: the lines of an insurer's list the clinic does not have become its treatments
   *  (inactive, no cash price, linked to the list); some codes, or every missing one. */
  const adoptLines = useMutation({
    mutationFn: async (i: { bookId: string; codes: string[] | null }): Promise<number> => {
      if (!supabase) return i.codes ? i.codes.length : 0
      const { data, error } = await supabase.rpc('adopt_tariff_lines', {
        p_book: i.bookId,
        p_codes: i.codes,
      })
      if (error) throw apiError(error)
      return Number((data as { created?: number } | null)?.created ?? 0)
    },
    onSuccess: done,
  })
  const linkLine = useMutation({
    mutationFn: async (i: {
      bookId: string
      code: string
      serviceId: string | null
      itemId: string | null
      unlink?: boolean
    }) => {
      if (!supabase) return
      if (i.unlink)
        await rpc('unlink_tariff_line', {
          p_book: i.bookId,
          p_service_id: i.serviceId,
          p_item_id: i.itemId,
        })
      else
        await rpc('link_tariff_line', {
          p_book: i.bookId,
          p_code: i.code,
          p_service_id: i.serviceId,
          p_item_id: i.itemId,
        })
    },
    onSuccess: done,
  })
  /** A clinic-wide list's private column and order; an insurer's own list's column. */
  const saveSettings = useMutation({
    mutationFn: async (i: {
      bookId: string
      privateColumn: string | null
      priority: number | null
      payerColumn: string | null
    }) => {
      if (!supabase) {
        const b = sampleBooks.find((x) => x.id === i.bookId)
        if (b && i.privateColumn) b.privateColumn = i.privateColumn
        if (b && i.priority != null) b.priority = i.priority
        if (b && i.payerColumn && b.followers[0]) b.followers[0].column = i.payerColumn
        return
      }
      await rpc('save_tariff_book_settings', {
        p_id: i.bookId,
        p_private_column: i.privateColumn,
        p_priority: i.priority,
        p_payer_column: i.payerColumn,
      })
    },
    onSuccess: done,
  })
  return {
    saveLine,
    removeLine,
    follow,
    saveException,
    saveBook,
    removeBook,
    applyListPrices,
    linkLine,
    adoptLines,
    saveSettings,
  }
}

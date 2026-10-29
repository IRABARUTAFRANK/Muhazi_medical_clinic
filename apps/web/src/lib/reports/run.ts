import type { ClinicProfile, StaffUser } from '@mmc/shared'
import {
  docDate,
  docDateTime,
  docMoney,
  docNumber,
  docTime,
  kigaliParts,
  makeDocLabels,
  type TFn,
} from '@/lib/doc-style'
import type {
  Cell,
  Report,
  ReportColumn,
  ReportRowKind,
  ReportTable,
  ReportTotalKind,
} from '@/lib/report'
import type {
  AnyReportDef,
  ColumnKind,
  ReportColumnDef,
  ReportContext,
  ReportFigureDef,
  ReportFilterValues,
  ReportOption,
  ReportTotalsAt,
  ReportValue,
} from './defs/types'

/**
 * The report centre's engine (pure, no React): from a report definition, its rows and the
 * person's choices (columns chosen and ordered, sort, group by with subtotals or a summary,
 * where the totals go) it builds the preview model the page shows, and the Report that
 * lib/report.ts prints as a PDF or writes as an Excel workbook. Both come from the same model,
 * so the screen, the paper and the workbook always say the same.
 */

/** "Details with subtotals" (the rows of each group, then its subtotal) or one row per group. */
export type GroupMode = 'details' | 'summary'

export interface ReportChoices {
  /** The column keys shown, in order. */
  columns: string[]
  sort: { key: string; dir: 'asc' | 'desc' } | null
  /** A group key of the definition, or null. */
  group: string | null
  mode: GroupMode
  totals: ReportTotalsAt
}

/** A column of the model, its header already in words. */
export interface ModelColumn {
  key: string
  label: string
  kind: ColumnKind
  total?: 'sum' | 'count' | 'avg'
  align: 'left' | 'right'
  nowrap?: boolean
  width?: string
}

export type ModelRow =
  | { kind: 'row'; cells: ReportValue[] }
  | { kind: 'group'; label: string; count: number }
  | { kind: 'subtotal'; label: string; count: number; cells: (number | null)[] }

export interface ReportModel {
  columns: ModelColumn[]
  rows: ModelRow[]
  /** The totals row, one value per column (null: no total). */
  totals: (number | null)[]
  /** Detail rows (the rows the loader returned). */
  count: number
  /** Groups found (0 when not grouped). */
  groups: number
  summary: boolean
  /** The group's heading ("Insurer"), when grouped. */
  groupLabel: string | null
}

/** The summary table's first two columns. */
export const GROUP_COLUMN = '__group'
export const COUNT_COLUMN = '__count'

const NUMERIC: readonly ColumnKind[] = ['number', 'money', 'percent']
const isNumeric = (k: ColumnKind | undefined) => !!k && NUMERIC.includes(k)

/** A column's header in words. */
export const columnLabel = (c: ReportColumnDef<unknown>, t: TFn) =>
  c.plainLabel ? c.label : t(c.label)

/**
 * The columns this person may choose: the definition's and the run-time ones (the clinic's own
 * fields), without those `allowed` refuses, and the sensitive ones only for clinical readers.
 */
export function availableColumns<Row>(
  cols: readonly ReportColumnDef<Row>[],
  ctx: ReportContext,
): ReportColumnDef<Row>[] {
  return cols.filter((c) => (!c.sensitive || ctx.clinical) && (!c.allowed || c.allowed(ctx)))
}

/** The choices a report opens with: its default columns, sort, grouping and totals. */
export function defaultChoices(
  def: AnyReportDef,
  cols: readonly ReportColumnDef<unknown>[],
): ReportChoices {
  const shown = cols.filter((c) => c.default).map((c) => c.key)
  const group =
    def.defaultGroup && def.groups?.some((g) => g.key === def.defaultGroup!.key)
      ? def.defaultGroup.key
      : null
  return {
    columns: shown.length ? shown : cols.slice(0, 6).map((c) => c.key),
    sort:
      def.defaultSort && cols.some((c) => c.key === def.defaultSort!.key)
        ? { ...def.defaultSort }
        : null,
    group,
    mode: group ? (def.defaultGroup?.mode ?? 'details') : 'details',
    totals: def.defaultTotals ?? 'bottom',
  }
}

/**
 * Saved choices made safe for today's report: unknown or no longer allowed columns dropped, the
 * sort and the group kept only if they still exist. Nothing left: the report's defaults.
 */
export function cleanChoices(
  saved: Partial<ReportChoices> | null | undefined,
  def: AnyReportDef,
  cols: readonly ReportColumnDef<unknown>[],
): ReportChoices {
  const base = defaultChoices(def, cols)
  if (!saved || typeof saved !== 'object') return base
  const known = new Set(cols.map((c) => c.key))
  const columns = Array.isArray(saved.columns)
    ? saved.columns.filter((k, i, all) => known.has(k) && all.indexOf(k) === i)
    : base.columns
  const group =
    saved.group && def.groups?.some((g) => g.key === saved.group) ? saved.group : base.group
  const sortOk =
    saved.sort &&
    (known.has(saved.sort.key) || saved.sort.key === COUNT_COLUMN) &&
    (saved.sort.dir === 'asc' || saved.sort.dir === 'desc')
  const totals = (['bottom', 'top', 'both', 'none'] as const).includes(
    saved.totals as ReportTotalsAt,
  )
    ? (saved.totals as ReportTotalsAt)
    : base.totals
  return {
    columns: columns.length ? columns : base.columns,
    sort: sortOk ? { key: saved.sort!.key, dir: saved.sort!.dir } : base.sort,
    group: saved.group === null ? null : group,
    mode: saved.mode === 'summary' || saved.mode === 'details' ? saved.mode : base.mode,
    totals,
  }
}

// ---------------------------------------------------------------- values

const isEmpty = (v: ReportValue) => v == null || v === '' || (typeof v === 'number' && isNaN(v))

const timeOf = (v: ReportValue): number | null => {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string') {
    const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v)
    return Number.isNaN(t) ? null : t
  }
  return typeof v === 'number' ? v : null
}
const numberOf = (v: ReportValue): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  if (typeof v === 'boolean') return v ? 1 : 0
  return null
}

/** Two values of a column in ascending order; empty values are handled by the caller. */
export function compareValues(a: ReportValue, b: ReportValue, kind?: ColumnKind): number {
  if (isNumeric(kind) || (typeof a === 'number' && typeof b === 'number'))
    return (numberOf(a) ?? 0) - (numberOf(b) ?? 0)
  if (kind === 'date' || kind === 'datetime' || kind === 'time' || a instanceof Date)
    return (timeOf(a) ?? 0) - (timeOf(b) ?? 0)
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(!!a) - Number(!!b)
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

/** Rows sorted by one column; empty values always last, whatever the direction. */
function sortRows<Row>(
  rows: Row[],
  col: ReportColumnDef<Row> | undefined,
  dir: 'asc' | 'desc',
): Row[] {
  if (!col) return rows
  const sign = dir === 'desc' ? -1 : 1
  return rows
    .map((row, i) => ({ row, i, v: col.value(row) }))
    .sort((x, y) => {
      const ex = isEmpty(x.v)
      const ey = isEmpty(y.v)
      if (ex || ey) return ex === ey ? x.i - y.i : ex ? 1 : -1
      return sign * compareValues(x.v, y.v, col.kind) || x.i - y.i
    })
    .map((x) => x.row)
}

/**
 * A column's total over some values: the sum, the average of the numbers, or the count of the
 * non-empty values (for a Yes / No column: the count of Yes). Null when there is nothing to add.
 */
export function totalFor(
  total: 'sum' | 'count' | 'avg' | undefined,
  kind: ColumnKind | undefined,
  values: ReportValue[],
): number | null {
  if (!total) return null
  if (total === 'count')
    return values.filter((v) => (kind === 'yesno' ? v === true : !isEmpty(v) && v !== false)).length
  const nums = values.map(numberOf).filter((n): n is number => n != null)
  if (total === 'sum') return nums.reduce((s, n) => s + n, 0)
  // an average keeps one decimal, on the screen, the paper and the workbook alike
  return nums.length ? Math.round((nums.reduce((s, n) => s + n, 0) / nums.length) * 10) / 10 : null
}

// ---------------------------------------------------------------- the model

/**
 * The preview model: the chosen columns in their order; the rows sorted; when grouped, either
 * each group's heading, its rows and its subtotal ("details") or one row per group ("summary");
 * and the totals over every row.
 */
export function buildModel<Row>(o: {
  def: AnyReportDef
  rows: readonly Row[]
  /** The columns this person may choose (availableColumns). */
  columns: readonly ReportColumnDef<Row>[]
  choices: ReportChoices
  t: TFn
}): ReportModel {
  const { def, choices, t } = o
  const byKey = new Map(o.columns.map((c) => [c.key, c]))
  const chosen = choices.columns
    .map((k) => byKey.get(k))
    .filter((c): c is ReportColumnDef<Row> => !!c)
  const shown = chosen.length ? chosen : o.columns.slice(0, 1)
  const group = choices.group ? def.groups?.find((g) => g.key === choices.group) : undefined
  const sortCol = choices.sort ? byKey.get(choices.sort.key) : undefined
  const dir = choices.sort?.dir ?? 'asc'
  const sorted = sortRows([...o.rows], sortCol, dir)
  const totalsOf = (rows: readonly Row[]) =>
    shown.map((c) =>
      totalFor(
        c.total,
        c.kind,
        rows.map((r) => c.value(r)),
      ),
    )
  const columnOf = (c: ReportColumnDef<Row>): ModelColumn => ({
    key: c.key,
    label: columnLabel(c as ReportColumnDef<unknown>, t),
    kind: c.kind ?? 'text',
    total: c.total,
    align: isNumeric(c.kind) ? 'right' : 'left',
    nowrap: c.nowrap,
    width: c.width,
  })

  if (!group) {
    return {
      columns: shown.map(columnOf),
      rows: sorted.map((r) => ({ kind: 'row', cells: shown.map((c) => c.value(r)) })),
      totals: totalsOf(sorted),
      count: sorted.length,
      groups: 0,
      summary: false,
      groupLabel: null,
    }
  }

  // the groups, in their own order (age bands, days) or by name; "not stated" last
  const notStated = t('reports.ui.notStated')
  const buckets = new Map<string, { label: string; order: string | number; rows: Row[] }>()
  for (const r of sorted) {
    const raw = group.value(r)
    const label = raw && String(raw).trim() ? String(raw) : notStated
    let b = buckets.get(label)
    if (!b) {
      b = { label, order: group.order ? group.order(r) : label, rows: [] }
      buckets.set(label, b)
    }
    b.rows.push(r)
  }
  const list = [...buckets.values()].sort((a, b) => {
    if ((a.label === notStated) !== (b.label === notStated)) return a.label === notStated ? 1 : -1
    return typeof a.order === 'number' && typeof b.order === 'number'
      ? a.order - b.order
      : String(a.order).localeCompare(String(b.order), undefined, { numeric: true })
  })
  const heading = t(group.heading ?? group.label)

  if (choices.mode === 'summary') {
    const sums = shown.filter((c) => c.total)
    const columns: ModelColumn[] = [
      { key: GROUP_COLUMN, label: heading, kind: 'text', align: 'left' },
      {
        key: COUNT_COLUMN,
        label: t(def.countLabel ?? 'reports.ui.rows'),
        kind: 'number',
        total: 'sum',
        align: 'right',
      },
      ...sums.map((c) => ({
        ...columnOf(c),
        // a count of Yes is a number in the summary
        kind: c.kind === 'yesno' ? ('number' as const) : (c.kind ?? 'text'),
        align: 'right' as const,
      })),
    ]
    let rows = list.map((b) => ({
      kind: 'row' as const,
      cells: [
        b.label,
        b.rows.length,
        ...sums.map((c) =>
          totalFor(
            c.total,
            c.kind,
            b.rows.map((r) => c.value(r)),
          ),
        ),
      ] as ReportValue[],
    }))
    // the groups sorted by a summary column (the count, an amount), when one is chosen
    const at = choices.sort ? columns.findIndex((c) => c.key === choices.sort!.key) : -1
    if (at > 0) {
      const sign = dir === 'desc' ? -1 : 1
      rows = [...rows].sort(
        (x, y) => sign * compareValues(x.cells[at] ?? 0, y.cells[at] ?? 0, 'number'),
      )
    }
    return {
      columns,
      rows,
      totals: [
        null,
        sorted.length,
        ...sums.map((c) =>
          totalFor(
            c.total,
            c.kind,
            sorted.map((r) => c.value(r)),
          ),
        ),
      ],
      count: sorted.length,
      groups: list.length,
      summary: true,
      groupLabel: heading,
    }
  }

  const rows: ModelRow[] = []
  for (const b of list) {
    rows.push({ kind: 'group', label: b.label, count: b.rows.length })
    for (const r of b.rows) rows.push({ kind: 'row', cells: shown.map((c) => c.value(r)) })
    rows.push({
      kind: 'subtotal',
      label: t('reports.ui.subtotalOf', { group: b.label }),
      count: b.rows.length,
      cells: totalsOf(b.rows),
    })
  }
  return {
    columns: shown.map(columnOf),
    rows,
    totals: totalsOf(sorted),
    count: sorted.length,
    groups: list.length,
    summary: false,
    groupLabel: heading,
  }
}

// ---------------------------------------------------------------- words of a cell

/** A value as the preview shows it: money and counts with thousands separators, Kigali dates. */
export function formatValue(v: ReportValue, kind: ColumnKind | undefined, t: TFn): string {
  if (v == null || v === '') return ''
  if (kind === 'yesno' || typeof v === 'boolean') return v ? t('common.yes') : t('common.no')
  if (kind === 'date') return docDate(v as string | Date) || String(v)
  if (kind === 'datetime') return docDateTime(v as string | Date) || String(v)
  if (kind === 'time') return docTime(v as string | Date) || String(v)
  const n = numberOf(v)
  if (kind === 'money' && n != null) return n < 0 ? `–${docMoney(-n)}` : docMoney(n)
  if (kind === 'percent' && n != null) return `${docNumber(Math.round(n * 10) / 10)} %`
  if (kind === 'number' && n != null)
    return n < 0 ? `–${docNumber(Math.round(-n * 10) / 10)}` : docNumber(Math.round(n * 10) / 10)
  if (v instanceof Date) return docDateTime(v)
  return String(v)
}

/** A group's heading in words: "RSSB (CBHI) — Patients: 12". */
export const groupHeading = (label: string, count: number, def: AnyReportDef, t: TFn) =>
  `${label} — ${t(def.countLabel ?? 'reports.ui.rows')}: ${docNumber(count)}`

// ---------------------------------------------------------------- the filters line

/** At most this many choice filters are each printed with "all"; more: only the chosen ones. */
const MAX_LISTED_FILTERS = 3

/**
 * The filters as printed after the period: one "Label: value" per filter ("all" when nothing is
 * chosen); a search or a switch only when used. A report with many filters prints the chosen
 * ones, then "Other filters: all".
 */
export function filterLines(o: {
  def: AnyReportDef
  values: ReportFilterValues
  /** The options of each select / multi filter (fixed or loaded). */
  options: Record<string, ReportOption[] | undefined>
  ctx: ReportContext
  t: TFn
}): { label: string; value: string }[] {
  const { def, values, t } = o
  const out: { label: string; value: string }[] = []
  const shown = def.filters.filter((f) => f.kind !== 'period' && (!f.allowed || f.allowed(o.ctx)))
  const many =
    shown.filter((f) => f.kind === 'select' || f.kind === 'multi').length > MAX_LISTED_FILTERS
  let unset = 0
  for (const f of shown) {
    const v = values[f.key]
    const opts = o.options[f.key] ?? f.options ?? []
    const name = (x: string) => {
      const opt = opts.find((p) => p.value === x)
      return opt ? (opt.labelIsKey ? t(opt.label) : opt.label) : x
    }
    if (f.kind === 'toggle') {
      if (v === true) out.push({ label: t(f.label), value: t('common.yes') })
    } else if (f.kind === 'text') {
      if (typeof v === 'string' && v.trim()) out.push({ label: t(f.label), value: `“${v.trim()}”` })
    } else {
      const list =
        f.kind === 'multi' ? (Array.isArray(v) ? v : []) : typeof v === 'string' && v ? [v] : []
      if (!list.length && many) unset++
      else
        out.push({
          label: t(f.label),
          value: list.length ? list.map(name).join(', ') : t('reports.ui.all'),
        })
    }
  }
  if (unset) out.push({ label: t('reports.ui.otherFilters'), value: t('reports.ui.all') })
  return out
}

// ---------------------------------------------------------------- the printed report

const ymd = (iso: string) => iso.slice(0, 10).replace(/-/g, '')
/** More than 7 columns, or a report marked wide: the PDF prints in landscape. */
const MAX_PORTRAIT_COLUMNS = 7

/** A model value as an Excel / PDF cell (Yes / No in words, numbers as numbers). */
function toCell(v: ReportValue, kind: ColumnKind, t: TFn): Cell {
  if (v == null || v === '') return null
  if (kind === 'yesno' || typeof v === 'boolean') return v ? t('common.yes') : t('common.no')
  if (isNumeric(kind)) return numberOf(v)
  return v as Cell
}
const reportKind = (k: ColumnKind): ReportColumn['kind'] => (k === 'yesno' ? 'text' : k)

/** The report number's part for the period: 20261028 or 20261001-20261028. */
export const periodKeyOf = (from: string, to: string) =>
  from === to ? ymd(from) : `${ymd(from)}-${ymd(to)}`

/**
 * The Report lib/report.ts prints and exports: the letterhead and title, the period and the
 * filters line, the key figures, ONE table (the rows, or the groups with their subtotals, or
 * the summary) with its totals where the person put them, the notes, "Prepared by" and the
 * report number RPT-<code>-<yyyymmdd[-yyyymmdd]>.
 */
export function buildReport(o: {
  def: AnyReportDef
  model: ReportModel
  values: ReportFilterValues
  filters: { label: string; value: string }[]
  figures?: ReportFigureDef[]
  totals: ReportTotalsAt
  clinic: ClinicProfile
  user: Pick<StaffUser, 'name'>
  t: TFn
  lang?: string
  /** The moment printed (default now): a report without a period is "as of" it. */
  printedAt?: Date
}): Report {
  const { def, model, t } = o
  const at = o.printedAt ?? new Date()
  // a report of a moment (stock on hand, employees): "As of <date and time printed>" and the
  // print date in its number, never a period it does not have
  const asOf = !def.filters.some((f) => f.kind === 'period')
  const today = kigaliDay(at)
  const p = asOf ? { from: today, to: today, label: docDateTime(at) } : o.values.period
  const columns: ReportColumn[] = model.columns.map((c) => ({
    label: c.label,
    kind: reportKind(c.kind),
    align: c.align,
    nowrap: c.nowrap,
    pdfWidth: c.width,
  }))
  const rows: Cell[][] = []
  const rowKinds: ReportRowKind[] = []
  for (const r of model.rows) {
    if (r.kind === 'group') {
      rows.push([groupHeading(r.label, r.count, def, t), ...model.columns.slice(1).map(() => null)])
      rowKinds.push('group')
    } else if (r.kind === 'subtotal') {
      rows.push(
        model.columns.map((c, i) =>
          i === 0
            ? r.cells[0] != null
              ? `${r.label}: ${formatValue(r.cells[0], c.kind === 'yesno' ? 'number' : c.kind, t)}`
              : r.label
            : r.cells[i] == null
              ? null
              : r.cells[i],
        ),
      )
      rowKinds.push('subtotal')
    } else {
      rows.push(r.cells.map((v, i) => toCell(v, model.columns[i]?.kind ?? 'text', t)))
      rowKinds.push('row')
    }
  }
  // Excel: sums, counts and averages are SUBTOTAL() formulas; a count of Yes and a summary's
  // average (weighted over every row) are written as values
  const totalKinds: (ReportTotalKind | null)[] = model.columns.map((c) => {
    if (!c.total) return null
    if (model.summary) return c.total === 'avg' ? 'value' : 'sum'
    return c.kind === 'yesno' ? 'value' : c.total
  })
  const grouped = model.groupLabel != null
  const table: ReportTable = {
    title: model.summary
      ? t('reports.ui.summaryBy', { group: model.groupLabel })
      : t(def.countLabel ?? 'reports.ui.rows'),
    note:
      grouped && !model.summary
        ? t('reports.ui.groupedBy', { group: model.groupLabel })
        : undefined,
    columns,
    rows,
    rowKinds: grouped && !model.summary ? rowKinds : undefined,
    totalKinds,
    totalValues: model.totals.map((v) => v),
    totalsAt: o.totals,
    totalLabel: grouped ? t('reports.ui.grandTotal') : t('report.total'),
  }
  const money = model.columns.some((c) => c.kind === 'money')
  const noteLines = [
    ...(money ? [t('report.notes.currency')] : []),
    ...(def.notes ?? []).map((k) => t(k)),
  ]
  const title = t(def.title)
  return {
    title,
    period: p.label,
    clinic: o.clinic,
    producedBy: o.user.name,
    sections: [{ name: def.id, tables: [table] }],
    fileName: `${def.code.toLowerCase()}_${p.from}${p.from === p.to ? '' : `_${p.to}`}`,
    code: def.code,
    periodKey: periodKeyOf(p.from, p.to),
    figures: o.figures?.slice(0, 6).map((f) => ({
      label: t(f.label),
      value: f.value,
      unit: f.unit && f.unit !== 'RWF' ? t(f.unit) : f.unit,
    })),
    notes: noteLines.length ? { title: t('report.notes.title'), lines: noteLines } : undefined,
    doc: makeDocLabels(t),
    words: {
      reportNo: t('report.reportNo'),
      printed: t('report.printed'),
      preparedBy: t('report.preparedBy'),
      checkedBy: t('report.checkedBy'),
      period: asOf ? t('reports.ui.asOf') : t('report.period'),
      total: t('report.total'),
      summarySheet: t('report.sheets.summary'),
      figure: t('report.cols.figure'),
      value: t('report.cols.value'),
      unit: t('report.cols.unit'),
    },
    lang: o.lang,
    filters: o.filters,
    orientation: def.wide || model.columns.length > MAX_PORTRAIT_COLUMNS ? 'landscape' : 'portrait',
    asOf,
    printedAt: at,
  }
}

/** The Kigali calendar day (yyyy-mm-dd) of a moment. */
function kigaliDay(d: Date) {
  const k = kigaliParts(d)
  return `${k.y}-${String(k.m).padStart(2, '0')}-${String(k.d).padStart(2, '0')}`
}

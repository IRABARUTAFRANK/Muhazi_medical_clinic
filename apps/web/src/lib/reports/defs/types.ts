import type { StaffUser } from '@mmc/shared'
import type { DashboardRange } from '@/lib/api/dashboard'

/**
 * The report centre (/app/reports): every report the clinic prints is one ReportDef. A report is
 * a TABLE first (one row per patient, payment, medicine, employee…) that the person filters,
 * whose columns they choose and order, with totals at the top or the bottom (or both, or none),
 * optionally grouped (subtotals per method, per day, per cashier…) or summarised (one row per
 * group). The same definition gives the on-screen preview, the printed PDF (lib/report.ts:
 * letterhead, filters line, key figures, the table, page x of y) and the Excel file.
 *
 * Each domain keeps its own list in ./finance.ts, ./patients.ts, ./stock.ts, ./staff.ts,
 * ./clinical.ts; ../catalog.ts joins them. A report shows only to the people `allowed` says,
 * and its database function checks the same right again (a report never shows more than the
 * person may see on the screens).
 *
 * All words are i18n keys (resolved with t() by the report centre).
 */

/** What a cell holds. Money is a number in RWF; dates are ISO strings or Date. */
export type ReportValue = string | number | Date | boolean | null | undefined

export type ColumnKind =
  | 'text'
  | 'number'
  | 'money'
  | 'date'
  | 'datetime'
  | 'time'
  | 'percent'
  /** true / false shown as Yes / No */
  | 'yesno'

export interface ReportColumnDef<Row> {
  /** Stable id (saved presets and the URL use it). */
  key: string
  /** i18n key of the header. */
  label: string
  kind?: ColumnKind
  /** Shown when the report opens; the person may tick the others. */
  default?: boolean
  /** In the totals row: sum the values, count the non-empty ones, or average them. */
  total?: 'sum' | 'count' | 'avg'
  value: (row: Row) => ReportValue
  /**
   * Clinical or private data (diagnosis, test result…): offered only when `ctx.clinical` is true
   * (the manager, a head for their department, the clinician for their own patients).
   */
  sensitive?: boolean
  /** The label is already in words (a field the manager named), not an i18n key. */
  plainLabel?: boolean
  /** Offered only to these people (money columns for the manager…); the database checks again. */
  allowed?: (ctx: ReportContext) => boolean
  /** PDF: the value never wraps (codes, file numbers, short words). */
  nowrap?: boolean
  /** PDF: a width hint ("18%"). */
  width?: string
}

export type FilterKind =
  /** The shared period: Today · This week · This month · All time · Custom. Key must be 'period'. */
  | 'period'
  /** One choice among options ('' = all). */
  | 'select'
  /** Several choices (empty = all). */
  | 'multi'
  /** Free text (search). */
  | 'text'
  /** On / off. */
  | 'toggle'

export interface ReportOption {
  value: string
  /** Already translated (names of people, stores…) or an i18n key when `labelIsKey`. */
  label: string
  labelIsKey?: boolean
}

export interface ReportFilterDef {
  key: string
  /** i18n key of the label. */
  label: string
  kind: FilterKind
  /** Fixed options (payment methods, statuses…) for select / multi. */
  options?: ReportOption[]
  /** Options loaded from the database (cashiers, departments, stores, doctors…). */
  loadOptions?: (ctx: ReportContext) => Promise<ReportOption[]>
  /** The value when the report opens (the period's default range for 'period'). */
  default?: string | string[] | boolean | DashboardRange
  /** i18n key of a short hint under the filter. */
  hint?: string
  /** Shown only to these people (a department filter for the manager…). */
  allowed?: (ctx: ReportContext) => boolean
  /** i18n key of the placeholder of a text filter. */
  placeholder?: string
}

/** The period as the loaders receive it: both days included, ISO yyyy-mm-dd. */
export interface ReportPeriod {
  range: DashboardRange
  from: string
  to: string
  /** "01/10/2026 – 28/10/2026" (already formatted for the report's header). */
  label: string
}

/** The filter values: `period` plus one entry per filter key. */
export interface ReportFilterValues {
  period: ReportPeriod
  [key: string]: string | string[] | boolean | ReportPeriod | null | undefined
}

/** Who is asking; built once by the report centre from the session. */
export interface ReportContext {
  user: StaffUser
  isManager: boolean
  /** Head (or assistant head) of a department: their department's reports. */
  isHead: boolean
  /** Settings › Who may do what (payment.take, stock.write, records.approve, stock.sell_walkin…). */
  can: (feature: string) => boolean
  /** The desks the person's departments give (pharmacy, laboratory, ultrasound, cashier…). */
  canDesk: (desk: string) => boolean
  /** Holds at least one room store (My store). */
  holdsStore: boolean
  /** May see clinical columns (diagnoses, results…): manager, heads, treating clinicians. */
  clinical: boolean
  /** Sample mode (no database): the loaders return sample rows. */
  sample: boolean
}

export interface ReportFigureDef {
  /** i18n key */
  label: string
  value: number
  /** 'RWF' for money, or an i18n key of a unit word. */
  unit?: string
}

export interface ReportGroupDef<Row> {
  key: string
  /** i18n key, e.g. "By payment method" */
  label: string
  value: (row: Row) => string
  /** The order of the groups (age bands, days…); without it, by the group's name. */
  order?: (row: Row) => string | number
  /** i18n key of the summary table's first column ("Payment method"); default: `label`. */
  heading?: string
}

/** What the person chose besides the filters, for loaders whose data depends on it. */
export interface ReportRunInfo {
  /** The column keys shown, in order. */
  columns: string[]
}

/** Where the totals row goes. */
export type ReportTotalsAt = 'bottom' | 'top' | 'both' | 'none'

export type ReportGroupName =
  'patients' | 'finance' | 'stock' | 'pharmacy' | 'staff' | 'clinical' | 'lab' | 'reception'

export interface ReportDef<Row = Record<string, unknown>> {
  /** 'finance.revenue', 'patients.visited'… (URL ?r=…) */
  id: string
  group: ReportGroupName
  /** i18n keys */
  title: string
  description: string
  /** Short code for the report number (REV, PAT, STK…): RPT-REV-20261028. */
  code: string
  /** Who sees and runs it (the database checks again). */
  allowed: (ctx: ReportContext) => boolean
  filters: ReportFilterDef[]
  columns: ReportColumnDef<Row>[]
  /**
   * The rows for the filters (sample rows when ctx.sample). `run` (optional) says which columns
   * are shown, for a loader that reads private data only when its column is chosen.
   */
  load: (f: ReportFilterValues, ctx: ReportContext, run?: ReportRunInfo) => Promise<Row[]>
  /** Optional key figures above the table (3 to 6). */
  figures?: (rows: Row[], f: ReportFilterValues) => ReportFigureDef[]
  /** Group-by choices: subtotals per group, or one summary row per group. */
  groups?: ReportGroupDef<Row>[]
  defaultSort?: { key: string; dir: 'asc' | 'desc' }
  /** i18n keys of "How the figures are counted" lines (printed and on the Excel summary). */
  notes?: string[]
  /** PDF orientation hint: wide reports print landscape. */
  wide?: boolean
  /**
   * Columns known only when the report runs (the clinic's own patient fields), after `columns`.
   * Loaded once per person (react-query).
   */
  extraColumns?: (ctx: ReportContext) => Promise<ReportColumnDef<Row>[]>
  /**
   * Column keys the loader reads only when they are shown (`run.columns`): choosing or removing
   * one loads the rows again (private data is read, and logged, only when it is printed).
   */
  fetchColumns?: string[]
  /** i18n key of what one row is ("Patients", "Payments"): the count column of a summary. */
  countLabel?: string
  /** The grouping the report opens with. */
  defaultGroup?: { key: string; mode?: 'details' | 'summary' }
  /** Where the totals go when the report opens (default: bottom). */
  defaultTotals?: ReportTotalsAt
}

/** Erase the row type so the catalogue can hold reports of different rows. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyReportDef = ReportDef<any>

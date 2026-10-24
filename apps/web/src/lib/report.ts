import type { ClinicProfile } from '@mmc/shared'
import {
  DASH,
  EXCEL,
  docDate,
  docDateTime,
  docMoney,
  docNumber,
  docTime,
  documentHtml,
  esc,
  escLines,
  excelDate,
  excelFooter,
  excelTextWidth,
  formatRwf,
  keyFiguresHtml,
  letterheadFrom,
  letterheadHtml,
  openPrintWindow,
  signatureHtml,
  titleBlockHtml,
  type CellValue,
  type DocLabels,
  type Letterhead,
  type ProfileLike,
} from '@/lib/doc-style'

/**
 * Management reports (dashboard, cashier day, laboratory, stock), following the clinic's
 * document design standard (C7 PDF, C8 / Part B Excel):
 *
 * - PDF: an A4 portrait print document with the compact letterhead, a title block (report no.,
 *   printed, prepared by), key figures, a one or two sentence summary, one headed table per
 *   detail section with its total as the last row, the cash count on a day close, and
 *   "Prepared by" / "Checked by" signature lines. The footer (clinic, report no., printed by,
 *   page x of y) is printed in the page margin boxes. Only a table with more than 7 columns
 *   moves to its own A4 landscape pages (a CSS named page); small tables (3 columns or fewer)
 *   sit side by side in two columns; tables of 12 rows or fewer are never split.
 * - Excel: Arial 10, a "Summary" sheet first (key figures as Label | Value | Unit, the summary
 *   sentences, the cash count) then one sheet per table. Every sheet starts with the clinic,
 *   title, period and printed lines, the header on row 6 (frozen, filtered, repeated on print),
 *   typed cells (numbers, Kigali wall-clock dates), SUM() totals as the last row.
 */

export type Cell = string | number | null | undefined | Date
export interface ReportColumn {
  /** Column header, without the unit: money columns get " (RWF)" added. */
  label: string
  /** Kept for older callers; Excel widths follow the standard (text: longest value + 2). */
  width?: number
  /**
   * money → "12,500" (RWF in the header); number → "1,234"; date → dd/mm/yyyy;
   * datetime → dd/mm/yyyy HH:mm; time → HH:mm (single-day reports: the date is in "Period").
   */
  kind?: 'text' | 'number' | 'money' | 'date' | 'datetime' | 'time'
  align?: 'left' | 'right'
  /** A negative value prints bold with a "–" sign (cash count difference). */
  boldNegative?: boolean
  /**
   * PDF only: printed on a second line under the previous column's value (8 pt, secondary
   * colour) instead of as a column of its own, e.g. the file no. under the patient's name.
   * Excel keeps it as its own column.
   */
  under?: boolean
  /** PDF only: a width hint ("32%"). */
  pdfWidth?: string
  /** PDF only: the value never wraps (short status words, names of a few words). */
  nowrap?: boolean
}
export interface ReportTable {
  title: string
  /** One short line under the heading (what the table shows). */
  note?: string
  columns: ReportColumn[]
  rows: Cell[][]
  /** Columns (by index) summed in a last "Total" row. */
  totals?: number[]
}
/** A key figure: a typed value with its unit ("RWF" prints as "RWF 71,270"). */
export interface ReportFigure {
  label: string
  value: number
  /** 'RWF' for money, or a unit word ("min", "of 10"); none for a plain count. */
  unit?: string
}
/** @deprecated use ReportFigure */
export type ReportSummaryItem = ReportFigure
export interface ReportSection {
  /** Groups tables in the builder; each table becomes its own PDF section and Excel sheet. */
  name: string
  tables: ReportTable[]
}
/** The wording report.ts needs beyond the shared document labels. */
export interface ReportWords {
  reportNo: string
  printed: string
  preparedBy: string
  checkedBy: string
  period: string
  total: string
  /** Name of the first Excel sheet. */
  summarySheet: string
  figure: string
  value: string
  unit: string
}
export interface Report {
  title: string
  /** "01/10/2026 to 20/10/2026" or a single day. */
  period: string
  clinic: ClinicProfile
  /** Full name of the user who prepares (prints or downloads) the report. */
  producedBy: string
  sections: ReportSection[]
  /** File stem without extension. */
  fileName: string
  /** Short report code (DAY, ACT, LAB, STK) and period key (yyyymmdd or yyyymmdd-yyyymmdd). */
  code: string
  periodKey: string
  /** 3 to 6 key figures. */
  figures?: ReportFigure[]
  /** One or two plain sentences under the key figures. */
  summaryText?: string
  /** Day close only: expected and counted cash (after the detail sections). */
  cashCount?: ReportTable
  doc: DocLabels
  words: ReportWords
  /** Defaults to the clinic profile with the logo of this site. */
  letterhead?: Letterhead
  /** Defaults to now. */
  printedAt?: Date
  /** Interface language of the wording (html lang). */
  lang?: string
}
/** The labels the report buttons pass (older wording); the report carries its own words. */
export interface ReportButtonLabels {
  period: string
  producedBy: string
  producedAt: string
  total: string
  page?: string
}

export const reportNumber = (r: Pick<Report, 'code' | 'periodKey'>) =>
  `RPT-${r.code}-${r.periodKey}`

const isNumKind = (k: ReportColumn['kind']) => k === 'money' || k === 'number'
const isDateKind = (k: ReportColumn['kind']) => k === 'date' || k === 'datetime' || k === 'time'
const isRight = (c: ReportColumn) =>
  c.align === 'right' || (c.align !== 'left' && isNumKind(c.kind))

/**
 * The column header with its unit: money columns read "Amount (RWF)". A label that already ends
 * in a parenthesis takes the unit inside it ("Value (at cost, RWF)"), never "(…) (RWF)".
 */
export const headerLabel = (c: ReportColumn) => {
  if (c.kind !== 'money' || /\bRWF\b/.test(c.label)) return c.label
  return /\)\s*$/.test(c.label) ? c.label.replace(/\)\s*$/, ', RWF)') : `${c.label} (RWF)`
}

/** Tables with at least one row (empty sections are left out). */
const tablesOf = (r: Report) => r.sections.flatMap((s) => s.tables).filter((t) => t.rows.length > 0)

const MAX_PORTRAIT_COLUMNS = 7
/** At most this many columns: a small table, printed in one half of the page. */
const MAX_HALF_COLUMNS = 3
/** At most this many rows (the total row included): the table is never split across pages. */
const MAX_KEEP_ROWS = 12

/** A printed column with the columns printed under it (`under`). */
interface PdfColumn {
  col: ReportColumn
  index: number
  under: { col: ReportColumn; index: number }[]
}
function pdfColumns(t: ReportTable): PdfColumn[] {
  const out: PdfColumn[] = []
  t.columns.forEach((col, index) => {
    const prev = out[out.length - 1]
    if (col.under && prev) prev.under.push({ col, index })
    else out.push({ col, index, under: [] })
  })
  return out
}
/** The PDF table needs a landscape page (more than 7 printed columns). */
const isWidePdf = (t: ReportTable) => pdfColumns(t).length > MAX_PORTRAIT_COLUMNS
/** The Excel sheet prints landscape (more than 7 columns). */
const isWideSheet = (t: ReportTable) => t.columns.length > MAX_PORTRAIT_COLUMNS
const isHalf = (t: ReportTable) => pdfColumns(t).length <= MAX_HALF_COLUMNS
const keepWhole = (t: ReportTable) => t.rows.length + (t.totals?.length ? 1 : 0) <= MAX_KEEP_ROWS

const sumColumn = (t: ReportTable, i: number) =>
  t.rows.reduce<number>((s, r) => s + (typeof r[i] === 'number' ? (r[i] as number) : 0), 0)

/** "RWF 71,270", "18 min", "3 of 10" or "6". */
export function figureText(f: ReportFigure): string {
  if (f.unit === 'RWF') return formatRwf(Math.round(f.value))
  const n = docNumber(f.value)
  return f.unit ? `${n} ${f.unit}` : n
}

// ---------------------------------------------------------------- PDF (print document)

/** Negative values with an en dash ("–1,200"), never a hyphen. */
const signed = (n: number, format: (n: number) => string) => (n < 0 ? `–${format(-n)}` : format(n))
/** A value that must not break across lines (date-times, file numbers, codes). */
const keep = (text: string): CellValue => ({ html: `<span class="nw">${esc(text)}</span>` })

/** Free text for a cell: escaped, line breaks kept, "x10^9" written as ×10⁹ (superscript). */
const textHtml = (s: string) =>
  escLines(s).replace(/(^|[\d\s(])[x×] ?10\^(-?\d+)/g, '$1×10<sup>$2</sup>')

function pdfCell(c: Cell, col: ReportColumn | undefined): CellValue {
  const kind = col?.kind
  if (c == null || c === '') return null
  if (c instanceof Date || (isDateKind(kind) && typeof c === 'string')) {
    const text = kind === 'date' ? docDate(c) : kind === 'time' ? docTime(c) : docDateTime(c)
    if (text) return keep(text)
  }
  if (typeof c === 'number') {
    if (kind !== 'money' && kind !== 'number') return keep(String(c))
    const text = esc(signed(c, kind === 'money' ? docMoney : docNumber))
    return { html: col?.boldNegative && c < 0 ? `<strong>${text}</strong>` : text }
  }
  const s = String(c)
  // one token (file no., receipt no., code, reference) stays on one line
  return /\s/.test(s) ? { html: textHtml(s) } : keep(s)
}

const cellHtml = (v: CellValue, empty: string): string => {
  if (v != null && typeof v === 'object') return v.html
  if (v == null || v === '') return empty
  return typeof v === 'number' ? esc(docNumber(v)) : textHtml(v)
}

/**
 * A detail table (A10, the shared `.dt` rules): header rule, hairline rows, right-aligned
 * tabular figures, "–" for an empty cell, the total as the last row. A column marked `under`
 * prints on a second line in the previous column's cell.
 */
function pdfTable(t: ReportTable, total: string): string {
  const cols = pdfColumns(t)
  const cls = (p: PdfColumn) =>
    [isRight(p.col) ? 'num' : '', p.col.nowrap ? 'nw' : ''].filter(Boolean).join(' ')
  const attr = (p: PdfColumn) => (cls(p) ? ` class="${cls(p)}"` : '')
  const subs = (parts: string[]) => parts.map((x) => `<div class="sub">${x}</div>`).join('')
  const head = cols
    .map(
      (p) =>
        `<th${attr(p)}${p.col.pdfWidth ? ` style="width:${esc(p.col.pdfWidth)}"` : ''}>${esc(
          headerLabel(p.col),
        )}${subs(p.under.map((u) => esc(headerLabel(u.col))))}</th>`,
    )
    .join('')
  const body = t.rows
    .map(
      (r) =>
        `<tr>${cols
          .map((p) => {
            const under = p.under
              .map((u) => pdfCell(r[u.index], u.col))
              .filter((v) => v != null && v !== '')
              .map((v) => cellHtml(v, ''))
            return `<td${attr(p)}>${cellHtml(pdfCell(r[p.index], p.col), DASH)}${subs(under)}</td>`
          })
          .join('')}</tr>`,
    )
    .join('')
  const totals = t.totals?.length
    ? `<tr class="total grand">${cols
        .map((p, i) => {
          const v =
            i === 0
              ? esc(total)
              : t.totals!.includes(p.index)
                ? cellHtml(pdfCell(sumColumn(t, p.index), p.col), '')
                : ''
          return `<td${attr(p)}>${v}</td>`
        })
        .join('')}</tr>`
    : ''
  return `<table class="dt"><thead><tr>${head}</tr></thead><tbody>${body}${totals}</tbody></table>`
}

/** Layout specific to management reports, on top of the shared document CSS. */
const REPORT_CSS = `
.summary-text { margin: 0 0 4pt; }
.table-note { margin: -1pt 0 3pt; }
.nw { white-space: nowrap; }
.dt td { overflow-wrap: break-word; }
.dt td.nw, .dt th.nw { white-space: nowrap; }
/* a long figure header ("Value at cost (RWF)") may wrap; the figures never do */
.dt th.num { white-space: normal; }
/* a second line in a cell (file no. under the patient's name) */
.dt .sub { font-size: var(--fs-small); color: var(--ink-2); }
.dt th .sub { font-weight: 400; }
/* small tables (3 columns or fewer) side by side, each heading rule as wide as its table */
.pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); column-gap: 10mm; align-items: start; }
.pair > .rs { min-width: 0; }
/* short tables are never split; a long table never leaves its total or last row alone */
.rs.keep, .pair.keep { break-inside: avoid; page-break-inside: avoid; }
.dt tr.total { break-before: avoid; page-break-before: avoid; }
.dt tbody tr:nth-last-child(2) { break-after: avoid; page-break-after: avoid; }
/* a table with more than 7 columns gets its own A4 landscape pages; the rest stays portrait */
@page wide { size: A4 landscape; margin: 15mm 18mm 20mm; }
.rs.wide { page: wide; }
.rs.wide > h2:first-child { margin-top: 0; }
/* the signature lines stay on the last landscape page when the report ends with a wide table */
.wide-tail { page: wide; }
/* the signature lines never stand alone at the top of a page: the last rows come with them */
.sig-wrap, .wide-tail { break-before: avoid; page-break-before: avoid; }
`

/** One headed table. */
const sectionHtml = (t: ReportTable, total: string, extra = '') => {
  const cls = ['rs', isWidePdf(t) ? 'wide' : '', keepWhole(t) ? 'keep' : '', extra]
    .filter(Boolean)
    .join(' ')
  return `<section class="${cls}"><h2>${esc(t.title)}</h2>${
    t.note ? `<p class="small table-note">${esc(t.note)}</p>` : ''
  }${pdfTable(t, total)}</section>`
}

/**
 * The detail tables. Two consecutive small tables share a row, each in one half of the page:
 * two short ones are kept whole together; with one long table, the long one goes on the left so
 * it can run on to the next page in its own column. Two long small tables each take a half row.
 */
function sectionsHtml(tables: ReportTable[], total: string): string {
  const out: string[] = []
  for (let i = 0; i < tables.length; i++) {
    const a = tables[i]
    if (!a) continue
    if (!isHalf(a)) {
      out.push(sectionHtml(a, total))
      continue
    }
    const next = tables[i + 1]
    const b = next && isHalf(next) && (keepWhole(a) || keepWhole(next)) ? next : null
    if (b) i++
    const pair: ReportTable[] = b ? (keepWhole(b) ? [a, b] : [b, a]) : [a]
    const keepPair = pair.every(keepWhole)
    out.push(
      `<div class="pair${keepPair ? ' keep' : ''}">${pair.map((t) => sectionHtml(t, total)).join('')}</div>`,
    )
  }
  return out.join('')
}

/** The full HTML of the PDF report (pure, so it can be rendered outside the app). */
export function reportHtml(report: Report, opts: { autoPrint?: boolean } = {}): string {
  const l = report.doc
  const w = report.words
  const at = report.printedAt ?? new Date()
  const no = reportNumber(report)
  const lh =
    report.letterhead ??
    letterheadFrom(report.clinic as unknown as ProfileLike, l, {
      logoUrl: `${window.location.origin}/logo.jpg`,
    })
  const tables = tablesOf(report)
  const cash = report.cashCount?.rows.length ? report.cashCount : null
  const sections = sectionsHtml(tables, w.total)
  const last = cash ?? tables[tables.length - 1]
  const signatures = signatureHtml(
    [
      { heading: w.preparedBy, name: report.producedBy },
      { heading: w.checkedBy, name: '' },
    ],
    l,
    { stamp: false, note: false },
  )

  const body = [
    letterheadHtml(lh, l, 'compact'),
    titleBlockHtml({
      title: report.title,
      scope: `${w.period}: ${report.period}`,
      meta: [
        [w.reportNo, no],
        [w.printed, docDateTime(at)],
        [w.preparedBy, report.producedBy],
      ],
    }),
    report.figures?.length
      ? keyFiguresHtml(report.figures.map((f) => ({ label: f.label, value: figureText(f) })))
      : '',
    report.summaryText ? `<p class="summary-text">${esc(report.summaryText)}</p>` : '',
    sections,
    cash ? sectionHtml(cash, w.total) : '',
    last && isWidePdf(last) ? `<div class="wide-tail">${signatures}</div>` : signatures,
  ].join('')

  return documentHtml({
    base: {
      page: 'a4',
      title: report.title,
      docNo: no,
      clinicName: lh.legalName,
      printedBy: report.producedBy,
      printedAt: at,
      labels: l,
    },
    css: REPORT_CSS,
    body,
    lang: report.lang ?? 'en',
    autoPrint: opts.autoPrint,
  })
}

/** The report's own words, with the buttons' older labels as a fallback. */
const withButtonLabels = (report: Report, labels?: ReportButtonLabels): Report =>
  labels
    ? {
        ...report,
        words: {
          ...report.words,
          period: report.words.period || labels.period,
          total: report.words.total || labels.total,
        },
      }
    : report

/** Opens the report in a print window ("Save as PDF"). False when the browser blocked it. */
export function openPdf(report: Report, labels?: ReportButtonLabels): boolean {
  return openPrintWindow(reportHtml(withButtonLabels(report, labels)))
}

// ---------------------------------------------------------------- Excel

type ExcelJSModule = typeof import('exceljs')
type Workbook = InstanceType<ExcelJSModule['Workbook']>
type Worksheet = ReturnType<Workbook['addWorksheet']>
type ExcelCell = ReturnType<Worksheet['getCell']>

const BLACK = { argb: 'FF000000' }
const thin = { style: 'thin' as const, color: BLACK }
const medium = { style: 'medium' as const, color: BLACK }

/** A sheet name: no : \ / ? * [ ], 31 characters at most, unique in the workbook. */
function sheetName(wb: Workbook, wanted: string): string {
  const base =
    wanted
      .replace(/[:\\/?*[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Sheet'
  // too long: cut at the last whole word that fits
  const fit = (max: number) => {
    if (base.length <= max) return base
    const cut = base.slice(0, max + 1)
    const space = cut.lastIndexOf(' ')
    return (space > max / 2 ? cut.slice(0, space) : base.slice(0, max)).replace(/[\s,;–-]+$/, '')
  }
  let name = fit(31)
  for (let i = 2; wb.worksheets.some((s) => s.name.toLowerCase() === name.toLowerCase()); i++) {
    const suffix = ` (${i})`
    name = `${fit(31 - suffix.length)}${suffix}`
  }
  return name
}

/** Excel format of a time of day (the cell still holds the full Kigali date and time). */
const TIME_FMT = 'hh:mm'
/** Excel width of a time column. */
const TIME_WIDTH = 10

/** Text for an Excel cell: "x10^9" written with superscript figures (×10⁹). */
const SUPERSCRIPT: Record<string, string> = {
  '-': '⁻',
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
}
const excelText = (s: string) =>
  s.replace(
    /(^|[\d\s(])[x×] ?10\^(-?\d+)/g,
    (_, pre: string, exp: string) =>
      `${pre}×10${[...exp].map((ch) => SUPERSCRIPT[ch] ?? ch).join('')}`,
  )

const excelFmt = (col: ReportColumn | undefined): string | undefined => {
  switch (col?.kind) {
    case 'money':
      return col.boldNegative ? '#,##0;"–"#,##0' : EXCEL.fmt.money
    case 'number':
      return EXCEL.fmt.count
    case 'date':
      return EXCEL.fmt.date
    case 'datetime':
      return EXCEL.fmt.datetime
    case 'time':
      return TIME_FMT
    default:
      return undefined
  }
}

/** Writes one value with its real type (number, Kigali wall-clock date, text). */
function writeCell(cell: ExcelCell, c: Cell, col: ReportColumn | undefined) {
  const kind = col?.kind
  const right = col?.align === 'right' || (col?.align !== 'left' && isNumKind(kind))
  cell.alignment = { horizontal: right ? 'right' : 'left', vertical: 'top' }
  if (c == null || c === '') return
  if (c instanceof Date || (isDateKind(kind) && typeof c === 'string')) {
    const d = excelDate(c)
    if (d) {
      cell.value = d
      cell.numFmt =
        kind === 'date' ? EXCEL.fmt.date : kind === 'time' ? TIME_FMT : EXCEL.fmt.datetime
      cell.alignment = { horizontal: 'left', vertical: 'top' }
      return
    }
  }
  if (typeof c === 'number') {
    cell.value = c
    const fmt = excelFmt(col) ?? EXCEL.fmt.count
    if (fmt) cell.numFmt = fmt
    if (col?.boldNegative && c < 0) cell.font = { ...EXCEL.font, bold: true }
    return
  }
  cell.value = excelText(String(c))
}

const columnLetter = (n: number): string => {
  let s = ''
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26))
    s = String.fromCharCode(65 + ((x - 1) % 26)) + s
  return s
}

/** Rows 1 to 4 of every sheet: clinic, title, period, printed (row 5 stays empty). */
function sheetHead(ws: Worksheet, report: Report, legalName: string, at: Date) {
  const l = report.doc
  const lines: [string, Partial<ExcelCell['font']>][] = [
    [legalName, EXCEL.clinicFont],
    [report.title, EXCEL.titleFont],
    [`${report.words.period}: ${report.period}`, EXCEL.font],
    [l.printedBy(docDateTime(at), report.producedBy), EXCEL.font],
  ]
  lines.forEach(([text, font], i) => {
    const cell = ws.getCell(i + 1, 1)
    cell.value = text
    cell.font = { ...font }
    cell.alignment = { horizontal: 'left', vertical: 'middle' }
  })
}

/** The header row: Arial 10 bold, no fill, medium black rule under it, wrapped, centred. */
function headerRow(ws: Worksheet, row: number, labels: string[], right: boolean[]) {
  labels.forEach((label, i) => {
    const cell = ws.getCell(row, i + 1)
    cell.value = label
    cell.font = { ...EXCEL.headerFont }
    cell.alignment = {
      horizontal: right[i] ? 'right' : 'left',
      vertical: 'middle',
      wrapText: true,
    }
    cell.border = { bottom: medium }
  })
}

/** A table from `row` (its header) down; returns the next free row. */
function writeTable(ws: Worksheet, row: number, t: ReportTable, total: string): number {
  const right = t.columns.map(isRight)
  headerRow(ws, row, t.columns.map(headerLabel), right)
  const first = row + 1
  t.rows.forEach((r, ri) => {
    t.columns.forEach((col, i) => writeCell(ws.getCell(first + ri, i + 1), r[i], col))
  })
  let next = first + t.rows.length
  if (t.totals?.length && t.rows.length) {
    const last = next - 1
    t.columns.forEach((col, i) => {
      const cell = ws.getCell(next, i + 1)
      cell.font = { ...EXCEL.font, bold: true }
      cell.border = { top: thin }
      cell.alignment = { horizontal: i === 0 || !right[i] ? 'left' : 'right', vertical: 'top' }
      if (i === 0) cell.value = total
      else if (t.totals!.includes(i)) {
        const L = columnLetter(i + 1)
        cell.value = { formula: `SUM(${L}${first}:${L}${last})`, result: sumColumn(t, i) }
        cell.numFmt = excelFmt(col) ?? EXCEL.fmt.count
      }
    })
    next++
  }
  return next
}

/** Column widths: text = longest value + 2 (10 to 50), numbers 14, date-time 17. */
function setWidths(ws: Worksheet, columns: ReportColumn[], rows: Cell[][]) {
  columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1)
    if (c.kind === 'datetime') col.width = EXCEL.widths.datetime
    else if (c.kind === 'time') col.width = TIME_WIDTH
    else if (c.kind === 'date' || isNumKind(c.kind)) col.width = EXCEL.widths.number
    else col.width = excelTextWidth(rows.map((r) => r[i]))
  })
}

/** Print setup: A4, fit to width, margins, header row repeated, standard footer. */
function printSetup(
  ws: Worksheet,
  report: Report,
  legalName: string,
  at: Date,
  landscape: boolean,
) {
  ws.pageSetup = {
    paperSize: 9,
    orientation: landscape ? 'landscape' : 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { ...EXCEL.margins },
    printTitlesRow: `${EXCEL.headerRow}:${EXCEL.headerRow}`,
  }
  ws.headerFooter.oddFooter = excelFooter({
    clinicName: legalName,
    reportNo: reportNumber(report),
    printedBy: report.producedBy,
    printedAt: at,
    labels: report.doc,
  })
}

/** Arial 10 for every cell of the used columns, also those typed in later. */
function defaultFont(ws: Worksheet, count: number) {
  for (let i = 1; i <= count; i++) ws.getColumn(i).font = { ...EXCEL.font }
}

function newSheet(wb: Workbook, name: string, columns: number) {
  const ws = wb.addWorksheet(sheetName(wb, name), {
    views: [{ state: 'frozen', ySplit: EXCEL.headerRow, showGridLines: true }],
  })
  defaultFont(ws, Math.max(columns, 3))
  return ws
}

/** Builds the workbook (pure: no download), so it can be checked outside the app. */
export async function buildWorkbook(report: Report): Promise<Workbook> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  const at = report.printedAt ?? new Date()
  const legalName = report.letterhead?.legalName ?? (report.clinic.name || 'Muhazi Medical Clinic')
  const w = report.words
  wb.creator = legalName
  wb.lastModifiedBy = report.producedBy
  wb.title = report.title
  wb.created = at

  // ---- Summary: key figures (Label | Value | Unit), the summary sentences, the cash count
  const figures = report.figures ?? []
  const cash = report.cashCount?.rows.length ? report.cashCount : null
  if (figures.length || report.summaryText || cash) {
    const ws = newSheet(wb, w.summarySheet, cash ? cash.columns.length : 3)
    sheetHead(ws, report, legalName, at)
    let row: number = EXCEL.headerRow
    const figColumns: ReportColumn[] = [
      { label: w.figure },
      { label: w.value, kind: 'number' },
      { label: w.unit },
    ]
    const figRows: Cell[][] = figures.map((f) => [f.label, f.value, f.unit ?? ''])
    if (figures.length) {
      headerRow(ws, row, figColumns.map(headerLabel), [false, true, false])
      figures.forEach((f, i) => {
        writeCell(ws.getCell(row + 1 + i, 1), f.label, figColumns[0])
        const v = ws.getCell(row + 1 + i, 2)
        writeCell(v, f.value, figColumns[1])
        v.numFmt = Number.isInteger(f.value) || f.unit === 'RWF' ? EXCEL.fmt.count : '#,##0.0'
        writeCell(ws.getCell(row + 1 + i, 3), f.unit ?? '', figColumns[2])
      })
      ws.autoFilter = { from: { row, column: 1 }, to: { row, column: 3 } }
      row += figures.length + 2
    }
    if (report.summaryText) {
      const cell = ws.getCell(row, 1)
      cell.value = report.summaryText
      cell.font = { ...EXCEL.font }
      row += 2
    }
    if (cash) {
      const title = ws.getCell(row, 1)
      title.value = cash.title
      title.font = { ...EXCEL.titleFont }
      writeTable(ws, row + 1, cash, w.total)
    }
    // widths: the figures and the cash count share columns A to C
    setWidths(ws, figColumns, figRows)
    if (cash) {
      cash.columns.forEach((c, i) => {
        const col = ws.getColumn(i + 1)
        const want =
          c.kind === 'datetime'
            ? EXCEL.widths.datetime
            : c.kind === 'time'
              ? TIME_WIDTH
              : isNumKind(c.kind) || c.kind === 'date'
                ? EXCEL.widths.number
                : excelTextWidth(cash.rows.map((r) => r[i]))
        col.width = Math.max(col.width ?? 0, want)
      })
    }
    printSetup(ws, report, legalName, at, !!cash && isWideSheet(cash))
  }

  // ---- one sheet per table
  for (const t of tablesOf(report)) {
    const ws = newSheet(wb, t.title, t.columns.length)
    sheetHead(ws, report, legalName, at)
    writeTable(ws, EXCEL.headerRow, t, w.total)
    ws.autoFilter = {
      from: { row: EXCEL.headerRow, column: 1 },
      to: { row: EXCEL.headerRow, column: t.columns.length },
    }
    setWidths(ws, t.columns, t.rows)
    printSetup(ws, report, legalName, at, isWideSheet(t))
  }

  if (!wb.worksheets.length) {
    const ws = newSheet(wb, w.summarySheet, 3)
    sheetHead(ws, report, legalName, at)
    ws.getCell(EXCEL.headerRow, 1).value = DASH
    printSetup(ws, report, legalName, at, false)
  }
  return wb
}

/** Downloads the report as an .xlsx workbook. */
export async function downloadExcel(report: Report, labels?: ReportButtonLabels) {
  const wb = await buildWorkbook(withButtonLabels(report, labels))
  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${report.fileName}.xlsx`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

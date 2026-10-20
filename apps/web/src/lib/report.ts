import { formatDate, formatTime, type ClinicProfile } from '@mmc/shared'

/**
 * Professional reports: the same content as an Excel workbook (several sheets, headers,
 * number formats, totals, column widths) or as a PDF (a print-styled document opened in a new
 * window and sent to the browser's print dialog → "Save as PDF"). Every report carries the
 * clinic's name and address, the title, the period, who produced it and when.
 */

export type Cell = string | number | null | undefined | Date
export interface ReportColumn {
  /** Column header. */
  label: string
  /** Width in characters (Excel) ; ignored in the PDF. */
  width?: number
  /** Money → "#,##0 RWF"-style formatting; number → "#,##0"; date → dd/mm/yyyy. */
  kind?: 'text' | 'number' | 'money' | 'date' | 'datetime'
  align?: 'left' | 'right'
}
export interface ReportTable {
  title: string
  /** One short line under the title (what the table shows). */
  note?: string
  columns: ReportColumn[]
  rows: Cell[][]
  /** Columns (by index) to sum in a last "Total" row. */
  totals?: number[]
}
export interface ReportSummaryItem {
  label: string
  value: string | number
}
export interface ReportSection {
  /** Sheet name in Excel / heading in the PDF (≤ 31 chars for Excel). */
  name: string
  /** Key figures shown before the tables. */
  summary?: ReportSummaryItem[]
  tables: ReportTable[]
}
export interface Report {
  title: string
  /** "01/10/2026 – 20/10/2026" or a single day. */
  period: string
  clinic: ClinicProfile
  producedBy: string
  sections: ReportSection[]
  /** File stem without extension. */
  fileName: string
}

const money = (n: number) => `${Math.round(n).toLocaleString('en-US')} RWF`
const num = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
const cellText = (c: Cell, kind: ReportColumn['kind']): string => {
  if (c == null || c === '') return '—'
  if (c instanceof Date)
    return kind === 'datetime' ? `${formatDate(c)} ${formatTime(c)}` : formatDate(c)
  if (typeof c === 'number')
    return kind === 'money' ? money(c) : kind === 'number' ? num(c) : String(c)
  if (kind === 'date' || kind === 'datetime') {
    const d = new Date(c)
    if (!Number.isNaN(d.getTime()))
      return kind === 'datetime' ? `${formatDate(d)} ${formatTime(d)}` : formatDate(d)
  }
  return c
}
const totalsRow = (t: ReportTable): Cell[] | null => {
  if (!t.totals?.length) return null
  const row: Cell[] = t.columns.map(() => null)
  row[0] = 'Total'
  for (const i of t.totals)
    row[i] = t.rows.reduce((s, r) => s + (typeof r[i] === 'number' ? (r[i] as number) : 0), 0)
  return row
}

// ---------------------------------------------------------------- Excel
export async function downloadExcel(
  report: Report,
  labels: { period: string; producedBy: string; producedAt: string; total: string },
) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = report.clinic.name
  wb.created = new Date()
  const navy = 'FF0B2252'
  const teal = 'FF1F6F8B'
  const light = 'FFE6F1F5'

  for (const section of report.sections) {
    const ws = wb.addWorksheet(section.name.slice(0, 31), { views: [{ showGridLines: false }] })
    const width = Math.max(6, ...section.tables.map((t) => t.columns.length))
    // Letterhead
    ws.mergeCells(1, 1, 1, width)
    const h1 = ws.getCell(1, 1)
    h1.value = report.clinic.name
    h1.font = { bold: true, size: 16, color: { argb: navy } }
    ws.mergeCells(2, 1, 2, width)
    ws.getCell(2, 1).value = [
      report.clinic.sector,
      report.clinic.district,
      report.clinic.province,
      report.clinic.country,
    ]
      .filter(Boolean)
      .join(' · ')
    ws.getCell(2, 1).font = { size: 10, color: { argb: 'FF52606D' } }
    ws.mergeCells(3, 1, 3, width)
    ws.getCell(3, 1).value = [report.clinic.phone, report.clinic.email].filter(Boolean).join(' · ')
    ws.getCell(3, 1).font = { size: 10, color: { argb: 'FF52606D' } }
    ws.mergeCells(5, 1, 5, width)
    const title = ws.getCell(5, 1)
    title.value = `${report.title} — ${section.name}`
    title.font = { bold: true, size: 14, color: { argb: teal } }
    ws.getCell(6, 1).value = `${labels.period}: ${report.period}`
    ws.getCell(7, 1).value = `${labels.producedBy}: ${report.producedBy}`
    ws.getCell(8, 1).value =
      `${labels.producedAt}: ${formatDate(new Date())} ${formatTime(new Date())}`
    for (const r of [6, 7, 8]) ws.getCell(r, 1).font = { size: 10, color: { argb: 'FF52606D' } }
    let row = 10

    if (section.summary?.length) {
      for (const s of section.summary) {
        ws.getCell(row, 1).value = s.label
        ws.getCell(row, 1).font = { bold: true }
        const v = ws.getCell(row, 2)
        v.value = s.value
        if (typeof s.value === 'number') v.numFmt = '#,##0'
        v.alignment = { horizontal: 'left' }
        row++
      }
      row++
    }

    for (const table of section.tables) {
      ws.mergeCells(row, 1, row, Math.max(1, table.columns.length))
      ws.getCell(row, 1).value = table.title
      ws.getCell(row, 1).font = { bold: true, size: 12, color: { argb: navy } }
      row++
      if (table.note) {
        ws.mergeCells(row, 1, row, Math.max(1, table.columns.length))
        ws.getCell(row, 1).value = table.note
        ws.getCell(row, 1).font = { italic: true, size: 10, color: { argb: 'FF616E7C' } }
        row++
      }
      const header = ws.getRow(row)
      table.columns.forEach((c, i) => {
        const cell = header.getCell(i + 1)
        cell.value = c.label
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: teal } }
        cell.alignment = {
          horizontal: c.align ?? (c.kind === 'money' || c.kind === 'number' ? 'right' : 'left'),
          vertical: 'middle',
        }
        cell.border = { bottom: { style: 'thin', color: { argb: navy } } }
        const col = ws.getColumn(i + 1)
        col.width = Math.max(col.width ?? 0, c.width ?? Math.max(12, c.label.length + 2))
      })
      row++
      const all = [...table.rows]
      const tr = totalsRow(table)
      all.forEach((r, ri) => {
        const line = ws.getRow(row)
        r.forEach((c, i) => {
          const cell = line.getCell(i + 1)
          const kind = table.columns[i]?.kind
          if (c instanceof Date) {
            cell.value = c
            cell.numFmt = kind === 'datetime' ? 'dd/mm/yyyy hh:mm' : 'dd/mm/yyyy'
          } else if (typeof c === 'number') {
            cell.value = c
            cell.numFmt = kind === 'money' ? '#,##0 "RWF"' : '#,##0.##'
          } else if ((kind === 'date' || kind === 'datetime') && c) {
            const d = new Date(String(c))
            if (!Number.isNaN(d.getTime())) {
              cell.value = d
              cell.numFmt = kind === 'datetime' ? 'dd/mm/yyyy hh:mm' : 'dd/mm/yyyy'
            } else cell.value = c
          } else cell.value = c ?? ''
          cell.alignment = {
            horizontal:
              table.columns[i]?.align ?? (kind === 'money' || kind === 'number' ? 'right' : 'left'),
          }
          if (ri % 2 === 1)
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: light } }
          cell.border = { bottom: { style: 'hair', color: { argb: 'FFD9DEE3' } } }
        })
        row++
      })
      if (tr) {
        const line = ws.getRow(row)
        tr.forEach((c, i) => {
          const cell = line.getCell(i + 1)
          cell.value = i === 0 ? labels.total : (c ?? '')
          cell.font = { bold: true }
          if (typeof c === 'number')
            cell.numFmt = table.columns[i]?.kind === 'money' ? '#,##0 "RWF"' : '#,##0.##'
          cell.alignment = { horizontal: i === 0 ? 'left' : 'right' }
          cell.border = { top: { style: 'thin', color: { argb: navy } } }
        })
        row++
      }
      row += 2
    }
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    ws.headerFooter.oddFooter = `&L${report.clinic.name}&C${report.title}&RPage &P / &N`
  }

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

// ---------------------------------------------------------------- PDF (print document)
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function openPdf(
  report: Report,
  labels: { period: string; producedBy: string; producedAt: string; total: string; page: string },
) {
  const sections = report.sections
    .map((section) => {
      const summary = section.summary?.length
        ? `<div class="summary">${section.summary
            .map(
              (s) =>
                `<div class="kpi"><span class="k">${esc(s.label)}</span><span class="v">${esc(typeof s.value === 'number' ? num(s.value) : String(s.value))}</span></div>`,
            )
            .join('')}</div>`
        : ''
      const tables = section.tables
        .map((t) => {
          const tr = totalsRow(t)
          const head = t.columns
            .map(
              (c) =>
                `<th class="${c.align ?? (c.kind === 'money' || c.kind === 'number' ? 'r' : 'l')}">${esc(c.label)}</th>`,
            )
            .join('')
          const body = t.rows
            .map(
              (r) =>
                `<tr>${r.map((c, i) => `<td class="${t.columns[i]?.align ?? (t.columns[i]?.kind === 'money' || t.columns[i]?.kind === 'number' ? 'r' : 'l')}">${esc(cellText(c, t.columns[i]?.kind))}</td>`).join('')}</tr>`,
            )
            .join('')
          const foot = tr
            ? `<tr class="total">${tr.map((c, i) => `<td class="${i === 0 ? 'l' : 'r'}">${i === 0 ? esc(labels.total) : typeof c === 'number' ? esc(cellText(c, t.columns[i]?.kind)) : ''}</td>`).join('')}</tr>`
            : ''
          return `<h3>${esc(t.title)}</h3>${t.note ? `<p class="note">${esc(t.note)}</p>` : ''}<table><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${t.columns.length}" class="empty">—</td></tr>`}${foot}</tbody></table>`
        })
        .join('')
      return `<section><h2>${esc(section.name)}</h2>${summary}${tables}</section>`
    })
    .join('')

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(report.title)}</title>
<style>
  @page { size: A4 landscape; margin: 14mm 12mm 16mm; }
  body { font: 11pt/1.4 Inter, "Segoe UI", Arial, sans-serif; color: #1f2933; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #0b2252; padding-bottom: 8px; margin-bottom: 14px; }
  .clinic b { font-size: 16pt; color: #0b2252; display: block; }
  .clinic span { color: #52606d; font-size: 9.5pt; display: block; }
  .meta { text-align: right; font-size: 9.5pt; color: #52606d; }
  .meta b { display: block; font-size: 15pt; color: #1f6f8b; margin-bottom: 2px; }
  h2 { font-size: 13pt; color: #0b2252; margin: 18px 0 6px; border-left: 4px solid #1f6f8b; padding-left: 8px; }
  h3 { font-size: 11pt; margin: 14px 0 4px; color: #0b2252; }
  .note { margin: 0 0 6px; color: #616e7c; font-style: italic; font-size: 9.5pt; }
  .summary { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0 10px; }
  .kpi { border: 1px solid #d9dee3; border-radius: 6px; padding: 6px 10px; min-width: 150px; }
  .kpi .k { display: block; font-size: 8.5pt; color: #52606d; text-transform: uppercase; letter-spacing: .04em; }
  .kpi .v { display: block; font-size: 13pt; font-weight: 700; color: #0b2252; }
  table { border-collapse: collapse; width: 100%; font-size: 9.5pt; page-break-inside: auto; }
  th { background: #1f6f8b; color: #fff; text-align: left; padding: 5px 6px; font-weight: 600; }
  td { padding: 4px 6px; border-bottom: 1px solid #e6eaee; vertical-align: top; }
  tr:nth-child(even) td { background: #f4f8fb; }
  .r { text-align: right; font-variant-numeric: tabular-nums; } .l { text-align: left; }
  tr.total td { font-weight: 700; border-top: 2px solid #0b2252; background: #fff; }
  td.empty { text-align: center; color: #616e7c; }
  section { page-break-after: auto; }
  footer { font-size: 8.5pt; color: #616e7c; display: flex; justify-content: space-between; margin-top: 16px; border-top: 1px solid #d9dee3; padding-top: 4px; }
  @media print { footer { position: fixed; bottom: 0; left: 0; right: 0; margin: 0; border: 0; } }
  @media screen { body { padding: 20px; background: #eef2f5; } .sheet { background: #fff; padding: 24px; max-width: 1100px; margin: 0 auto; box-shadow: 0 6px 24px rgba(0,0,0,.1); } }
</style></head><body><div class="sheet">
<header><div class="clinic"><b>${esc(report.clinic.name)}</b><span>${esc([report.clinic.sector, report.clinic.district, report.clinic.province, report.clinic.country].filter(Boolean).join(' · '))}</span><span>${esc([report.clinic.phone, report.clinic.email].filter(Boolean).join(' · '))}</span></div>
<div class="meta"><b>${esc(report.title)}</b><span>${esc(labels.period)}: ${esc(report.period)}</span><br><span>${esc(labels.producedBy)}: ${esc(report.producedBy)}</span><br><span>${esc(labels.producedAt)}: ${esc(`${formatDate(new Date())} ${formatTime(new Date())}`)}</span></div></header>
${sections}
<footer><span>${esc(report.clinic.name)} · ${esc(report.title)}</span><span>${esc(report.period)}</span></footer>
</div><script>window.addEventListener('load', () => setTimeout(() => window.print(), 300))</script></body></html>`
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.open()
  w.document.write(html)
  w.document.close()
  return true
}

/**
 * Reads the official medicine list (RHIA / RSSB) the manager uploads: the Excel file the body
 * publishes (.xlsx) or a .csv. The header row is found by its column names (case and accents do
 * not matter: "DRUG_CODE", "Generic description", "Désignation", "Prix"…); the rows under it
 * become { row, code, generic, presentation, rule, unit, price, group }. A heading line such as
 * "A01 .STOMATOLOGICAL PREPARATIONS" gives the ATC group of the rows below it when the file has
 * no group column. A PDF cannot be read reliably: the caller asks for the Excel file instead.
 */

/** The columns of the list, in the order they are shown. */
export const REFERENCE_COLUMNS = [
  'code',
  'generic',
  'presentation',
  'rule',
  'unit',
  'price',
  'group',
] as const
export type ReferenceColumn = (typeof REFERENCE_COLUMNS)[number]

/** One row sent to the database (the row number is the file's, for the errors). */
export interface ReferenceRowInput {
  row: number
  code: string
  generic: string
  presentation: string | null
  rule: string | null
  unit: string | null
  /** A number, or the text as written when it is not one (the database says which row). */
  price: number | string | null
  group: string | null
}

export interface ParsedReferenceFile {
  rows: ReferenceRowInput[]
  /** The columns recognised in the header, and the ones not found. */
  columns: ReferenceColumn[]
  missing: ReferenceColumn[]
  /** The file's row number of the header. */
  headerRow: number
  sheet: string | null
  /** A title above the header ("RHIA REIMBURSABLE MEDICINES LIST JUNE 2026"), to suggest a name. */
  title: string | null
}

export type ReferenceFileProblem = 'pdf' | 'type' | 'noHeader' | 'empty' | 'unreadable'

export class ReferenceFileError extends Error {
  readonly problem: ReferenceFileProblem
  constructor(problem: ReferenceFileProblem) {
    super(problem)
    this.name = 'ReferenceFileError'
    this.problem = problem
  }
}

/** "Générique" → "generique", "DRUG_CODE" → "drug code". */
const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const has = (h: string, words: string[]) => {
  const parts = h.split(' ')
  return words.some((w) => (w.includes(' ') ? h.includes(w) : parts.includes(w)))
}

/** Which column a header names (null: none of the list's). The order settles "unit price". */
function columnOf(header: string): ReferenceColumn | null {
  const h = norm(header)
  if (!h) return null
  if (has(h, ['atc', 'group', 'groupe', 'class', 'classe', 'category', 'categorie', 'therapeutic']))
    return 'group'
  if (has(h, ['code', 'codes', 'kode'])) return 'code'
  if (has(h, ['generic', 'generique', 'generics', 'dci', 'inn', 'molecule'])) return 'generic'
  if (has(h, ['designation', 'presentation', 'strength', 'dosage', 'forme', 'brand', 'specialite']))
    return 'presentation'
  if (
    has(h, [
      'instruction',
      'instructions',
      'prescribing',
      'prescription',
      'rule',
      'rules',
      'regle',
      'niveau',
      'level',
    ])
  )
    return 'rule'
  if (has(h, ['price', 'prix', 'tariff', 'tarif', 'amount', 'montant', 'cost', 'rwf', 'frw']))
    return 'price'
  if (has(h, ['unit', 'unite', 'uom'])) return 'unit'
  if (has(h, ['description', 'name', 'nom', 'medicine', 'medicament', 'drug'])) return 'generic'
  return null
}

/** The text of a cell (Excel rich text, formulas, links, dates). */
function cellText(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim() || null
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (Array.isArray(o.richText))
      return cellText((o.richText as { text?: string }[]).map((x) => x.text ?? '').join(''))
    if ('result' in o) return cellText(o.result)
    if ('text' in o) return cellText(o.text)
  }
  return null
}

/** "9 345", "1,200.50", "RWF 300" → a number; anything else stays the text. */
function priceOf(raw: unknown): number | string | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  const s = cellText(raw)
  if (s == null) return null
  const n = s.replace(/rwf|frw|frs?/gi, '').replace(/[\s,]/g, '')
  return /^\d+(\.\d+)?$/.test(n) ? Number(n) : s
}

const SECTION = /^([A-Z]\d{2}[A-Z]{0,2})\s*\.?\s*-?\s*(.+)$/

/** The rows of one sheet (or the CSV), each with its row number: cells as they came. */
type Sheet = { name: string | null; rows: { n: number; cells: unknown[] }[] }

function readSheet(sheet: Sheet): ParsedReferenceFile | null {
  // the header: among the first 40 rows, the one naming the most columns, with code and generic
  let best: { at: number; map: Map<number, ReferenceColumn> } | null = null
  for (const [at, r] of sheet.rows.slice(0, 40).entries()) {
    const map = new Map<number, ReferenceColumn>()
    const seen = new Set<ReferenceColumn>()
    r.cells.forEach((c, i) => {
      const text = cellText(c)
      const col = text ? columnOf(text) : null
      if (col && !seen.has(col)) {
        seen.add(col)
        map.set(i, col)
      }
    })
    if (seen.has('code') && seen.has('generic') && (!best || map.size > best.map.size))
      best = { at, map }
  }
  if (!best) return null
  const header = sheet.rows[best.at]!
  const title =
    sheet.rows
      .slice(0, best.at)
      .flatMap((r) => r.cells.map(cellText))
      .filter((x): x is string => !!x && x.length > 8)[0] ?? null
  const columns = REFERENCE_COLUMNS.filter((c) => [...best.map.values()].includes(c))
  const at = (cells: unknown[], col: ReferenceColumn) => {
    for (const [i, c] of best.map) if (c === col) return cells[i]
    return undefined
  }
  const rows: ReferenceRowInput[] = []
  let section: string | null = null
  for (const r of sheet.rows.slice(best.at + 1)) {
    const code = cellText(at(r.cells, 'code'))
    const generic = cellText(at(r.cells, 'generic'))
    if (!code && !generic) {
      // a heading line: "A01 .STOMATOLOGICAL PREPARATIONS" names the group of the rows below
      const texts = r.cells.map(cellText).filter((x): x is string => !!x)
      const m = texts.length === 1 ? SECTION.exec(texts[0]!) : null
      if (m) section = `${m[1]} · ${m[2]!.trim()}`
      continue
    }
    rows.push({
      row: r.n,
      code: (code ?? '').replace(/\s+/g, '').toUpperCase(),
      generic: generic ?? '',
      presentation: cellText(at(r.cells, 'presentation')),
      rule: cellText(at(r.cells, 'rule')),
      unit: cellText(at(r.cells, 'unit')),
      price: priceOf(at(r.cells, 'price')),
      group: cellText(at(r.cells, 'group')) ?? section,
    })
  }
  return {
    rows,
    columns,
    missing: REFERENCE_COLUMNS.filter((c) => !columns.includes(c)),
    headerRow: header.n,
    sheet: sheet.name,
    title,
  }
}

/** A CSV (comma, semicolon or tab), quotes as in RFC 4180. */
function csvRows(text: string): Sheet['rows'] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const count = (ch: string) => firstLine.split(ch).length - 1
  const sep = [';', '\t', ','].reduce((a, b) => (count(b) > count(a) ? b : a), ',')
  const out: Sheet['rows'] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let n = 1
  const endRow = () => {
    row.push(cell)
    if (row.some((c) => c.trim() !== '')) out.push({ n, cells: row })
    row = []
    cell = ''
    n++
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === sep) {
      row.push(cell)
      cell = ''
    } else if (c === '\n') endRow()
    else if (c !== '\r') cell += c
  }
  if (cell !== '' || row.length) endRow()
  return out
}

/** Reads the file the manager chose. Throws ReferenceFileError with what went wrong. */
export async function readReferenceFile(file: File): Promise<ParsedReferenceFile> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf') || file.type === 'application/pdf') throw new ReferenceFileError('pdf')
  let sheets: Sheet[]
  try {
    if (name.endsWith('.csv') || file.type === 'text/csv') {
      // a CSV saved by Excel starts with the byte-order mark
      const text = await file.text()
      sheets = [{ name: null, rows: csvRows(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) }]
    } else if (name.endsWith('.xlsx')) {
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(await file.arrayBuffer())
      sheets = wb.worksheets.map((ws) => {
        const rows: Sheet['rows'] = []
        ws.eachRow({ includeEmpty: false }, (r, n) => {
          // exceljs rows are 1-based (index 0 is empty)
          const v = r.values
          rows.push({ n, cells: Array.isArray(v) ? v.slice(1) : [] })
        })
        return { name: ws.name, rows }
      })
    } else {
      throw new ReferenceFileError('type')
    }
  } catch (e) {
    if (e instanceof ReferenceFileError) throw e
    throw new ReferenceFileError('unreadable')
  }
  // the first sheet with a header (the list); the others are its legend and notes
  for (const s of sheets) {
    const parsed = readSheet(s)
    if (parsed) {
      if (parsed.rows.length === 0) throw new ReferenceFileError('empty')
      return parsed
    }
  }
  throw new ReferenceFileError('noHeader')
}

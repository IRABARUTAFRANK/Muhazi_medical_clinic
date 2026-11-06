import { DocumentError, loadDocument } from '@/lib/document-grids'
import { pdfToGrid } from '@/lib/price-list-file'
import type { TariffLineInput } from '@/lib/api/insurers'

/**
 * Reads an insurer's price list the manager uploads, in any kind of file lib/document-grids reads
 * (Excel .xlsx / .xls / .ods, CSV or text, a PDF with text, Word .docx / .odt, a web page). The header
 * row is found by its column names (case and accents do not matter: "Code", "Service",
 * "Désignation", "Tarif", "Prix MMI"…); the rows under it become { row, kind, code, name, price }.
 * A column naming the kind of line ("Type": medicine / service) is read when there is one; a
 * sheet named like the kind ("Medicines", "Actes") counts too. Without it the database decides
 * (a treatment first, then a medicine).
 */

/** The columns of a tariff, in the order they are shown. */
export const TARIFF_COLUMNS = ['code', 'name', 'price', 'kind'] as const
export type TariffColumn = (typeof TARIFF_COLUMNS)[number]

export interface ParsedTariffFile {
  lines: TariffLineInput[]
  /** The columns recognised in the header, and the ones not found. */
  columns: TariffColumn[]
  missing: TariffColumn[]
  /** The file's row number of the header. */
  headerRow: number
  sheet: string | null
  /** A title above the header, to suggest a name. */
  title: string | null
}

export type TariffFileProblem =
  'type' | 'noHeader' | 'empty' | 'unreadable' | 'pdfNoText' | 'oldWord' | 'image'

export class TariffFileError extends Error {
  readonly problem: TariffFileProblem
  constructor(problem: TariffFileProblem) {
    super(problem)
    this.name = 'TariffFileError'
    this.problem = problem
  }
}

/** "Désignation" → "designation", "PRIX_MMI" → "prix mmi". */
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

/** Which column a header names (null: none of the tariff's). */
function columnOf(header: string): TariffColumn | null {
  const h = norm(header)
  if (!h) return null
  if (has(h, ['type', 'kind', 'category', 'categorie', 'nature', 'genre'])) return 'kind'
  if (has(h, ['code', 'codes', 'kode', 'ref', 'reference'])) return 'code'
  if (
    has(h, ['price', 'prix', 'tariff', 'tarif', 'amount', 'montant', 'cost', 'rwf', 'frw', 'rate'])
  )
    return 'price'
  if (
    has(h, [
      'name',
      'nom',
      'designation',
      'description',
      'libelle',
      'service',
      'treatment',
      'acte',
      'actes',
      'prestation',
      'medicine',
      'medicament',
      'drug',
      'generic',
      'generique',
      'item',
      'izina',
    ])
  )
    return 'name'
  return null
}

/** A word that says a line is a medicine or a treatment (null: neither). */
export function kindOf(text: string | null | undefined): 'service' | 'item' | null {
  const h = norm(text ?? '')
  if (!h) return null
  if (/\b(medic|medoc|drug|pharma|umuti|imiti|item|produit|product|supply|consumable)/.test(h))
    return 'item'
  if (/\b(service|treatment|acte|prestation|soin|consult|exam|test|lab|procedure|serivisi)/.test(h))
    return 'service'
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
  // "12.500" (a dot between the thousands, as in French) is 12 500: francs have no cents
  if (/^\d{1,3}(\.\d{3})+$/.test(n)) return Number(n.replace(/\./g, ''))
  return /^\d+(\.\d+)?$/.test(n) ? Number(n) : s
}

/** The rows of one sheet (or the CSV), each with its row number: cells as they came. */
type Sheet = { name: string | null; rows: { n: number; cells: unknown[] }[] }

function readSheet(sheet: Sheet): ParsedTariffFile | null {
  // the header: among the first 40 rows, the one naming the most columns, with a name and a price
  let best: { at: number; map: Map<number, TariffColumn> } | null = null
  for (const [at, r] of sheet.rows.slice(0, 40).entries()) {
    const map = new Map<number, TariffColumn>()
    const seen = new Set<TariffColumn>()
    r.cells.forEach((c, i) => {
      const text = cellText(c)
      const col = text ? columnOf(text) : null
      if (col && !seen.has(col)) {
        seen.add(col)
        map.set(i, col)
      }
    })
    if (
      seen.has('price') &&
      (seen.has('name') || seen.has('code')) &&
      (!best || map.size > best.map.size)
    )
      best = { at, map }
  }
  if (!best) return null
  const header = sheet.rows[best.at]!
  const title =
    sheet.rows
      .slice(0, best.at)
      .flatMap((r) => r.cells.map(cellText))
      .filter((x): x is string => !!x && x.length > 8)[0] ?? null
  const columns = TARIFF_COLUMNS.filter((c) => [...best.map.values()].includes(c))
  const at = (cells: unknown[], col: TariffColumn) => {
    for (const [i, c] of best.map) if (c === col) return cells[i]
    return undefined
  }
  // a sheet named "Medicines" / "Actes": every line is of that kind unless a column says otherwise
  const sheetKind = kindOf(sheet.name)
  const lines: TariffLineInput[] = []
  let section: 'service' | 'item' | null = null
  for (const r of sheet.rows.slice(best.at + 1)) {
    const code = cellText(at(r.cells, 'code'))
    const name = cellText(at(r.cells, 'name'))
    const price = at(r.cells, 'price')
    if (!code && !name) continue
    if (price == null || cellText(price) == null) {
      // a heading line ("MEDICINES", "Actes dentaires"): the kind of the rows below it, when it says one
      const k = kindOf(name ?? code)
      if (k) section = k
      continue
    }
    lines.push({
      row: r.n,
      kind: kindOf(cellText(at(r.cells, 'kind'))) ?? section ?? sheetKind,
      code: code ? code.replace(/\s+/g, '').toUpperCase() : null,
      name: name ?? null,
      price: priceOf(price),
    })
  }
  return {
    lines,
    columns,
    missing: TARIFF_COLUMNS.filter((c) => !columns.includes(c)),
    headerRow: header.n,
    sheet: sheet.name,
    title,
  }
}

/** Reads the file the manager chose. Throws TariffFileError with what went wrong. */
export async function readTariffFile(file: File): Promise<ParsedTariffFile> {
  let sheets: Sheet[]
  try {
    sheets = (await loadDocument(file, pdfToGrid)).grids
  } catch (e) {
    const problem = e instanceof DocumentError ? e.problem : 'unreadable'
    throw new TariffFileError(problem === 'noTable' ? 'noHeader' : problem)
  }
  // every sheet with a header counts (a tariff may keep its treatments and medicines apart)
  const parts = sheets.map(readSheet).filter((p): p is ParsedTariffFile => !!p)
  if (parts.length === 0) throw new TariffFileError('noHeader')
  const first = parts[0]!
  const lines = parts.flatMap((p) => p.lines)
  if (lines.length === 0) throw new TariffFileError('empty')
  return {
    ...first,
    lines,
    sheet:
      parts.length > 1
        ? parts
            .map((p) => p.sheet)
            .filter(Boolean)
            .join(', ')
        : first.sheet,
  }
}

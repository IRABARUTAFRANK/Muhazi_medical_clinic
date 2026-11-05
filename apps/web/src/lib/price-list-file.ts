/**
 * Reads a published price list the manager uploads (Prices › Published price lists): the Ministry
 * of Health's tariff of treatments, RSSB / RHIA's list of medicines, an insurer's list. An Excel
 * file (.xlsx), a .csv or a PDF with text (not a scan).
 *
 * The header row is found by its column names (case, accents and punctuation do not matter):
 * the code ("RHIC", "DRUG_CODE", "ATC Code"; a second code column such as "ICHI CODE" is kept as
 * the other code), the name ("Procedure name", "Product Name", "GENERIC DESCRIPTION"; a second one
 * such as "DESIGNATION" is the detail), the section ("Speciality", "Pharmacological Group"), the
 * unit ("Selling Unit"), the instructions ("EC Instructions & Guideline", "INSTRUCTIONS") and the
 * row number ("SN", "No"). Every other column whose values are numbers is a PRICE column, kept
 * with its header ("RAMA; MMI", "Private Insurances", "Polyclinic **", "NEW PRICE"): a list may
 * have several prices, one per kind of payer or of facility. A heading row ("A01 .STOMATOLOGICAL
 * PREPARATIONS") gives the section of the rows below it; a row of text alone under the table
 * ("NC: Not covered by Edencare unless special pre-auth") is kept as a note of the file.
 *
 * A PDF is read with pdf.js: its text is put back into rows and columns by position (the header's
 * columns; a row starts at its number or its code; a price or a name written a little lower
 * belongs to the row above). Text outside the rows is kept as a note.
 */

export type ListRole =
  'code' | 'altCode' | 'name' | 'detail' | 'section' | 'unit' | 'note' | 'number' | 'price'

export interface PriceListColumn {
  key: string
  label: string
}

/** One line sent to the database (row: the file's row, for the messages). */
export interface PriceListLineInput {
  row: number
  code: string
  name: string
  detail: string | null
  section: string | null
  altCode: string | null
  unit: string | null
  note: string | null
  /** Per price column key: a number, the text as written when it is not one, or null. */
  prices: Record<string, number | string | null>
}

export interface ParsedPriceList {
  lines: PriceListLineInput[]
  /** The price columns, in the file's order. */
  columns: PriceListColumn[]
  /** What each recognised column is, for the screen ("ICHI CODE" → other code). */
  roles: { role: ListRole; label: string }[]
  headerRow: number
  sheet: string | null
  /** A title above the header, to suggest a name. */
  title: string | null
  /** Text of the file outside the lines (a legend, a remark). */
  notes: string[]
  /** Treatments or medicines, when the file says so. */
  kind: 'treatments' | 'medicines' | null
  /** yyyy-mm-dd: a month written in the title ("FEB2026", "JUNE 2026"), its first day. */
  from: string | null
  format: 'xlsx' | 'csv' | 'pdf'
}

export type PriceListFileProblem = 'type' | 'noHeader' | 'empty' | 'unreadable' | 'pdfNoText'

export class PriceListFileError extends Error {
  readonly problem: PriceListFileProblem
  constructor(problem: PriceListFileProblem) {
    super(problem)
    this.name = 'PriceListFileError'
    this.problem = problem
  }
}

/** The rows of one sheet (or the CSV, or the PDF put back in rows): cells as they came. */
export interface Grid {
  name: string | null
  rows: { n: number; cells: unknown[] }[]
  /** Text found outside the rows (PDF). */
  notes?: string[]
  /** Text above the table (PDF). */
  above?: string[]
}

// ---------------------------------------------------------------- words
/** "Désignation" → "designation", "PRICE_MMI" → "price mmi". */
export const norm = (s: string) =>
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

/** What a header names (null: none of the known columns; its values decide). */
export function roleOfHeader(header: string): ListRole | null {
  const h = norm(header)
  if (!h) return null
  if (/^(s ?n|sr ?no|no|n|nr|num|numero|serial( no)?|no drug( no group)?|n o)$/.test(h))
    return 'number'
  if (h.startsWith('no ') && h.length < 24 && !has(h, ['name', 'price', 'code'])) return 'number'
  if (
    has(h, [
      'instruction',
      'instructions',
      'guideline',
      'guidelines',
      'remark',
      'remarks',
      'observation',
      'observations',
      'comment',
      'comments',
      'condition',
      'conditions',
      'note',
      'notes',
      'rule',
      'rules',
      'restriction',
      'restrictions',
      'prescribing',
    ])
  )
    return 'note'
  if (
    has(h, [
      'speciality',
      'specialty',
      'specialite',
      'category',
      'categorie',
      'group',
      'groupe',
      'department',
      'departement',
      'section',
      'chapter',
      'chapitre',
      'class',
      'classe',
      'therapeutic',
    ])
  )
    return 'section'
  if (has(h, ['unit', 'unite', 'uom', 'selling unit', 'unit of sale'])) return 'unit'
  if (has(h, ['code', 'codes', 'kode', 'rhic', 'rltc', 'ref', 'reference', 'atc', 'loinc']))
    return 'code'
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
      'procedure',
      'procedures',
      'product',
      'produit',
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
      'examen',
      'exam',
      'test',
      'intervention',
    ])
  )
    return 'name'
  if (has(h, ['presentation', 'strength', 'dosage', 'form', 'forme'])) return 'detail'
  return null
}

/** The text of a cell (Excel rich text, formulas, links, dates). */
export function cellText(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim() || null
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null
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

/**
 * A price cell: a number; "9 345", "1,200.50", "RWF 300" → a number; a formula the file kept no
 * value for → "=G322" (the database says it is not a number); anything else stays the text.
 */
export function priceOf(raw: unknown): number | string | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (raw && typeof raw === 'object' && !('result' in raw)) {
    const o = raw as Record<string, unknown>
    const f = o.formula ?? o.sharedFormula
    if (typeof f === 'string') return `=${f}`
  }
  if (raw && typeof raw === 'object' && 'result' in raw) {
    const r = (raw as { result: unknown }).result
    if (typeof r === 'number') return Number.isFinite(r) ? r : null
    if (r && typeof r === 'object' && 'error' in r) return String((r as { error: unknown }).error)
  }
  const s = cellText(raw)
  if (s == null) return null
  const n = s.replace(/rwf|frw|frs?/gi, '').replace(/[\s,]/g, '')
  if (n === '' || n === '-') return null
  return /^\d+(\.\d+)?$/.test(n) ? Number(n) : s
}

const isNumberLike = (v: unknown) => typeof priceOf(v) === 'number'
/** A code: letters and digits (dots, dashes, slashes), at least one digit, no spaces. */
const CODE_LIKE = /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9.\-/_]{2,39}$/
/** An ATC-based medicine code (N05AA01003, A03B001, V07AB001). */
const ATC_LIKE = /^[A-Z]\d{2}[A-Z]{0,2}\d{0,2}\d{3}$/

const MONTHS: Record<string, number> = {
  jan: 1,
  janv: 1,
  january: 1,
  janvier: 1,
  feb: 2,
  fev: 2,
  february: 2,
  fevrier: 2,
  mar: 3,
  march: 3,
  mars: 3,
  apr: 4,
  april: 4,
  avr: 4,
  avril: 4,
  may: 5,
  mai: 5,
  jun: 6,
  june: 6,
  juin: 6,
  jul: 7,
  july: 7,
  juil: 7,
  juillet: 7,
  aug: 8,
  august: 8,
  aout: 8,
  sep: 9,
  sept: 9,
  september: 9,
  septembre: 9,
  oct: 10,
  october: 10,
  octobre: 10,
  nov: 11,
  november: 11,
  novembre: 11,
  dec: 12,
  december: 12,
  decembre: 12,
}

/** "…FEB2026", "EFFECTIVE FROM JUNE 2026", "June-2026" → the first day of that month. */
export function monthIn(text: string): string | null {
  const t = norm(text).replace(/([a-z])(\d{4})/g, '$1 $2')
  const m = t.match(
    /\b(jan|janv|january|janvier|feb|fev|february|fevrier|mar|march|mars|apr|april|avr|avril|may|mai|jun|june|juin|jul|july|juil|juillet|aug|august|aout|sep|sept|september|septembre|oct|october|octobre|nov|november|novembre|dec|december|decembre)\s+(20\d{2})\b/,
  )
  if (!m) return null
  return `${m[2]}-${String(MONTHS[m[1]!]).padStart(2, '0')}-01`
}

/** "Private Insurances" → "private_insurances"; "RAMA; MMI" → "rama_mmi". */
export function keyOf(label: string, taken: Set<string>): string {
  const base = norm(label).replace(/ /g, '_').slice(0, 36) || 'price'
  let key = base
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`
  taken.add(key)
  return key
}

// ---------------------------------------------------------------- one sheet
interface ColumnPlan {
  index: number
  role: ListRole
  label: string
  key?: string
}

/** The header row: among the first 60 rows, the one naming the most kinds of column, with a name. */
function findHeader(rows: Grid['rows']): number {
  let best = -1
  let bestScore = 0
  rows.slice(0, 60).forEach((r, at) => {
    const seen = new Set<ListRole>()
    const texts = new Set<string>()
    for (const c of r.cells) {
      const text = cellText(c)
      if (!text || text.length > 60) continue
      texts.add(norm(text))
      const role = roleOfHeader(text)
      if (role) seen.add(role)
    }
    // a title copied over merged cells repeats one text: it is not a header
    if (texts.size < 3 || !seen.has('name')) return
    const score = seen.size
    if (score >= 2 && score > bestScore) {
      best = at
      bestScore = score
    }
  })
  return best
}

/** How each column is read, from its header and from its values under it. */
function planColumns(header: unknown[], data: unknown[][]): ColumnPlan[] {
  const width = Math.max(header.length, ...data.map((r) => r.length))
  const plans: ColumnPlan[] = []
  for (let i = 0; i < width; i++) {
    const label = cellText(header[i]) ?? ''
    const values = data.map((r) => r[i]).filter((v) => cellText(v) != null)
    const nonEmpty = values.length
    if (nonEmpty === 0 && !label) continue
    const numeric = values.filter(isNumberLike).length
    const texts = values.map((v) => cellText(v)!)
    const unique = new Set(texts).size
    const codeLike = texts.filter((t) => CODE_LIKE.test(t)).length
    let role = label ? roleOfHeader(label) : null
    const mostlyNumbers = nonEmpty > 0 && numeric / nonEmpty >= 0.6
    if (role === null && mostlyNumbers) {
      // a running number (1, 2, 3…) is the row number, not a price
      const ints = values.map((v) => priceOf(v)).filter((n): n is number => typeof n === 'number')
      const running =
        ints.length === nonEmpty &&
        ints.every((n, k) => Number.isInteger(n) && (k === 0 || n > ints[k - 1]!)) &&
        unique === nonEmpty
      role = running && i === 0 ? 'number' : 'price'
    }
    if (role === null && nonEmpty > 0 && codeLike / nonEmpty >= 0.8 && unique / nonEmpty >= 0.9)
      role = 'code'
    if (role === 'price' && nonEmpty > 0 && numeric / nonEmpty < 0.3) role = 'note'
    if (role === null) continue
    plans.push({ index: i, role, label: label || (role === 'price' ? 'Price' : '') })
    void unique
  }
  // one code: the most distinct values (the left-most on a tie); the others are other codes
  const codes = plans.filter((p) => p.role === 'code')
  if (codes.length > 1) {
    const distinct = (p: ColumnPlan) => {
      const vals = data.map((r) => cellText(r[p.index])).filter((v): v is string => !!v)
      return vals.length ? new Set(vals).size / vals.length : 0
    }
    const main = codes.reduce((a, b) => (distinct(b) > distinct(a) + 0.01 ? b : a))
    for (const p of codes) if (p !== main) p.role = 'altCode'
  }
  // one name: the first; the others are details
  let named = false
  for (const p of plans) {
    if (p.role !== 'name') continue
    if (named) p.role = 'detail'
    named = true
  }
  // the price columns' keys
  const taken = new Set<string>()
  for (const p of plans) if (p.role === 'price') p.key = keyOf(p.label, taken)
  return plans
}

/** A heading row ("A. ALIMENTARY TRACT", "A01 .STOMATOLOGICAL PREPARATIONS", "DENTISTRY"). */
const isHeading = (text: string) =>
  text.length <= 90 &&
  (/^[A-Z]\d{2}\b/.test(text) || /^[A-Z]\s*\.\s/.test(text) || text === text.toUpperCase()) &&
  !/:\s/.test(text)

/** One sheet read with its header; null when it has none. */
export function readGrid(grid: Grid): Omit<ParsedPriceList, 'format'> | null {
  const at = findHeader(grid.rows)
  if (at < 0) return null
  const header = grid.rows[at]!
  const body = grid.rows.slice(at + 1)
  const plans = planColumns(
    header.cells,
    body.slice(0, 3000).map((r) => r.cells),
  )
  const col = (role: ListRole) => plans.find((p) => p.role === role)
  const code = col('code')
  const name = col('name')
  const prices = plans.filter((p) => p.role === 'price')
  if (!name || prices.length === 0) return null
  const headerKey = header.cells.map((c) => norm(cellText(c) ?? '')).join('|')
  const text = (cells: unknown[], p: ColumnPlan | undefined) =>
    p ? cellText(cells[p.index]) : null
  const joined = (cells: unknown[], role: ListRole) =>
    plans
      .filter((p) => p.role === role)
      .map((p) => cellText(cells[p.index]))
      .filter(Boolean)
      .join(' · ') || null

  const lines: PriceListLineInput[] = []
  const notes: string[] = [...(grid.notes ?? [])]
  let heading: string | null = null
  for (const r of body) {
    const cells = r.cells
    if (cells.map((c) => norm(cellText(c) ?? '')).join('|') === headerKey) continue
    const filled = cells.map(cellText).filter((t): t is string => !!t)
    if (filled.length === 0) continue
    const lineCode = text(cells, code)
    const lineName = text(cells, name)
    const linePrices: Record<string, number | string | null> = {}
    let anyPrice = false
    for (const p of prices) {
      const v = priceOf(cells[p.index])
      linePrices[p.key!] = v
      if (v != null) anyPrice = true
    }
    if (!anyPrice && (!lineCode || !CODE_LIKE.test(lineCode))) {
      // a heading over the rows below it, or a note of the file
      const only = filled.length === 1 ? filled[0]! : null
      if (only && isHeading(only)) heading = only
      else notes.push(filled.join(' — '))
      continue
    }
    if (!lineCode && !lineName) continue
    lines.push({
      row: r.n,
      code: lineCode ?? '',
      name: lineName ?? '',
      detail: joined(cells, 'detail'),
      section: joined(cells, 'section') ?? heading,
      altCode: joined(cells, 'altCode'),
      unit: joined(cells, 'unit'),
      note: joined(cells, 'note'),
      prices: linePrices,
    })
  }
  const above = [
    ...(grid.above ?? []),
    ...grid.rows
      .slice(0, at)
      .flatMap((r) => [...new Set(r.cells.map(cellText).filter((x): x is string => !!x))]),
  ]
  const texts = above.filter(
    (x) => x.length > 8 && /[a-z]{3}/i.test(x) && !/^www\.|@|^p\.?o\.? box/i.test(x),
  )
  // the title says what it is ("…TARIFF…", "PRICES LIST…"); else the first text above the table
  const title = texts.find((x) => /tarif|tariff|list|liste|price|prix/i.test(x)) ?? texts[0]
  const from = above.map(monthIn).find(Boolean) ?? (grid.name ? monthIn(grid.name) : null) ?? null
  return {
    lines,
    columns: prices.map((p) => ({ key: p.key!, label: p.label })),
    roles: plans.map((p) => ({ role: p.role, label: p.label })),
    headerRow: header.n,
    sheet: grid.name,
    title: title ? title.slice(0, 160) : null,
    notes: [...new Set(notes)].slice(0, 30),
    kind: kindOf(lines, plans),
    from,
  }
}

/** Medicines when the codes are ATC codes or the headers speak of drugs; treatments for RHIC. */
function kindOf(
  lines: PriceListLineInput[],
  plans: ColumnPlan[],
): 'treatments' | 'medicines' | null {
  const codes = lines.map((l) => l.code.replace(/\s+/g, '').toUpperCase()).filter(Boolean)
  if (codes.length) {
    if (codes.filter((c) => ATC_LIKE.test(c)).length / codes.length >= 0.6) return 'medicines'
    if (codes.filter((c) => /^(RHIC|RLTC)-/.test(c)).length / codes.length >= 0.6)
      return 'treatments'
  }
  const words = norm(plans.map((p) => p.label).join(' '))
  if (/\b(drug|medicine|medicament|generic|product|selling unit|atc)\b/.test(words))
    return 'medicines'
  if (/\b(procedure|service|treatment|acte|prestation|exam|test)\b/.test(words)) return 'treatments'
  return null
}

// ---------------------------------------------------------------- PDF
/** A piece of text of a PDF page and where it is (points, y up). */
export interface PdfItem {
  page: number
  x: number
  y: number
  w: number
  text: string
}

/**
 * Text pieces of a PDF put back into a grid: the header line names the columns (a second line
 * just under it completes a header: "NEW" / "PRICE"); a row starts at a line with a row number or
 * a code; the lines a little under it (a price or a name written lower) belong to it; a section
 * written over several rows ("Analgesics, antipyretics and" / "Non Steroidal…") is joined.
 */
export function pdfToGrid(items: PdfItem[]): Grid | null {
  type Line = { page: number; y: number; items: PdfItem[] }
  const lines: Line[] = []
  const sorted = items
    .filter((i) => i.text.trim())
    .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
  for (const it of sorted) {
    const l = lines.find((x) => x.page === it.page && Math.abs(x.y - it.y) <= 2.5)
    if (l) l.items.push(it)
    else lines.push({ page: it.page, y: it.y, items: [it] })
  }
  lines.sort((a, b) => a.page - b.page || b.y - a.y)
  for (const l of lines) l.items.sort((a, b) => a.x - b.x)

  // the header: the first line with three or more column names, a name among them
  const hIndex = lines.findIndex((l) => {
    const roles = new Set(l.items.map((i) => roleOfHeader(i.text)).filter(Boolean))
    return roles.size >= 3 && roles.has('name')
  })
  if (hIndex < 0) return null
  const head = lines[hIndex]!
  const cols: { x: number; label: string }[] = head.items.map((i) => ({
    x: i.x,
    label: i.text.trim(),
  }))
  let first = hIndex + 1
  // a second header line just under it ("PRICE" under "NEW")
  while (first < lines.length) {
    const l = lines[first]!
    if (l.page !== head.page || head.y - l.y > 16) break
    if (l.items.some((i) => CODE_LIKE.test(i.text.trim()) && /\d/.test(i.text))) break
    for (const it of l.items) {
      const c = cols.reduce((a, b) => (Math.abs(b.x - it.x) < Math.abs(a.x - it.x) ? b : a))
      c.label = `${c.label} ${it.text.trim()}`
    }
    first++
  }
  cols.sort((a, b) => a.x - b.x)
  const colOf = (x: number) => {
    let k = 0
    for (let i = 0; i < cols.length; i++) if (x >= cols[i]!.x - 6) k = i
    return k
  }
  const codeCol = cols.findIndex((c) => roleOfHeader(c.label) === 'code')
  const sectionCol = cols.findIndex((c) => roleOfHeader(c.label) === 'section')
  const startsRow = (l: Line) =>
    l.items.some((i) => {
      const t = i.text.trim()
      const c = colOf(i.x)
      return (c === 0 && /^\d{1,5}\b/.test(t)) || (c === codeCol && CODE_LIKE.test(t))
    })

  type Rec = { page: number; y: number; cells: string[] }
  const recs: Rec[] = []
  const notes: string[] = []
  const above: string[] = lines.slice(0, hIndex).map((l) => l.items.map((i) => i.text).join(' '))
  let orphan: string[] | null = null
  const flushOrphan = () => {
    const t = (orphan ?? [])
      .map((c) => c?.trim())
      .filter(Boolean)
      .join(' — ')
    if (t) notes.push(t)
    orphan = null
  }
  const put = (cells: string[], l: Line) => {
    for (const it of l.items) {
      const c = colOf(it.x)
      cells[c] = cells[c] ? `${cells[c]} ${it.text.trim()}` : it.text.trim()
    }
  }
  // the usual distance between two rows, to know what is "a little under" a row
  const gaps: number[] = []
  let prev: Line | null = null
  for (const l of lines.slice(first)) {
    if (!startsRow(l)) continue
    if (prev && prev.page === l.page) gaps.push(prev.y - l.y)
    prev = l
  }
  gaps.sort((a, b) => a - b)
  const step = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 20
  for (const l of lines.slice(first)) {
    if (startsRow(l)) {
      flushOrphan()
      const cells: string[] = []
      put(cells, l)
      recs.push({ page: l.page, y: l.y, cells })
      continue
    }
    const last = recs[recs.length - 1]
    if (last && last.page === l.page && last.y - l.y < step * 0.75 && !orphan) {
      put(last.cells, l)
      continue
    }
    orphan ??= []
    put(orphan, l)
  }
  flushOrphan()
  if (recs.length === 0) return null

  // a section written over several rows: "…and" then "Antipsychotics", or "and Antibacterials"
  if (sectionCol >= 0) {
    let groupStart = -1
    for (let i = 0; i < recs.length; i++) {
      const s = recs[i]!.cells[sectionCol]?.trim()
      if (!s) {
        if (i > 0) recs[i]!.cells[sectionCol] = recs[i - 1]!.cells[sectionCol] ?? ''
        continue
      }
      const prevText = i > 0 ? (recs[groupStart]?.cells[sectionCol] ?? '') : ''
      const joins = i > 0 && (/(\band|,|&|-)$/i.test(prevText.trim()) || /^(and\b|&|,|\()/i.test(s))
      if (joins && groupStart >= 0) {
        const all = `${prevText.trim()} ${s}`.replace(/\s+/g, ' ')
        for (let k = groupStart; k <= i; k++) recs[k]!.cells[sectionCol] = all
      } else {
        groupStart = i
      }
    }
  }
  return {
    name: null,
    rows: [
      { n: 0, cells: cols.map((c) => c.label) },
      ...recs.map((r, i) => ({ n: i + 1, cells: cols.map((_, k) => r.cells[k] ?? null) })),
    ],
    notes,
    above,
  }
}

// ---------------------------------------------------------------- CSV
/** A CSV (comma, semicolon or tab), quotes as in RFC 4180. */
function csvRows(text: string): Grid['rows'] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const count = (ch: string) => firstLine.split(ch).length - 1
  const sep = [';', '\t', ','].reduce((a, b) => (count(b) > count(a) ? b : a), ',')
  const out: Grid['rows'] = []
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

/** The pieces of text of a PDF with their places (pdf.js, loaded only when a PDF is chosen). */
async function pdfItems(data: ArrayBuffer): Promise<PdfItem[]> {
  const pdfjs = await import('pdfjs-dist')
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = worker
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise
  const out: PdfItem[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    for (const it of content.items) {
      if (!('str' in it) || !it.str.trim()) continue
      out.push({ page: p, x: it.transform[4], y: it.transform[5], w: it.width, text: it.str })
    }
  }
  await doc.destroy()
  return out
}

/** Merges what each sheet read (a list may keep its parts on several sheets). */
export function mergeParts(
  parts: Omit<ParsedPriceList, 'format'>[],
  format: ParsedPriceList['format'],
): ParsedPriceList {
  const first = parts[0]!
  const columns: PriceListColumn[] = []
  for (const p of parts)
    for (const c of p.columns) if (!columns.some((x) => x.key === c.key)) columns.push(c)
  return {
    ...first,
    lines: parts.flatMap((p) => p.lines),
    columns,
    notes: [...new Set(parts.flatMap((p) => p.notes))].slice(0, 30),
    sheet:
      parts.length > 1
        ? parts
            .map((p) => p.sheet)
            .filter(Boolean)
            .join(', ')
        : first.sheet,
    format,
  }
}

/** Reads the file the manager chose. Throws PriceListFileError with what went wrong. */
export async function readPriceListFile(file: File): Promise<ParsedPriceList> {
  const name = file.name.toLowerCase()
  let grids: Grid[]
  let format: ParsedPriceList['format']
  try {
    if (name.endsWith('.pdf') || file.type === 'application/pdf') {
      format = 'pdf'
      const items = await pdfItems(await file.arrayBuffer())
      if (items.length === 0) throw new PriceListFileError('pdfNoText')
      const grid = pdfToGrid(items)
      if (!grid) throw new PriceListFileError('noHeader')
      grids = [grid]
    } else if (name.endsWith('.csv') || file.type === 'text/csv') {
      format = 'csv'
      // a CSV saved by Excel starts with the byte-order mark
      const text = await file.text()
      grids = [{ name: null, rows: csvRows(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) }]
    } else if (name.endsWith('.xlsx')) {
      format = 'xlsx'
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(await file.arrayBuffer())
      grids = wb.worksheets
        .filter((ws) => ws.state === 'visible')
        .map((ws) => {
          const rows: Grid['rows'] = []
          ws.eachRow({ includeEmpty: false }, (r, n) => {
            // exceljs rows are 1-based (index 0 is empty)
            const v = r.values
            rows.push({ n, cells: Array.isArray(v) ? v.slice(1) : [] })
          })
          return { name: ws.name, rows }
        })
    } else {
      throw new PriceListFileError('type')
    }
  } catch (e) {
    if (e instanceof PriceListFileError) throw e
    throw new PriceListFileError('unreadable')
  }
  const parts = grids.map(readGrid).filter((p): p is NonNullable<typeof p> => !!p)
  if (parts.length === 0) throw new PriceListFileError('noHeader')
  const merged = mergeParts(parts, format)
  if (merged.lines.length === 0) throw new PriceListFileError('empty')
  // "Final Tariff Tables - Private FEB2026.xlsx": the month the file name says
  return { ...merged, from: merged.from ?? monthIn(file.name) }
}

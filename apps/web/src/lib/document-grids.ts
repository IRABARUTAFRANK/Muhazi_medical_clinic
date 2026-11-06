/**
 * Any price list file the manager uploads, turned into rows and columns ("grids": one per sheet,
 * or per table of a document) for the readers of price lists (the published lists, an insurer's
 * own list, the official medicine list):
 *   - Excel .xlsx / .xlsm (exceljs: formulas keep what Excel calculated);
 *   - old Excel .xls, .xlsb and OpenDocument .ods / .fods (SheetJS, loaded only for them);
 *   - CSV and text tables .csv / .tsv / .txt (comma, semicolon or tab);
 *   - PDF with text (pdf.js; the caller puts the text back into rows: its columns are its own);
 *   - Word .docx and OpenDocument text .odt: their tables (a table continued on the next page is
 *     one table; the text above the first table is its title);
 *   - a web page .html / .htm: its tables.
 * An old Word file (.doc, .rtf), a photo or a scan has no table to read: the error says what to
 * do (save it as .docx or PDF; ask for the file the list was made with).
 */

/** The rows of one sheet or table: cells as they came, with the file's row number. */
export interface Grid {
  name: string | null
  rows: { n: number; cells: unknown[] }[]
  /** Text found outside the rows (PDF, a document's text after its table). */
  notes?: string[]
  /** Text above the table (PDF, a document's title). */
  above?: string[]
}

/** A piece of text of a PDF page and where it is (points, y up). */
export interface PdfItem {
  page: number
  x: number
  y: number
  w: number
  text: string
}

export type DocumentFormat = 'xlsx' | 'xls' | 'ods' | 'csv' | 'pdf' | 'docx' | 'odt' | 'html'

export type DocumentProblem = 'type' | 'oldWord' | 'image' | 'pdfNoText' | 'noTable' | 'unreadable'

export class DocumentError extends Error {
  readonly problem: DocumentProblem
  constructor(problem: DocumentProblem) {
    super(problem)
    this.name = 'DocumentError'
    this.problem = problem
  }
}

export interface LoadedDocument {
  format: DocumentFormat
  grids: Grid[]
  /** The sheets hidden in Excel (read only when the caller wants them). */
  hidden: Set<Grid>
}

/** Every kind of file the price list uploads accept (the file picker shows them). */
export const DOCUMENT_ACCEPT = [
  '.xlsx',
  '.xlsm',
  '.xls',
  '.xlsb',
  '.ods',
  '.fods',
  '.csv',
  '.tsv',
  '.txt',
  '.pdf',
  '.docx',
  '.odt',
  '.html',
  '.htm',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/csv',
  'text/tab-separated-values',
  'text/plain',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'text/html',
].join(',')

const ext = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase()

/** The kind of a file, from its name (else its type). */
export function formatOf(file: { name: string; type: string }): DocumentFormat | DocumentProblem {
  const e = ext(file.name)
  const t = file.type
  if (e === 'xlsx' || e === 'xlsm') return 'xlsx'
  if (['xls', 'xlsb', 'ods', 'fods'].includes(e)) return e === 'ods' || e === 'fods' ? 'ods' : 'xls'
  if (['csv', 'tsv', 'txt'].includes(e)) return 'csv'
  if (e === 'pdf') return 'pdf'
  if (e === 'docx') return 'docx'
  if (e === 'odt') return 'odt'
  if (e === 'html' || e === 'htm') return 'html'
  if (e === 'doc' || e === 'rtf') return 'oldWord'
  if (/^(jpe?g|png|gif|bmp|tiff?|webp|heic|heif)$/.test(e) || t.startsWith('image/')) return 'image'
  if (t.includes('spreadsheetml')) return 'xlsx'
  if (t === 'application/vnd.ms-excel') return 'xls'
  if (t.includes('opendocument.spreadsheet')) return 'ods'
  if (t === 'text/csv' || t === 'text/tab-separated-values' || t === 'text/plain') return 'csv'
  if (t === 'application/pdf') return 'pdf'
  if (t.includes('wordprocessingml')) return 'docx'
  if (t.includes('opendocument.text')) return 'odt'
  if (t === 'text/html') return 'html'
  if (t === 'application/msword' || t === 'application/rtf') return 'oldWord'
  return 'type'
}

// ---------------------------------------------------------------- text tables
/** A CSV or a text table (comma, semicolon or tab: the one the first line uses most); quotes as in RFC 4180. */
export function csvRows(text: string): Grid['rows'] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const firstLine = body.split(/\r?\n/, 1)[0] ?? ''
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
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
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

// ---------------------------------------------------------------- documents (tables)
const clean = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * The tables of a document as grids: a table with the same number of columns as the one before
 * it continues it (a table running over several pages, its column names repeated or not); the
 * text before the first table is above it, the text after the tables is a note.
 */
function documentGrids(
  blocks: ({ kind: 'text'; text: string } | { kind: 'table'; rows: string[][] })[],
): Grid[] {
  const grids: Grid[] = []
  const above: string[] = []
  const notes: string[] = []
  let width = -1
  let n = 0
  for (const b of blocks) {
    if (b.kind === 'text') {
      if (!b.text) continue
      if (grids.length === 0) above.push(b.text)
      else notes.push(b.text)
      continue
    }
    const rows = b.rows.filter((r) => r.some((c) => c !== ''))
    if (rows.length === 0) continue
    const w = Math.max(...rows.map((r) => r.length))
    if (grids.length === 0 || w !== width) {
      grids.push({ name: grids.length === 0 ? null : `Table ${grids.length + 1}`, rows: [] })
      width = w
    }
    const g = grids[grids.length - 1]!
    for (const r of rows) g.rows.push({ n: ++n, cells: r })
  }
  if (grids.length > 0) {
    grids[0]!.above = above
    grids[grids.length - 1]!.notes = notes
    if (grids.length > 1) grids[0]!.name = 'Table 1'
  }
  return grids
}

const parseXml = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml')

/** The direct children of an element with that local name. */
const kids = (el: Element, local: string) =>
  Array.from(el.children).filter((c) => c.localName === local)

/** Word (.docx): the body's paragraphs and tables (a merged cell keeps its place in the row). */
export function docxGrids(documentXml: string): Grid[] {
  const doc = parseXml(documentXml)
  const body = Array.from(doc.getElementsByTagName('*')).find((e) => e.localName === 'body')
  if (!body) return []
  /** A paragraph's text (its runs; a tab is a space). */
  const paraText = (p: Element) =>
    Array.from(p.getElementsByTagName('*'))
      .filter((x) => x.localName === 't' || x.localName === 'tab')
      .map((x) => (x.localName === 'tab' ? ' ' : (x.textContent ?? '')))
      .join('')
  /** A cell's text: its paragraphs, one after the other. */
  const cellText = (tc: Element) =>
    clean(
      Array.from(tc.getElementsByTagName('*'))
        .filter((x) => x.localName === 'p')
        .map(paraText)
        .join(' '),
    )
  const blocks: Parameters<typeof documentGrids>[0] = []
  const walk = (parent: Element) => {
    for (const el of Array.from(parent.children)) {
      if (el.localName === 'p') blocks.push({ kind: 'text', text: clean(paraText(el)) })
      else if (el.localName === 'tbl') {
        const rows: string[][] = []
        for (const tr of kids(el, 'tr')) {
          const cells: string[] = []
          for (const tc of kids(tr, 'tc')) {
            const pr = kids(tc, 'tcPr')[0]
            const span = pr ? kids(pr, 'gridSpan')[0] : undefined
            const n = Number(span?.getAttribute('w:val') ?? span?.getAttribute('val') ?? 1) || 1
            cells.push(cellText(tc))
            for (let k = 1; k < Math.min(n, 50); k++) cells.push('')
          }
          rows.push(cells)
        }
        blocks.push({ kind: 'table', rows })
      }
      // content controls hold paragraphs and tables too
      else if (el.localName === 'sdt' || el.localName === 'sdtContent') walk(el)
    }
  }
  walk(body)
  return documentGrids(blocks)
}

/** OpenDocument text (.odt): its paragraphs and tables (repeated rows and cells spread out). */
export function odtGrids(contentXml: string): Grid[] {
  const doc = parseXml(contentXml)
  const text = Array.from(doc.getElementsByTagName('*')).find((e) => e.localName === 'text')
  if (!text) return []
  const attr = (el: Element, name: string) =>
    el.getAttribute(`table:${name}`) ?? el.getAttribute(name)
  const blocks: Parameters<typeof documentGrids>[0] = []
  const walk = (parent: Element) => {
    for (const el of Array.from(parent.children)) {
      if (el.localName === 'p' || el.localName === 'h')
        blocks.push({ kind: 'text', text: clean(el.textContent ?? '') })
      else if (el.localName === 'table') {
        const rows: string[][] = []
        const rowEls = Array.from(el.getElementsByTagName('*')).filter(
          (x) => x.localName === 'table-row',
        )
        for (const tr of rowEls) {
          const cells: string[] = []
          for (const tc of Array.from(tr.children)) {
            if (tc.localName !== 'table-cell' && tc.localName !== 'covered-table-cell') continue
            const times = Math.min(Number(attr(tc, 'number-columns-repeated') ?? 1) || 1, 50)
            const value = tc.localName === 'covered-table-cell' ? '' : clean(tc.textContent ?? '')
            for (let k = 0; k < times; k++) cells.push(value)
          }
          while (cells.length && cells[cells.length - 1] === '') cells.pop()
          const times = Math.min(Number(attr(tr, 'number-rows-repeated') ?? 1) || 1, 50)
          for (let k = 0; k < times; k++) rows.push(cells)
        }
        blocks.push({ kind: 'table', rows })
      } else if (
        el.localName === 'section' ||
        el.localName === 'list' ||
        el.localName === 'list-item'
      )
        walk(el)
    }
  }
  walk(text)
  return documentGrids(blocks)
}

/** A web page: its tables (a cell over several columns keeps their places) and the text before them. */
export function htmlGrids(html: string): Grid[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const blocks: Parameters<typeof documentGrids>[0] = []
  const title = clean(doc.querySelector('h1, h2, title')?.textContent ?? '')
  if (title) blocks.push({ kind: 'text', text: title })
  for (const table of Array.from(doc.querySelectorAll('table'))) {
    // a table inside another one is read with it
    if (table.parentElement?.closest('table')) continue
    const rows: string[][] = []
    for (const tr of Array.from(table.querySelectorAll('tr'))) {
      if (tr.closest('table') !== table) continue
      const cells: string[] = []
      for (const td of Array.from(tr.children)) {
        if (td.tagName !== 'TD' && td.tagName !== 'TH') continue
        cells.push(clean(td.textContent ?? ''))
        const span = Math.min(Number(td.getAttribute('colspan') ?? 1) || 1, 50)
        for (let k = 1; k < span; k++) cells.push('')
      }
      rows.push(cells)
    }
    blocks.push({ kind: 'table', rows })
  }
  return documentGrids(blocks)
}

// ---------------------------------------------------------------- reading the file
/** The pieces of text of a PDF with their places (pdf.js, loaded only when a PDF is chosen). */
export async function pdfItems(data: ArrayBuffer): Promise<PdfItem[]> {
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

/** An Excel workbook read by exceljs: every sheet, the hidden ones marked. */
async function xlsxGrids(data: ArrayBuffer): Promise<{ grids: Grid[]; hidden: Set<Grid> }> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(data)
  const hidden = new Set<Grid>()
  const grids = wb.worksheets.map((ws) => {
    const rows: Grid['rows'] = []
    ws.eachRow({ includeEmpty: false }, (r, n) => {
      // exceljs rows are 1-based (index 0 is empty)
      const v = r.values
      rows.push({ n, cells: Array.isArray(v) ? v.slice(1) : [] })
    })
    const g: Grid = { name: ws.name, rows }
    if (ws.state !== 'visible') hidden.add(g)
    return g
  })
  return { grids, hidden }
}

/** An old Excel (.xls, .xlsb) or OpenDocument (.ods) workbook read by SheetJS. */
async function sheetjsGrids(data: ArrayBuffer): Promise<{ grids: Grid[]; hidden: Set<Grid> }> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(new Uint8Array(data), { type: 'array', cellDates: true })
  const hidden = new Set<Grid>()
  const grids = wb.SheetNames.map((name, i) => {
    const ws = wb.Sheets[name]!
    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null
    const rows: Grid['rows'] = []
    if (range) {
      const all = XLSX.utils.sheet_to_json<unknown[]>(ws, {
        header: 1,
        raw: true,
        blankrows: true,
        defval: null,
      })
      all.forEach((cells, k) => {
        if (cells.some((c) => c != null && c !== '')) rows.push({ n: range.s.r + k + 1, cells })
      })
    }
    const g: Grid = { name, rows }
    if (wb.Workbook?.Sheets?.[i]?.Hidden) hidden.add(g)
    return g
  })
  return { grids, hidden }
}

/** A zip document's part (Word, OpenDocument). */
async function zipPart(data: ArrayBuffer, path: string): Promise<string> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(data)
  const part = zip.file(path)
  if (!part) throw new DocumentError('unreadable')
  return part.async('string')
}

/**
 * Reads the file into grids. A PDF goes through `pdf` (the caller's way of putting its text back
 * into rows). Throws DocumentError with what went wrong.
 */
export async function loadDocument(
  file: File,
  pdf: (items: PdfItem[]) => Grid | null,
): Promise<LoadedDocument> {
  const kind = formatOf(file)
  if (kind === 'type' || kind === 'oldWord' || kind === 'image') throw new DocumentError(kind)
  const format = kind as DocumentFormat
  let grids: Grid[] = []
  let hidden = new Set<Grid>()
  try {
    if (format === 'xlsx') ({ grids, hidden } = await xlsxGrids(await file.arrayBuffer()))
    else if (format === 'xls' || format === 'ods')
      ({ grids, hidden } = await sheetjsGrids(await file.arrayBuffer()))
    else if (format === 'csv') grids = [{ name: null, rows: csvRows(await file.text()) }]
    else if (format === 'pdf') {
      const items = await pdfItems(await file.arrayBuffer())
      if (items.length === 0) throw new DocumentError('pdfNoText')
      const g = pdf(items)
      grids = g ? [g] : []
    } else if (format === 'docx')
      grids = docxGrids(await zipPart(await file.arrayBuffer(), 'word/document.xml'))
    else if (format === 'odt')
      grids = odtGrids(await zipPart(await file.arrayBuffer(), 'content.xml'))
    else if (format === 'html') grids = htmlGrids(await file.text())
  } catch (e) {
    if (e instanceof DocumentError) throw e
    throw new DocumentError('unreadable')
  }
  if (grids.length === 0) throw new DocumentError('noTable')
  return { format, grids, hidden }
}

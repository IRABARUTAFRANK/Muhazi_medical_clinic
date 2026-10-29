import i18next from 'i18next'
import {
  DASH,
  allergyHtml,
  allergyList,
  chipHtml,
  docDate,
  docDateTime,
  docNumber,
  docStamp,
  docTime,
  documentHtml,
  dobWithAge,
  esc,
  escLines,
  identityHtml,
  keyFiguresHtml,
  letterheadHtml,
  makeDocLabels,
  openPrintWindow,
  runInHtml,
  signatureHtml,
  tableHtml,
  titleBlockHtml,
  toDate,
  type CellValue,
  type ChipTone,
  type Column,
  type DocLabels,
  type Field,
  type FontUrls,
  type Letterhead,
  type TFn,
} from './doc-style'

/**
 * The clinic's medical documents, laid out by the document design standard (doc-style.ts):
 *
 * - the medical report of one visit (C1) and the medical history of every visit (C2), A4
 *   portrait: letterhead, title block, patient identity, allergy statement, then the visit's
 *   diagnoses, clinical summary, vital signs, investigations, procedures, medicines, advice and
 *   plan; the clinician's comment and the signature and stamp block;
 * - the laboratory (or ultrasound) result report (C3): asked for with a `title` (the lab's
 *   result slip) or `layout: 'lab'`; it has its own layout: request block, validation banner,
 *   results, findings and conclusion, "Performed by" and "Validated by".
 *
 * Every field the standard asks for that a caller does not pass yet is optional: a missing value
 * is left out, label and all (or printed as a ruled blank where the standard wants one).
 * `buildMedicalReportHtml` is pure (it takes the translation function), so the document can be
 * rendered from a script; `openMedicalReport` opens it in a print window.
 */

// ---------------------------------------------------------------- data

export interface ReportTest {
  name: string
  /** Free-text result (or the findings of a text result: malaria RDT, urine microscopy…). */
  findings: string | null
  /** Conclusion / impression. */
  impression: string | null
  verified: boolean
  /** Panel the test belongs to ("Full blood count", "Chemistry"…), for grouping. */
  panel?: string | null
  /** A measured result; `unit` like "g/dL" or "x10^9/L" (printed ×10⁹/L). */
  value?: string | number | null
  unit?: string | null
  /** Reference range from the test template; "–" when there is none (never invented). */
  range?: string | null
  flag?: 'H' | 'L' | 'CRIT' | null
  /** Who was told of a critical result, and when (ISO). */
  notified?: { name: string; at?: string | null } | null
}

export interface ReportMedicine {
  /** Legacy: "Amoxicillin 500 mg capsule × 21" (the quantity after "×" is read back). */
  name: string
  /** Legacy: the directions joined with "·". */
  how: string
  dose?: string | null
  route?: string | null
  frequency?: string | null
  /** "5 days". */
  duration?: string | null
  quantity?: number | null
  status?: 'new' | 'changed' | 'stopped' | 'given' | null
}

export interface ReportTreatment {
  text: string
  at?: string | null
  by?: string | null
}

export interface ReportVisit {
  /** The visit date as dd/mm/yyyy, used when `at` is not given. */
  date: string
  /** The visit's start (ISO): printed as dd/mm/yyyy HH:mm in Kigali time. */
  at?: string | null
  /** Visit reference, for the document number MR-{reference}. */
  reference?: string | null
  department?: string | null
  /** The attending clinician. */
  doctor?: string | null
  /** No longer printed (standard A11). */
  desks?: string[]
  referredBy?: string | null
  /** Latest value of each vital sign; the label is matched to its code to build the table. */
  vitals: { label: string; value: string; code?: string | null; unit?: string | null }[]
  vitalsBy?: string | null
  vitalsAt?: string | null
  /** Clinical notes, printed as paragraphs of the clinical summary. */
  notes: string[]
  history?: string | null
  examination?: string | null
  diagnoses: { text: string; icd10: string | null; primary: boolean; provisional: boolean }[]
  tests: ReportTest[]
  treatments: (string | ReportTreatment)[]
  medicines: ReportMedicine[]
  advice?: string | null
  plan?: string | null
  /** yyyy-mm-dd or ISO. */
  followUp?: string | null
}

/** Laboratory request and validation details (result report, C3). */
export interface ReportLabInfo {
  sampleId?: string | null
  department?: string | null
  /** Clinical information (the request's reason); default: the visit's notes. */
  reason?: string | null
  specimen?: string | null
  requestedAt?: string | null
  collectedAt?: string | null
  receivedAt?: string | null
  reportedAt?: string | null
  method?: string | null
  validatedBy?: { name: string; title?: string | null; registrationNo?: string | null } | null
  validatedAt?: string | null
  performedAt?: string | null
  /** The date-time (ISO) of the report this one replaces, for an amended report. */
  amends?: string | null
  /** An amended report whose first issue date is not known: the banner without the date. */
  amended?: boolean
}

/** The clinic as `useLetterhead()` gives it (structured fields plus the older joined strings). */
export type ReportClinic = Partial<Letterhead> & {
  name: string
  address: string
  contacts: string
  licences?: string
  logoUrl: string
}

export interface MedicalReportDoc {
  kind: 'visit' | 'history'
  /** Another title than "Medical report": the laboratory / ultrasound result report. */
  title?: string
  /** 'lab' = the result report layout (default when a `title` is given). */
  layout?: 'medical' | 'lab'
  clinic: ReportClinic
  patient: {
    name: string
    fileNumber: string
    /**
     * Legacy "38 F" / "4m M": used only when the birth date and sex are not given, printed as
     * two fields in words ("Age: 38 years", "Sex: Male").
     */
    ageSex: string
    /** yyyy-mm-dd. */
    birthDate?: string | null
    /** Sex in words. */
    sex?: string | null
    phone?: string | null
    insurer?: string | null
    memberNo?: string | null
    weightKg?: number | string | null
    /** Free text; null or empty = not recorded; "none" style words = no known allergies. */
    allergies?: string | null
    bloodGroup?: string | null
  }
  visits: ReportVisit[]
  comment?: string | null
  author: { name: string; title: string; registrationNo?: string | null }
  /** Full name of the user who prints (default: the author, except on the lab report). */
  printedBy?: string | null
  /** Distribution line "Copy to: …". */
  copyTo?: string | null
  lab?: ReportLabInfo | null
}

/** The wording the callers already pass (from `useMedicalReportLabels`). */
export interface MedicalReportLabels {
  title: string
  titleHistory: string
  produced: string
  patient: string
  file: string
  ageSex: string
  phone: string
  allergies: string
  bloodGroup: string
  none: string
  visitOf: (date: string) => string
  seenBy: string
  desks: string
  vitals: string
  notes: string
  diagnoses: string
  primary: string
  provisional: string
  tests: string
  conclusion: string
  notVerified: string
  treatments: string
  medicines: string
  comment: string
  nothing: string
  author: string
  signature: string
  stamp: string
  confidential: string
  visitsCount: (n: number) => string
}

// ---------------------------------------------------------------- wording

function medWords(t: TFn) {
  const k = (key: string, vars?: Record<string, unknown>) => t(`medReport.doc.${key}`, vars)
  /** A newer key, with its English wording until the translation is merged. */
  const kd = (key: string, en: string, vars: Record<string, unknown> = {}) => {
    const full = `medReport.doc.${key}`
    const v = t(full, { defaultValue: en, ...vars })
    return v && v !== full ? v : en.replace(/{{(w+)}}/g, (_, n: string) => String(vars[n] ?? ''))
  }
  return {
    flagHigh: kd('flagHigh', 'High'),
    flagLow: kd('flagLow', 'Low'),
    validatedBanner: (date: string, name: string) =>
      kd('validatedBanner', 'VALIDATED – {{date}} by {{name}}', { date, name }),
    chipValidated: kd('chipValidated', 'Validated'),
    chipPreliminary: kd('chipPreliminary', 'Preliminary'),
    chipAmended: kd('chipAmended', 'Amended'),
    visitDate: k('visitDate'),
    age: k('age'),
    department: k('department'),
    attending: k('attending'),
    referredBy: k('referredBy'),
    diagnosis: k('diagnosis'),
    icd10: k('icd10'),
    status: k('status'),
    statusPrimary: k('statusPrimary'),
    statusSecondary: k('statusSecondary'),
    statusProvisional: k('statusProvisional'),
    clinicalSummary: k('clinicalSummary'),
    history: k('history'),
    examination: k('examination'),
    measuredBy: k('measuredBy'),
    measuredAt: k('measuredAt'),
    investigations: k('investigations'),
    test: k('test'),
    result: k('result'),
    results: k('results'),
    unit: k('unit'),
    range: k('range'),
    flag: k('flag'),
    preliminary: k('preliminary'),
    awaited: k('awaited'),
    procedures: k('procedures'),
    procedure: k('procedure'),
    dateTime: k('dateTime'),
    by: k('by'),
    medicine: k('medicine'),
    dose: k('dose'),
    route: k('route'),
    frequency: k('frequency'),
    duration: k('duration'),
    qty: k('qty'),
    directions: k('directions'),
    medStatus: (s: string) => k(`medStatus.${s}`),
    advice: k('advice'),
    plan: k('plan'),
    followUp: k('followUp'),
    clinicianComment: k('clinicianComment'),
    copyTo: k('copyTo'),
    summary: k('summary'),
    recentDiagnoses: k('recentDiagnoses'),
    currentMedicines: k('currentMedicines'),
    visits: k('visits'),
    clinician: k('clinician'),
    mainDiagnosis: k('mainDiagnosis'),
    visitsScope: (count: number, from: string, to: string) => k('visitsScope', { count, from, to }),
    vital: (code: string) => k(`vital.${code}`),
    // laboratory result report
    reportNo: k('reportNo'),
    labNo: k('labNo'),
    reported: k('reported'),
    requestedBy: k('requestedBy'),
    visitNo: k('visitNo'),
    clinicalInfo: k('clinicalInfo'),
    specimen: k('specimen'),
    requested: k('requested'),
    collected: k('collected'),
    received: k('received'),
    preliminaryBanner: k('preliminaryBanner'),
    amendedBanner: (date: string) => k('amendedBanner', { date }),
    amendedBannerNoDate: k('amendedBannerNoDate'),
    findings: k('findings'),
    method: k('method'),
    rangesNote: k('rangesNote'),
    performedBy: k('performedBy'),
    validatedBy: k('validatedBy'),
    notified: (name: string, time: string) => k('notified', { name, time }),
  }
}
type Words = ReturnType<typeof medWords>

// ---------------------------------------------------------------- helpers

/** The structured letterhead from the clinic (older callers: from the joined strings). */
function letterheadOf(c: ReportClinic): Letterhead {
  if (c.legalName) {
    return {
      legalName: c.legalName,
      addressLine: c.addressLine ?? null,
      phone: c.phone ?? null,
      email: c.email ?? null,
      tin: c.tin ?? null,
      mohLicence: c.mohLicence ?? null,
      fdaLicence: c.fdaLicence ?? null,
      poBox: c.poBox ?? null,
      logoUrl: c.logoUrl,
      openingHours: c.openingHours ?? null,
    }
  }
  const parts = c.contacts
    .split(/\s*·\s*|\s{2,}/)
    .map((x) => x.replace(/^(tel\.?|email|phone)\s*:?\s*/i, '').trim())
    .filter(Boolean)
  return {
    legalName: c.name,
    addressLine: c.address.replace(/\s*·\s*/g, ', ') || null,
    phone: parts.find((x) => !x.includes('@')) ?? null,
    email: parts.find((x) => x.includes('@')) ?? null,
    tin: null,
    mohLicence: null,
    fdaLicence: null,
    poBox: null,
    logoUrl: c.logoUrl,
    openingHours: null,
  }
}

/** dd/mm/yyyy HH:mm of the visit, or its date as given. */
const visitWhen = (v: ReportVisit) => docDateTime(v.at) || v.date
const visitDay = (v: ReportVisit) => docDate(v.at) || v.date

/** "×10<sup>9</sup>/L" for "x10^9/L", "10^9/L", "×10^12/L". */
function unitHtml(unit: string | null | undefined): string {
  if (!unit) return ''
  return esc(unit).replace(/(?:[x×]\s*)?10\^(\d+)/g, '×10<sup>$1</sup>')
}

/** "Amoxicillin 500 mg capsule × 21" → name and quantity. */
function splitQty(m: ReportMedicine): { name: string; qty: number | null } {
  if (m.quantity != null) return { name: m.name.replace(/\s*[×x]\s*\d+\s*$/, ''), qty: m.quantity }
  const hit = /^(.*?)\s*[×x]\s*(\d+)\s*$/.exec(m.name)
  return hit ? { name: hit[1]!, qty: Number(hit[2]) } : { name: m.name, qty: null }
}

const NBSP = String.fromCharCode(0xa0)
/** A number never leaves the word after it: "20 mg", "3 days", "1 L" do not break. */
const keepNumberWithUnit = (s: string | null | undefined) =>
  s ? s.replace(/(\d)[ \t]+(?=[^\s\d])/g, `$1${NBSP}`) : (s ?? null)
/** Short cells ("Iminsi 3", "Inshuro 3 ku munsi"): the number stays with the words around it. */
const keepNumberPhrase = (s: string | null | undefined) =>
  s ? keepNumberWithUnit(s)!.replace(/([^\s\d])[ \t]+(?=\d)/g, `$1${NBSP}`) : (s ?? null)

/** The first number of a measured value ("37.8 °C" → "37.8"), or the text as given. */
function bareValue(value: string): { num: string; unit: string } {
  const hit = /^\s*(-?\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?)\s*(.*)$/.exec(value)
  return hit ? { num: hit[1]!.replace(/\s+/g, ''), unit: hit[2]!.trim() } : { num: value, unit: '' }
}

/** Which columns have a value in some row (or are always kept). */
const usedColumns = (n: number, rows: CellValue[][], keep: number[]) =>
  Array.from(
    { length: n },
    (_, i) => keep.includes(i) || rows.some((r) => r[i] != null && r[i] !== ''),
  )

/** A column with its share of the table width (fixed layout). */
type FixedColumn = Column & { share: number }

/**
 * A data table with a fixed column layout (`<colgroup>` widths in %), so every table of a kind
 * lines up across visits and a continuation table matches the one above it. Without `withHead`
 * the header row is left out (the rows kept with the signature block).
 */
function fixedTable(
  cols: FixedColumn[],
  rows: CellValue[][],
  opts: { used?: boolean[]; withHead?: boolean; className?: string } = {},
): string {
  const keep = (i: number) => opts.used?.[i] ?? true
  const shown = cols.filter((_, i) => keep(i))
  const total = shown.reduce((s, c) => s + c.share, 0) || 1
  const colgroup = `<colgroup>${shown
    .map((c) => `<col style="width:${((c.share * 100) / total).toFixed(2)}%">`)
    .join('')}</colgroup>`
  const html = tableHtml(
    // the widths come from the colgroup
    shown.map((c): Column => ({ label: c.label, num: c.num, money: c.money })),
    rows.map((r) => r.filter((_, i) => keep(i))),
    { className: ['fixed', opts.className ?? ''].filter(Boolean).join(' ') },
  ).replace(/^(<table[^>]*>)/, `$1${colgroup}`)
  return opts.withHead === false ? html.replace(/<thead>[\s\S]*?<\/thead>/, '') : html
}

const VITAL_CODES = ['temp', 'pulse', 'resp', 'bp', 'spo2', 'weight', 'height'] as const

// ---------------------------------------------------------------- pieces of content

/**
 * A piece of the document body. `small` pieces (a short paragraph, a table of one or two rows)
 * may join the signature block whole; a long table offers a `split`: the table without its last
 * row, and that row as a continuation table, so the signature never stands alone at the top of
 * a page without whole sections being pushed off the page.
 */
interface Piece {
  html: string
  small: boolean
  split?: [before: string, keepWithNext: string]
}

const paraPiece = (html: string): Piece => ({
  html,
  small: !html.includes('<table') && html.length < 600,
})

/** A heading and a table of `n` rows; `render(from, to, withHead)` draws a slice of the rows. */
function tablePiece(
  head: string,
  n: number,
  render: (from: number, to: number, withHead: boolean) => string,
  after = '',
  lastRows = 1,
): Piece {
  const html = head + render(0, n, true) + after
  if (n <= 2) return { html, small: true }
  const cut = n - Math.min(Math.max(lastRows, 1), n - 1)
  return {
    html,
    small: false,
    split: [head + render(0, cut, true), render(cut, n, false) + after],
  }
}

/** The signature block, with at most one small piece (or the last row of a table) before it. */
function withSignature(pieces: Piece[], signature: string): string[] {
  const out = pieces.filter((p) => p.html)
  const last = out.pop()
  const keep = (html: string) => `<div class="keep">${html}${signature}</div>`
  if (!last) return [signature]
  const before = out.map((p) => p.html)
  if (last.small) return [...before, keep(last.html)]
  if (last.split) return [...before, last.split[0], keep(last.split[1])]
  return [...before, last.html, signature]
}

// ---------------------------------------------------------------- sections of a visit

/** Column plan shared by every visit of the document, so tables of a kind line up. */
interface Plan {
  structuredMeds: boolean
  medUsed: boolean[]
  procUsed: boolean[]
}

interface Ctx {
  t: TFn
  w: Words
  l: MedicalReportLabels
  dl: DocLabels
  plan: Plan
}

/** A section heading: h2 in the one-visit report, a 10 pt sub-heading inside a history visit. */
const heading = (text: string, inVisit: boolean) =>
  inVisit ? `<h4 class="cap">${esc(text)}</h4>` : `<h2>${esc(text)}</h2>`

function diagnosesPiece(v: ReportVisit, c: Ctx, inVisit: boolean): Piece | null {
  if (!v.diagnoses.length) return null
  const sorted = [...v.diagnoses].sort((a, b) => Number(b.primary) - Number(a.primary))
  const status = (d: ReportVisit['diagnoses'][number]) => {
    const words = [d.primary ? c.w.statusPrimary : c.w.statusSecondary]
    if (d.provisional) words.push(c.w.statusProvisional.toLowerCase())
    return d.primary || !d.provisional ? words.join(', ') : c.w.statusProvisional
  }
  const cols: FixedColumn[] = [
    { label: c.w.diagnosis, share: 64 },
    { label: c.w.icd10, share: 14 },
    { label: c.w.status, share: 22 },
  ]
  const tone = (d: ReportVisit['diagnoses'][number]): ChipTone =>
    d.provisional ? 'warn' : d.primary ? 'info' : 'muted'
  const rows: CellValue[][] = sorted.map((d) => [
    d.text,
    d.icd10 ? { html: `<strong>${esc(d.icd10)}</strong>` } : null,
    chipCell(status(d), tone(d)),
  ])
  return tablePiece(heading(c.l.diagnoses, inVisit), rows.length, (a, b, h) =>
    fixedTable(cols, rows.slice(a, b), { withHead: h }),
  )
}

function summaryPiece(v: ReportVisit, c: Ctx, inVisit: boolean): Piece | null {
  const body =
    runInHtml(c.w.history, v.history) +
    v.notes
      .filter((n) => n && n.trim())
      .map((n) => `<p>${escLines(n.trim())}</p>`)
      .join('') +
    runInHtml(c.w.examination, v.examination)
  return body ? paraPiece(heading(c.w.clinicalSummary, inVisit) + body) : null
}

function vitalsPiece(v: ReportVisit, c: Ctx, inVisit: boolean): Piece | null {
  if (!v.vitals.length) return null
  // match each vital to its code by the code given or by its translated label
  const byLabel = new Map<string, string>()
  for (const code of [
    'temp',
    'pulse',
    'resp',
    'spo2',
    'weight',
    'height',
    'muac',
    'bp_sys',
    'bp_dia',
  ])
    byLabel.set(c.t(`triage.vitals.${code}`).toLowerCase(), code)
  const known = new Map<string, string>()
  const others: { label: string; num: string }[] = []
  for (const x of v.vitals) {
    const code = x.code ?? byLabel.get(x.label.toLowerCase())
    const { num, unit } = bareValue(x.value)
    if (code) known.set(code, num)
    else others.push({ label: unit || x.unit ? `${x.label} (${x.unit || unit})` : x.label, num })
  }
  const sys = known.get('bp_sys')
  const dia = known.get('bp_dia')
  if (sys || dia) known.set('bp', `${sys ?? DASH}/${dia ?? DASH}`)
  // only the vitals that were measured
  const codes = [...VITAL_CODES, 'muac'].filter((code) => known.has(code))
  const cols: Column[] = [
    ...codes.map((code) => ({ label: c.w.vital(code), num: true })),
    ...others.map((o) => ({ label: o.label, num: true })),
  ]
  const row: CellValue[] = [
    ...codes.map((code) => known.get(code) ?? null),
    ...others.map((o) => o.num),
  ]
  // "Measured by: Nurse X, 24/10/2026 09:52" (or the time alone)
  const when = docDateTime(v.vitalsAt)
  const measured = v.vitalsBy
    ? `${c.w.measuredBy}: ${[v.vitalsBy, when].filter(Boolean).join(', ')}`
    : when
      ? `${c.w.measuredAt}: ${when}`
      : ''
  if (!cols.length) return null
  return {
    html:
      heading(c.l.vitals, inVisit) +
      tableHtml(cols, [row], { className: 'vitals' }) +
      (measured ? `<p class="small measured">${esc(measured)}</p>` : ''),
    small: true,
  }
}

const hasResult = (x: ReportTest) =>
  (x.value != null && x.value !== '') || !!x.findings?.trim() || !!x.impression?.trim()

/**
 * The flag cell: a bordered chip with the letter and the word beside it ("H High", "L Low"),
 * a red "CRIT" chip (with who was notified), or PRELIMINARY. The letter, the word and the bold
 * weight carry the meaning in black and white; the colour only helps.
 */
function flagHtml(x: ReportTest, c: Ctx, preliminary: boolean): string {
  const parts: string[] = []
  if (x.flag === 'CRIT') {
    parts.push(`<strong class="flag-word">${chipHtml('CRIT', 'alert')}</strong>`)
    if (x.notified)
      parts.push(
        `<div class="small">${esc(c.w.notified(x.notified.name, docTime(x.notified.at)))}</div>`,
      )
  } else if (x.flag)
    parts.push(
      `<strong>${chipHtml(x.flag, x.flag === 'H' ? 'warn' : 'info')}</strong> <span class="flag-txt">${esc(
        x.flag === 'H' ? c.w.flagHigh : c.w.flagLow,
      )}</span>`,
    )
  if (preliminary && !x.verified && hasResult(x))
    parts.push(`<div class="prelim">${esc(c.w.preliminary)}</div>`)
  return parts.join('')
}

/** A status word as a chip, for a table cell. */
const chipCell = (text: string, tone: ChipTone): CellValue => ({ html: chipHtml(text, tone) })

/** One results row; a text-only result spans the Result, Unit and Reference range columns. */
function resultRow(x: ReportTest, c: Ctx, opts: { preliminary: boolean; textInCell: boolean }) {
  const flag = flagHtml(x, c, opts.preliminary)
  const flagCell = `<td class="flag">${flag || DASH}</td>`
  const name = `<td>${esc(x.name)}</td>`
  if (x.value != null && x.value !== '') {
    const abnormal = !!x.flag
    const value = typeof x.value === 'number' ? String(x.value) : x.value
    return `<tr>${name}<td class="num">${abnormal ? `<strong>${esc(value)}</strong>` : esc(value)}</td><td>${unitHtml(x.unit) || DASH}</td><td class="num">${x.range ? esc(x.range) : DASH}</td>${flagCell}</tr>`
  }
  const text = opts.textInCell
    ? [
        x.findings?.trim() ? escLines(x.findings.trim()) : '',
        x.impression?.trim()
          ? `<div><span class="lbl">${esc(c.l.conclusion)}:</span> ${escLines(x.impression.trim())}</div>`
          : '',
      ].join('') || esc(c.w.awaited)
    : esc(hasResult(x) ? '' : c.w.awaited)
  return `<tr>${name}<td colspan="3">${text || DASH}</td>${flagCell}</tr>`
}

/** The results table (fixed columns: the same on the medical report, history and lab report). */
function resultsTable(rows: string[], c: Ctx, withHead = true) {
  const head = withHead
    ? `<thead><tr><th>${esc(c.w.test)}</th><th class="num">${esc(c.w.result)}</th><th>${esc(c.w.unit)}</th><th class="num">${esc(c.w.range)}</th><th>${esc(c.w.flag)}</th></tr></thead>`
    : ''
  return `<table class="dt fixed results"><colgroup><col style="width:31%"><col style="width:14%"><col style="width:13%"><col style="width:18%"><col style="width:24%"></colgroup>${head}<tbody>${rows.join('')}</tbody></table>`
}

function investigationsPiece(v: ReportVisit, c: Ctx, inVisit: boolean): Piece | null {
  if (!v.tests.length) return null
  const rows = v.tests.map((x) => resultRow(x, c, { preliminary: true, textInCell: true }))
  return tablePiece(heading(c.w.investigations, inVisit), rows.length, (a, b, h) =>
    resultsTable(rows.slice(a, b), c, h),
  )
}

const procedureRow = (x: string | ReportTreatment): CellValue[] =>
  typeof x === 'string' ? [x, null, null] : [x.text, docDateTime(x.at) || null, x.by ?? null]

function proceduresPiece(v: ReportVisit, c: Ctx, inVisit: boolean): Piece | null {
  if (!v.treatments.length) return null
  const cols: FixedColumn[] = [
    { label: c.w.procedure, share: 58 },
    { label: c.w.dateTime, share: 18 },
    { label: c.w.by, share: 24 },
  ]
  const rows = v.treatments.map(procedureRow)
  return tablePiece(heading(c.w.procedures, inVisit), rows.length, (a, b, h) =>
    fixedTable(cols, rows.slice(a, b), { used: c.plan.procUsed, withHead: h }),
  )
}

const MED_TONE: Record<NonNullable<ReportMedicine['status']>, ChipTone> = {
  new: 'info',
  changed: 'warn',
  stopped: 'muted',
  given: 'ok',
}

/** The medicine's status as a chip ("New", "Given at clinic"), or nothing. */
const medStatusCell = (m: ReportMedicine, w: Words): CellValue =>
  m.status ? chipCell(w.medStatus(m.status), MED_TONE[m.status]) : null

/** Structured medicine rows: Medicine | Dose | Route | Frequency | Duration | Qty | Status. */
function medicineRow(m: ReportMedicine, w: Words): CellValue[] {
  const { name, qty } = splitQty(m)
  return [
    keepNumberWithUnit(name),
    keepNumberWithUnit(m.dose),
    m.route ?? null,
    keepNumberPhrase(m.frequency),
    keepNumberPhrase(m.duration),
    qty,
    medStatusCell(m, w),
  ]
}

/** Older callers: the directions as one phrase. Medicine | Directions | Qty | Status. */
function medicineRowLegacy(m: ReportMedicine, w: Words): CellValue[] {
  const { name, qty } = splitQty(m)
  const how = m.how
    .split(/\s*·\s*/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(', ')
  return [keepNumberWithUnit(name), keepNumberWithUnit(how) || null, qty, medStatusCell(m, w)]
}

const isStructured = (m: ReportMedicine) => !!(m.dose || m.route || m.frequency || m.duration)

function medicinesPiece(v: ReportVisit, c: Ctx, inVisit: boolean): Piece | null {
  if (!v.medicines.length) return null
  const w = c.w
  const cols: FixedColumn[] = c.plan.structuredMeds
    ? [
        { label: w.medicine, share: 28 },
        { label: w.dose, share: 13 },
        { label: w.route, share: 13 },
        { label: w.frequency, share: 14 },
        { label: w.duration, share: 9 },
        { label: w.qty, num: true, share: 10 },
        { label: w.status, share: 13 },
      ]
    : [
        { label: w.medicine, share: 36 },
        { label: w.directions, share: 41 },
        { label: w.qty, num: true, share: 10 },
        { label: w.status, share: 13 },
      ]
  const rows = v.medicines.map((m) =>
    c.plan.structuredMeds ? medicineRow(m, w) : medicineRowLegacy(m, w),
  )
  return tablePiece(heading(c.l.medicines, inVisit), rows.length, (a, b, h) =>
    fixedTable(cols, rows.slice(a, b), {
      used: c.plan.medUsed,
      withHead: h,
      className: c.plan.structuredMeds ? 'meds' : 'meds legacy',
    }),
  )
}

function advicePiece(v: ReportVisit, c: Ctx, inVisit: boolean): Piece | null {
  const advice = v.advice?.trim()
    ? heading(c.w.advice, inVisit) + `<p>${escLines(v.advice.trim())}</p>`
    : ''
  const planBody =
    (v.plan?.trim() ? `<p>${escLines(v.plan.trim())}</p>` : '') +
    (v.followUp
      ? `<p><span class="lbl">${esc(c.w.followUp)}:</span> ${esc(docDate(v.followUp))}</p>`
      : '')
  const html = advice + (planBody ? heading(c.w.plan, inVisit) + planBody : '')
  return html ? paraPiece(html) : null
}

/** C1 items 5 to 11 of one visit; empty sections are left out. */
function visitPieces(v: ReportVisit, c: Ctx, inVisit: boolean): Piece[] {
  return [
    diagnosesPiece(v, c, inVisit),
    summaryPiece(v, c, inVisit),
    vitalsPiece(v, c, inVisit),
    investigationsPiece(v, c, inVisit),
    proceduresPiece(v, c, inVisit),
    medicinesPiece(v, c, inVisit),
    advicePiece(v, c, inVisit),
  ].filter((p): p is Piece => !!p)
}

/** The column plan of every visit of the document. */
function planOf(visits: ReportVisit[], w: Words): Plan {
  const meds = visits.flatMap((v) => v.medicines)
  const structuredMeds = meds.some(isStructured)
  const medRows = meds.map((m) => (structuredMeds ? medicineRow(m, w) : medicineRowLegacy(m, w)))
  return {
    structuredMeds,
    medUsed: usedColumns(
      structuredMeds ? 7 : 4,
      medRows,
      structuredMeds ? [0, 1, 2, 3, 4, 5] : [0, 1, 2],
    ),
    procUsed: usedColumns(
      3,
      visits.flatMap((v) => v.treatments.map(procedureRow)),
      [0],
    ),
  }
}

// ---------------------------------------------------------------- the patient

/** Older callers' "27 F", "4m M", "38 · Male": Age and Sex as two fields, in words. */
function legacyAgeSex(text: string, c: Ctx): { age: string | null; sex: string | null } {
  const s = text.replace(/\s*·\s*/g, ' ').trim()
  const age = /^(\d+)\s*([a-z]*)/i.exec(s)
  const n = age ? Number(age[1]) : NaN
  const ageWords = Number.isFinite(n)
    ? /^m/i.test(age![2] ?? '')
      ? c.dl.ageMonths(n)
      : c.dl.ageYears(n)
    : null
  const rest = (age ? s.slice(age[0].length) : s).trim()
  const letter = { F: 'female', M: 'male' }[rest.toUpperCase()]
  const sex = letter ? c.t(`register.sexes.${letter}`) : rest && rest !== '—' ? rest : null
  return { age: ageWords, sex }
}

function patientFields(d: MedicalReportDoc, c: Ctx, layout: 'visit' | 'history' | 'lab') {
  const p = d.patient
  const dob = p.birthDate ? dobWithAge(p.birthDate, c.dl) : ''
  const legacy = !dob && !p.sex && p.ageSex ? legacyAgeSex(p.ageSex, c) : null
  const weight = p.weightKg != null && p.weightKg !== '' ? String(p.weightKg) : null
  const left: (Field | null)[] = [
    { label: c.dl.name, value: p.name },
    dob ? { label: c.dl.dateOfBirth, value: dob } : null,
    legacy?.age ? { label: c.w.age, value: legacy.age } : null,
    { label: c.dl.sex, value: p.sex ?? legacy?.sex ?? null },
    { label: c.dl.fileNo, value: p.fileNumber },
  ]
  // weight belongs to one visit (it is in each visit's vital signs on the history); the result
  // report carries it too, since doses and some reference values depend on it
  const right: (Field | null)[] = [
    { label: c.dl.phone, value: p.phone },
    { label: c.dl.insurer, value: p.insurer },
    { label: c.dl.memberNo, value: p.memberNo },
    layout !== 'history' ? { label: c.dl.weightKg, value: weight } : null,
    layout === 'history' ? { label: c.l.bloodGroup, value: p.bloodGroup } : null,
  ]
  const html = identityHtml(left, right)
  return layout === 'lab' ? html.replace('class="idg"', 'class="idg lab-grid"') : html
}

/** Null or empty = not recorded; "none" style words = no known allergies; else the list. */
const allergiesOf = (text: string | null | undefined) =>
  text && text.trim() ? allergyList(text) : null

// ---------------------------------------------------------------- the documents

const MEDICAL_CSS = `
h4.cap { font-size: var(--fs-sub); font-weight: 700; line-height: 1.2; color: var(--accent); margin: 8pt 0 3pt;
  padding-bottom: 1.5pt; border-bottom: 0.5pt solid var(--hair); break-after: avoid; page-break-after: avoid; }
/* a visit of the history: a navy-edged band with the date, department and clinician */
h3.visit-h { font-size: var(--fs-h); font-weight: 700; color: var(--accent-ink); background: var(--tint);
  border-left: 3pt solid var(--accent); border-radius: 0 2pt 2pt 0; padding: 3pt 6pt; margin: 16pt 0 3pt; }
h3.visit-h.first { margin-top: 10pt; }
h3.visit-h + h4.cap { margin-top: 5pt; }
table.dt.fixed { table-layout: fixed; }
.dt.fixed td { overflow-wrap: break-word; }
.dt.meds td:nth-child(5), .dt.meds td:nth-child(6) { white-space: nowrap; }
.dt td .chip { white-space: normal; }
.measured { margin: -3pt 0 6pt; }
.results td.flag { white-space: normal; }
.results .flag-txt { font-size: var(--fs-small); color: var(--ink-2); }
.prelim { font-weight: 700; letter-spacing: 0.05em; font-size: var(--fs-small); line-height: 1.2; color: var(--warn); margin-top: 1pt; }
.results td.flag .small { font-weight: 400; margin-top: 1pt; }
.dt.results tbody tr.panel > td { font-size: var(--fs-sub); font-weight: 700; color: var(--accent); background: transparent;
  padding-top: 7pt; border-bottom: 0.75pt solid var(--accent-2); }
.dt.vitals { width: auto; }
.dt.vitals td, .dt.vitals th { white-space: nowrap; }
.dt.vitals td { font-size: var(--fs-body); font-weight: 600; }
.idg.lab-grid { --id-label: 34mm; grid-template-columns: var(--id-label) minmax(0, 1.5fr) calc(var(--id-label) + 5mm) minmax(0, 1fr); }
.idg .nw { white-space: nowrap; }
.idg.req { background: transparent; margin-top: -3pt; }
.idg.req > .v:nth-child(2) { font-weight: 400; }
.keep { break-inside: avoid; page-break-inside: avoid; }
.keep > table.dt { margin-top: 0; }
.banner { border: 1pt solid var(--rule); border-left-width: 4pt; border-radius: 2pt; padding: 4pt 6pt; margin: 0 0 8pt;
  font-weight: 700; break-inside: avoid; }
.banner.amended { color: var(--alert); border-color: var(--alert); background: var(--alert-bg); }
.banner.prelim-banner { color: var(--warn); border-color: var(--warn); background: var(--warn-bg); }
.banner.ok { color: var(--ok); border-color: var(--ok); background: var(--ok-bg); }
/* imaging and text results: the conclusion stands out on a panel with a teal edge */
.conclusion { background: var(--panel); border: 0.5pt solid var(--hair); border-left: 3pt solid var(--accent-2);
  border-radius: 2pt; padding: 3pt 7pt 4pt; margin: 6pt 0 4pt; break-inside: avoid; }
.conclusion h3 { margin-top: 2pt; }
.conclusion p { font-weight: 600; margin: 0; }
.copy-to { font-size: var(--fs-small); color: var(--ink-2); margin-top: 6pt; }
.lab-notes { font-size: var(--fs-small); color: var(--ink-2); margin-top: 4pt; }
.lab-notes p { margin: 0 0 2pt; }
`

export interface MedicalReportContext {
  /** Translation function (dotted keys, {{vars}}). */
  t: TFn
  /** Document language (html lang). */
  lang?: string
  /** "Printed" date (default: now). */
  now?: Date
  /** Default true; false for previews. */
  autoPrint?: boolean
  /** The Source Sans 3 files (absolute URLs); default: the ones bundled with the website. */
  fonts?: FontUrls
}

/** The full HTML of the medical report, history or result report (pure; see `openMedicalReport`). */
export function buildMedicalReportHtml(
  d: MedicalReportDoc,
  l: MedicalReportLabels,
  ctx: MedicalReportContext,
): string {
  const layout = d.layout ?? (d.title ? 'lab' : 'medical')
  if (layout === 'lab') return labReportHtml(d, l, ctx)
  const p = medicalReportParts(d, l, ctx)
  return documentHtml({
    base: {
      page: 'a4',
      title: p.title,
      docNo: p.docNo,
      clinicName: p.clinicName,
      printedBy: p.printedBy,
      printedAt: p.now,
      medical: true,
      identity: p.identity,
      labels: p.dl,
      fonts: ctx.fonts,
    },
    css: MEDICAL_CSS,
    body: p.body,
    lang: ctx.lang,
    autoPrint: ctx.autoPrint,
  })
}

/** The pieces of a medical report or history, without the document wrapper. */
interface ReportParts {
  title: string
  docNo: string
  clinicName: string
  printedBy: string | null
  now: Date
  identity: { name: string; fileNo: string | null; dob: string | null }
  dl: DocLabels
  body: string
}

/** The one-visit report or the history, laid out (letterhead to signature) but not wrapped:
 *  one document prints it alone; the documents of a period join several (the batch below). */
function medicalReportParts(
  d: MedicalReportDoc,
  l: MedicalReportLabels,
  ctx: MedicalReportContext,
): ReportParts {
  const now = ctx.now ?? new Date()
  const dl = makeDocLabels(ctx.t)
  const w = medWords(ctx.t)
  const c: Ctx = { t: ctx.t, w, l, dl, plan: planOf(d.visits, w) }
  const lh = letterheadOf(d.clinic)
  const one = d.kind === 'visit'
  const title = d.title ?? (one ? l.title : l.titleHistory)
  const v0 = d.visits[0]
  const docNo = one
    ? `MR-${v0?.reference || `${d.patient.fileNumber}-${docStamp(toDate(v0?.at) ?? now)}`}`
    : `MH-${d.patient.fileNumber}-${docStamp(now)}`
  const printedBy = d.printedBy ?? d.author.name ?? null

  let tb: string
  if (one) {
    tb = titleBlockHtml({
      title,
      meta: [
        [dl.docNo, docNo],
        [c.w.visitDate, v0 ? visitWhen(v0) : null],
        [c.w.department, v0?.department],
        [c.w.attending, v0?.doctor],
      ],
    })
  } else {
    const n = d.visits.length
    const newest = d.visits[0]
    const oldest = d.visits[n - 1]
    tb = titleBlockHtml({
      title,
      scope: n && newest && oldest ? c.w.visitsScope(n, visitDay(oldest), visitDay(newest)) : null,
      meta: [
        [dl.docNo, docNo],
        [dl.date, docDateTime(now)],
      ],
    })
  }

  const head: string[] = [
    letterheadHtml(lh, dl),
    tb,
    patientFields(d, c, one ? 'visit' : 'history'),
    allergyHtml(allergiesOf(d.patient.allergies), dl),
  ]
  const pieces: Piece[] = []

  if (one && v0) {
    if (v0.referredBy?.trim())
      pieces.push(
        paraPiece(`<p><span class="lbl">${esc(c.w.referredBy)}:</span> ${esc(v0.referredBy)}</p>`),
      )
    pieces.push(...visitPieces(v0, c, false))
  } else if (!one) {
    const summary = historySummary(d, c, now)
    if (summary) pieces.push(paraPiece(summary))
    if (d.visits.length) {
      const rows: CellValue[][] = d.visits.map((v) => {
        const main = v.diagnoses.find((x) => x.primary) ?? v.diagnoses[0]
        return [
          visitDay(v),
          v.department ?? null,
          v.doctor ?? null,
          main ? `${main.text}${main.icd10 ? ` (${main.icd10})` : ''}` : null,
        ]
      })
      const cols: FixedColumn[] = [
        { label: c.w.visitDate, share: 15 },
        { label: c.w.department, share: 22 },
        { label: c.w.clinician, share: 25 },
        { label: c.w.mainDiagnosis, share: 38 },
      ]
      const used = usedColumns(4, rows, [0, 2, 3])
      pieces.push(
        tablePiece(`<h2>${esc(c.w.visits)}</h2>`, rows.length, (a, b, h) =>
          fixedTable(cols, rows.slice(a, b), { used, withHead: h }),
        ),
      )
      // one block per visit, newest first; the visit heading travels with its first section
      d.visits.forEach((v, i) => {
        const text = [`${c.w.visitDate}: ${visitWhen(v)}`, v.department, v.doctor]
          .filter(Boolean)
          .join(', ')
        const visitHead = `<h3 class="visit-h${i === 0 ? ' first' : ''}">${esc(text)}</h3>`
        const sections = visitPieces(v, c, true)
        const first = sections[0]
        if (!first) {
          pieces.push({ html: visitHead, small: true })
          return
        }
        sections[0] = {
          html: visitHead + first.html,
          small: first.small,
          split: first.split ? [visitHead + first.split[0], first.split[1]] : undefined,
        }
        pieces.push(...sections)
      })
    }
  }

  if (d.comment?.trim())
    pieces.push(
      paraPiece(`<h2>${esc(c.w.clinicianComment)}</h2><p>${escLines(d.comment.trim())}</p>`),
    )
  const signature = signatureHtml(
    [
      {
        name: d.author.name || null,
        qualification: d.author.title || null,
        registrationNo: d.author.registrationNo ?? null,
      },
    ],
    dl,
    { stamp: true, clinicName: lh.legalName },
  )
  const body = [...head, ...withSignature(pieces, signature)]
  if (d.copyTo?.trim()) body.push(`<p class="copy-to">${esc(c.w.copyTo)}: ${esc(d.copyTo)}</p>`)

  return {
    title,
    docNo,
    clinicName: lh.legalName,
    printedBy,
    now,
    identity: {
      name: d.patient.name,
      fileNo: d.patient.fileNumber,
      dob: docDate(d.patient.birthDate ?? null) || null,
    },
    dl,
    body: body.join(''),
  }
}

// ---------------------------------------------------------------- several reports in one document

/** The cover of the documents of a period: what the list says, in the reader's language. */
export interface ReportsBatchCover {
  /** "Patients' documents". */
  title: string
  /** "N medical reports · period · printed by …". */
  summary: string
  periodWord: string
  periodLabel: string
  /** The filters in words ("Department: Dental", "Doctor: …"), printed in the meta box. */
  filters: [label: string, value: string | null | undefined][]
  /** Key figures: reports, patients. */
  reportsLabel: string
  patientsLabel: string
  /** Column labels of the list. */
  columns: {
    no: string
    date: string
    patient: string
    file: string
    doctor: string
    diagnosis: string
  }
  /** "N visits could not be printed: their records are private." (left out when 0). */
  hidden?: string | null
}

const BATCH_CSS = `
.mr-cover .dt { margin-top: 8pt; }
.mr-copy { break-before: page; page-break-before: always; }
.mr-copy .mr-no { font-size: var(--fs-small); color: var(--ink-2); text-align: right; margin: 0 0 4pt; }
`

/**
 * The medical reports of several visits in ONE document (the manager's "Print all medical
 * reports"): a cover page listing them, then each report on its own page(s), laid out exactly
 * as the single report is. The running identity strip is left out (the patient changes from one
 * report to the next); each report carries its own patient block. Pure (no window).
 */
export function buildMedicalReportsBatchHtml(
  docs: MedicalReportDoc[],
  l: MedicalReportLabels,
  ctx: MedicalReportContext,
  cover: ReportsBatchCover,
  printedBy: string | null,
): string {
  const now = ctx.now ?? new Date()
  const dl = makeDocLabels(ctx.t)
  const parts = docs.map((d) => medicalReportParts(d, l, ctx))
  const first = docs[0]
  const lh = first ? letterheadOf(first.clinic) : null
  const patients = new Set(docs.map((d) => d.patient.fileNumber || d.patient.name)).size
  const c = cover.columns
  const list = tableHtml(
    [
      { label: c.no, width: '30mm' },
      { label: c.date, width: '28mm' },
      { label: c.patient },
      { label: c.file, width: '24mm' },
      { label: c.doctor, width: '36mm' },
      { label: c.diagnosis },
    ],
    docs.map((d, i) => {
      const v = d.visits[0]
      const main = v?.diagnoses.find((x) => x.primary) ?? v?.diagnoses[0]
      return [
        parts[i]!.docNo,
        v ? (v.at ? docDateTime(v.at) : v.date) : null,
        d.patient.name,
        d.patient.fileNumber,
        v?.doctor ?? null,
        main ? `${main.text}${main.icd10 ? ` (${main.icd10})` : ''}` : null,
      ]
    }),
  )
  const coverHtml = [
    lh ? letterheadHtml(lh, dl) : '',
    titleBlockHtml({
      title: cover.title,
      scope: cover.summary,
      meta: [[cover.periodWord, cover.periodLabel], ...cover.filters],
    }),
    keyFiguresHtml([
      { label: cover.reportsLabel, value: docNumber(docs.length), tone: 'teal' },
      { label: cover.patientsLabel, value: docNumber(patients), tone: 'navy' },
    ]),
    cover.hidden ? `<p class="alert">${esc(cover.hidden)}</p>` : '',
    list,
  ].join('')
  const copies = parts
    .map(
      (p, i) =>
        `<section class="mr-copy"><p class="mr-no">${esc(p.docNo)} · ${i + 1} / ${parts.length}</p>${p.body}</section>`,
    )
    .join('')
  return documentHtml({
    base: {
      page: 'a4',
      title: cover.title,
      docNo: null,
      clinicName: lh?.legalName ?? '',
      printedBy,
      printedAt: now,
      medical: true,
      identity: null,
      labels: dl,
      fonts: ctx.fonts,
    },
    css: MEDICAL_CSS + BATCH_CSS,
    body: `<section class="mr-cover">${coverHtml}</section>${copies}`,
    lang: ctx.lang,
    autoPrint: ctx.autoPrint,
  })
}

/** C2 item 4: recent primary diagnoses (12 months) and the latest visit's current medicines. */
function historySummary(d: MedicalReportDoc, c: Ctx, now: Date) {
  const yearAgo = now.getTime() - 365 * 86_400_000
  const seen = new Set<string>()
  const dx: string[] = []
  for (const v of d.visits) {
    const at = toDate(v.at)
    if (at && at.getTime() < yearAgo) continue
    for (const x of v.diagnoses.filter((y) => y.primary)) {
      const text = `${x.text}${x.icd10 ? ` (${x.icd10})` : ''}`
      if (!seen.has(text.toLowerCase())) {
        seen.add(text.toLowerCase())
        dx.push(text)
      }
    }
  }
  const meds = (d.visits[0]?.medicines ?? [])
    .filter((m) => m.status !== 'stopped' && m.status !== 'given')
    .map((m) => splitQty(m).name)
  const body =
    runInHtml(c.w.recentDiagnoses, dx.join('; ')) + runInHtml(c.w.currentMedicines, meds.join('; '))
  return body ? `<h2>${esc(c.w.summary)}</h2>${body}` : ''
}

/** C3: the laboratory (or ultrasound) result report of the visit's tests. */
function labReportHtml(d: MedicalReportDoc, l: MedicalReportLabels, ctx: MedicalReportContext) {
  const now = ctx.now ?? new Date()
  const dl = makeDocLabels(ctx.t)
  const w = medWords(ctx.t)
  const c: Ctx = { t: ctx.t, w, l, dl, plan: planOf([], w) }
  const lh = letterheadOf(d.clinic)
  const lab = d.lab ?? {}
  const v = d.visits[0]
  const tests = d.visits.flatMap((x) => x.tests)
  const title = d.title ?? l.title
  const sampleId = lab.sampleId?.trim() || null
  const docNo = sampleId
    ? `LAB-${sampleId}`
    : `LAB-${d.patient.fileNumber}-${docStamp(toDate(lab.requestedAt) ?? toDate(v?.at) ?? now)}`
  const verified = tests.length > 0 && tests.every((x) => x.verified || !hasResult(x))
  const anyResult = tests.some(hasResult)
  const reported = docDateTime(lab.reportedAt) || docDateTime(lab.validatedAt)
  const amended = !!lab.amends || !!lab.amended
  // the state of the report at a glance: Validated / Preliminary, Amended
  const badges = [
    anyResult
      ? verified
        ? chipHtml(w.chipValidated, 'ok')
        : chipHtml(w.chipPreliminary, 'warn')
      : '',
    amended ? chipHtml(w.chipAmended, 'alert') : '',
  ].join('')

  const head: string[] = [
    letterheadHtml(lh, dl),
    titleBlockHtml({
      title,
      badges,
      meta: [
        [w.reportNo, docNo],
        [w.labNo, sampleId],
        // every title block carries a date: the report time, else the printing time
        reported ? [w.reported, reported] : [dl.date, docDateTime(now)],
      ],
    }),
    patientFields(d, c, 'lab'),
  ]

  // request block: who asked, why and the specimen on the left; the stored times on the right
  const reason = lab.reason?.trim() || v?.notes.filter((x) => x.trim()).join('\n') || null
  // "Dr. X, General consultation": a line break may fall after the comma, never inside the name
  const requester = [v?.doctor, lab.department ?? v?.department]
    .filter(Boolean)
    .map((x) => `<span class="nw">${esc(x)}</span>`)
    .join(', ')
  const requested = docDateTime(lab.requestedAt) || (v ? visitWhen(v) : '')
  head.push(
    identityHtml(
      [
        { label: w.requestedBy, value: requester || null, html: true },
        { label: w.clinicalInfo, value: reason },
        { label: w.specimen, value: lab.specimen },
      ],
      [
        { label: w.visitNo, value: v?.reference?.trim() || null },
        { label: w.requested, value: requested || null },
        { label: w.collected, value: docDateTime(lab.collectedAt) || null },
        { label: w.received, value: docDateTime(lab.receivedAt) || null },
      ],
    ).replace('class="idg"', 'class="idg lab-grid req"'),
  )

  if (lab.amends)
    head.push(
      `<div class="banner amended flag-word">${esc(w.amendedBanner(docDateTime(lab.amends)))}</div>`,
    )
  else if (lab.amended)
    head.push(`<div class="banner amended flag-word">${esc(w.amendedBannerNoDate)}</div>`)
  if (anyResult && !verified)
    head.push(`<div class="banner prelim-banner">${esc(w.preliminaryBanner)}</div>`)
  else if (anyResult && lab.validatedBy?.name && lab.validatedAt)
    head.push(
      `<div class="banner ok flag-word">${esc(w.validatedBanner(docDateTime(lab.validatedAt), lab.validatedBy.name))}</div>`,
    )

  // measured results in a table, grouped by panel; text results as findings and conclusion
  const pieces: Piece[] = []
  const measured = tests.filter((x) => x.value != null && x.value !== '')
  const text = tests.filter((x) => !(x.value != null && x.value !== ''))
  if (measured.length) {
    const panels = new Map<string, ReportTest[]>()
    for (const x of measured) {
      const key = x.panel?.trim() ?? ''
      panels.set(key, [...(panels.get(key) ?? []), x])
    }
    const rows: string[] = []
    for (const [panel, list] of panels) {
      if (panel) rows.push(`<tr class="panel"><td colspan="5">${esc(panel)}</td></tr>`)
      for (const x of list) rows.push(resultRow(x, c, { preliminary: false, textInCell: false }))
    }
    // a panel sub-head never stays behind without its row
    const lastRows =
      rows.length > 2 && rows[rows.length - 2]!.startsWith('<tr class="panel"') ? 2 : 1
    pieces.push(
      tablePiece(
        `<h2>${esc(w.results)}</h2>`,
        rows.length,
        (a, b, h) => resultsTable(rows.slice(a, b), c, h),
        '',
        lastRows,
      ),
    )
  }
  for (const x of text) {
    const findings = x.findings?.trim()
    const impression = x.impression?.trim()
    pieces.push(
      paraPiece(
        `<h2>${esc(x.name)}</h2>` +
          (findings || impression
            ? (findings ? `<h3>${esc(w.findings)}</h3><p>${escLines(findings)}</p>` : '') +
              (impression
                ? `<div class="conclusion"><h3>${esc(l.conclusion)}</h3><p>${escLines(impression)}</p></div>`
                : '')
            : `<p>${esc(w.awaited)}</p>`),
      ),
    )
  }
  // the method and reference-range note belong to the results above them
  const notes = [
    lab.method?.trim() ? `<p>${esc(w.method)}: ${esc(lab.method.trim())}</p>` : '',
    measured.length ? `<p>${esc(w.rangesNote)}</p>` : '',
  ].join('')
  const last = pieces[pieces.length - 1]
  if (notes && last) {
    const block = `<div class="lab-notes">${notes}</div>`
    pieces[pieces.length - 1] = {
      html: last.html + block,
      small: last.small,
      split: last.split ? [last.split[0], last.split[1] + block] : undefined,
    }
  }

  const validator = lab.validatedBy
  const signature = signatureHtml(
    [
      {
        heading: w.performedBy,
        name: d.author.name || null,
        qualification: d.author.title || null,
        date: lab.performedAt ? docDateTime(lab.performedAt) : null,
        noSignature: true,
      },
      {
        heading: w.validatedBy,
        name: validator?.name ?? null,
        qualification: validator ? (validator.title ?? null) : null,
        registrationNo: validator?.registrationNo ?? null,
        date: lab.validatedAt ? docDateTime(lab.validatedAt) : null,
      },
    ],
    dl,
    { stamp: false, clinicName: lh.legalName },
  )
  const body = [...head, ...withSignature(pieces, signature)]
  if (d.copyTo?.trim()) body.push(`<p class="copy-to">${esc(w.copyTo)}: ${esc(d.copyTo)}</p>`)

  // pages 2+: the Lab no. on the right (title plus Lab no. overlaps the identity strip in rw/fr)
  const runningTitle = sampleId ? `${w.labNo}: ${sampleId}` : title
  return documentHtml({
    base: {
      page: 'a4',
      title,
      docNo: sampleId ? `${docNo}   ${w.labNo}: ${sampleId}` : docNo,
      clinicName: lh.legalName,
      printedBy: d.printedBy ?? null,
      printedAt: now,
      medical: true,
      identity: {
        name: d.patient.name,
        fileNo: d.patient.fileNumber,
        dob: docDate(d.patient.birthDate ?? null) || null,
      },
      runningTitle,
      labels: dl,
      fonts: ctx.fonts,
    },
    css: MEDICAL_CSS,
    body: body.join(''),
    lang: ctx.lang,
    autoPrint: ctx.autoPrint,
  })
}

/**
 * Opens the medical report (one visit or the whole history) or the result report in a new
 * window and sends it to the print dialog. False when the browser blocked the window.
 * `fonts`: the bundled Source Sans 3 files, when the app provides them.
 */
export function openMedicalReport(
  d: MedicalReportDoc,
  l: MedicalReportLabels,
  opts: { fonts?: FontUrls } = {},
): boolean {
  const t: TFn = (key, vars) => i18next.t(key, vars ?? {}) as string
  return openPrintWindow(
    buildMedicalReportHtml(d, l, { t, lang: i18next.language, fonts: opts.fonts }),
  )
}

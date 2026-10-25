import { formatNumber, formatRwf } from '@mmc/shared'
import sourceSansLatin from '@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-normal.woff2?url'
import sourceSansLatinExt from '@fontsource-variable/source-sans-3/files/source-sans-3-latin-ext-wght-normal.woff2?url'

/**
 * The clinic's document design standard (v1), shared by every printed or exported document:
 * the medical report and history, the lab result report, the prescription, the payment receipt,
 * the dispensing labels, the PDF management reports and the Excel reports.
 *
 * Pure functions only (no React), so builders stay testable and can be rendered from a script.
 * A builder composes its body from the pieces below and hands it to `documentHtml`, then
 * `openPrintWindow` writes it into a new window, waits for the fonts and images and prints.
 *
 * Type: Source Sans 3 (400, 600, 700), bundled with the website (no Google Fonts, so printing
 * never depends on the internet), with a full system fallback. Colour: near-black text, one navy accent (letterhead only), red only for
 * ALLERGY / CRIT / AMENDED (always with the word and bold weight, so B&W prints keep the meaning).
 */

// ---------------------------------------------------------------- types

export type PageKind = 'a4' | 'a4-landscape' | 'a5' | 'receipt' | 'label'

/** The clinic's identity as printed in letterheads. Missing values are null and never printed. */
export interface Letterhead {
  legalName: string
  /** "Kiramuruzi, Gatsibo District, Eastern Province, Rwanda". */
  addressLine: string | null
  phone: string | null
  email: string | null
  tin: string | null
  mohLicence: string | null
  fdaLicence: string | null
  poBox: string | null
  /** Absolute URL of the logo (the print window is a fresh document). */
  logoUrl: string
  /** "24 hours, 7 days a week" or "Mon–Fri 08:00–18:00, Sat 08:00–13:00". */
  openingHours: string | null
}

/** A translation function: dotted key, optional {{vars}} (and `count` for plurals). */
export type TFn = (key: string, vars?: Record<string, unknown>) => string

/** The shared wording of every document, in the interface language (see `makeDocLabels`). */
export interface DocLabels {
  docNo: string
  date: string
  printedBy: (date: string, name: string) => string
  printedAt: (date: string) => string
  /** Template with {{page}} and {{pages}}. */
  pageOf: string
  confidential: string
  patient: string
  name: string
  dateOfBirth: string
  dobShort: string
  sex: string
  fileNo: string
  phone: string
  insurer: string
  memberNo: string
  weightKg: string
  ageYears: (n: number) => string
  ageMonths: (n: number) => string
  ageDays: (n: number) => string
  allergyFlag: string
  allergies: string
  noKnownAllergies: string
  notRecorded: string
  tel: string
  email: string
  tin: string
  mohLicence: string
  fdaLicence: string
  poBox: string
  district: (name: string) => string
  qualification: string
  registrationNo: string
  signature: string
  stamp: string
  generated: (clinic: string) => string
  total: string
  printHint: string
  openingHours: string
  open24: string
  closed: string
  /** A payment method code (cash, momo, airtel, card, bank, insurer, credit, deposit) in words. */
  method: (code: string) => string
}

export function makeDocLabels(t: TFn): DocLabels {
  const k = (key: string, vars?: Record<string, unknown>) => t(`doc.${key}`, vars)
  return {
    docNo: k('docNo'),
    date: k('date'),
    printedBy: (date, name) => k('printedBy', { date, name }),
    printedAt: (date) => k('printedAt', { date }),
    // the placeholders stay in the text: the page counters are filled in by CSS or Excel
    pageOf: k('pageOf', { page: '{{page}}', pages: '{{pages}}' }),
    confidential: k('confidential'),
    patient: k('patient'),
    name: k('name'),
    dateOfBirth: k('dateOfBirth'),
    dobShort: k('dobShort'),
    sex: k('sex'),
    fileNo: k('fileNo'),
    phone: k('phone'),
    insurer: k('insurer'),
    memberNo: k('memberNo'),
    weightKg: k('weightKg'),
    ageYears: (count) => k('ageYears', { count }),
    ageMonths: (count) => k('ageMonths', { count }),
    ageDays: (count) => k('ageDays', { count }),
    allergyFlag: k('allergyFlag'),
    allergies: k('allergies'),
    noKnownAllergies: k('noKnownAllergies'),
    notRecorded: k('notRecorded'),
    tel: k('tel'),
    email: k('email'),
    tin: k('tin'),
    mohLicence: k('mohLicence'),
    fdaLicence: k('fdaLicence'),
    poBox: k('poBox'),
    district: (name) => k('district', { name }),
    qualification: k('qualification'),
    registrationNo: k('registrationNo'),
    signature: k('signature'),
    stamp: k('stamp'),
    generated: (clinic) => k('generated', { clinic }),
    total: k('total'),
    printHint: k('printHint'),
    openingHours: k('openingHours'),
    open24: k('open24'),
    closed: k('closed'),
    method: (code) => t(`visit.payment.methods.${code}`, { defaultValue: code }),
  }
}

// ---------------------------------------------------------------- text, dates, numbers

/** HTML-escapes any value (null and undefined become ''). */
export const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** Escaped text with its line breaks kept. */
export const escLines = (s: unknown): string => esc(s).replace(/\r?\n/g, '<br>')

/** A CSS string literal ("…"), for margin-box content: escapes \ and ", drops line breaks. */
export const cssString = (s: unknown): string =>
  `"${String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ')}"`

/** The empty-cell mark. */
export const DASH = '–'

/** Kigali is UTC+2 all year (no daylight saving). */
const KIGALI_OFFSET_MS = 2 * 3600_000
const pad = (n: number) => String(n).padStart(2, '0')

export const toDate = (v: Date | string | number | null | undefined): Date | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Wall-clock parts in Africa/Kigali, whatever the computer's time zone. */
export function kigaliParts(d: Date) {
  const k = new Date(d.getTime() + KIGALI_OFFSET_MS)
  return {
    y: k.getUTCFullYear(),
    m: k.getUTCMonth() + 1,
    d: k.getUTCDate(),
    H: k.getUTCHours(),
    M: k.getUTCMinutes(),
  }
}

/** dd/mm/yyyy in Kigali time ('' when there is no date). */
export function docDate(v: Date | string | number | null | undefined): string {
  const d = toDate(v)
  if (!d) return ''
  // a plain yyyy-mm-dd (birth date, follow-up date) is a calendar day, not an instant
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, day] = v.split('-')
    return `${day}/${m}/${y}`
  }
  const p = kigaliParts(d)
  return `${pad(p.d)}/${pad(p.m)}/${p.y}`
}

/** dd/mm/yyyy HH:mm, 24-hour, in Kigali time. */
export function docDateTime(v: Date | string | number | null | undefined): string {
  const d = toDate(v)
  if (!d) return ''
  const p = kigaliParts(d)
  return `${pad(p.d)}/${pad(p.m)}/${p.y} ${pad(p.H)}:${pad(p.M)}`
}

/** HH:mm in Kigali time. */
export function docTime(v: Date | string | number | null | undefined): string {
  const d = toDate(v)
  if (!d) return ''
  const p = kigaliParts(d)
  return `${pad(p.H)}:${pad(p.M)}`
}

/** mm/yyyy (expiry dates). */
export function docMonthYear(v: Date | string | number | null | undefined): string {
  const d = toDate(v)
  if (!d) return ''
  const p = kigaliParts(d)
  return `${pad(p.m)}/${p.y}`
}

/** yyyymmddHHmm in Kigali time, for document numbers (MH-{file}-{stamp}). */
export function docStamp(v: Date = new Date()): string {
  const p = kigaliParts(v)
  return `${p.y}${pad(p.m)}${pad(p.d)}${pad(p.H)}${pad(p.M)}`
}

/** "12,500" for a money table cell (the unit is in the column header). */
export const docMoney = (n: number): string => formatNumber(Math.round(n))
/** "RWF 12,500" for a single value or running text: the one money format. */
export { formatRwf }

/** "38 years", "7 months" or "12 days" at the given date. */
export function ageText(
  birth: Date | string | null | undefined,
  l: DocLabels,
  at: Date = new Date(),
): string {
  const b = toDate(birth)
  if (!b) return ''
  const days = Math.floor((at.getTime() - b.getTime()) / 86_400_000)
  if (days < 0) return ''
  if (days < 31) return l.ageDays(days)
  const bp = kigaliParts(b)
  const ap = kigaliParts(at)
  let months = (ap.y - bp.y) * 12 + (ap.m - bp.m) - (ap.d < bp.d ? 1 : 0)
  if (months < 0) months = 0
  return months < 24 ? l.ageMonths(months) : l.ageYears(Math.floor(months / 12))
}

/** "14/03/1988 (38 years)", or '' when the birth date is unknown. */
export function dobWithAge(
  birth: Date | string | null | undefined,
  l: DocLabels,
  at: Date = new Date(),
): string {
  const date = docDate(birth ?? null)
  if (!date) return ''
  const age = ageText(birth, l, at)
  return age ? `${date} (${age})` : date
}

// ---------------------------------------------------------------- letterhead data

/** The raw `clinic.profile` setting (all optional: a new clinic may not have filled it). */
export interface ProfileLike {
  name?: string | null
  sector?: string | null
  district?: string | null
  province?: string | null
  country?: string | null
  phone?: string | null
  email?: string | null
  tin?: unknown
  moh_licence?: unknown
  fda_licence?: unknown
  po_box?: unknown
}

/** Weekly hours as stored in `clinic.hours` (day '0' = Sunday). */
export interface HoursLike {
  days?: Partial<Record<string, [string, string] | null>>
}

const str = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).trim()
  return s ? s : null
}

/** "Mon–Fri 08:00–18:00, Sat 08:00–13:00, Sun closed", or "24 hours, 7 days a week". */
export function openingHoursText(
  hours: HoursLike | null | undefined,
  l: DocLabels,
  shortDays: string[],
): string | null {
  const days = hours?.days
  if (!days) return null
  const order = ['1', '2', '3', '4', '5', '6', '0']
  const span = (k: string) => {
    const s = days[k]
    return s ? `${s[0]}–${s[1] === '24:00' && s[0] === '00:00' ? '24:00' : s[1]}` : null
  }
  if (order.every((k) => days[k]?.[0] === '00:00' && days[k]?.[1] === '24:00')) return l.open24
  const groups: { from: string; to: string; span: string | null }[] = []
  for (const k of order) {
    const s = span(k)
    const last = groups[groups.length - 1]
    if (last && last.span === s) last.to = k
    else groups.push({ from: k, to: k, span: s })
  }
  return groups
    .map((g) => {
      const name = (k: string) => shortDays[Number(k)] ?? k
      const range = g.from === g.to ? name(g.from) : `${name(g.from)}–${name(g.to)}`
      return `${range} ${g.span ?? l.closed}`
    })
    .join(', ')
}

/** Builds the structured letterhead from the clinic profile and hours. */
export function letterheadFrom(
  profile: ProfileLike,
  l: DocLabels,
  opts: { logoUrl: string; hours?: HoursLike | null; shortDays?: string[] },
): Letterhead {
  const district = str(profile.district)
  const districtText =
    district && !/district|akarere/i.test(district) ? l.district(district) : district
  const address = [str(profile.sector), districtText, str(profile.province), str(profile.country)]
    .filter(Boolean)
    .join(', ')
  return {
    legalName: str(profile.name) ?? 'Muhazi Medical Clinic',
    addressLine: address || null,
    phone: str(profile.phone),
    email: str(profile.email),
    tin: str(profile.tin),
    mohLicence: str(profile.moh_licence),
    fdaLicence: str(profile.fda_licence),
    poBox: str(profile.po_box),
    logoUrl: opts.logoUrl,
    openingHours: openingHoursText(opts.hours, l, opts.shortDays ?? []),
  }
}

// ---------------------------------------------------------------- fonts

export const FONT_STACK = '"Source Sans 3", "Segoe UI", Arial, "Liberation Sans", sans-serif'

/** The Source Sans 3 woff2 files (variable weight 200–900), as absolute URLs. */
export interface FontUrls {
  latin: string
  latinExt: string
}

/**
 * Absolute URL of a file served by the website. The print window is a fresh `about:blank`
 * document, so a root-relative path would not resolve there. Outside a browser (a script that
 * renders a document) the path is returned as it is.
 */
function absoluteUrl(path: string): string {
  try {
    if (typeof window === 'undefined' || !window.location?.origin) return path
    return new URL(path, window.location.origin).href
  } catch {
    return path
  }
}

/**
 * The Source Sans 3 files bundled with the website (no internet needed to print): Vite copies
 * them into the build and gives their served path. Every document uses them unless the caller
 * passes other `fonts`.
 */
export function defaultFonts(): FontUrls {
  return { latin: absoluteUrl(sourceSansLatin), latinExt: absoluteUrl(sourceSansLatinExt) }
}

const LATIN_RANGE =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
const LATIN_EXT_RANGE =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'

/** The @font-face rules of the document; the system fonts of FONT_STACK stay as the fallback. */
function fontHead(fonts: FontUrls = defaultFonts()): string {
  const face = (url: string, range: string) =>
    `@font-face{font-family:"Source Sans 3";font-style:normal;font-weight:200 900;font-display:swap;src:url(${cssString(url)}) format("woff2-variations"),url(${cssString(url)}) format("woff2");unicode-range:${range}}`
  const preload = `<link rel="preload" as="font" type="font/woff2" href="${esc(fonts.latin)}" crossorigin>`
  return `${preload}<style>${face(fonts.latin, LATIN_RANGE)}${face(fonts.latinExt, LATIN_EXT_RANGE)}</style>`
}

// ---------------------------------------------------------------- base CSS

export interface PrintBaseOptions {
  page: PageKind
  /** The document title (window title, running header). */
  title: string
  /** Unique document number, printed in the title block and the footer. */
  docNo?: string | null
  /** Clinic legal name for the footer. */
  clinicName: string
  /** Full name of the user who prints. */
  printedBy?: string | null
  printedAt?: Date
  /** Medical documents: "Confidential medical information" footer and the running identity. */
  medical?: boolean
  /** Running identity strip from page 2 on (medical documents). */
  identity?: { name: string; fileNo?: string | null; dob?: string | null } | null
  /** Top-right running text from page 2 on (default: the title). */
  runningTitle?: string
  labels: DocLabels
  /** Font files; omitted = the Source Sans 3 files bundled with the website (`defaultFonts`). */
  fonts?: FontUrls
}

interface Scale {
  title: number
  clinic: number
  h: number
  sub: number
  body: number
  table: number
  small: number
  logo: string
  idLabel: string
  stampW: string
  stampH: string
  sheetW: string
  pad: string
  page: string
}

const SCALES: Record<PageKind, Scale> = {
  a4: {
    title: 15,
    clinic: 13,
    h: 11,
    sub: 10,
    body: 10,
    table: 9,
    small: 8,
    logo: '20mm',
    idLabel: '28mm',
    stampW: '40mm',
    stampH: '28mm',
    sheetW: '210mm',
    pad: '15mm 18mm 20mm',
    page: 'size: A4 portrait; margin: 15mm 18mm 20mm;',
  },
  'a4-landscape': {
    title: 15,
    clinic: 13,
    h: 11,
    sub: 10,
    body: 10,
    table: 9,
    small: 8,
    logo: '14mm',
    idLabel: '28mm',
    stampW: '40mm',
    stampH: '28mm',
    sheetW: '297mm',
    pad: '15mm 18mm 20mm',
    page: 'size: A4 landscape; margin: 15mm 18mm 20mm;',
  },
  a5: {
    title: 13,
    clinic: 12,
    h: 10,
    sub: 9.5,
    body: 9.5,
    table: 9,
    small: 7.5,
    logo: '16mm',
    idLabel: '24mm',
    stampW: '35mm',
    stampH: '25mm',
    sheetW: '148mm',
    pad: '12mm 12mm 16mm',
    page: 'size: A5 portrait; margin: 12mm 12mm 16mm;',
  },
  receipt: {
    title: 11,
    clinic: 11,
    h: 9,
    sub: 9,
    body: 9,
    table: 9,
    small: 8,
    logo: '14mm',
    idLabel: '22mm',
    stampW: '0',
    stampH: '0',
    sheetW: '80mm',
    pad: '3mm 4mm',
    // the height is set to the content by the print script (Chrome ignores "80mm auto")
    page: 'size: 80mm 200mm; margin: 3mm 4mm;',
  },
  label: {
    title: 10,
    clinic: 7.5,
    h: 10,
    sub: 9.5,
    body: 7.5,
    table: 7.5,
    small: 7.5,
    logo: '0',
    idLabel: '0',
    stampW: '0',
    stampH: '0',
    sheetW: '70mm',
    pad: '0',
    page: 'size: 70mm 40mm; margin: 0;',
  },
}

/** CSS `content` from a template with {{page}} / {{pages}} placeholders. */
function pageCounterContent(template: string): string {
  const parts = template.split(/(\{\{pages?\}\})/)
  return parts
    .filter((p) => p !== '')
    .map((p) =>
      p === '{{page}}' ? 'counter(page)' : p === '{{pages}}' ? 'counter(pages)' : cssString(p),
    )
    .join(' ')
}

const GAP = '  ' // about 12 pt between labelled pairs at 8 pt

function marginBoxes(o: PrintBaseOptions): string {
  if (o.page === 'receipt' || o.page === 'label') return ''
  const l = o.labels
  const at = docDateTime(o.printedAt ?? new Date())
  const box = `font: 400 ${SCALES[o.page].small}pt/1.2 ${FONT_STACK}; color: #444444; white-space: pre;`
  const left = o.medical
    ? [o.docNo, l.confidential].filter(Boolean).join(GAP)
    : [o.clinicName, o.docNo].filter(Boolean).join(GAP)
  const printed = o.printedBy ? l.printedBy(at, o.printedBy) : l.printedAt(at)
  // Two lines on the left, the page count on the right: three boxes on one line overlap on
  // A4/A5 (Chrome centres the middle box whatever the width of the left one).
  let css = `@page {
  @bottom-left { content: ${cssString(left)} "\\A" ${cssString(printed)}; ${box} vertical-align: top; padding-top: 4mm; width: 75%; }
  @bottom-right { content: ${pageCounterContent(l.pageOf)}; ${box} text-align: right; vertical-align: top; padding-top: 4mm; width: 25%; }`
  if (o.medical && o.identity) {
    const id = o.identity
    const strip = [
      `${l.patient}: ${id.name}`,
      id.fileNo ? `${l.fileNo}: ${id.fileNo}` : '',
      id.dob ? `${l.dobShort}: ${id.dob}` : '',
    ]
      .filter(Boolean)
      .join(GAP)
    css += `
  @top-left { content: ${cssString(strip)}; ${box} vertical-align: bottom; padding-bottom: 3mm; }
  @top-right { content: ${cssString(o.runningTitle ?? o.title)}; ${box} vertical-align: bottom; padding-bottom: 3mm; }`
  }
  css += '\n}'
  if (o.medical && o.identity)
    css += '\n@page :first { @top-left { content: none; } @top-right { content: none; } }'
  return css
}

/**
 * The shared CSS of every document: tokens, typography, @page size and margin boxes (footer with
 * "Page x of y", running identity strip), letterhead, title block, identity grid, allergy
 * statement, tables, key figures, signature and stamp block, screen preview and print rules.
 * Builders add only the layout specific to their document.
 */
export function printBase(o: PrintBaseOptions): string {
  const s = SCALES[o.page]
  const thermal = o.page === 'receipt' || o.page === 'label'
  const ink = thermal ? '#000000' : '#111111'
  const ink2 = thermal ? '#000000' : '#444444'
  const hair = thermal ? '#000000' : '#bbbbbb'
  const accent = thermal ? '#000000' : '#1B3A75'
  const alert = thermal ? '#000000' : '#B00020'
  return `
:root {
  --ink: ${ink}; --ink-2: ${ink2}; --rule: ${ink}; --hair: ${hair}; --accent: ${accent}; --alert: ${alert};
  --font: ${FONT_STACK};
  --fs-title: ${s.title}pt; --fs-clinic: ${s.clinic}pt; --fs-h: ${s.h}pt; --fs-sub: ${s.sub}pt;
  --fs-body: ${s.body}pt; --fs-table: ${s.table}pt; --fs-small: ${s.small}pt;
  --logo: ${s.logo}; --id-label: ${s.idLabel}; --stamp-w: ${s.stampW}; --stamp-h: ${s.stampH};
}
@page { ${s.page} }
${marginBoxes(o)}
* { box-sizing: border-box; }
html {
  font: 400 var(--fs-body)/1.35 var(--font); color: var(--ink); background: #ffffff;
  font-kerning: normal; font-variant-numeric: lining-nums; text-rendering: optimizeLegibility;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; -webkit-text-size-adjust: 100%;
}
body { margin: 0; background: #ffffff; }
p { margin: 0 0 4pt; }
i, em, cite, address { font-style: normal; }
b, strong { font-weight: 700; }
.sb, .lbl { font-weight: 600; }
.small { font-size: var(--fs-small); color: var(--ink-2); }
.num { text-align: right; font-variant-numeric: tabular-nums lining-nums; white-space: nowrap; }
.alert { color: var(--alert); font-weight: 700; }
.flag-word { font-weight: 700; letter-spacing: 0.05em; }
sup, sub { font-size: 70%; line-height: 0; }
img { max-width: 100%; }

/* letterhead (page 1) */
.lh { display: flex; align-items: center; gap: 4mm; padding-bottom: 4pt; margin: 0 0 6pt;
  border-bottom: 0.75pt solid var(--accent); line-height: 1.2; }
.lh img { height: var(--logo); width: auto; display: block; flex: none; }
.lh-name { font-size: var(--fs-clinic); font-weight: 600; color: var(--accent); margin-bottom: 1.5pt; }
.lh-line { font-size: var(--fs-small); color: var(--ink-2); }
.pairs > span { display: inline-block; white-space: nowrap; margin-right: 12pt; }
.pairs > span:last-child { margin-right: 0; }

/* receipt letterhead (centred) */
.rh { text-align: center; line-height: 1.25; padding-bottom: 4pt; border-bottom: 0.5pt solid var(--rule); margin-bottom: 5pt; }
.rh img { height: var(--logo); width: auto; display: block; margin: 0 auto 2pt; }
.rh-name { font-size: var(--fs-clinic); font-weight: 600; }
.rh-line { font-size: var(--fs-small); }

/* title block */
.tb { display: flex; justify-content: space-between; align-items: flex-start; gap: 8mm; margin: 0 0 8pt; }
.tb h1 { font-size: var(--fs-title); font-weight: 700; line-height: 1.2; margin: 0; }
.tb-scope { font-size: var(--fs-table); margin-top: 2pt; }
.tb-meta { font-size: var(--fs-table); line-height: 1.3; text-align: right; flex: none; }
.tb-meta .lbl { color: var(--ink); }

/* patient identity */
.idg { display: grid; grid-template-columns: var(--id-label) minmax(0, 1fr) calc(var(--id-label) + 5mm) minmax(0, 1fr);
  row-gap: 1.5pt; align-items: baseline; border-top: 0.5pt solid var(--rule); border-bottom: 0.5pt solid var(--rule);
  padding: 4pt 0; margin: 0 0 6pt; line-height: 1.25; }
.idg .k { font-size: var(--fs-table); font-weight: 600; }
.idg .k.c2 { padding-left: 5mm; }
.idg .v { font-size: var(--fs-body); }
.blank { display: inline-block; min-width: 28mm; border-bottom: 0.5pt solid var(--rule); height: 1.1em; vertical-align: bottom; }

/* allergy statement */
.allergy-box { border: 1pt solid var(--rule); padding: 4pt; margin: 0 0 8pt; font-weight: 700; break-inside: avoid; }
.allergy-box .flag-word { color: var(--alert); margin-right: 3pt; }
.allergy-line { margin: 0 0 8pt; }

/* headings */
h2 { font-size: var(--fs-h); font-weight: 600; line-height: 1.2; margin: 10pt 0 3pt; padding-bottom: 1.5pt;
  border-bottom: 0.5pt solid var(--rule); break-after: avoid; page-break-after: avoid; }
h3 { font-size: var(--fs-sub); font-weight: 600; line-height: 1.2; margin: 7pt 0 3pt; break-after: avoid; page-break-after: avoid; }
h2 + h3 { margin-top: 4pt; }

/* tables */
table.dt { border-collapse: collapse; width: 100%; font-size: var(--fs-table); line-height: 1.2;
  font-variant-numeric: tabular-nums lining-nums; margin: 2pt 0 6pt; }
table.dt.fit { width: auto; min-width: 60%; }
.dt thead { display: table-header-group; }
.dt th { font-weight: 600; text-align: left; vertical-align: bottom; padding: 3pt 6pt; border-bottom: 0.75pt solid var(--rule); }
.dt td { vertical-align: top; padding: 3pt 6pt; border-bottom: 0.5pt solid var(--hair); }
.dt th:first-child, .dt td:first-child { padding-left: 0; }
.dt th:last-child, .dt td:last-child { padding-right: 0; }
.dt th.num, .dt td.num { text-align: right; }
.dt tr { break-inside: avoid; page-break-inside: avoid; }
.dt tr.total td { border-top: 1pt solid var(--rule); border-bottom: 0; font-weight: 600; }
.dt tr.total + tr.total td { border-top: 0; }
.dt tr.grand td { font-weight: 700; }

/* run-in paragraphs, key figures */
.runin .lbl { margin-right: 3pt; }
.kf { display: flex; flex-wrap: wrap; gap: 4pt 10mm; padding: 0 0 5pt; margin: 0 0 8pt; border-bottom: 0.5pt solid var(--rule); }
.kf .k { font-size: var(--fs-small); color: var(--ink-2); line-height: 1.2; }
.kf .v { font-size: ${s.h}pt; font-weight: 600; line-height: 1.25; font-variant-numeric: tabular-nums lining-nums; }

/* signature and stamp */
.sig-wrap { break-inside: avoid; page-break-inside: avoid; margin-top: 16pt; }
.sig { display: grid; gap: 4pt 10mm; }
.sig-col > div { display: flex; align-items: flex-end; gap: 2mm; margin: 0 0 5pt; }
.sig-col .k { font-weight: 600; font-size: var(--fs-table); flex: none; width: var(--id-label); }
.sig-col .k.auto { width: auto; }
.sig-col .head { font-weight: 600; margin-bottom: 4pt; }
.sig-line { display: inline-block; border-bottom: 0.5pt solid var(--rule); width: 50mm; height: 1.2em; }
.sig-line.tall { height: 9mm; }
.sig-line.short { width: 30mm; }
.stamp-space { width: var(--stamp-w); height: var(--stamp-h); }
.sig-note { font-size: var(--fs-small); color: var(--ink-2); margin-top: 6pt; }

/* dispensing labels: one 70 x 40 mm page each, die-cut stock is the border */
.label { width: 70mm; height: 40mm; padding: 2mm; overflow: hidden; break-after: page; page-break-after: always; line-height: 1.2; }
.label:last-child { break-after: auto; page-break-after: auto; }

/* shown only where the browser has no @page margin boxes (Firefox) */
.printed-fallback { display: none; font-size: var(--fs-small); color: var(--ink-2); margin-top: 12pt; }
html.no-margin-boxes .printed-fallback { display: block; }

@media screen {
  html { background: #e9e9e9; }
  body { background: #e9e9e9; padding: 0 12px 24px; }
  .screen-hint { position: sticky; top: 0; z-index: 1; margin: 0 -12px 16px; padding: 8px 12px; background: #ffffff;
    border-bottom: 1px solid #bbbbbb; font: 400 10pt/1.35 var(--font); color: #111111; text-align: center; }
  .sheet { background: #ffffff; width: ${s.sheetW}; max-width: 100%; margin: 0 auto; padding: ${s.pad}; border: 1px solid #bbbbbb; }
  ${o.page === 'label' ? '.sheet { padding: 0; border: 0; background: transparent; } .label { background: #ffffff; outline: 1px solid #bbbbbb; margin: 0 auto 6mm; }' : ''}
  ${o.page === 'receipt' ? '.sheet { width: 80mm; }' : ''}
}
@media print {
  .screen-hint { display: none; }
  .sheet { width: auto; padding: 0; border: 0; margin: 0; }
}
`
}

// ---------------------------------------------------------------- HTML pieces

/** A labelled pair "Label: value" (escaped). */
const pair = (label: string, value: string | null | undefined) =>
  value ? `<span>${esc(label)}: ${esc(value)}</span>` : ''

/**
 * The page-1 letterhead: logo, legal name (navy), address, contacts, licences, navy rule.
 * `compact` (management reports): logo, name and "TIN … MoH licence …" only.
 */
export function letterheadHtml(lh: Letterhead, l: DocLabels, variant: 'full' | 'compact' = 'full') {
  const licences = [
    pair(l.tin, lh.tin),
    pair(l.mohLicence, lh.mohLicence),
    variant === 'full' ? pair(l.fdaLicence, lh.fdaLicence) : '',
  ].join('')
  const lines =
    variant === 'compact'
      ? [licences]
      : [
          [
            lh.addressLine ? `<span>${esc(lh.addressLine)}</span>` : '',
            pair(l.poBox, lh.poBox),
          ].join(''),
          [pair(l.tel, lh.phone), pair(l.email, lh.email)].join(''),
          licences,
        ]
  return `<header class="lh"${variant === 'compact' ? ' style="--logo:14mm"' : ''}><img src="${esc(lh.logoUrl)}" alt=""><div>
<div class="lh-name">${esc(lh.legalName)}</div>
${lines
  .filter(Boolean)
  .map((x) => `<div class="lh-line pairs">${x}</div>`)
  .join('')}
</div></header>`
}

/** The 80 mm receipt's centred letterhead: logo, name, address, Tel., TIN, then a rule. */
export function receiptLetterheadHtml(lh: Letterhead, l: DocLabels) {
  const lines = [
    lh.addressLine,
    lh.poBox ? `${l.poBox}: ${lh.poBox}` : null,
    lh.phone ? `${l.tel}: ${lh.phone}` : null,
    lh.tin ? `${l.tin}: ${lh.tin}` : null,
  ].filter(Boolean)
  return `<header class="rh"><img src="${esc(lh.logoUrl)}" alt=""><div class="rh-name">${esc(lh.legalName)}</div>${lines
    .map((x) => `<div class="rh-line">${esc(x)}</div>`)
    .join('')}</header>`
}

/** One "Label: value" line; null/empty values are left out (label and all). */
export type MetaLine = [label: string, value: string | null | undefined] | null | false | undefined

/** The title block: title (+ scope line) on the left, label/value lines on the right. */
export function titleBlockHtml(o: { title: string; scope?: string | null; meta?: MetaLine[] }) {
  const meta = (o.meta ?? [])
    .filter((m): m is [string, string] => !!m && !!m[1])
    .map(([k, v]) => `<div><span class="lbl">${esc(k)}:</span> ${esc(v)}</div>`)
    .join('')
  return `<section class="tb"><div><h1>${esc(o.title)}</h1>${o.scope ? `<div class="tb-scope">${esc(o.scope)}</div>` : ''}</div>${meta ? `<div class="tb-meta">${meta}</div>` : ''}</section>`
}

/** A field of the identity grid. Empty values are left out, unless `blank` asks for a ruled blank. */
export interface Field {
  label: string
  value?: string | null
  /** Print a ruled blank to fill by hand when the value is missing (e.g. weight of a child). */
  blank?: boolean
  /** The value is already HTML (escaped by the caller). */
  html?: boolean
}

const fieldShown = (f: Field | null | undefined): f is Field => !!f && (!!f.value || !!f.blank)

/**
 * The patient identity block: a two-column grid of label/value pairs between two rules.
 * Left and right columns are given in order; empty fields are dropped and the grid is filled
 * row by row, so only the last right-hand cell can stay empty.
 */
export function identityHtml(left: (Field | null)[], right: (Field | null)[] = []) {
  const a = left.filter(fieldShown)
  const b = right.filter(fieldShown)
  const flat: Field[] = []
  while (a.length || b.length) {
    if (a.length && b.length) flat.push(a.shift()!, b.shift()!)
    else flat.push(...a.splice(0), ...b.splice(0))
  }
  const cell = (f: Field, i: number) =>
    `<div class="k${i % 2 ? ' c2' : ''}">${esc(f.label)}:</div><div class="v">${
      f.value ? (f.html ? f.value : esc(f.value)) : '<span class="blank"></span>'
    }</div>`
  return `<section class="idg">${flat.map(cell).join('')}</section>`
}

/**
 * The allergy statement, three states:
 * a list → boxed "ALLERGY: …"; [] (recorded as none) → "No known allergies";
 * null/undefined (never recorded or not looked up) → "Not recorded".
 */
export function allergyHtml(allergies: string[] | null | undefined, l: DocLabels) {
  if (allergies == null)
    return `<p class="allergy-line"><span class="lbl">${esc(l.allergies)}:</span> ${esc(l.notRecorded)}</p>`
  if (!allergies.length)
    return `<p class="allergy-line"><span class="lbl">${esc(l.allergies)}:</span> ${esc(l.noKnownAllergies)}</p>`
  return `<div class="allergy-box"><span class="flag-word">${esc(l.allergyFlag)}:</span>${esc(allergies.join(', '))}</div>`
}

/** Splits a free-text allergy field: '' or "none" style words → [], null → null. */
export function allergyList(text: string | null | undefined): string[] | null {
  if (text == null) return null
  const s = text.trim()
  if (!s || /^(none|nkda|nka|no known.*|aucune.*|nta .*)$/i.test(s)) return []
  return s
    .split(/[,;\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

/** A paragraph with a semibold run-in label: "History: …". Omitted when the text is empty. */
export function runInHtml(label: string, text: string | null | undefined) {
  if (!text || !text.trim()) return ''
  return `<p class="runin"><span class="lbl">${esc(label)}:</span>${escLines(text)}</p>`
}

/** A table cell: plain text or number, or ready-made HTML. Null/'' prints "–". */
export type CellValue = string | number | null | undefined | { html: string }

export interface Column {
  label: string
  /** Right-aligned, tabular figures. Numbers in a `money` column print as "12,500". */
  num?: boolean
  money?: boolean
  /** CSS width, e.g. "22mm" or "30%". */
  width?: string
}

export interface TotalRow {
  cells: CellValue[]
  /** The grand total (bold); others are sub-totals (semibold). */
  grand?: boolean
}

const decimals = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

/** "1,234.5" for a count or measurement (up to 2 decimals, never rounded to an integer). */
export const docNumber = (n: number): string => decimals.format(n)

const cellHtml = (c: CellValue, col?: Column, empty = DASH): string => {
  if (c != null && typeof c === 'object') return c.html
  if (c == null || c === '') return empty
  if (typeof c === 'number') return esc(col?.money ? docMoney(c) : docNumber(c))
  return escLines(c)
}

/**
 * A data table (A10): header rule, hairline rows, right-aligned tabular numbers, totals as the
 * last rows (1 pt rule above). `fit` sizes it to its content (management reports).
 */
export function tableHtml(
  columns: Column[],
  rows: CellValue[][],
  opts: { totals?: TotalRow[]; fit?: boolean; className?: string } = {},
) {
  const cls = ['dt', opts.fit ? 'fit' : '', opts.className ?? ''].filter(Boolean).join(' ')
  const isNum = (i: number) => !!(columns[i]?.num || columns[i]?.money)
  const head = columns
    .map(
      (c, i) =>
        `<th${isNum(i) ? ' class="num"' : ''}${c.width ? ` style="width:${esc(c.width)}"` : ''}>${esc(c.label)}</th>`,
    )
    .join('')
  // empty cells print "–" in the body, nothing in the totals rows
  const row = (r: CellValue[], trClass = '') =>
    `<tr${trClass ? ` class="${trClass}"` : ''}>${r
      .map(
        (c, i) =>
          `<td${isNum(i) ? ' class="num"' : ''}>${cellHtml(c, columns[i], trClass ? '' : DASH)}</td>`,
      )
      .join('')}</tr>`
  const totals = (opts.totals ?? [])
    .map((t) => row(t.cells, t.grand ? 'total grand' : 'total'))
    .join('')
  return `<table class="${cls}"><thead><tr>${head}</tr></thead><tbody>${rows.map((r) => row(r)).join('')}${totals}</tbody></table>`
}

/** Key figures of a management report: 3 to 6 label/value pairs in one row, a rule under it. */
export function keyFiguresHtml(items: { label: string; value: string }[]) {
  return `<section class="kf">${items
    .map(
      (x) => `<div><div class="k">${esc(x.label)}</div><div class="v">${esc(x.value)}</div></div>`,
    )
    .join('')}</section>`
}

/**
 * One signer. Lines are printed in this order; a field left `undefined` is not printed at all,
 * a field given as null or '' prints its label with a ruled blank to fill by hand.
 */
export interface Signer {
  /** Optional head of the column ("Performed by", "Prepared by"). */
  heading?: string
  name?: string | null
  qualification?: string | null
  registrationNo?: string | null
  phone?: string | null
  /** Pre-filled date (e.g. validation date and time); otherwise a 30 mm line. */
  date?: string | null
  /** Hide the signature line (rare). */
  noSignature?: boolean
}

/**
 * The signature and stamp block (A12): signers in columns, optional stamp space on the right,
 * and the "generated electronically" note. Never split across pages.
 */
export function signatureHtml(
  signers: Signer[],
  l: DocLabels,
  opts: { stamp?: boolean; note?: boolean; clinicName?: string; nameLabel?: string } = {},
) {
  const line = (label: string, v: string | null | undefined, cls = '') =>
    v === undefined
      ? ''
      : `<div><span class="k">${esc(label)}:</span>${v ? `<span>${esc(v)}</span>` : `<span class="sig-line${cls}"></span>`}</div>`
  const col = (s: Signer) =>
    `<div class="sig-col">${s.heading ? `<div class="head">${esc(s.heading)}</div>` : ''}${line(opts.nameLabel ?? l.name, s.name)}${line(l.qualification, s.qualification)}${line(l.registrationNo, s.registrationNo)}${line(l.phone, s.phone)}${s.noSignature ? '' : `<div><span class="k">${esc(l.signature)}:</span><span class="sig-line tall"></span></div>`}<div><span class="k">${esc(l.date)}:</span>${s.date ? `<span>${esc(s.date)}</span>` : '<span class="sig-line short"></span>'}</div></div>`
  const cols = signers.map(col)
  if (opts.stamp)
    cols.push(
      `<div class="sig-col"><div><span class="k">${esc(l.stamp)}:</span></div><div class="stamp-space"></div></div>`,
    )
  const system = (opts.clinicName ?? '').replace(/\s+(ltd|limited)\.?$/i, '')
  return `<section class="sig-wrap"><div class="sig" style="grid-template-columns:repeat(${cols.length},minmax(0,1fr))">${cols.join('')}</div>${
    opts.note !== false && system ? `<p class="sig-note">${esc(l.generated(system))}</p>` : ''
  }</section>`
}

// ---------------------------------------------------------------- document and printing

/** The print script: fonts and images ready (3 s cap), receipt height fitted, then print. */
function printScript(page: PageKind, autoPrint: boolean): string {
  return `(function(){
  if (/firefox/i.test(navigator.userAgent)) document.documentElement.classList.add('no-margin-boxes');
  var cap = new Promise(function(r){ setTimeout(r, 3000); });
  var loaded = new Promise(function(r){ if (document.readyState === 'complete') r(); else window.addEventListener('load', r, { once: true }); });
  var ready = loaded.then(function(){
    var f = document.fonts;
    var want = f ? Promise.all(['400','600','700'].map(function(w){ return f.load(w + ' 10pt "Source Sans 3"').catch(function(){}); })) : Promise.resolve();
    return want.then(function(){ return f ? f.ready : null; });
  }).then(function(){
    return Promise.all(Array.prototype.map.call(document.images, function(i){ return i.decode ? i.decode().catch(function(){}) : null; }));
  }).catch(function(){});
  Promise.race([ready, cap]).then(function(){
    ${
      page === 'receipt'
        ? `var s = document.querySelector('.sheet');
    if (s) { var mm = Math.ceil(s.scrollHeight * 25.4 / 96) + 8; var st = document.createElement('style');
      st.textContent = '@page { size: 80mm ' + mm + 'mm; margin: 3mm 4mm; }'; document.head.appendChild(st); }`
        : ''
    }
    ${autoPrint ? 'window.focus(); window.print();' : ''}
  });
})();`
}

/**
 * The full HTML of a document: fonts, shared CSS (`printBase`) plus the builder's own CSS,
 * the screen-only hint bar, the body, the Firefox "Printed … by …" fallback and the print script.
 */
export function documentHtml(o: {
  base: PrintBaseOptions
  /** Layout specific to this document. */
  css?: string
  body: string
  lang?: string
  /** Default true; false for previews. */
  autoPrint?: boolean
}): string {
  const b = o.base
  const l = b.labels
  const at = docDateTime(b.printedAt ?? new Date())
  const printed = b.printedBy ? l.printedBy(at, b.printedBy) : l.printedAt(at)
  const windowTitle = [b.title, b.docNo].filter(Boolean).join(' ')
  const fallback =
    b.page === 'receipt' || b.page === 'label'
      ? ''
      : `<p class="printed-fallback">${esc([b.docNo, printed].filter(Boolean).join(GAP))}</p>`
  return `<!doctype html><html lang="${esc(o.lang ?? 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(windowTitle)}</title>${fontHead(b.fonts)}<style>${printBase(b)}${o.css ?? ''}</style></head><body class="page-${b.page}"><div class="screen-hint">${esc(l.printHint)}</div><main class="sheet">${o.body}${fallback}</main><script>${printScript(b.page, o.autoPrint !== false)}</script></body></html>`
}

/** Opens a new window with the document and lets its script print it. False when blocked. */
export function openPrintWindow(html: string): boolean {
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.open()
  w.document.write(html)
  w.document.close()
  return true
}

// ---------------------------------------------------------------- Excel (Part B)

/** Excel conventions: Arial 10 black, typed number formats. */
export const EXCEL = {
  font: { name: 'Arial', size: 10, color: { argb: 'FF000000' } },
  clinicFont: { name: 'Arial', size: 12, bold: true, color: { argb: 'FF000000' } },
  titleFont: { name: 'Arial', size: 11, bold: true, color: { argb: 'FF000000' } },
  headerFont: { name: 'Arial', size: 10, bold: true, color: { argb: 'FF000000' } },
  fmt: {
    money: '#,##0',
    count: '#,##0',
    percent: '0%',
    date: 'dd/mm/yyyy',
    datetime: 'dd/mm/yyyy hh:mm',
  },
  widths: { number: 14, datetime: 17, textMin: 10, textMax: 50 },
  margins: { left: 0.6, right: 0.6, top: 0.6, bottom: 0.7, header: 0.3, footer: 0.3 },
  /** Table header row (rows 1–4: clinic, title, period, printed; row 5 empty). */
  headerRow: 6,
} as const

/**
 * A date for an Excel cell: its UTC fields equal the Kigali wall-clock time, because Excel has
 * no time zone (exceljs writes the UTC fields), which made every time 2 hours early.
 */
export function excelDate(v: Date | string | number | null | undefined): Date | null {
  const d = toDate(v)
  if (!d) return null
  // a plain yyyy-mm-dd is a calendar day: midnight UTC is that day in Excel
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00Z`)
  const p = kigaliParts(d)
  return new Date(Date.UTC(p.y, p.m - 1, p.d, p.H, p.M))
}

/** The sheet footer: "{legal name}  {report no.}" | "Printed … by …" | "Page x of y" (8 pt). */
export function excelFooter(o: {
  clinicName: string
  reportNo?: string | null
  printedBy?: string | null
  printedAt?: Date
  labels: DocLabels
}): string {
  const amp = (s: string) => s.replace(/&/g, '&&')
  const at = docDateTime(o.printedAt ?? new Date())
  const printed = o.printedBy ? o.labels.printedBy(at, o.printedBy) : o.labels.printedAt(at)
  const page = o.labels.pageOf.replace('{{pages}}', '&N').replace('{{page}}', '&P')
  const left = [o.clinicName, o.reportNo].filter(Boolean).join('  ')
  return `&L&8${amp(left)}&C&8${amp(printed)}&R&8${page}`
}

/** A text column width: longest value + 2, between 10 and 50 characters. */
export function excelTextWidth(values: unknown[]): number {
  const longest = values.reduce<number>((m, v) => Math.max(m, String(v ?? '').length), 0)
  return Math.min(EXCEL.widths.textMax, Math.max(EXCEL.widths.textMin, longest + 2))
}

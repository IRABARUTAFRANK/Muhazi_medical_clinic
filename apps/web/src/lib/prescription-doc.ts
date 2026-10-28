import i18next from 'i18next'
import {
  allergyHtml,
  allergyList,
  bottomLeftCss,
  docDate,
  docNumber,
  docStamp,
  documentHtml,
  dobWithAge,
  esc,
  footerLines,
  identityHtml,
  kigaliParts,
  letterheadHtml,
  makeDocLabels,
  openPrintWindow,
  runInHtml,
  titleBlockHtml,
  toDate,
  type DocLabels,
  type Field,
  type FontUrls,
  type Letterhead,
  type TFn,
} from './doc-style'

/**
 * The prescription a patient takes to any pharmacy (document design standard v2, C4): an A5
 * portrait page with the letterhead, the title block (prescription no., date and "valid until"), the patient
 * grid and allergy statement, the diagnosis, every medicine as a numbered two-line item (generic
 * name, strength and form with the quantity in figures and words; then the directions in plain
 * words), a closing line (total items, refill), and the prescriber's signature and stamp block.
 * Medicines already given at the clinic are not printed (they stay on the medical report), so
 * they are never dispensed a second time.
 *
 * `buildPrescriptionHtml` is pure (testable, renderable from a script); `openPrescription`
 * writes it into a new window, which waits for the fonts and the logo and then prints.
 */

export interface RxDocMedicine {
  /** Generic name, strength and form ("Artemether/Lumefantrine 20 mg/120 mg tablet"). */
  name: string
  quantity: number
  /** "4 tablets", "500 mg", "0.5 ml". */
  dose: string | null
  /** A route code (oral, IV, IM…) or its translation from `clinical.routes`. */
  route: string | null
  /** A frequency code (OD, BD, TDS…) or its translation from `clinical.frequencies`. */
  frequency: string | null
  days: number | null
  instructions: string | null
}

/** The clinic as older callers pass it: pre-joined strings (converted to a letterhead). */
export interface RxDocLegacyClinic {
  name: string
  address: string
  contacts: string
  licences?: string
  logoUrl: string
}

export type RxSex = 'female' | 'male' | 'other' | 'unknown'

export interface RxDoc {
  /** "RX-…" is printed as is; any other number is replaced by RX-{file no.}-{yyyymmddHHmm}. */
  number: string
  date: Date
  /** The structured letterhead (`useLetterhead()`), or the older pre-joined strings. */
  clinic: Letterhead | RxDocLegacyClinic
  patient: {
    name: string
    fileNumber: string
    /** "31 F", "4m M": used only when birthDate / sex are not given. */
    ageSex?: string | null
    birthDate?: string | Date | null
    sex?: RxSex | null
    /** "62 kg" or 62. */
    weight?: string | number | null
    /** Free text (", " separated; "none" = recorded as none) or a list; null = not recorded. */
    allergies?: string | string[] | null
    phone?: string | null
    insurer?: string | null
    memberNo?: string | null
  }
  /** Text plus ICD-10, or the older pre-joined string. */
  diagnosis?: string | { text: string; icd10?: string | null; provisional?: boolean } | null
  /** To collect at a pharmacy. */
  medicines: RxDocMedicine[]
  /** Already given at the clinic: not printed on the patient's prescription. */
  givenHere?: RxDocMedicine[]
  /** 0100: the prescription for an outside pharmacy: only the medicines the patient buys
   *  outside, under its own title and a line saying the clinic does not give them. */
  outside?: boolean
  prescriber: {
    name: string
    /** Qualification ("Medical doctor", "Clinical officer"). */
    title: string
    /** RMDC / council registration no.; empty prints a ruled blank. */
    registrationNo?: string | null
    phone?: string | null
  }
  /** Number of refills allowed; none = "Refill: No". */
  refills?: number | null
  /** Full name of the user who prints ("Printed … by …"). */
  printedBy?: string | null
}

/**
 * The wording. The document reads its own keys (`rxDoc.*`, `doc.*`) through `t`, which defaults
 * to the app's i18next instance; the older label fields are still accepted and not needed.
 */
export interface RxDocLabels {
  /** Translation function (default: i18next). */
  t?: TFn
  /** The shared document wording (default: built from `t`). */
  doc?: DocLabels
  /** Interface language: quantities are written in words in English and French. */
  lang?: string
  title?: string
  number?: string
  date?: string
  patient?: string
  file?: string
  ageSex?: string
  weight?: string
  allergies?: string
  none?: string
  diagnosis?: string
  medicines?: string
  quantity?: string
  forDays?: (n: number) => string
  givenHere?: string
  prescriber?: string
  signature?: string
  stamp?: string
  validity?: string
  asWritten?: string
}

/** A prescription is valid this many days from its date (the `rxDoc.validity` sentence). */
export const RX_VALID_DAYS = 7

const ROUTES = ['oral', 'IV', 'IM', 'SC', 'topical', 'rectal', 'inhaled', 'other'] as const
const FREQUENCIES = ['OD', 'BD', 'TDS', 'QID', 'Q8H', 'Q6H', 'NOCTE', 'PRN', 'STAT'] as const

/** Lower-cases the first letter of a phrase, but not of an acronym ("IV"). */
const lowerFirst = (s: string) =>
  s.length > 1 &&
  s.charAt(1) === s.charAt(1).toUpperCase() &&
  s.charAt(1) !== s.charAt(1).toLowerCase()
    ? s
    : s.charAt(0).toLowerCase() + s.slice(1)
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const endSentence = (s: string) => (/[.!?:;]$/.test(s) ? s : `${s}.`)

// ---------------------------------------------------------------- quantity in words

const EN_ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
]
const EN_TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
]

function enWords(n: number): string {
  if (n < 20) return EN_ONES[n] ?? ''
  if (n < 100) return EN_TENS[Math.floor(n / 10)] + (n % 10 ? `-${EN_ONES[n % 10]}` : '')
  if (n < 1000) {
    const rest = n % 100
    return `${EN_ONES[Math.floor(n / 100)]} hundred${rest ? ` and ${enWords(rest)}` : ''}`
  }
  const rest = n % 1000
  return `${enWords(Math.floor(n / 1000))} thousand${
    rest ? (rest < 100 ? ` and ${enWords(rest)}` : ` ${enWords(rest)}`) : ''
  }`
}

const FR_ONES = [
  'zéro',
  'un',
  'deux',
  'trois',
  'quatre',
  'cinq',
  'six',
  'sept',
  'huit',
  'neuf',
  'dix',
  'onze',
  'douze',
  'treize',
  'quatorze',
  'quinze',
  'seize',
  'dix-sept',
  'dix-huit',
  'dix-neuf',
]
const FR_TENS = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante']

function frWords(n: number): string {
  if (n < 20) return FR_ONES[n] ?? ''
  if (n < 70) {
    const u = n % 10
    const t = FR_TENS[Math.floor(n / 10)] ?? ''
    return u === 0 ? t : u === 1 ? `${t} et un` : `${t}-${FR_ONES[u]}`
  }
  if (n < 80) return n === 71 ? 'soixante et onze' : `soixante-${FR_ONES[n - 60]}`
  if (n < 100) return n === 80 ? 'quatre-vingts' : `quatre-vingt-${FR_ONES[n - 80]}`
  if (n < 1000) {
    const h = Math.floor(n / 100)
    const rest = n % 100
    const head = h === 1 ? 'cent' : `${FR_ONES[h]} cent${rest ? '' : 's'}`
    return rest ? `${head} ${frWords(rest)}` : head
  }
  const th = Math.floor(n / 1000)
  const rest = n % 1000
  // "quatre-vingts" and "deux cents" lose their s before "mille"
  const head = th === 1 ? 'mille' : `${frWords(th).replace(/s$/, '')} mille`
  return rest ? `${head} ${frWords(rest)}` : head
}

/** "twenty-four" / "vingt-quatre"; null for Kinyarwanda (figures only), decimals or huge values. */
export function quantityInWords(n: number, lang: string): string | null {
  if (!Number.isInteger(n) || n < 0 || n >= 1_000_000) return null
  if (lang.startsWith('en')) return enWords(n)
  if (lang.startsWith('fr')) return frWords(n)
  return null
}

// ---------------------------------------------------------------- wording rules

/**
 * Safe writing of doses and directions: units in full ("units", "micrograms", "daily" instead
 * of U, mcg / µg, QD), a leading zero (".5" → "0.5") and no trailing zero ("1.0" → "1").
 */
export function normaliseText(
  s: string,
  words: { units: string; micrograms: string; daily: string },
) {
  return (
    s
      .replace(/(\d)\s*(?:mcg|µg|μg)(?![A-Za-z])/gi, `$1 ${words.micrograms}`)
      .replace(/(^|[^A-Za-z])(?:mcg|µg|μg)(?![A-Za-z])/gi, `$1${words.micrograms}`)
      // insulin and heparin units: "10 IU", "18 UI" (French), "5U", "100 UI/ml" (ISMP do-not-use)
      .replace(/(\d)\s*(?:IU|UI|U)(?![A-Za-zÀ-ÿ])/g, `$1 ${words.units}`)
      .replace(/\b(?:QD|qd|q\.d\.)(?![A-Za-z])/g, words.daily)
  )
}

/** A number and the word after it stay on one line ("38 °C", "3 days"). */
const keepUnits = (s: string) => s.replace(/(\d) (?=\S)/g, '$1 ')

/** Leading and trailing zeros of decimal numbers (dose only: dates in free text are left alone). */
const tidyDecimals = (s: string) =>
  s.replace(/(?<![\d.,])\d*\.\d+(?![\d.])/g, (x) => String(Number(x)))

/** A translation that came back as its own key (or empty) counts as missing. */
const found = (s: string, key: string) => (s && s !== key && !s.endsWith(key) ? s : '')

/** Free text inside the sentence: no trailing "(BD)"-style code, lower case. */
const inSentence = (s: string) => lowerFirst(s.replace(/\s*\([^()]*\)\s*$/, '').trim())

/**
 * The plain-words form of a route or frequency, from its code or its translated label. A known
 * code is never dropped: without its plain-words translation it falls back to the app's own
 * label ("Twice a day (BD)" → "twice a day"), then to the code itself.
 */
function plainWords(
  value: string | null,
  codes: readonly string[],
  labelKey: 'clinical.routes' | 'clinical.frequencies',
  plainKey: 'rxDoc.routes' | 'rxDoc.freq',
  t: TFn,
): { code: string | null; text: string } | null {
  const v = value?.trim()
  if (!v) return null
  const label = (c: string) =>
    found(t(`${labelKey}.${c}`, { defaultValue: '' }), `${labelKey}.${c}`)
  const code =
    codes.find((c) => c.toLowerCase() === v.toLowerCase()) ??
    codes.find((c) => label(c) === v) ??
    null
  if (code) {
    const plain = found(t(`${plainKey}.${code}`, { defaultValue: '' }), `${plainKey}.${code}`)
    return { code, text: plain || inSentence(label(code)) || code }
  }
  const text = inSentence(v)
  return text ? { code: null, text } : null
}

/** Dose units worded per language with the dispensing label's keys, so both say the same. */
const DOSE_UNITS: Record<string, string> = {
  tab: 'tablet',
  tabs: 'tablet',
  tablet: 'tablet',
  tablets: 'tablet',
  cp: 'tablet',
  comp: 'tablet',
  comprimé: 'tablet',
  comprimés: 'tablet',
  ikinini: 'tablet',
  ibinini: 'tablet',
  cap: 'capsule',
  caps: 'capsule',
  capsule: 'capsule',
  capsules: 'capsule',
  gélule: 'capsule',
  gélules: 'capsule',
  kapusile: 'capsule',
  drop: 'drop',
  drops: 'drop',
  gtt: 'drop',
  goutte: 'drop',
  gouttes: 'drop',
  sachet: 'sachet',
  sachets: 'sachet',
}

/** "2 tablets" → "ibinini 2" / "2 comprimés"; any other dose is kept as written. */
function doseWords(dose: string, t: TFn): string {
  const m = /^(\d+(?:\.\d+)?)\s+(\S+?)\.?$/.exec(dose)
  const key = m ? DOSE_UNITS[(m[2] ?? '').toLowerCase()] : undefined
  if (!m || !key) return dose
  const count = Number(m[1])
  const k = `dispenseLabel.units.${key}`
  return found(t(k, { count, defaultValue: '' }), k) || dose
}

/** Fills a sentence template whose parts may be empty, then tidies the spaces and commas. */
function fillSentence(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{\{(\w+)\}\}/g, (_, n: string) => vars[n] ?? '')
    .replace(/\s+,/g, ',')
    .replace(/,(\s*,)+/g, ',')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .replace(/\s{2,}/g, ' ')
}

// ---------------------------------------------------------------- letterhead, patient

const isLetterhead = (c: RxDoc['clinic']): c is Letterhead => 'legalName' in c

/** The older pre-joined strings ("a · b · c", "Tel.: x   Email: y") as a structured letterhead. */
function letterheadFromLegacy(c: RxDocLegacyClinic, dl: DocLabels, t: TFn): Letterhead {
  const parts = (s?: string) =>
    (s ?? '')
      .split(/\s*·\s*|\s{2,}/)
      .map((x) => x.trim())
      .filter(Boolean)
  const value = (x: string, labels: string[]) => {
    for (const label of labels) {
      if (label && x.toLowerCase().startsWith(label.toLowerCase()))
        return x
          .slice(label.length)
          .replace(/^\s*:?\s*/, '')
          .trim()
    }
    return null
  }
  const contacts = parts(c.contacts).map((x) => x.replace(/^[^:@\d+]{1,20}:\s*/, ''))
  const licences = parts(c.licences)
  const find = (labels: string[]) => {
    for (const x of licences) {
      const v = value(x, labels)
      if (v) return v
    }
    return null
  }
  return {
    legalName: c.name,
    addressLine: parts(c.address).join(', ') || null,
    phone: contacts.find((x) => !x.includes('@') && /\d{3}/.test(x)) ?? null,
    email: contacts.find((x) => x.includes('@')) ?? null,
    tin: find([dl.tin, 'TIN']),
    mohLicence: find([dl.mohLicence, t('rxDoc.moh', { defaultValue: '' }), 'MoH licence']),
    fdaLicence: find([dl.fdaLicence, 'FDA licence']),
    poBox: null,
    logoUrl: c.logoUrl,
    openingHours: null,
  }
}

/** The age in "31 F" (years) or "4m F" (months, babies): a lowercase m right after the number. */
const AGE_RE = /^\s*(\d+)(m)?(?![\d.])/

/** Age in whole years at `at`, from the birth date or the "31 F" / "4m F" text; null if unknown. */
function ageYears(p: RxDoc['patient'], at: Date): number | null {
  const b = toDate(p.birthDate ?? null)
  if (b) {
    const bp = kigaliParts(b)
    const ap = kigaliParts(at)
    return ap.y - bp.y - (ap.m < bp.m || (ap.m === bp.m && ap.d < bp.d) ? 1 : 0)
  }
  const m = AGE_RE.exec(p.ageSex ?? '')
  if (!m) return null
  return m[2] ? 0 : Number(m[1])
}

function sexOf(p: RxDoc['patient']): RxSex | null {
  if (p.sex) return p.sex
  const m = /(?:^|\s)([FM])\s*$/.exec(p.ageSex ?? '')
  return m ? (m[1] === 'F' ? 'female' : 'male') : null
}

/** The patient grid: Name, date of birth (or age), sex, weight | file no., phone, insurer, member no. */
function patientFields(d: RxDoc, dl: DocLabels, t: TFn): [Field[], Field[]] {
  const p = d.patient
  let dob: Field | null = null
  const dobText = dobWithAge(p.birthDate ?? null, dl, d.date)
  if (dobText) dob = { label: dl.dateOfBirth, value: dobText }
  else {
    const m = AGE_RE.exec(p.ageSex ?? '')
    if (m)
      dob = {
        label: t('rxDoc.age'),
        value: m[2] ? dl.ageMonths(Number(m[1])) : dl.ageYears(Number(m[1])),
      }
  }
  const sex = sexOf(p)
  const age = ageYears(p, d.date)
  const weight =
    typeof p.weight === 'number'
      ? docNumber(p.weight)
      : (p.weight ?? '')
          .replace(/\s*kg\.?\s*$/i, '')
          .trim()
          .replace(/^(\d+)\.0+$/, '$1')
  // weight is required for children under 12 and adults over 65 (a ruled blank to fill)
  const needsWeight = age == null || age < 12 || age > 65
  const left: Field[] = [
    { label: dl.name, value: p.name },
    dob ?? { label: dl.dateOfBirth, value: null },
    {
      label: dl.sex,
      value: sex && sex !== 'unknown' ? t(`register.sexes.${sex}`, { defaultValue: sex }) : null,
    },
    { label: dl.weightKg, value: weight || null, blank: needsWeight },
  ]
  const right: Field[] = [
    { label: dl.fileNo, value: p.fileNumber },
    { label: dl.phone, value: p.phone ?? null },
    { label: dl.insurer, value: p.insurer ?? null },
    { label: dl.memberNo, value: p.memberNo ?? null },
  ]
  return [left, right]
}

function diagnosisText(dx: RxDoc['diagnosis'], t: TFn): string | null {
  if (!dx) return null
  if (typeof dx === 'string')
    return (
      dx
        .split(/\s*·\s*/)
        .filter(Boolean)
        .map((s, i) => (i ? lowerFirst(s) : s))
        .join(', ') || null
    )
  const text = dx.text.trim()
  if (!text) return null
  const icd = dx.icd10?.trim() ? ` (ICD-10: ${dx.icd10.trim()})` : ''
  const prov = dx.provisional ? `, ${lowerFirst(t('clinical.provisional'))}` : ''
  return `${text}${icd}${prov}`
}

// ---------------------------------------------------------------- the document

/** English fallbacks of the document's own keys (the dictionaries hold the real wording). */
const RX_EN: Record<string, string> = {
  title: 'Prescription',
  outsideTitle: 'Prescription for an outside pharmacy',
  outsideMedicines: 'To buy at an outside pharmacy',
  outsideNote:
    'The clinic pharmacy does not give these medicines. Please buy them at any pharmacy.',
  number: 'Prescription no.',
  diagnosis: 'Diagnosis',
  medicines: 'Medicines',
  quantity: 'Qty',
  prescriber: 'Prescribed by',
  validity: 'Valid for 7 days from date of issue',
  age: 'Age',
  forDays: 'for {{count}} days',
  totalItems: 'Total items',
  refill: 'Refill',
  refillNo: 'No',
  refillYes: 'Yes, ×{{count}}',
  validUntil: 'Valid until',
  directions: '{{verb}} {{dose}} {{route}} {{freq}} {{days}}',
  'verbs.default': 'Take',
  'words.units': 'units',
  'words.micrograms': 'micrograms',
  'words.daily': 'daily',
}

/**
 * The closing line and the prescriber's signature and stamp block (C4 items 6 and 8; A12,
 * compact for A5, about 30 mm): under a 0.75 pt rule, "Total items: N   Refill: No", then
 * "Prescribed by: Dr. X, qualification", "Registration no.: …   Phone: …" (a ruled blank when
 * the registration no. is missing), the 50 mm signature line and the 30 mm date line; the
 * 35 x 25 mm stamp space sits to the right of the whole block; then the system note.
 */
function closingHtml(o: {
  prescriber: RxDoc['prescriber']
  clinicName: string
  dl: DocLabels
  prescribedBy: string
  /** "Valid for 7 days from date of issue", printed under the totals. */
  validity?: string
  totals: [label: string, value: string][]
}): string {
  const { prescriber: p, dl } = o
  // the qualification moves to the next line as a whole, never split mid-phrase
  const qual = p.title?.trim()
  const who = `${esc(p.name.trim())}${qual ? `, <span class="rx-qual">${esc(qual)}</span>` : ''}`
  const reg = p.registrationNo?.trim()
  const phone = p.phone?.trim()
  const system = o.clinicName.replace(/\s+(ltd|limited)\.?$/i, '')
  const pair = (k: string, html: string) =>
    `<span><span class="lbl">${esc(k)}:</span> ${html}</span>`
  return `<section class="rx-close"><div class="rx-sig-main">
<div class="pairs rx-totals">${o.totals.map(([k, v]) => pair(k, esc(v))).join('')}</div>${
    o.validity ? `<div class="rx-valid">${esc(o.validity)}</div>` : ''
  }
<div>${pair(o.prescribedBy, who)}</div>
<div class="pairs">${pair(dl.registrationNo, reg ? esc(reg) : '<span class="rx-line reg"></span>')}${
    phone ? pair(dl.phone, esc(phone)) : ''
  }</div>
<div class="rx-sig-row"><span class="lbl">${esc(dl.signature)}:</span><span class="rx-line"></span></div>
<div class="rx-sig-row"><span class="lbl">${esc(dl.date)}:</span><span class="rx-line date"></span></div>
</div><div class="rx-stamp"><span class="lbl">${esc(dl.stamp)}:</span><div class="rx-stamp-box"></div></div></section>${
    system ? `<p class="sig-note">${esc(dl.generated(system))}</p>` : ''
  }`
}

const stringVars = (vars: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(vars)
      .filter(([k]) => k !== 'defaultValue')
      .map(([k, v]) => [k, v == null ? '' : String(v)]),
  )

const CSS = `
/* the medicines: "Rx" mark in the heading, numbered items with the quantity boxed on the right */
h2.rx-h { display: flex; align-items: baseline; gap: 4pt; }
.rx-mark { font-weight: 700; font-style: oblique; color: var(--accent-2); font-size: calc(var(--fs-h) + 2pt); line-height: 1; }
ol.rx { list-style: none; margin: 0; padding: 0; }
ol.rx > li { padding: 4pt 0 4.5pt; border-top: 0.5pt solid var(--hair); break-inside: avoid; page-break-inside: avoid; }
ol.rx > li.rx-first { border-top: 0; }
.rx-l1 { display: flex; align-items: baseline; gap: 2mm; line-height: 1.25; }
.rx-n { flex: none; display: inline-block; width: 4.6mm; height: 4.6mm; line-height: 4.4mm; text-align: center; border-radius: 50%;
  border: 0.75pt solid var(--accent); background: var(--tint); color: var(--accent-ink); font-size: var(--fs-small); font-weight: 700;
  font-variant-numeric: tabular-nums lining-nums; }
.rx-name { flex: 1; min-width: 0; font-weight: 700; color: var(--ink); }
.rx-qty { flex: none; white-space: nowrap; font-variant-numeric: tabular-nums lining-nums; font-size: var(--fs-table);
  border: 0.5pt solid var(--hair); background: var(--panel); border-radius: 2pt; padding: 0.5pt 5pt; }
.rx-qty .lbl { color: var(--ink-2); }
.rx-words { color: var(--ink-2); }
.rx-l2 { padding-left: 6.6mm; margin-top: 1.5pt; }
.rx-dx { margin: 0 0 2pt; }
.rx-out { margin: 0 0 4pt; font-weight: 600; border: 0.75pt solid var(--warn); border-left-width: 3pt; background: var(--warn-bg);
  border-radius: 2pt; padding: 3pt 6pt; break-inside: avoid; }
/* the last medicine, the closing line and the prescriber block never part: a page break always
   carries at least one medicine onto the signed page, and the block never stands alone */
.rx-end { break-inside: avoid; page-break-inside: avoid; }
/* closing line (0.75 pt navy rule) and the compact prescriber block, stamp space 35 x 25 mm right */
.rx-close { display: flex; gap: 6mm; border-top: 0.75pt solid var(--accent); padding-top: 3pt; margin-top: 1pt; line-height: 1.2; }
.rx-sig-main { flex: 1; min-width: 0; }
.rx-sig-main > div { margin: 0 0 1.5pt; }
.rx-sig-main > .rx-totals { margin-bottom: 1pt; }
.rx-valid { font-size: var(--fs-small); font-weight: 600; color: var(--accent-ink); margin-bottom: 3pt !important; }
.rx-qual { display: inline-block; }
.rx-sig-row { display: flex; align-items: flex-end; gap: 2mm; }
.rx-sig-row .lbl { flex: none; min-width: 16mm; }
.rx-line { display: inline-block; flex: none; width: 50mm; height: 5mm; border-bottom: 0.75pt solid var(--rule); }
.rx-line.date { width: 30mm; height: 4.5mm; }
.rx-line.reg { width: 30mm; height: 1.1em; vertical-align: bottom; }
.rx-stamp { flex: none; width: var(--stamp-w); }
.rx-stamp-box { height: calc(var(--stamp-h) - 4mm); margin-top: 1pt; border: 0.75pt dashed var(--line); border-radius: 3pt; }
.rx-close + .sig-note { margin-top: 2pt; }
`

/** The prescription's full HTML (A5 portrait), ready to print. */
export function buildPrescriptionHtml(
  d: RxDoc,
  l: RxDocLabels = {},
  opts: { autoPrint?: boolean; printedAt?: Date; fonts?: FontUrls } = {},
): string {
  const t: TFn = l.t ?? ((key, vars) => i18next.t(key, vars ?? {}) as string)
  const lang = l.lang ?? i18next.resolvedLanguage ?? i18next.language ?? 'en'
  const dl = l.doc ?? makeDocLabels(t)
  // English wording when a key is missing, so a printed prescription never shows "rxDoc.…"
  const r = (key: string, vars: Record<string, unknown> = {}) => {
    const k = `rxDoc.${key}`
    const v = t(k, { defaultValue: RX_EN[key] ?? '', ...vars })
    return found(v, k) || fillSentence(RX_EN[key] ?? '', stringVars(vars))
  }
  const lh = isLetterhead(d.clinic) ? d.clinic : letterheadFromLegacy(d.clinic, dl, t)
  const printedAt = opts.printedAt ?? new Date()
  const rxNo = /^RX-/i.test(d.number) ? d.number : `RX-${d.patient.fileNumber}-${docStamp(d.date)}`
  const title = d.outside ? r('outsideTitle') : r('title')
  const words = {
    units: r('words.units'),
    micrograms: r('words.micrograms'),
    daily: r('words.daily'),
  }

  const items = d.medicines.map((m, i) => {
    const dose = m.dose?.trim()
      ? doseWords(normaliseText(tidyDecimals(m.dose.trim()), words), t)
      : ''
    const route =
      m.route === 'other' ? null : plainWords(m.route, ROUTES, 'clinical.routes', 'rxDoc.routes', t)
    const freq = plainWords(m.frequency, FREQUENCIES, 'clinical.frequencies', 'rxDoc.freq', t)
    const days = m.days ? r('forDays', { count: m.days }) : ''
    // one sentence in the language's own order ("Fata ibinini 2 mu kanwa, inshuro 2 ku munsi, …")
    const how =
      dose || route || freq || days
        ? fillSentence(
            r('directions', {
              verb: r(`verbs.${route?.code ?? 'default'}`, {
                defaultValue: r('verbs.default', { defaultValue: '' }),
              }),
              dose,
              route: route?.text ?? '',
              freq: freq?.text ?? '',
              days,
              defaultValue: '{{verb}} {{dose}} {{route}} {{freq}} {{days}}',
            }),
            {},
          )
        : ''
    const ins = m.instructions?.trim() ? normaliseText(m.instructions.trim(), words) : ''
    const line2 = [how ? endSentence(upperFirst(how)) : '', ins ? endSentence(upperFirst(ins)) : '']
      .filter(Boolean)
      .join(' ')
    const qty = Number(m.quantity)
    const inWords = quantityInWords(qty, lang)
    return `<li${i === 0 ? ' class="rx-first"' : ''}><div class="rx-l1"><span class="rx-n">${i + 1}</span><span class="rx-name">${esc(keepUnits(normaliseText(m.name.trim(), words)))}</span><span class="rx-qty"><span class="lbl">${esc(r('quantity'))}:</span> <strong>${esc(docNumber(qty))}</strong>${inWords ? ` <span class="rx-words">(${esc(inWords)})</span>` : ''}</span></div>${
      line2 ? `<div class="rx-l2">${esc(keepUnits(line2))}</div>` : ''
    }</li>`
  })

  const allergies = Array.isArray(d.patient.allergies)
    ? d.patient.allergies
    : allergyList(d.patient.allergies ?? null)
  const [left, right] = patientFields(d, dl, t)
  const dx = diagnosisText(d.diagnosis, t)
  const refill = d.refills ? r('refillYes', { count: d.refills }) : r('refillNo')

  const body = [
    letterheadHtml(lh, dl),
    titleBlockHtml({
      title,
      meta: [
        [r('number'), rxNo],
        [dl.date, docDate(d.date)],
        [r('validUntil'), docDate(new Date(d.date.getTime() + RX_VALID_DAYS * 86_400_000))],
      ],
    }),
    identityHtml(left, right),
    allergyHtml(allergies, dl),
    dx ? runInHtml(r('diagnosis'), dx).replace('<p class="runin">', '<p class="runin rx-dx">') : '',
    `<h2 class="rx-h"><span class="rx-mark" aria-hidden="true">Rx</span>${esc(r(d.outside ? 'outsideMedicines' : 'medicines'))}</h2>`,
    d.outside ? `<p class="rx-out">${esc(r('outsideNote'))}</p>` : '',
    items.length > 1 ? `<ol class="rx">${items.slice(0, -1).join('')}</ol>` : '',
    `<div class="rx-end">`,
    items.length ? `<ol class="rx">${items[items.length - 1]}</ol>` : '',
    closingHtml({
      prescriber: d.prescriber,
      clinicName: lh.legalName,
      dl,
      prescribedBy: r('prescriber'),
      validity: r('validity'),
      totals: [
        [r('totalItems'), String(d.medicines.length)],
        [r('refill'), refill],
      ],
    }),
    `</div>`,
  ].join('')

  // footer: "clinic · prescription no." over "Printed … by …"; the validity is printed in the
  // body (meta box and closing line), and the A5 line has no room for the confidentiality note
  const footer = `@page { ${bottomLeftCss(
    'a5',
    footerLines({
      clinicName: lh.legalName,
      docNo: rxNo,
      printedBy: d.printedBy ?? null,
      printedAt,
      labels: dl,
    }),
  )} }`

  return documentHtml({
    base: {
      page: 'a5',
      title,
      docNo: rxNo,
      clinicName: lh.legalName,
      printedBy: d.printedBy ?? null,
      printedAt,
      medical: true,
      identity: {
        name: d.patient.name,
        fileNo: d.patient.fileNumber,
        dob: docDate(d.patient.birthDate ?? null) || null,
      },
      labels: dl,
      fonts: opts.fonts,
    },
    css: CSS + footer,
    body,
    lang,
    autoPrint: opts.autoPrint,
  })
}

/** Opens the prescription in a new window and prints it. False when the window is blocked. */
export function openPrescription(d: RxDoc, l: RxDocLabels = {}): boolean {
  return openPrintWindow(buildPrescriptionHtml(d, l))
}

import i18next from 'i18next'
import {
  docDate,
  docMonthYear,
  documentHtml,
  esc,
  makeDocLabels,
  openPrintWindow,
  type DocLabels,
  type TFn,
} from './doc-style'

/**
 * The dispensing labels (document standard v2, C6): one 70 x 40 mm sticker per medicine, all in
 * pure black for thermal label printers. Fixed line budget inside 2 mm of padding:
 *   1. clinic name and Tel. (7.5 pt semibold)
 *   2. patient name (10 pt bold, the full width, at most 2 lines)
 *   3. generic name, strength and form (10 pt bold, at most 2 lines), "Qty: …" on the right
 *   4. directions in Kinyarwanda (9.5 pt semibold, at most 2 lines)
 *   5. the same directions in English or French (dropped first when space runs out, and
 *      never printed cut short)
 *   6. "Bika kure y'abana / Keep out of reach of children.", followed on the same line by the
 *      caution and instructions (cut first, never the keep-out words)
 *   7. "File: …   Ref.: …   Exp.: …   Batch: …   By: …" (always printed, pinned to the bottom)
 * Each sticker hides its overflow, so a label never spills onto a second sticker, and a line
 * that does not fit whole is hidden rather than printed half cut.
 */
export interface DispenseLabel {
  /** Generic name and strength ("Artemether-lumefantrine 20/120 mg"). */
  item: string
  /** A short name for the label ("Prenatal multivitamin and minerals"), when the catalogue has one. */
  labelName?: string | null
  quantity: number
  /** Selling unit ("tab", "cap", "sachet"); gives the form when `form` is not known. */
  unit: string | null
  /** As prescribed: "4 tab", "1/2 tablet", "5 ml", "10 U". */
  dose: string | null
  /** A frequency code (OD, BD, TDS, QID, Q8H, Q6H, NOCTE, PRN, STAT) or free text. */
  frequency: string | null
  days: number | null
  /** The prescriber's instructions: a code (AC, PC, SHAKE, FRIDGE), its words, or free text. */
  instructions: string | null
  /** Pharmaceutical form ("tablet"), when known. */
  form?: string | null
  /** Cautionary text of the item ("Take with food"), when the catalogue holds one. */
  caution?: string | null
  /** The dispensed batch and its expiry (yyyy-mm-dd or a date). */
  batchNo?: string | null
  expiry?: string | Date | null
  /** The dispense (hand-over) reference. */
  ref?: string | null
}

export interface DispenseLabelDoc {
  /** `contacts` is the older "Tel.: …   Email: …" string; `phone` is used when given. */
  clinic: { name: string; contacts: string; phone?: string | null }
  patient: { name: string; fileNumber: string }
  date: Date
  lines: DispenseLabel[]
  /** Who hands the medicines over: printed as initials with the registration number. */
  dispensedBy?: { name: string; registrationNo?: string | null } | null
}

/** Translation functions: the interface language, Kinyarwanda and the second language (en/fr). */
export interface LabelWording {
  lang: string
  ui: TFn
  rw: TFn
  second: TFn
  doc: DocLabels
}

export interface DispenseLabelText {
  /** @deprecated the label no longer prints a footer word; kept for the callers. */
  title: string
  /** @deprecated the days are worded by the label itself in each language. */
  days: (n: number) => string
  /** The wording; built from the app's translations when left out. */
  wording?: LabelWording
}

// ---------------------------------------------------------------- wording

/** A lookup with an English default, so a label still reads well before a key is translated. */
const say = (
  t: TFn,
  key: string,
  en: string,
  vars: Record<string, unknown> = {},
  enOther?: string,
): string =>
  t(`dispenseLabel.${key}`, {
    defaultValue: en,
    ...(enOther ? { defaultValue_other: enOther } : {}),
    ...vars,
  })

/** Dose units the label words in each language; other units are printed as typed. */
const UNIT_ALIASES: Record<string, string> = {
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
  drop: 'drop',
  drops: 'drop',
  gtt: 'drop',
  goutte: 'drop',
  gouttes: 'drop',
  sachet: 'sachet',
  sachets: 'sachet',
  u: 'unit',
  iu: 'unit',
  ui: 'unit',
  unit: 'unit',
  units: 'unit',
  unité: 'unit',
  unités: 'unit',
  ml: 'ml',
  mls: 'ml',
}

const UNIT_EN: Record<string, [string, string]> = {
  tablet: ['{{count}} tablet', '{{count}} tablets'],
  capsule: ['{{count}} capsule', '{{count}} capsules'],
  drop: ['{{count}} drop', '{{count}} drops'],
  sachet: ['{{count}} sachet', '{{count}} sachets'],
  unit: ['{{count}} unit', '{{count}} units'],
  ml: ['{{count}} ml', '{{count}} ml'],
}

/** Half and quarter doses said in words ("half a tablet"), where the unit can be split. */
const PART_EN: Record<string, Partial<Record<'half' | 'quarter', string>>> = {
  tablet: { half: 'half a tablet', quarter: 'a quarter of a tablet' },
  sachet: { half: 'half a sachet' },
}

const FREQ_EN: Record<string, string> = {
  OD: 'once a day',
  BD: 'twice a day',
  TDS: 'three times a day',
  QID: 'four times a day',
  Q8H: 'every 8 hours',
  Q6H: 'every 6 hours',
  NOCTE: 'at night',
  PRN: 'when needed',
  STAT: 'once, straight away',
}

/** Other spellings of the same frequency codes. */
const FREQ_ALIASES: Record<string, string> = {
  QD: 'OD',
  DAILY: 'OD',
  BID: 'BD',
  TID: 'TDS',
  QDS: 'QID',
  HS: 'NOCTE',
  ON: 'NOCTE',
  SOS: 'PRN',
}

/** Pharmaceutical forms added to the medicine name when the name lacks them. */
const FORM_EN: Record<string, string> = {
  tablet: 'tablet',
  capsule: 'capsule',
  drop: 'drops',
  sachet: 'sachet',
}

/** Instructions the label says in Kinyarwanda and the second language. */
const NOTE_EN: Record<string, string> = {
  AC: 'Before food.',
  PC: 'After food.',
  SHAKE: 'Shake well before use.',
  FRIDGE: 'Keep in the fridge (2–8 °C).',
}

const NOTE_CODES: Record<string, string> = {
  ac: 'AC',
  'before food': 'AC',
  'before meal': 'AC',
  'before meals': 'AC',
  'before eating': 'AC',
  pc: 'PC',
  'after food': 'PC',
  'after meal': 'PC',
  'after meals': 'PC',
  'after eating': 'PC',
  shake: 'SHAKE',
  'shake well': 'SHAKE',
  'shake before use': 'SHAKE',
  'shake well before use': 'SHAKE',
  fridge: 'FRIDGE',
  'keep in fridge': 'FRIDGE',
  'keep in the fridge': 'FRIDGE',
  'keep refrigerated': 'FRIDGE',
  refrigerate: 'FRIDGE',
  'store in the fridge': 'FRIDGE',
  'store in a refrigerator': 'FRIDGE',
}

/**
 * Strengths as the standard writes them: "micrograms" and "units" in full (no mcg, µg, U or
 * IU), no trailing zero ("1 mg", not "1.00 mg"), a space between figure and unit ("100 mg")
 * and spaced plus signs ("A 1 mg + B 3 mg").
 */
export const plainUnits = (s: string): string =>
  s
    .replace(/(\d)\s*(?:mcg|µg|μg)(?![a-zA-Z])/gi, '$1 micrograms')
    .replace(/(\d)\s*(?:IU|U)\b/g, '$1 units')
    .replace(/(\d)\.0+(?!\d)/g, '$1')
    .replace(/(\.\d*?[1-9])0+(?!\d)/g, '$1')
    .replace(/(\d)\s*(mg|g|ml|l|micrograms|units)(?![a-z])/gi, '$1 $2')
    .replace(/\s*\+\s*/g, ' + ')

/** Splits "4 tab", "1/2 tablet", ".5 ml" into a number and the unit as typed. */
function parseDose(dose: string): { n: number; unit: string } | null {
  const m = /^\s*(\d+\s*\/\s*\d+|\d*[.,]\d+|\d+|½|¼)\s*(.*?)\s*$/.exec(dose)
  if (!m) return null
  const raw = (m[1] ?? '').replace(/\s/g, '')
  const [top = '', bottom = ''] = raw.split('/')
  const n =
    raw === '½'
      ? 0.5
      : raw === '¼'
        ? 0.25
        : raw.includes('/')
          ? Number(top) / Number(bottom)
          : Number(raw.replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? { n, unit: m[2] ?? '' } : null
}

const unitKey = (unit: string | null | undefined): string | undefined =>
  UNIT_ALIASES[(unit ?? '').trim().toLowerCase().replace(/\.$/, '')]

/** 0.5, 1, 2.5: leading zero, no trailing zero. */
const num = (n: number) => String(Math.round(n * 1000) / 1000)

/** A dose figure for a patient: ½, ¼, ¾ and 1½ as fractions, other decimals in the language. */
function doseFigure(n: number, lang: string): string {
  const whole = Math.floor(n)
  const rest = Math.round((n - whole) * 100) / 100
  const glyph = rest === 0.5 ? '½' : rest === 0.25 ? '¼' : rest === 0.75 ? '¾' : null
  if (rest === 0) return String(whole)
  if (glyph) return whole ? `${whole}${glyph}` : glyph
  return new Intl.NumberFormat(lang === 'fr' ? 'fr' : 'en', { maximumFractionDigits: 3 }).format(n)
}

/** "4 tablets", "half a tablet", "1½ tablets", "10 units" in the language of `t`. */
function amountText(p: { n: number; unit: string }, t: TFn, lang: string): string {
  const key = unitKey(p.unit)
  const shown = doseFigure(p.n, lang)
  const en = key ? UNIT_EN[key] : undefined
  if (!key || !en) return plainUnits(`${shown} ${p.unit}`.trim())
  const part = p.n === 0.5 ? 'half' : p.n === 0.25 ? 'quarter' : null
  const partEn = part ? PART_EN[key]?.[part] : undefined
  if (part && partEn) return say(t, `units.${key}_${part}`, partEn)
  // the plural follows the next whole number, so ½ or 0.75 never reads as plural
  const count = Math.max(1, Math.ceil(p.n))
  const text = say(t, `units.${key}`, en[0], { count }, en[1])
  return shown === String(count) ? text : text.replace(String(count), shown)
}

/** The frequency code of a typed frequency ("bd", "BID" → "BD"), or null for free text. */
function freqCode(f: string | null | undefined): string | null {
  const c = (f ?? '').trim().toUpperCase().replace(/[\s.]/g, '')
  if (!c) return null
  const code = FREQ_ALIASES[c] ?? c
  return FREQ_EN[code] ? code : null
}

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const sentence = (s: string) => {
  const x = upperFirst(s.trim())
  return /[.!?)]$/.test(x) ? x : `${x}.`
}

/**
 * "Fata ibinini 4 inshuro 2 ku munsi, iminsi 3" / "Take 4 tablets twice a day, for 3 days" in
 * the language of `t`. Only the coded parts are worded: a dose or frequency typed as free text
 * is left out here and printed once, as typed, by `typedParts`.
 */
export function directions(x: DispenseLabel, t: TFn, lang = 'en'): string {
  const parts: string[] = []
  const p = x.dose?.trim() ? parseDose(x.dose) : null
  if (p) parts.push(say(t, 'take', 'Take {{dose}}', { dose: amountText(p, t, lang) }))
  const code = freqCode(x.frequency)
  if (code) parts.push(say(t, `freq.${code}`, FREQ_EN[code] ?? code))
  let s = parts.join(' ')
  if (x.days && x.days > 0) {
    const d = say(t, 'days', 'for {{count}} day', { count: x.days }, 'for {{count}} days')
    s = s ? `${s}, ${d}` : d
  }
  return upperFirst(s)
}

/** The dose and frequency typed as free text (no code), printed once as typed. */
export function typedParts(x: DispenseLabel): string[] {
  const out: string[] = []
  const dose = x.dose?.trim()
  if (dose && !parseDose(dose)) out.push(plainUnits(dose))
  const f = x.frequency?.trim()
  if (f && !freqCode(f)) out.push(f)
  return out
}

const noteCode = (s: string): string | null =>
  NOTE_CODES[
    s
      .trim()
      .toLowerCase()
      .replace(/[.!]+$/, '')
      .replace(/\s+/g, ' ')
  ] ?? null

/** The form of the item: as given, or from its selling unit ("cap" → "capsule"). */
function formText(x: DispenseLabel, t: TFn): string {
  if (x.form?.trim()) return plainUnits(x.form.trim())
  const key = unitKey(x.unit)
  const en = key ? FORM_EN[key] : undefined
  return key && en ? say(t, `forms.${key}`, en) : ''
}

/**
 * "Artemether-lumefantrine 20/120 mg tablet": the label name when the catalogue has one, else
 * the generic name with the form added when the name lacks it. A combination too long for two
 * lines is written "{first ingredient} + {n} more, {form}", so the form is never cut off.
 */
export function medicineName(x: DispenseLabel, t: TFn): string {
  const short = x.labelName?.trim()
  const name = plainUnits(short || x.item.trim()).replace(/[.;,]+$/, '')
  const form = formText(x, t)
  if (!short && name.length > 60) {
    const parts = (name.includes('+') ? name.split(/\s+\+\s+/) : name.split(/,\s+(?=[^\d\s])/))
      .map((s) => s.trim().replace(/[.;,]+$/, ''))
      .filter(Boolean)
    const [first] = parts
    if (first && parts.length > 1) {
      const more = say(
        t,
        'more',
        '{{first}} + {{count}} more',
        { first, count: parts.length - 1 },
        '{{first}} + {{count}} more',
      )
      return form ? `${more}, ${form}` : more
    }
  }
  if (!form || name.toLowerCase().includes(form.toLowerCase())) return name
  return `${name} ${form}`
}

/** "Uwimana Josiane" → "UJ". */
const initials = (name: string) =>
  name
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase())
    .join('')

/** The phone from the older "Tel.: …   Email: …" contacts string. */
function phoneOf(clinic: DispenseLabelDoc['clinic']): string | null {
  if (clinic.phone) return clinic.phone
  const tel = clinic.contacts
    .split(/\s{2,}|\s·\s/)
    .map((s) => s.trim())
    .find((s) => s && !s.includes('@'))
  return tel ? tel.replace(/^[^:\d+]*:\s*/, '') : null
}

// ---------------------------------------------------------------- layout

const CSS = `
.label { display: flex; flex-direction: column; font-size: 7.5pt; line-height: 1.2; color: #000000; overflow-wrap: anywhere; }
.label p { margin: 0; }
.lb-main { flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column; gap: 0.3mm; }
.lb-main > * { flex: none; }
.lb-row { display: flex; justify-content: space-between; align-items: baseline; gap: 2mm; }
.lb-row > :first-child { min-width: 0; }
.lb-row > :last-child { flex: none; white-space: nowrap; }
.lb-clinic { font-weight: 700; padding-bottom: 0.4mm; border-bottom: 0.75pt solid #000000; }
.lb-clinic > :last-child { font-weight: 600; }
.lb-clinic > :first-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.lb-big { font-size: 10pt; font-weight: 700; line-height: 1.1; }
.lb-patient { padding-top: 0.2mm; }
.lb-patient .lb-big { font-size: 10.5pt; letter-spacing: 0.01em; }
.lb-patient .lb-big, .lb-med .lb-big { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.lb-aside { font-size: 7.5pt; font-weight: 700; border: 0.75pt solid #000000; border-radius: 1mm; padding: 0 1mm; }
.lb-rw { font-size: 9.5pt; font-weight: 700; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.lb-2nd { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.lb-keep > .lb-keep-words { font-weight: 700; }
.lb-keep { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.label.notes-1 .lb-keep { -webkit-line-clamp: 2; }
.label.notes-0 .lb-keep { -webkit-line-clamp: 1; }
.lb-foot { flex: none; padding-top: 0.4mm; border-top: 0.5pt dashed #000000; }
.lb-foot span { display: inline-block; white-space: nowrap; margin-right: 1.8mm; }
.lb-foot span:last-child { margin-right: 0; }
.label.drop-2nd .lb-2nd, .label.drop-alt .lb-alt { display: none; }
`

/**
 * When a label's content does not fit, it tries in order: drop line 5 (second-language
 * directions), then also the second-language halves of the keep-out and instruction lines,
 * then the keep-out line with the instructions on two lines, then on one. The patient name is never shortened. A direction cut
 * short is never printed, and a line that still does not fit whole is hidden. A line counts as
 * fitting only when its box ends within half a pixel of the sticker's text area. Runs again
 * once the fonts are in and just before printing.
 */
const FIT_SCRIPT = `(function(){
  var STEPS = [[], ['drop-2nd'], ['drop-2nd', 'drop-alt'], ['drop-2nd', 'drop-alt', 'notes-1'],
    ['drop-2nd', 'drop-alt', 'notes-0']];
  function shown(c){ return getComputedStyle(c).display !== 'none'; }
  function clipped(el){ return el.scrollHeight > el.clientHeight + 1; }
  function over(m){
    var b = m.getBoundingClientRect().bottom + 0.5;
    for (var i = 0; i < m.children.length; i++) {
      var c = m.children[i];
      if (shown(c) && c.getBoundingClientRect().bottom > b) return true;
    }
    return false;
  }
  function fit(){
    Array.prototype.forEach.call(document.querySelectorAll('.label'), function(l){
      var m = l.querySelector('.lb-main'); if (!m) return;
      var s = l.querySelector('.lb-2nd');
      Array.prototype.forEach.call(m.children, function(c){ c.style.visibility = ''; });
      for (var i = 0; i < STEPS.length; i++) {
        l.classList.remove('drop-2nd', 'drop-alt', 'notes-1', 'notes-0');
        STEPS[i].forEach(function(c){ l.classList.add(c); });
        var cut = s && STEPS[i].indexOf('drop-2nd') < 0 && clipped(s);
        if (!cut && !over(m)) return;
      }
      var b = m.getBoundingClientRect().bottom + 0.5;
      Array.prototype.forEach.call(m.children, function(c){
        if (shown(c) && c.getBoundingClientRect().bottom > b) c.style.visibility = 'hidden';
      });
    });
  }
  fit();
  window.addEventListener('load', fit);
  window.addEventListener('beforeprint', fit);
  if (document.fonts) { document.fonts.addEventListener('loadingdone', fit); document.fonts.ready.then(fit); }
})();`

/** The labels' full HTML (pure: no window, no React), used by `openDispenseLabels`. */
export function buildDispenseLabelsHtml(
  d: DispenseLabelDoc,
  w: LabelWording,
  opts: { autoPrint?: boolean } = {},
): string {
  const secondLang = w.lang === 'fr' ? 'fr' : 'en'
  const tel = phoneOf(d.clinic)
  const keep = say(w.rw, 'keepAway', 'Keep out of reach of children')
  const keep2 = say(w.second, 'keepAway', 'Keep out of reach of children')
  const alt = (main: string, second: string) =>
    `${esc(main)}${second !== main ? `<span class="lb-alt"> / ${esc(second)}</span>` : ''}`
  const name = d.dispensedBy?.name?.trim()
  const reg = d.dispensedBy?.registrationNo?.trim()
  const by = name ? [initials(name), reg].filter(Boolean).join(' ') : null

  const label = (x: DispenseLabel) => {
    const rw = directions(x, w.rw, 'rw')
    const second = directions(x, w.second, secondLang)
    const notes: string[] = []
    for (const raw of [x.caution, x.instructions]) {
      const text = raw?.trim()
      if (!text) continue
      const code = noteCode(text)
      const en = code ? NOTE_EN[code] : undefined
      notes.push(
        code && en
          ? alt(say(w.rw, `notes.${code}`, en), say(w.second, `notes.${code}`, en))
          : esc(sentence(text)),
      )
    }
    for (const typed of typedParts(x)) notes.push(esc(sentence(typed)))
    const pair = (k: string, v: string | null | undefined) =>
      v ? `<span>${esc(k)}: ${esc(v)}</span>` : ''
    const ref = x.ref?.trim() || null
    // in this order the pairs pack into two lines at 7.5 pt in every language
    const foot = [
      pair(say(w.ui, 'file', 'File'), d.patient.fileNumber),
      // the dispense reference carries the date; the date is printed only without one
      ref ? pair(say(w.ui, 'ref', 'Ref.'), ref) : pair(say(w.ui, 'date', 'Date'), docDate(d.date)),
      pair(say(w.ui, 'exp', 'Exp.'), docMonthYear(x.expiry ?? null)),
      pair(say(w.ui, 'batch', 'Batch'), x.batchNo?.trim()),
      pair(say(w.ui, 'by', 'By'), by),
    ].join('')
    return `<div class="label">
<div class="lb-main">
<div class="lb-row lb-clinic"><span>${esc(d.clinic.name)}</span>${tel ? `<span>${esc(say(w.ui, 'tel', 'Tel.'))}: ${esc(tel)}</span>` : ''}</div>
<div class="lb-patient"><span class="lb-big">${esc(d.patient.name)}</span></div>
<div class="lb-row lb-med"><span class="lb-big">${esc(medicineName(x, w.second))}</span><span class="lb-aside">${esc(say(w.ui, 'qty', 'Qty'))}: ${esc(num(x.quantity))}</span></div>
${rw ? `<p class="lb-rw">${esc(rw)}</p>` : ''}
${second && second !== rw ? `<p class="lb-2nd">${esc(second)}</p>` : ''}
<p class="lb-keep"><span class="lb-keep-words">${alt(keep, keep2)}.</span>${notes.length ? ` <span class="lb-notes">${notes.join(' ')}</span>` : ''}</p>
</div>
<div class="lb-foot">${foot}</div>
</div>`
  }

  const title = say(w.ui, 'title', 'Dispensing labels')
  return documentHtml({
    base: {
      page: 'label',
      title: `${title} ${d.patient.name}`,
      clinicName: d.clinic.name,
      labels: w.doc,
    },
    css: CSS,
    body: `${d.lines.map(label).join('\n')}<script>${FIT_SCRIPT}</script>`,
    lang: w.lang,
    autoPrint: opts.autoPrint,
  })
}

/** The wording from the app's translations (Kinyarwanda always, English or French second). */
function appWording(): LabelWording {
  const ready = i18next.isInitialized
  const fixed = (lng: string): TFn =>
    ready
      ? (key, vars) => i18next.getFixedT(lng)(key, vars ?? {}) as string
      : (key, vars = {}) =>
          String((vars.count !== 1 && vars.defaultValue_other) || vars.defaultValue || key).replace(
            /\{\{(\w+)\}\}/g,
            (_, n: string) => String(vars[n] ?? ''),
          )
  const lang = ready ? i18next.language : 'en'
  const ui = fixed(lang)
  return {
    lang,
    ui,
    rw: fixed('rw'),
    second: fixed(lang === 'fr' ? 'fr' : 'en'),
    doc: makeDocLabels(ui),
  }
}

/** Returns false when the browser blocked the new window. */
export function openDispenseLabels(d: DispenseLabelDoc, l: DispenseLabelText): boolean {
  return openPrintWindow(buildDispenseLabelsHtml(d, l.wording ?? appWording()))
}

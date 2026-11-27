/**
 * The papers a printed document can go on (0207, Frank: "whatever the case I will be able to
 * print"): sheets (A3, A4, A5, A6, B5, Letter, Legal; portrait or landscape), receipt rolls
 * (58, 76, 80 and 112 mm, as long as the content), labels (40 × 30 mm to 100 × 150 mm) and a
 * custom size typed in millimetres; margins normal, narrow or none.
 *
 * Pure (no React, no window). `paperLayout` turns a choice into the type sizes, the @page rule and
 * the page classes of a document; it is self-contained on purpose (it uses only its arguments),
 * because the print window carries a copy of it (`String(paperLayout)`) to apply a choice live.
 * Each document kind remembers its paper on this computer (`mmc.print.<kind>` in localStorage).
 */

// ---------------------------------------------------------------- the catalogue

/** Today's pages of the builders: each is one choice of the catalogue (`pageChoice`). */
export type PageKind = 'a4' | 'a4-landscape' | 'a5' | 'receipt' | 'label'

export type PaperGroup = 'sheet' | 'roll' | 'label'
export type Orientation = 'portrait' | 'landscape'
export type Margins = 'normal' | 'narrow' | 'none'
export const MARGINS: readonly Margins[] = ['normal', 'narrow', 'none']

/** Every printed document, each with its own remembered paper. */
export type DocKind =
  | 'receipt'
  | 'prescription'
  | 'medicalReport'
  | 'history'
  | 'resultReport'
  | 'report'
  | 'transferNote'
  | 'label'

export const DOC_KINDS: readonly DocKind[] = [
  'receipt',
  'prescription',
  'medicalReport',
  'history',
  'resultReport',
  'report',
  'transferNote',
  'label',
]

/** Sheets for every document; receipt rolls also for the receipt, the prescription, the result
 *  report and the labels; label stock only for the labels. */
const KIND_GROUPS: Record<DocKind, PaperGroup[]> = {
  receipt: ['sheet', 'roll'],
  prescription: ['sheet', 'roll'],
  medicalReport: ['sheet'],
  history: ['sheet'],
  resultReport: ['sheet', 'roll'],
  report: ['sheet'],
  transferNote: ['sheet'],
  label: ['sheet', 'roll', 'label'],
}

/** The sizes of a document (points for type, CSS lengths for the rest). */
export interface Scale {
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
  /** Width of the sheet in the screen preview. */
  sheetW: string
  /** Padding of the sheet in the screen preview (the print margins). */
  pad: string
  /** The body of the @page rule. */
  page: string
}

/** Type sizes by the printable width: a 58 mm roll smaller than the 80 mm receipt, A6 smaller
 *  than A5… `logoWide` is the logo of a landscape sheet. */
export type TierId =
  'a4' | 'a5' | 'a6' | 'r112' | 'r80' | 'r76' | 'r58' | 'lS' | 'lM' | 'lL' | 'lXL'
export interface Tier {
  title: number
  clinic: number
  h: number
  sub: number
  body: number
  table: number
  small: number
  logo: string
  logoWide: string
  idLabel: string
  stampW: string
  stampH: string
}

export const TIERS: Record<TierId, Tier> = {
  // A3, A4, B5, Letter, Legal (and A4 landscape with its smaller logo): today's A4
  a4: {
    title: 16,
    clinic: 15,
    h: 11,
    sub: 10,
    body: 10,
    table: 9,
    small: 8,
    logo: '20mm',
    logoWide: '14mm',
    idLabel: '28mm',
    stampW: '40mm',
    stampH: '28mm',
  },
  // A5: today's prescription
  a5: {
    title: 14,
    clinic: 13,
    h: 10,
    sub: 9.5,
    body: 9.5,
    table: 9,
    small: 7.5,
    logo: '16mm',
    logoWide: '12mm',
    idLabel: '24mm',
    stampW: '35mm',
    stampH: '25mm',
  },
  a6: {
    title: 12,
    clinic: 11,
    h: 9,
    sub: 8.5,
    body: 8.5,
    table: 8,
    small: 7,
    logo: '12mm',
    logoWide: '10mm',
    idLabel: '20mm',
    stampW: '28mm',
    stampH: '20mm',
  },
  r112: {
    title: 12,
    clinic: 12,
    h: 10,
    sub: 10,
    body: 10,
    table: 10,
    small: 9,
    logo: '16mm',
    logoWide: '16mm',
    idLabel: '26mm',
    stampW: '0',
    stampH: '0',
  },
  // the 80 mm receipt of today
  r80: {
    title: 11,
    clinic: 11,
    h: 9,
    sub: 9,
    body: 9,
    table: 9,
    small: 8,
    logo: '14mm',
    logoWide: '14mm',
    idLabel: '22mm',
    stampW: '0',
    stampH: '0',
  },
  r76: {
    title: 10.5,
    clinic: 10.5,
    h: 8.5,
    sub: 8.5,
    body: 8.5,
    table: 8.5,
    small: 7.5,
    logo: '13mm',
    logoWide: '13mm',
    idLabel: '20mm',
    stampW: '0',
    stampH: '0',
  },
  r58: {
    title: 10,
    clinic: 10,
    h: 8,
    sub: 8,
    body: 8,
    table: 8,
    small: 7,
    logo: '12mm',
    logoWide: '12mm',
    idLabel: '17mm',
    stampW: '0',
    stampH: '0',
  },
  // labels: 40 × 30, 50 × 25, 50 × 30 mm
  lS: {
    title: 8,
    clinic: 6,
    h: 8,
    sub: 7.5,
    body: 6,
    table: 6,
    small: 6,
    logo: '0',
    logoWide: '0',
    idLabel: '0',
    stampW: '0',
    stampH: '0',
  },
  // 58 × 40, 60 × 40, 70 × 40 mm: today's medicine label
  lM: {
    title: 10,
    clinic: 7.5,
    h: 10,
    sub: 9.5,
    body: 7.5,
    table: 7.5,
    small: 7.5,
    logo: '0',
    logoWide: '0',
    idLabel: '0',
    stampW: '0',
    stampH: '0',
  },
  lL: {
    title: 12,
    clinic: 9,
    h: 12,
    sub: 11,
    body: 9,
    table: 9,
    small: 9,
    logo: '0',
    logoWide: '0',
    idLabel: '0',
    stampW: '0',
    stampH: '0',
  },
  lXL: {
    title: 14,
    clinic: 10,
    h: 14,
    sub: 13,
    body: 10,
    table: 10,
    small: 10,
    logo: '0',
    logoWide: '0',
    idLabel: '0',
    stampW: '0',
    stampH: '0',
  },
}

export interface Paper {
  /** 'a4', 'roll-58', 'label-50x30'. */
  id: string
  group: PaperGroup
  /** Width and height in mm, portrait; a roll has no height (as long as the content). */
  w: number
  h: number | null
  /** The CSS name of the size ('A4', 'letter'), so the print dialog picks the same paper. */
  name?: string
  tier: TierId
  /** The @page margins (top, sides, bottom: the bottom holds the footer of a sheet). */
  margins: Record<Margins, string>
}

const M_SHEET = { normal: '15mm 18mm 20mm', narrow: '8mm 10mm 14mm', none: '0' }
const M_A5 = { normal: '12mm 12mm 16mm', narrow: '7mm 8mm 13mm', none: '0' }
const M_A6 = { normal: '8mm 8mm 12mm', narrow: '6mm 5mm 11mm', none: '0' }
const M_LABEL = { normal: '0', narrow: '0', none: '0' }
const roll = (w: number, tier: TierId, normal: string, narrow: string): Paper => ({
  id: `roll-${w}`,
  group: 'roll',
  w,
  h: null,
  tier,
  margins: { normal, narrow, none: '0' },
})
const label = (w: number, h: number, tier: TierId): Paper => ({
  id: `label-${w}x${h}`,
  group: 'label',
  w,
  h,
  tier,
  margins: M_LABEL,
})

/** In the order of the paper list. The printable width of a roll: 48 mm on 58 mm paper, 64 mm on
 *  76 mm (impact printers), 72 mm on 80 mm, 104 mm on 112 mm. */
export const PAPERS: readonly Paper[] = [
  { id: 'a4', group: 'sheet', w: 210, h: 297, name: 'A4', tier: 'a4', margins: M_SHEET },
  { id: 'a3', group: 'sheet', w: 297, h: 420, name: 'A3', tier: 'a4', margins: M_SHEET },
  { id: 'a5', group: 'sheet', w: 148, h: 210, name: 'A5', tier: 'a5', margins: M_A5 },
  { id: 'a6', group: 'sheet', w: 105, h: 148, tier: 'a6', margins: M_A6 },
  { id: 'b5', group: 'sheet', w: 176, h: 250, name: 'B5', tier: 'a4', margins: M_SHEET },
  { id: 'letter', group: 'sheet', w: 216, h: 279, name: 'letter', tier: 'a4', margins: M_SHEET },
  { id: 'legal', group: 'sheet', w: 216, h: 356, name: 'legal', tier: 'a4', margins: M_SHEET },
  roll(58, 'r58', '3mm 5mm', '2mm 3mm'),
  roll(76, 'r76', '3mm 6mm', '2mm 3mm'),
  roll(80, 'r80', '3mm 4mm', '2mm 2mm'),
  roll(112, 'r112', '3mm 4mm', '2mm 2mm'),
  label(40, 30, 'lS'),
  label(50, 25, 'lS'),
  label(50, 30, 'lS'),
  label(58, 40, 'lM'),
  label(60, 40, 'lM'),
  label(70, 40, 'lM'),
  label(100, 50, 'lL'),
  label(100, 150, 'lXL'),
]

/** A custom size: width and height in mm (the height of a roll may stay empty). */
export const CUSTOM_LIMITS = { wMin: 20, wMax: 500, hMin: 20, hMax: 1200 }

/** What a person chose (or the document's own paper). */
export interface PaperChoice {
  /** A paper id, or 'custom'. */
  paper: string
  /** null: as the document suggests (a wide report suggests landscape). */
  orientation?: Orientation | null
  margins?: Margins | null
  /** Custom size, mm; a NaN is a size typed wrong. */
  w?: number | null
  h?: number | null
}

/** The choice kept on this computer for a document kind. */
export interface SavedChoice extends PaperChoice {
  /** Print straight away next time (no print options shown). */
  straight?: boolean
  /** When it was chosen (ISO). */
  at?: string
}

/** Everything `paperLayout` needs, carried as JSON into the print window. */
export interface PaperCfg {
  kind: DocKind
  /** The document's own paper (today's page of its builder). */
  def: { paper: string; orientation: Orientation; margins: Margins }
  /** The papers this kind may print on. */
  papers: Paper[]
  /** The whole catalogue (a custom size takes the type sizes of the closest standard paper). */
  catalog: Paper[]
  groups: PaperGroup[]
  tiers: Record<TierId, Tier>
  limits: typeof CUSTOM_LIMITS
  /** The footer of a sheet (page margin boxes) with `FS_SMALL` for its type size; null for a
   *  document made for thermal paper (a receipt, the labels), which carries its own. */
  footer: string | null
  /** The same for a narrow sheet (A6): a shorter running identity at the top. */
  footerNarrow: string | null
}

/** The type size placeholder of `PaperCfg.footer`. */
export const FS_SMALL = '__FS_SMALL__'

export type PaperLayout =
  | {
      ok: true
      group: PaperGroup
      orientation: Orientation
      margins: Margins
      /** The paper size after the orientation, mm (a roll: null height = the content). */
      w: number
      h: number | null
      /** The @page margin and the printable width (mm). */
      margin: string
      printable: number
      scale: Scale
      /** The paper's own CSS: type sizes, @page rules, footer, preview size. */
      css: string
      /** The classes of <html>: paper-sheet|roll|label, paper-portrait|landscape, pw-xs…pw-l
       *  (printable width), thermal (black only), paper-nofoot (a sheet without page footer). */
      cls: string[]
    }
  | { ok: false; error: 'width' | 'height' }

export const groupsFor = (kind: DocKind): PaperGroup[] => KIND_GROUPS[kind].slice()

export const papersFor = (kind: DocKind): Paper[] =>
  PAPERS.filter((p) => KIND_GROUPS[kind].includes(p.group))

/** Today's page of a builder as a choice of the catalogue. */
export function pageChoice(page: PageKind): PaperCfg['def'] {
  switch (page) {
    case 'a4-landscape':
      return { paper: 'a4', orientation: 'landscape', margins: 'normal' }
    case 'a5':
      return { paper: 'a5', orientation: 'portrait', margins: 'normal' }
    case 'receipt':
      return { paper: 'roll-80', orientation: 'portrait', margins: 'normal' }
    case 'label':
      return { paper: 'label-70x40', orientation: 'portrait', margins: 'normal' }
    default:
      return { paper: 'a4', orientation: 'portrait', margins: 'normal' }
  }
}

/** The document kind a page stands for when a builder does not say (older callers, tests). */
export function kindOfPage(page: PageKind): DocKind {
  return page === 'receipt'
    ? 'receipt'
    : page === 'label'
      ? 'label'
      : page === 'a5'
        ? 'prescription'
        : 'report'
}

export function paperCfg(
  kind: DocKind,
  page: PageKind,
  footer: string | null = null,
  footerNarrow: string | null = footer,
): PaperCfg {
  return {
    kind,
    def: pageChoice(page),
    papers: papersFor(kind),
    catalog: PAPERS.slice(),
    groups: groupsFor(kind),
    tiers: TIERS,
    limits: CUSTOM_LIMITS,
    footer,
    footerNarrow,
  }
}

/**
 * A choice as the document's paper: sizes, @page and classes. Self-contained (the print window
 * runs a copy of it): no import, no module constant, nothing but its arguments.
 */
export function paperLayout(cfg: PaperCfg, choice: PaperChoice | null | undefined): PaperLayout {
  const c: PaperChoice = choice || cfg.def
  const lim = cfg.limits
  const margins: Margins = c.margins === 'narrow' || c.margins === 'none' ? c.margins : 'normal'
  let orientation: Orientation =
    c.orientation === 'portrait' || c.orientation === 'landscape'
      ? c.orientation
      : cfg.def.orientation
  let paper: Paper | null = null
  let group: PaperGroup
  let w: number
  let h: number | null
  let custom = false
  if (c.paper === 'custom') {
    const cw = typeof c.w === 'number' ? c.w : NaN
    const ch = c.h == null ? null : typeof c.h === 'number' ? c.h : NaN
    if (!(cw >= lim.wMin && cw <= lim.wMax)) return { ok: false, error: 'width' }
    if (ch !== null && !(ch >= lim.hMin && ch <= lim.hMax)) return { ok: false, error: 'height' }
    group = ch === null ? 'roll' : cfg.kind === 'label' ? 'label' : 'sheet'
    // a roll that this document cannot print on: the height is missing
    if (cfg.groups.indexOf(group) < 0) return { ok: false, error: 'height' }
    // the type sizes and margins of the closest standard paper of the same kind
    for (const p of cfg.catalog)
      if (p.group === group && (!paper || Math.abs(p.w - cw) < Math.abs(paper.w - cw))) paper = p
    if (!paper) return { ok: false, error: 'width' }
    w = Math.round(cw * 10) / 10
    h = ch === null ? null : Math.round(ch * 10) / 10
    orientation = 'portrait'
    custom = true
  } else {
    for (const p of cfg.papers) if (p.id === c.paper) paper = p
    if (!paper) for (const p of cfg.papers) if (p.id === cfg.def.paper) paper = p
    if (!paper) paper = cfg.papers[0]!
    group = paper.group
    w = paper.w
    h = paper.h
    if (group !== 'sheet') orientation = 'portrait'
    else if (orientation === 'landscape' && h !== null) {
      const t = w
      w = h
      h = t
    }
  }
  const tier = cfg.tiers[paper.tier]
  const margin = paper.margins[margins]
  // the side margin: "15mm 18mm 20mm" → 18 (one, two, three or four values)
  const parts = margin.split(/\s+/).map((x) => parseFloat(x) || 0)
  const side =
    parts.length === 1 ? parts[0]! : parts.length === 4 ? (parts[1]! + parts[3]!) / 2 : parts[1]!
  const printable = Math.round((w - 2 * side) * 10) / 10
  const mm = (n: number) => `${n}mm`
  const name = !custom && group === 'sheet' ? paper.name : undefined
  let page: string
  let wide = ''
  let wideW = w
  if (group === 'sheet') {
    page = name
      ? `size: ${name} ${orientation}; margin: ${margin};`
      : `size: ${mm(w)} ${mm(h!)}; margin: ${margin};`
    // a table too wide for a portrait page gets landscape pages of the same paper (reports)
    wideW = Math.max(w, h!)
    wide = name
      ? `size: ${name} landscape; margin: ${margin};`
      : `size: ${mm(wideW)} ${mm(Math.min(w, h!))}; margin: ${margin};`
  } else {
    // a roll: 200 mm until the print script measures the content
    page = `size: ${mm(w)} ${mm(h === null ? 200 : h)}; margin: ${margin};`
  }
  const s: Scale = {
    title: tier.title,
    clinic: tier.clinic,
    h: tier.h,
    sub: tier.sub,
    body: tier.body,
    table: tier.table,
    small: tier.small,
    logo: orientation === 'landscape' ? tier.logoWide : tier.logo,
    idLabel: tier.idLabel,
    stampW: tier.stampW,
    stampH: tier.stampH,
    sheetW: mm(w),
    pad: margin,
    page,
  }
  // the footer of a sheet; a narrow one (A6) has a shorter running identity at the top
  const tpl = printable < 100 && cfg.footerNarrow ? cfg.footerNarrow : cfg.footer
  const footer =
    group === 'sheet' && margins !== 'none' && tpl
      ? `\n${tpl.split('__FS_SMALL__').join(String(s.small))}`
      : ''
  const labelW = group === 'label' ? mm(w) : '70mm'
  const labelH = group === 'label' ? mm(h!) : '40mm'
  const css = `
:root { --fs-title: ${s.title}pt; --fs-clinic: ${s.clinic}pt; --fs-h: ${s.h}pt; --fs-sub: ${s.sub}pt; --fs-body: ${s.body}pt; --fs-table: ${s.table}pt; --fs-small: ${s.small}pt;
  --logo: ${s.logo}; --id-label: ${s.idLabel}; --stamp-w: ${s.stampW}; --stamp-h: ${s.stampH}; --label-w: ${labelW}; --label-h: ${labelH}; --wide-sheet: ${mm(wideW)};
  --sheet-w: ${s.sheetW}; --sheet-pad: ${s.pad}; }
@page { ${s.page} }${wide ? `\n@page wide { ${wide} }` : ''}${footer}
@media screen { .sheet { width: ${s.sheetW}; padding: ${s.pad}; } }
`
  const pw = printable < 56 ? 'pw-xs' : printable < 100 ? 'pw-s' : printable < 150 ? 'pw-m' : 'pw-l'
  const cls = [`paper-${group}`, `paper-${orientation}`, pw]
  if (group !== 'sheet') cls.push('thermal')
  if (group === 'sheet' && (margins === 'none' || !cfg.footer)) cls.push('paper-nofoot')
  return { ok: true, group, orientation, margins, w, h, margin, printable, scale: s, css, cls }
}

/** The sizes of today's pages (what `SCALES` held before 0207). */
export function scaleOf(page: PageKind): Scale {
  const l = paperLayout(paperCfg(kindOfPage(page), page), null)
  if (!l.ok) throw new Error('paper')
  return l.scale
}

/** Why a custom size cannot be printed for this kind, or null when it can. */
export function customError(
  kind: DocKind,
  w: number | null,
  h: number | null,
): 'width' | 'height' | null {
  const l = paperLayout(paperCfg(kind, 'a4'), { paper: 'custom', w, h })
  return l.ok ? null : l.error
}

// ---------------------------------------------------------------- remembered on this computer

export const printKey = (kind: DocKind) => `mmc.print.${kind}`

/** The paper kept for a kind on this computer (null: none, or the browser keeps nothing). */
export function readPrintChoice(kind: DocKind): SavedChoice | null {
  try {
    const raw = localStorage.getItem(printKey(kind))
    if (!raw) return null
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || typeof (v as SavedChoice).paper !== 'string') return null
    return v as SavedChoice
  } catch {
    return null
  }
}

export function writePrintChoice(kind: DocKind, c: SavedChoice): boolean {
  try {
    localStorage.setItem(printKey(kind), JSON.stringify(c))
    return true
  } catch {
    return false
  }
}

export function forgetPrintChoice(kind: DocKind): void {
  try {
    localStorage.removeItem(printKey(kind))
  } catch {
    /* the browser keeps nothing: nothing to forget */
  }
}

/** Whether this browser keeps the choices (a private window may not). */
export function canKeepChoices(): boolean {
  try {
    const k = 'mmc.print.__test'
    localStorage.setItem(k, '1')
    localStorage.removeItem(k)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- words

/** The print options' words, in the interface language (`makeDocLabels`). */
export interface PaperWords {
  options: string
  paper: string
  sheets: string
  rolls: string
  labels: string
  custom: string
  /** "A4 (210 × 297 mm)". */
  sheet: (name: string, w: number, h: number) => string
  /** "Receipt roll 58 mm". */
  roll: (w: number) => string
  /** "Label 50 × 30 mm". */
  label: (w: number, h: number) => string
  /** "Custom size 120 × 200 mm" / "Custom roll 57 mm wide" (the remembered choices). */
  customSheet: (w: number, h: number) => string
  customRoll: (w: number) => string
  letter: string
  legal: string
  width: string
  height: string
  heightRoll: string
  orientation: string
  portrait: string
  landscape: string
  margins: string
  normal: string
  narrow: string
  none: string
  straight: string
  print: string
  close: string
  errWidth: string
  errHeight: string
  errHeightRoll: string
}

/** A paper of the list in words. */
export function paperName(p: Paper, w: PaperWords): string {
  if (p.group === 'roll') return w.roll(p.w)
  if (p.group === 'label') return w.label(p.w, p.h ?? 0)
  const name = p.id === 'letter' ? w.letter : p.id === 'legal' ? w.legal : p.id.toUpperCase()
  return w.sheet(name, p.w, p.h ?? 0)
}

/** A remembered choice in words: "Receipt roll 58 mm · Margins: Narrow". */
export function choiceText(kind: DocKind, c: PaperChoice, w: PaperWords): string {
  const cfg = paperCfg(kind, 'a4')
  const l = paperLayout(cfg, c)
  const parts: string[] = []
  if (c.paper === 'custom') {
    if (!l.ok) return w.custom
    parts.push(l.h === null ? w.customRoll(l.w) : w.customSheet(l.w, l.h))
  } else {
    const p = PAPERS.find((x) => x.id === c.paper)
    parts.push(p ? paperName(p, w) : c.paper)
    if (p?.group === 'sheet' && c.orientation)
      parts.push(c.orientation === 'landscape' ? w.landscape : w.portrait)
  }
  if (l.ok && l.group !== 'label') parts.push(`${w.margins}: ${w[l.margins]}`)
  return parts.join(' · ')
}

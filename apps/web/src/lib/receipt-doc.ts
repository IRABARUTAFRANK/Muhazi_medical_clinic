import i18n from 'i18next'
import {
  chipHtml,
  documentHtml,
  docDateTime,
  docMoney,
  docNumber,
  esc,
  formatRwf,
  keyFiguresHtml,
  letterheadHtml,
  makeDocLabels,
  openPrintWindow,
  receiptLetterheadHtml,
  tableHtml,
  titleBlockHtml,
  type DocLabels,
  type Letterhead,
  type TFn,
} from '@/lib/doc-style'

/**
 * The payment receipt handed to the patient (document standard C5): an 80 mm roll, all text
 * pure black for thermal printers. Centred letterhead, title, receipt meta, patient, the items at
 * full price, the insurer / patient split, the total due (boxed), this payment, what is paid and
 * still due (a PAID IN FULL or PART PAID chip), the tax notice, who received the money, the opening
 * hours and the thank-you line. The visit no. is printed when the caller has it.
 *
 * `buildReceiptHtml` is pure (no window, no React); `openReceipt` writes it into a print window.
 */

export interface ReceiptLine {
  description: string
  quantity: number
  /**
   * The line amount. With `unitPrice` (or `fullAmount`) given it is ignored; without them it is
   * read as the patient's share of the line (older callers).
   */
  amount: number
  /** Full unit price before the insurer split. */
  unitPrice?: number
  /** Full line amount before the insurer split (default unitPrice × quantity). */
  fullAmount?: number
}

export interface ReceiptDoc {
  receiptNo: string | null
  invoiceNo: string | null
  /** The visit's reference (V-…), printed when the caller has it. */
  visitNo?: string | null
  at: Date
  /** The clinic's letterhead: the structured fields of `useLetterhead()` (older string fields kept). */
  clinic: {
    name: string
    address: string
    contacts: string
    licences?: string
    logoUrl: string
  } & Partial<Letterhead>
  patient: {
    name: string
    fileNumber: string
    /** Insurer name (default: `insurer.name`). */
    insurer?: string | null
    memberNo?: string | null
  }
  lines: ReceiptLine[]
  /** The patient's share of the bill (what the patient owes before any discount below). */
  total: number
  /** Full charges before the insurer split (default: total + insurer amount). */
  subtotal?: number
  /** `pct` is the insurer's cover in percent (default: computed when it is a whole number). */
  insurer: { name: string; amount: number; pct?: number | null } | null
  /** An amount taken off the patient's share (printed only when not 0). */
  discount?: number
  /** `method` may be a code (cash, momo, airtel, card, …) or words already translated. */
  payment: { method: string; amount: number; reference: string | null } | null
  paid: number
  balance: number
  cashier: string
}

/**
 * The wording older callers pass. Kept so they keep compiling; the receipt now reads its wording
 * from the translations (see `receiptText`) and uses these only when no translation is loaded.
 * @deprecated pass nothing, or `{ text, labels }` in the third argument of `openReceipt`.
 */
export interface ReceiptLabels {
  title: string
  statement: string
  receiptNo: string
  invoiceNo: string
  patient: string
  file: string
  item: string
  amount: string
  total: string
  insurerPays: (name: string) => string
  patientPays: string
  paidNow: string
  reference: string
  paidSoFar: string
  balance: string
  settled: string
  cashier: string
  thanks: string
}

/** The receipt's own wording (the shared words come from `DocLabels`). */
export interface ReceiptText {
  title: string
  statement: string
  receiptNo: string
  invoiceNo: string
  visitNo: string
  cashier: string
  description: string
  qty: string
  unitPrice: string
  amountRwf: string
  patientShareRwf: string
  subtotal: string
  insurerPays: (name: string, pct: number | null) => string
  patientShare: (pct: number | null) => string
  discount: string
  totalDue: string
  paidNow: (method: string) => string
  reference: string
  totalPaid: string
  balanceDue: string
  change: string
  paidInFull: string
  /** "PART PAID": something is paid and a balance is still due. */
  partPaid: string
  taxNotice: string
  taxNoticeStatement: string
  ebmNo: string
  receivedBy: string
  preparedBy: string
  thankYou: (clinic: string) => string
}

/** The receipt wording from the translations (`receipt.*`). */
export function receiptText(t: TFn): ReceiptText {
  const k = (key: string, vars?: Record<string, unknown>) => t(`receipt.${key}`, vars)
  /** A newer key, with its English wording until the translation is merged. */
  const kd = (key: string, en: string) => {
    const v = t(`receipt.${key}`, { defaultValue: en })
    return v && v !== `receipt.${key}` ? v : en
  }
  return {
    title: k('title'),
    statement: k('statement'),
    receiptNo: k('receiptNo'),
    invoiceNo: k('invoiceNo'),
    visitNo: kd('visitNo', 'Visit no.'),
    cashier: k('cashierName'),
    description: k('item'),
    qty: k('qty'),
    unitPrice: k('unitPrice'),
    amountRwf: k('amountRwf'),
    patientShareRwf: k('patientShareRwf'),
    subtotal: k('subtotal'),
    // the insurer's name is already in the patient block: a short label that pairs with the
    // patient share under it and does not wrap on 72 mm
    insurerPays: (_name, pct) => (pct == null ? k('insurerShare') : k('insurerSharePct', { pct })),
    patientShare: (pct) => (pct == null ? k('patientPays') : k('patientSharePct', { pct })),
    discount: k('discount'),
    totalDue: k('totalDue'),
    paidNow: (method) => k('paidNowBy', { method }),
    reference: k('reference'),
    totalPaid: k('paidSoFar'),
    balanceDue: k('balance'),
    change: k('change'),
    paidInFull: k('settled'),
    partPaid: kd('chipPartial', 'PART PAID'),
    taxNotice: k('taxNotice'),
    taxNoticeStatement: k('taxNoticeStatement'),
    ebmNo: k('ebmNo'),
    receivedBy: k('cashier'),
    preparedBy: k('preparedBy'),
    thankYou: (clinic) => k('thankYou', { clinic }),
  }
}

/** Receipt wording from an older caller's labels (used only when no translation is loaded). */
function textFromLegacy(l: ReceiptLabels): ReceiptText {
  return {
    title: l.title,
    statement: l.statement,
    receiptNo: l.receiptNo,
    invoiceNo: l.invoiceNo,
    visitNo: 'Visit no.',
    cashier: l.cashier,
    description: l.item,
    qty: 'Qty',
    unitPrice: 'Unit price',
    amountRwf: `${l.amount} (RWF)`,
    patientShareRwf: `${l.patientPays} (RWF)`,
    subtotal: 'Subtotal',
    insurerPays: (name, pct) =>
      pct == null ? l.insurerPays(name) : `${l.insurerPays(name)} ${pct}%`,
    patientShare: (pct) => (pct == null ? l.patientPays : `${l.patientPays} (${pct}%)`),
    discount: 'Discount',
    totalDue: l.total,
    paidNow: (method) => `${l.paidNow}: ${method}`,
    reference: l.reference,
    totalPaid: l.paidSoFar,
    balanceDue: l.balance,
    change: 'Change',
    paidInFull: l.settled,
    partPaid: 'PART PAID',
    taxNotice: 'This is a payment receipt, not an RRA tax invoice (EBM).',
    taxNoticeStatement: 'This statement is not an RRA tax invoice (EBM).',
    ebmNo: 'EBM invoice no.',
    receivedBy: l.cashier,
    preparedBy: 'Prepared by',
    thankYou: () => l.thanks,
  }
}

/** The structured letterhead, also from an older caller's pre-joined strings. */
function letterheadOf(c: ReceiptDoc['clinic']): Letterhead {
  return {
    legalName: c.legalName ?? c.name,
    addressLine: c.addressLine !== undefined ? c.addressLine : c.address || null,
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

const METHOD_CODES = new Set([
  'cash',
  'momo',
  'airtel',
  'card',
  'bank',
  'insurer',
  'credit',
  'deposit',
])

/** The insurer's share in whole percent, or null when the split is not one whole percentage. */
function coverPct(subtotal: number, insurer: number, given?: number | null): number | null {
  if (given != null && Number.isFinite(given)) return Math.round(given * 100) / 100
  if (subtotal <= 0 || insurer <= 0) return null
  const pct = Math.round((insurer * 100) / subtotal)
  return Math.abs((subtotal * pct) / 100 - insurer) < 1 ? pct : null
}

/** Receipt layout only (the shared parts come from `printBase`); pure black for thermal paper. */
const RECEIPT_CSS = `
/* the title between two rules, the document's one strong mark */
.r-title { font-size: var(--fs-title); font-weight: 700; text-align: center; line-height: 1.2; margin: 0 0 4pt;
  padding: 1pt 0 3pt; border-bottom: 1pt solid #000; letter-spacing: 0.06em; text-transform: uppercase; }
.kv { display: grid; grid-template-columns: var(--kv-label) minmax(0, 1fr); column-gap: 2mm; line-height: 1.3; }
.kv .k { font-weight: 600; overflow-wrap: break-word; }
/* one label width for every block, wide enough for the longest single word of the labels */
:root { --kv-label: 24mm; }
:root:lang(rw) { --kv-label: 31mm; }
.kv .v { overflow-wrap: anywhere; }
.kv .v.strong { font-weight: 700; }
/* thermal style: blocks parted by a dashed rule */
.r-block { padding: 4pt 0; border-top: 0.75pt dashed #000; }
.r-block:first-of-type, .r-block.r-due-only { border-top: 0; }
table.rt { width: 100%; border-collapse: collapse; font-size: var(--fs-table); line-height: 1.25;
  font-variant-numeric: tabular-nums lining-nums; }
.rt th { font-weight: 700; text-align: left; vertical-align: bottom; padding: 0 0 2pt; border-bottom: 0.75pt solid #000; line-height: 1.2; }
.rt th.num { white-space: normal; }
.rt td { vertical-align: top; padding: 1.5pt 0; }
.rt th + th, .rt td + td { padding-left: 1.5mm; }
.rt .num { text-align: right; white-space: nowrap; }
.rt td.desc { width: 100%; overflow-wrap: break-word; }
.rt tbody tr:first-child td { padding-top: 3pt; }
.rt tr { break-inside: avoid; page-break-inside: avoid; }
.sums td { padding: 1pt 0; }
.sums td:first-child { width: 100%; }
.sums td.num, .sums .pct { white-space: nowrap; }
.sums tr.share td { font-weight: 600; }
/* TOTAL DUE in a box: the one figure the patient looks for */
.sums tr.due td { border-top: 1.5pt solid #000; border-bottom: 1.5pt solid #000; padding: 3pt 0; font-size: var(--fs-title); font-weight: 700; }
.sums tr.balance td { font-weight: 700; }
.r-status { text-align: center; margin: 5pt 0 0; }
.r-status .chip { font-size: var(--fs-body); padding: 1pt 9pt; border-width: 1.25pt; letter-spacing: 0.08em; }
.notice { font-size: var(--fs-small); line-height: 1.3; }
.notice p { margin: 0; }
.sign { display: flex; align-items: flex-end; gap: 2mm; margin-top: 4pt; }
.sign.tall { margin-top: 7pt; }
.sign .k { font-weight: 600; flex: none; }
.sign .line { flex: 1; border-bottom: 0.75pt solid #000; height: 1.1em; }
.sign.tall .line { height: 7mm; }
.r-foot { text-align: center; font-size: var(--fs-small); line-height: 1.35; padding-top: 4pt; border-top: 2.25pt double #000; margin-top: 6pt; }
.r-foot .thanks { font-size: var(--fs-body); font-weight: 700; margin-top: 2pt; }
`

/** The receipt's money lines: full charges, the insurer's and the patient's shares, what is due. */
export interface ReceiptSums {
  /** Full charges before the insurer split. */
  subtotal: number
  /** The insurer's share (0 without an insurer). */
  insurer: number
  /** The patient's share (subtotal − insurer share). */
  patient: number
  /** The insurer's cover in percent, when the split is one whole percentage (else null). */
  insurerPct: number | null
  /** The patient's part in percent (100 − insurerPct), or null. */
  patientPct: number | null
  discount: number
  /** What the patient owes: patient share − discount (never below 0). */
  totalDue: number
}

/** The money lines of a receipt (pure, so the split can be checked). */
export function receiptSums(
  d: Pick<ReceiptDoc, 'total' | 'subtotal' | 'insurer' | 'discount'>,
): ReceiptSums {
  const insured = !!d.insurer && d.insurer.amount > 0
  const insurer = insured ? d.insurer!.amount : 0
  const subtotal = d.subtotal ?? d.total + insurer
  const insurerPct = insured ? coverPct(subtotal, insurer, d.insurer!.pct) : null
  const discount = Math.max(0, d.discount ?? 0)
  return {
    subtotal,
    insurer,
    patient: d.total,
    insurerPct,
    patientPct: insurerPct == null ? null : Math.round((100 - insurerPct) * 100) / 100,
    discount,
    totalDue: Math.max(0, d.total - discount),
  }
}

/** The receipt's full HTML document (pure: no window). */
export function buildReceiptHtml(
  d: ReceiptDoc,
  rt: ReceiptText,
  dl: DocLabels,
  opts: { lang?: string; autoPrint?: boolean; printedBy?: string | null; printedAt?: Date } = {},
): string {
  const { title, body } = receiptBodyHtml(d, rt, dl, opts)
  return documentHtml({
    base: {
      page: 'receipt',
      title,
      docNo: d.receiptNo,
      clinicName: letterheadOf(d.clinic).legalName,
      printedBy: opts.printedBy ?? null,
      printedAt: opts.printedAt,
      labels: dl,
    },
    css: RECEIPT_CSS,
    body,
    lang: opts.lang,
    autoPrint: opts.autoPrint,
  })
}

/**
 * The receipt's body (letterhead to thank-you line) and its title, without the document
 * wrapper: one receipt prints it on the 80 mm roll, the receipts of a period print one copy
 * per page on A4 (`buildReceiptsBatchHtml`).
 */
export function receiptBodyHtml(
  d: ReceiptDoc,
  rt: ReceiptText,
  dl: DocLabels,
  opts: { printedBy?: string | null; printedAt?: Date } = {},
): { title: string; body: string } {
  const lh = letterheadOf(d.clinic)
  // a receipt once anything is paid (also when reprinted without this payment); else a statement
  const isReceipt = !!d.payment || d.paid > 0
  const title = isReceipt ? rt.title : rt.statement
  const kv = (label: string, value: string | null | undefined, strong = false) =>
    value
      ? `<div class="k">${esc(label)}:</div><div class="v${strong ? ' strong' : ''}">${esc(value)}</div>`
      : ''

  // meta: receipt no., date, visit no., invoice no., cashier (only when known)
  const meta = [
    kv(rt.receiptNo, d.receiptNo, true),
    kv(dl.date, docDateTime(d.at)),
    kv(rt.visitNo, d.visitNo),
    kv(rt.invoiceNo, d.invoiceNo),
    kv(rt.cashier, d.cashier),
  ].join('')

  // patient
  const insurerName = d.patient.insurer ?? (d.insurer?.name || null)
  const patient = [
    kv(dl.name, d.patient.name, true),
    kv(dl.fileNo, d.patient.fileNumber),
    kv(dl.insurer, insurerName),
    insurerName ? kv(dl.memberNo, d.patient.memberNo) : '',
  ].join('')

  // items at full price when the caller gives them, else the patient's share of each line
  const full =
    d.lines.length > 0 && d.lines.every((x) => x.unitPrice != null || x.fullAmount != null)
  const lineAmount = (x: ReceiptLine) =>
    full ? (x.fullAmount ?? Math.round((x.unitPrice ?? 0) * x.quantity)) : x.amount
  const unit = (x: ReceiptLine) =>
    x.unitPrice != null ? x.unitPrice : x.quantity ? lineAmount(x) / x.quantity : lineAmount(x)
  const sums = receiptSums(d)
  const insured = sums.insurer > 0
  const amountHead = !full && insured ? rt.patientShareRwf : rt.amountRwf
  const items = `<table class="rt"><thead><tr><th>${esc(rt.description)}</th><th class="num">${esc(rt.qty)}</th>${full ? `<th class="num">${esc(rt.unitPrice)}</th>` : ''}<th class="num">${esc(amountHead)}</th></tr></thead>
<tbody>${d.lines
    .map(
      (x) =>
        `<tr><td class="desc">${esc(x.description)}</td><td class="num">${esc(docNumber(x.quantity))}</td>${
          full ? `<td class="num">${esc(docMoney(unit(x)))}</td>` : ''
        }<td class="num">${esc(docMoney(lineAmount(x)))}</td></tr>`,
    )
    .join('')}</tbody></table>`

  // totals: subtotal, insurer pays %, patient share (%), discount, total due
  // a trailing "(85%)" stays on the line of the word before it
  const labelHtml = (label: string) =>
    esc(label).replace(/\s*(\([^()]*\))$/, (_m, p: string) => `&nbsp;<span class="pct">${p}</span>`)
  const sum = (label: string, value: string, cls = '') =>
    `<tr${cls ? ` class="${cls}"` : ''}><td>${labelHtml(label)}</td><td class="num">${esc(value)}</td></tr>`
  // without insurer or discount, TOTAL DUE is the only row: its own box is the only line
  const dueOnly = !insured && !sums.discount
  const sumsHtml = `<table class="rt sums"><tbody>${[
    dueOnly ? '' : sum(rt.subtotal, formatRwf(sums.subtotal)),
    insured
      ? sum(rt.insurerPays(d.insurer!.name, sums.insurerPct), `–${formatRwf(sums.insurer)}`)
      : '',
    insured ? sum(rt.patientShare(sums.patientPct), formatRwf(sums.patient), 'share') : '',
    sums.discount ? sum(rt.discount, `–${formatRwf(sums.discount)}`) : '',
    sum(rt.totalDue, formatRwf(sums.totalDue), 'due'),
  ].join('')}</tbody></table>`

  // this payment, what is paid so far and what is still due (or change)
  const method = d.payment
    ? METHOD_CODES.has(d.payment.method)
      ? dl.method(d.payment.method)
      : d.payment.method
    : ''
  const balance = d.balance
  const status =
    balance <= 0 && d.paid > 0
      ? chipHtml(rt.paidInFull, 'ok')
      : d.paid > 0 && balance > 0
        ? chipHtml(rt.partPaid, 'warn')
        : ''
  const payment = `<table class="rt sums"><tbody>${[
    d.payment ? sum(rt.paidNow(method), formatRwf(d.payment.amount)) : '',
    d.payment?.reference ? sum(rt.reference, d.payment.reference) : '',
    sum(rt.totalPaid, formatRwf(d.paid)),
    balance < 0
      ? sum(rt.change, formatRwf(-balance), 'balance')
      : sum(rt.balanceDue, formatRwf(balance), 'balance'),
  ].join('')}</tbody></table>${status ? `<p class="r-status flag-word">${status}</p>` : ''}`

  const foot = [
    lh.openingHours ? `<div>${esc(dl.openingHours)}: ${esc(lh.openingHours)}</div>` : '',
    // the receipt has no page footer: who printed it (a reprint too) is said here
    opts.printedBy
      ? `<div>${esc(dl.printedBy(docDateTime(opts.printedAt ?? new Date()), opts.printedBy))}</div>`
      : '',
    `<div class="thanks">${esc(rt.thankYou(lh.legalName))}</div>`,
  ].join('')

  const body = [
    receiptLetterheadHtml(lh, dl),
    `<h1 class="r-title">${esc(title)}</h1>`,
    `<section class="r-block kv">${meta}</section>`,
    `<section class="r-block kv">${patient}</section>`,
    `<section class="r-block">${items}</section>`,
    `<section class="r-block${dueOnly ? ' r-due-only' : ''}">${sumsHtml}</section>`,
    `<section class="r-block">${payment}</section>`,
    `<section class="r-block notice"><p>${esc(isReceipt ? rt.taxNotice : rt.taxNoticeStatement)}</p>
<div class="sign"><span class="k">${esc(rt.ebmNo)}:</span><span class="line"></span></div></section>`,
    `<section class="r-block"><div class="kv">${kv(isReceipt ? rt.receivedBy : rt.preparedBy, d.cashier)}</div>
<div class="sign tall"><span class="k">${esc(dl.signature)}:</span><span class="line"></span></div></section>`,
    `<footer class="r-foot">${foot}</footer>`,
  ].join('\n')

  return { title, body }
}

/** The receipts of a period in one document: a cover (figures and the list), then one receipt
 *  per page, each in its 80 mm width, as the cash desk printed it. Pure (no window). */
const BATCH_CSS = `
.r-cover .dt { margin-top: 8pt; }
.r-copy { width: 80mm; margin: 0 auto; padding: 3mm 4mm; border: 0.5pt solid var(--hair);
  break-before: page; page-break-before: always; break-inside: avoid; page-break-inside: avoid;
  --fs-title: 11pt; --fs-clinic: 11pt; --fs-h: 9pt; --fs-sub: 9pt; --fs-body: 9pt; --fs-table: 9pt; --fs-small: 8pt;
  --logo: 14mm; --ink: #000000; --ink-2: #000000; --hair: #000000;
  font-size: var(--fs-body); line-height: 1.38; color: #000000; }
.r-copy .r-no { font-size: 8pt; text-align: right; color: #000000; margin: 0 0 3pt; }
`

export interface ReceiptsBatchCover {
  /** "Receipts of the period". */
  title: string
  /** "Period", then "24/10/2026" or "01/10/2026 to 24/10/2026". */
  periodWord: string
  periodLabel: string
  /** "N receipts". */
  countLabel: string
  /** "RWF total". */
  totalLabel: string
  /** The cashier and the payment method filters, in words (left out when not filtered). */
  cashier?: string | null
  method?: string | null
  /** Column labels of the list. */
  columns: {
    no: string
    time: string
    patient: string
    file: string
    method: string
    cashier: string
    amount: string
  }
  /** "Cashier: …", "Method: …". */
  cashierLabel: string
  methodLabel: string
  /** The counter line "N receipts · RWF total · period · printed by". */
  summary: string
}

export function buildReceiptsBatchHtml(
  docs: ReceiptDoc[],
  rt: ReceiptText,
  dl: DocLabels,
  cover: ReceiptsBatchCover,
  opts: { lang?: string; autoPrint?: boolean; printedBy?: string | null; printedAt?: Date } = {},
): string {
  const first = docs[0]
  const lh = first ? letterheadOf(first.clinic) : null
  const total = docs.reduce((s, d) => s + (d.payment?.amount ?? 0), 0)
  const figures = keyFiguresHtml([
    { label: cover.countLabel, value: docNumber(docs.length), tone: 'teal' },
    { label: cover.totalLabel, value: formatRwf(total), tone: 'violet' },
    ...(cover.cashier
      ? [{ label: cover.cashierLabel, value: cover.cashier, tone: 'navy' as const }]
      : []),
    ...(cover.method
      ? [{ label: cover.methodLabel, value: cover.method, tone: 'mint' as const }]
      : []),
  ])
  const c = cover.columns
  const list = tableHtml(
    [
      { label: c.no, width: '26mm' },
      { label: c.time, width: '28mm' },
      { label: c.patient },
      { label: c.file, width: '24mm' },
      { label: c.method, width: '22mm' },
      { label: c.cashier, width: '34mm' },
      { label: c.amount, money: true, width: '24mm' },
    ],
    docs.map((d) => [
      d.receiptNo,
      docDateTime(d.at),
      d.patient.name,
      d.patient.fileNumber,
      d.payment
        ? METHOD_CODES.has(d.payment.method)
          ? dl.method(d.payment.method)
          : d.payment.method
        : null,
      d.cashier,
      d.payment?.amount ?? 0,
    ]),
    { totals: [{ cells: [dl.total, null, null, null, null, null, total], grand: true }] },
  )
  const coverHtml = [
    lh ? letterheadHtml(lh, dl) : '',
    titleBlockHtml({
      title: cover.title,
      scope: cover.summary,
      meta: [
        [cover.periodWord, cover.periodLabel],
        [cover.cashierLabel, cover.cashier],
        [cover.methodLabel, cover.method],
      ],
    }),
    figures,
    list,
  ].join('')
  const copies = docs
    .map((d, i) => {
      const { body } = receiptBodyHtml(d, rt, dl, opts)
      return `<section class="r-copy"><p class="r-no">${i + 1} / ${docs.length}</p>${body}</section>`
    })
    .join('\n')
  return documentHtml({
    base: {
      page: 'a4',
      title: cover.title,
      docNo: null,
      clinicName: lh?.legalName ?? '',
      printedBy: opts.printedBy ?? null,
      printedAt: opts.printedAt,
      labels: dl,
    },
    css: RECEIPT_CSS + BATCH_CSS,
    body: `<section class="r-cover">${coverHtml}</section>${copies}`,
    lang: opts.lang,
    autoPrint: opts.autoPrint,
  })
}

/** The translation function of the running app, when it is loaded. */
function appT(): TFn | null {
  if (!i18n.isInitialized) return null
  return (key, vars) => i18n.t(key, { ...(vars ?? {}) }) as string
}

/**
 * Opens the receipt in a print window (false when the window is blocked). The wording comes from
 * the app's translations, or from `opts.text` / `opts.labels` when given; an older caller's
 * `legacy` labels stand in for the receipt's own words only when `opts.labels` is given but the
 * translations are not loaded (the app always loads them at start).
 */
export function openReceipt(
  d: ReceiptDoc,
  legacy?: ReceiptLabels,
  opts: { text?: ReceiptText; labels?: DocLabels; printedBy?: string | null } = {},
): boolean {
  const t = appT()
  const dl = opts.labels ?? (t ? makeDocLabels(t) : null)
  const rt = opts.text ?? (t ? receiptText(t) : legacy ? textFromLegacy(legacy) : null)
  if (!dl || !rt) return false
  const html = buildReceiptHtml(d, rt, dl, {
    lang: i18n.language,
    printedBy: opts.printedBy,
  })
  return openPrintWindow(html)
}

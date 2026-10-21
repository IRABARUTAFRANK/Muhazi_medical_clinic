import { formatDate, formatRwf, formatTime } from '@mmc/shared'

/**
 * The receipt handed to the patient after a payment: the clinic's letterhead, the receipt number,
 * the patient, what was charged on the visit (the patient's share of each line), this payment
 * (how and the reference), what is paid so far and what is still due, and who took the money.
 * A narrow page that prints well on paper or as a PDF.
 */
export interface ReceiptDoc {
  receiptNo: string | null
  invoiceNo: string | null
  at: Date
  clinic: { name: string; address: string; contacts: string; licences?: string; logoUrl: string }
  patient: { name: string; fileNumber: string }
  lines: { description: string; quantity: number; amount: number }[]
  total: number
  insurer: { name: string; amount: number } | null
  payment: { method: string; amount: number; reference: string | null } | null
  paid: number
  balance: number
  cashier: string
}

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

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export function openReceipt(d: ReceiptDoc, l: ReceiptLabels): boolean {
  const title = d.payment ? l.title : l.statement
  const row = (a: string, b: string, strong = false) =>
    `<tr class="${strong ? 'strong' : ''}"><td>${a}</td><td class="r">${b}</td></tr>`
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} ${esc(d.receiptNo ?? '')}</title>
<style>
  @page { size: 80mm auto; margin: 4mm; }
  * { box-sizing: border-box; }
  body { font: 10pt/1.4 Inter, "Segoe UI", Arial, sans-serif; color: #111; margin: 0; }
  .sheet { max-width: 76mm; margin: 0 auto; }
  header { text-align: center; border-bottom: 1px dashed #999; padding-bottom: 6px; }
  header img { width: 44px; height: 44px; object-fit: contain; }
  header b { display: block; font-size: 11.5pt; }
  header span { display: block; font-size: 8.5pt; color: #444; }
  h1 { font-size: 11pt; text-align: center; letter-spacing: .08em; text-transform: uppercase; margin: 8px 0 2px; }
  .meta { text-align: center; font-size: 8.5pt; color: #444; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  td { padding: 2px 0; vertical-align: top; }
  td.r { text-align: right; white-space: nowrap; padding-left: 6px; }
  tr.strong td { font-weight: 700; }
  .sep td { border-top: 1px dashed #999; padding-top: 4px; }
  .who { margin-top: 8px; font-size: 8.5pt; color: #444; text-align: center; }
  .paid { margin: 6px 0; text-align: center; font-weight: 700; border: 1.5px solid #111; border-radius: 4px; padding: 3px; }
  footer { margin-top: 8px; border-top: 1px dashed #999; padding-top: 5px; font-size: 8pt; text-align: center; color: #444; }
  @media screen { body { background: #eef2f5; padding: 16px; } .sheet { background: #fff; padding: 10px 12px; box-shadow: 0 6px 24px rgba(0,0,0,.12); } }
</style></head><body><div class="sheet">
<header><img src="${esc(d.clinic.logoUrl)}" alt=""><b>${esc(d.clinic.name)}</b><span>${esc(d.clinic.address)}</span><span>${esc(d.clinic.contacts)}</span>${d.clinic.licences ? `<span>${esc(d.clinic.licences)}</span>` : ''}</header>
<h1>${esc(title)}</h1>
<div class="meta">${d.receiptNo ? `${esc(l.receiptNo)} <b>${esc(d.receiptNo)}</b><br>` : ''}${d.invoiceNo ? `${esc(l.invoiceNo)} ${esc(d.invoiceNo)}<br>` : ''}${esc(`${formatDate(d.at)} ${formatTime(d.at)}`)}</div>
<table>
  ${row(esc(l.patient), `<b>${esc(d.patient.name)}</b>`)}
  ${row(esc(l.file), esc(d.patient.fileNumber))}
</table>
<table style="margin-top:6px">
  <tr class="sep"><td><b>${esc(l.item)}</b></td><td class="r"><b>${esc(l.amount)}</b></td></tr>
  ${d.lines.map((x) => row(`${esc(x.description)}${x.quantity > 1 ? ` × ${esc(x.quantity)}` : ''}`, esc(formatRwf(x.amount)))).join('')}
  <tr class="sep"><td>${esc(l.total)}</td><td class="r">${esc(formatRwf(d.total))}</td></tr>
  ${d.insurer && d.insurer.amount > 0 ? row(esc(l.insurerPays(d.insurer.name)), esc(formatRwf(d.insurer.amount))) : ''}
  ${d.payment ? row(`${esc(l.paidNow)} · ${esc(d.payment.method)}`, esc(formatRwf(d.payment.amount)), true) : ''}
  ${d.payment?.reference ? row(esc(l.reference), esc(d.payment.reference)) : ''}
  ${row(esc(l.paidSoFar), esc(formatRwf(d.paid)))}
  ${row(esc(l.balance), esc(formatRwf(Math.max(0, d.balance))), true)}
</table>
${d.balance <= 0 ? `<div class="paid">${esc(l.settled)}</div>` : ''}
<div class="who">${esc(l.cashier)}: ${esc(d.cashier)}</div>
<footer>${esc(l.thanks)}<br>${esc(d.clinic.name)} · ${esc(d.clinic.contacts)}</footer>
</div><script>window.addEventListener('load', () => setTimeout(() => window.print(), 400))</script></body></html>`
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.open()
  w.document.write(html)
  w.document.close()
  return true
}

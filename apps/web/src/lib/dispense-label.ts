import { formatDate } from '@mmc/shared'

/**
 * The labels stuck on what the pharmacy hands over: one small label per medicine with the
 * clinic, the patient, the medicine and quantity, how to take it and the date. Opened in a new
 * window and sent to the print dialog (label printer, paper or PDF).
 */
export interface DispenseLabel {
  item: string
  quantity: number
  unit: string | null
  dose: string | null
  frequency: string | null
  days: number | null
  instructions: string | null
}

export interface DispenseLabelDoc {
  clinic: { name: string; contacts: string }
  patient: { name: string; fileNumber: string }
  date: Date
  lines: DispenseLabel[]
}

export interface DispenseLabelText {
  title: string
  days: (n: number) => string
}

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** Returns false when the browser blocked the new window. */
export function openDispenseLabels(d: DispenseLabelDoc, l: DispenseLabelText): boolean {
  const label = (x: DispenseLabel) => {
    const how = [x.dose, x.frequency, x.days ? l.days(x.days) : null].filter(Boolean).join(' · ')
    return `<section class="label">
  <header><b>${esc(d.clinic.name)}</b><span>${esc(d.clinic.contacts)}</span></header>
  <p class="who">${esc(d.patient.name)} · ${esc(d.patient.fileNumber)}</p>
  <p class="item">${esc(x.item)} <span>× ${esc(x.quantity)}${x.unit ? ' ' + esc(x.unit) : ''}</span></p>
  ${how ? `<p class="how">${esc(how)}</p>` : ''}
  ${x.instructions ? `<p class="note">${esc(x.instructions)}</p>` : ''}
  <footer>${esc(l.title)} · ${esc(formatDate(d.date))}</footer>
</section>`
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(l.title)} ${esc(d.patient.name)}</title>
<style>
  @page { size: 70mm 40mm; margin: 2mm; }
  * { box-sizing: border-box; }
  body { font: 9pt/1.3 Inter, "Segoe UI", Arial, sans-serif; color: #111; margin: 0; }
  .label { width: 66mm; min-height: 36mm; border: 1px solid #111; border-radius: 3mm; padding: 2mm 3mm;
           page-break-after: always; break-after: page; display: flex; flex-direction: column; gap: 1mm; }
  .label:last-child { page-break-after: auto; break-after: auto; }
  header { display: flex; justify-content: space-between; gap: 2mm; font-size: 7.5pt; border-bottom: 1px dashed #999; padding-bottom: 1mm; }
  header span { color: #444; }
  p { margin: 0; }
  .who { font-size: 8pt; color: #333; }
  .item { font-size: 10.5pt; font-weight: 700; }
  .item span { font-weight: 400; }
  .how { font-size: 10pt; font-weight: 600; }
  .note { font-size: 8pt; }
  footer { margin-top: auto; font-size: 7pt; color: #555; }
  @media screen { body { background: #eef2f5; padding: 16px; } .label { background: #fff; margin: 0 auto 12px; } }
</style></head><body>${d.lines.map(label).join('\n')}
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 150))</script>
</body></html>`
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.open()
  w.document.write(html)
  w.document.close()
  return true
}

import { formatDate, formatTime } from '@mmc/shared'

/**
 * The prescription a patient takes to any pharmacy: an A5 page with the clinic's letterhead,
 * the patient, the diagnosis, every medicine written in full (dose, how, how often, how long,
 * quantity) and the prescriber's name, signature line and stamp box. Opened in a new window and
 * sent to the print dialog ("Save as PDF" or paper).
 */

export interface RxDocMedicine {
  name: string
  quantity: number
  dose: string | null
  route: string | null
  frequency: string | null
  days: number | null
  instructions: string | null
}

export interface RxDoc {
  number: string
  date: Date
  clinic: {
    name: string
    address: string
    contacts: string
    /** "MoH licence 123 · TIN 456" when the clinic has set them. */
    licences?: string
    logoUrl: string
  }
  patient: {
    name: string
    fileNumber: string
    ageSex: string
    weight?: string | null
    allergies?: string | null
  }
  diagnosis?: string | null
  /** To collect at a pharmacy. */
  medicines: RxDocMedicine[]
  /** Already given at the clinic (listed for the record). */
  givenHere: RxDocMedicine[]
  prescriber: { name: string; title: string }
}

export interface RxDocLabels {
  title: string
  number: string
  date: string
  patient: string
  file: string
  ageSex: string
  weight: string
  allergies: string
  none: string
  diagnosis: string
  medicines: string
  quantity: string
  /** "for 5 days". */
  forDays: (n: number) => string
  givenHere: string
  prescriber: string
  signature: string
  stamp: string
  validity: string
  asWritten: string
}

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

function line(m: RxDocMedicine, l: RxDocLabels) {
  const how = [m.dose, m.route, m.frequency, m.days ? l.forDays(m.days) : null]
    .filter(Boolean)
    .map(esc)
    .join(' · ')
  return `<li><div class="med"><b>${esc(m.name)}</b><span class="qty">${esc(l.quantity)}: <b>${esc(m.quantity)}</b></span></div>${how ? `<div class="how">${how}</div>` : ''}${m.instructions ? `<div class="ins">${esc(m.instructions)}</div>` : ''}</li>`
}

export function openPrescription(d: RxDoc, l: RxDocLabels): boolean {
  const meds = d.medicines.map((m) => line(m, l)).join('')
  const given = d.givenHere.length
    ? `<h3>${esc(l.givenHere)}</h3><ol class="rx given">${d.givenHere.map((m) => line(m, l)).join('')}</ol>`
    : ''
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(l.title)} ${esc(d.number)}</title>
<style>
  @page { size: A5 portrait; margin: 9mm 9mm 11mm; }
  * { box-sizing: border-box; }
  body { font: 10pt/1.4 Inter, "Segoe UI", Arial, sans-serif; color: #1f2933; margin: 0; }
  header { display: flex; gap: 10px; align-items: center; border-bottom: 3px solid #0b2252; padding-bottom: 7px; }
  header img { width: 52px; height: 52px; object-fit: contain; border-radius: 8px; }
  .clinic { flex: 1; }
  .clinic b { display: block; font-size: 13pt; color: #0b2252; }
  .clinic span { display: block; font-size: 8.5pt; color: #52606d; }
  .doc { text-align: right; }
  .doc .rx { font: italic 700 26pt/1 Georgia, serif; color: #1f6f8b; }
  .doc b { display: block; font-size: 11pt; letter-spacing: .08em; color: #0b2252; text-transform: uppercase; }
  .doc span { display: block; font-size: 8.5pt; color: #52606d; }
  .patient { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 14px; margin: 9px 0; padding: 8px 10px; border: 1px solid #d9dee3; border-radius: 8px; background: #f6f9fb; }
  .patient div { font-size: 9pt; } .patient i { font-style: normal; color: #616e7c; margin-right: 4px; }
  .patient .wide { grid-column: 1 / -1; }
  .allergy { color: #b42318; font-weight: 700; }
  .dx { margin: 0 0 8px; font-size: 9.5pt; } .dx i { font-style: normal; color: #616e7c; margin-right: 4px; }
  h3 { font-size: 10pt; color: #0b2252; margin: 10px 0 4px; border-left: 4px solid #1f6f8b; padding-left: 7px; text-transform: uppercase; letter-spacing: .05em; }
  ol.rx { margin: 0; padding-left: 20px; }
  ol.rx li { padding: 6px 0 7px; border-bottom: 1px dashed #d9dee3; page-break-inside: avoid; }
  ol.rx li::marker { font-weight: 700; color: #1f6f8b; }
  .med { display: flex; justify-content: space-between; gap: 8px; font-size: 10.5pt; }
  .qty { white-space: nowrap; font-size: 9pt; color: #52606d; }
  .how { font-size: 9.5pt; margin-top: 1px; }
  .ins { font-size: 9pt; font-style: italic; color: #52606d; }
  ol.given li { opacity: .75; }
  .sign { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; margin-top: 18px; }
  .sign .who b { display: block; font-size: 10pt; } .sign .who span { font-size: 8.5pt; color: #52606d; }
  .sign .line { margin-top: 26px; border-top: 1px solid #1f2933; width: 170px; font-size: 8pt; color: #616e7c; padding-top: 2px; }
  .stamp { width: 92px; height: 92px; border: 1.5px dashed #9aa5b1; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 8pt; color: #9aa5b1; text-align: center; }
  footer { margin-top: 12px; border-top: 1px solid #d9dee3; padding-top: 5px; font-size: 7.8pt; color: #616e7c; }
  footer b { color: #1f2933; }
  @media screen { body { background: #eef2f5; padding: 20px; } .sheet { background: #fff; max-width: 148mm; margin: 0 auto; padding: 9mm; box-shadow: 0 6px 24px rgba(0,0,0,.12); } }
</style></head><body><div class="sheet">
<header><img src="${esc(d.clinic.logoUrl)}" alt=""><div class="clinic"><b>${esc(d.clinic.name)}</b><span>${esc(d.clinic.address)}</span><span>${esc(d.clinic.contacts)}</span>${d.clinic.licences ? `<span>${esc(d.clinic.licences)}</span>` : ''}</div>
<div class="doc"><div class="rx">℞</div><b>${esc(l.title)}</b><span>${esc(l.number)} ${esc(d.number)}</span><span>${esc(l.date)} ${esc(`${formatDate(d.date)} ${formatTime(d.date)}`)}</span></div></header>
<div class="patient">
  <div class="wide"><i>${esc(l.patient)}</i><b>${esc(d.patient.name)}</b></div>
  <div><i>${esc(l.file)}</i>${esc(d.patient.fileNumber)}</div>
  <div><i>${esc(l.ageSex)}</i>${esc(d.patient.ageSex)}</div>
  <div><i>${esc(l.weight)}</i>${esc(d.patient.weight || '—')}</div>
  <div><i>${esc(l.allergies)}</i>${d.patient.allergies ? `<span class="allergy">${esc(d.patient.allergies)}</span>` : esc(l.none)}</div>
</div>
${d.diagnosis ? `<p class="dx"><i>${esc(l.diagnosis)}</i><b>${esc(d.diagnosis)}</b></p>` : ''}
<h3>${esc(l.medicines)}</h3>
<ol class="rx">${meds}</ol>
${given}
<div class="sign"><div class="who"><span>${esc(l.prescriber)}</span><b>${esc(d.prescriber.name)}</b><span>${esc(d.prescriber.title)}</span><div class="line">${esc(l.signature)}</div></div><div class="stamp">${esc(l.stamp)}</div></div>
<footer><b>${esc(l.validity)}</b> ${esc(l.asWritten)}<br>${esc(d.clinic.name)} · ${esc(d.clinic.contacts)}</footer>
</div><script>window.addEventListener('load', () => setTimeout(() => window.print(), 400))</script></body></html>`
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.open()
  w.document.write(html)
  w.document.close()
  return true
}

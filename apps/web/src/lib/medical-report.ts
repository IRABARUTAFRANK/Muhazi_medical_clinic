import { formatDate, formatTime } from '@mmc/shared'

/**
 * The patient's medical report: an A4 page with the clinic's letterhead, the patient, and for
 * each visit the vital signs, the notes, the diagnoses, the tests with their results, the
 * treatments and medicines; an optional comment of the clinician; their name, signature line
 * and the clinic stamp. One visit (from the visit screen) or the whole history (patient file).
 * Opened in a new window and sent to the print dialog ("Save as PDF" or paper).
 */

export interface ReportVisit {
  date: string
  doctor?: string | null
  desks?: string[]
  vitals: { label: string; value: string }[]
  notes: string[]
  diagnoses: { text: string; icd10: string | null; primary: boolean; provisional: boolean }[]
  tests: { name: string; findings: string | null; impression: string | null; verified: boolean }[]
  treatments: string[]
  medicines: { name: string; how: string }[]
}

export interface MedicalReportDoc {
  kind: 'visit' | 'history'
  clinic: { name: string; address: string; contacts: string; licences?: string; logoUrl: string }
  patient: {
    name: string
    fileNumber: string
    ageSex: string
    phone?: string | null
    allergies?: string | null
    bloodGroup?: string | null
  }
  visits: ReportVisit[]
  comment?: string | null
  author: { name: string; title: string }
}

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

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

function visitBlock(v: ReportVisit, l: MedicalReportLabels, one: boolean) {
  const part = (title: string, body: string) => (body ? `<h4>${esc(title)}</h4>${body}` : '')
  const list = (items: string[]) =>
    items.length ? `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''
  const vitals = v.vitals.length
    ? `<div class="vitals">${v.vitals.map((x) => `<span><i>${esc(x.label)}</i> ${esc(x.value)}</span>`).join('')}</div>`
    : ''
  const dx = list(
    v.diagnoses.map(
      (d) =>
        `<b>${esc(d.text)}</b>${d.icd10 ? ` <span class="muted">(${esc(d.icd10)})</span>` : ''}${d.primary ? ` <span class="tag">${esc(l.primary)}</span>` : ''}${d.provisional ? ` <span class="muted">· ${esc(l.provisional)}</span>` : ''}`,
    ),
  )
  const tests = list(
    v.tests.map(
      (x) =>
        `<b>${esc(x.name)}</b>${x.findings ? `: ${esc(x.findings)}` : ''}${x.impression ? `<br><span class="muted">${esc(l.conclusion)}:</span> ${esc(x.impression)}` : ''}${!x.verified && (x.findings || x.impression) ? ` <span class="muted">(${esc(l.notVerified)})</span>` : ''}`,
    ),
  )
  const body =
    vitals +
    part(l.notes, list(v.notes.map(esc))) +
    part(l.diagnoses, dx) +
    part(l.tests, tests) +
    part(l.treatments, list(v.treatments.map(esc))) +
    part(
      l.medicines,
      list(v.medicines.map((m) => `<b>${esc(m.name)}</b>${m.how ? ` · ${esc(m.how)}` : ''}`)),
    )
  const meta = [
    v.doctor ? `${esc(l.seenBy)} ${esc(v.doctor)}` : '',
    v.desks?.length ? `${esc(l.desks)}: ${esc(v.desks.join(', '))}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return `<section class="visit">${one ? '' : `<h3>${esc(l.visitOf(v.date))}</h3>`}${meta ? `<p class="meta">${meta}</p>` : ''}${body || `<p class="muted">${esc(l.nothing)}</p>`}</section>`
}

export function openMedicalReport(d: MedicalReportDoc, l: MedicalReportLabels): boolean {
  const now = new Date()
  const one = d.kind === 'visit'
  const title = one ? l.title : l.titleHistory
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} · ${esc(d.patient.name)}</title>
<style>
  @page { size: A4 portrait; margin: 14mm 13mm 16mm; }
  * { box-sizing: border-box; }
  body { font: 10.5pt/1.45 Inter, "Segoe UI", Arial, sans-serif; color: #1f2933; margin: 0; }
  header { display: flex; gap: 12px; align-items: center; border-bottom: 3px solid #0b2252; padding-bottom: 8px; }
  header img { width: 58px; height: 58px; object-fit: contain; border-radius: 8px; }
  .clinic { flex: 1; } .clinic b { display: block; font-size: 14pt; color: #0b2252; }
  .clinic span { display: block; font-size: 9pt; color: #52606d; }
  .doc { text-align: right; } .doc b { display: block; font-size: 13pt; letter-spacing: .06em; color: #0b2252; text-transform: uppercase; }
  .doc span { display: block; font-size: 9pt; color: #52606d; }
  .patient { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 16px; margin: 10px 0 6px; padding: 9px 12px; border: 1px solid #d9dee3; border-radius: 8px; background: #f6f9fb; }
  .patient div { font-size: 9.5pt; } .patient i, .vitals i, .meta i { font-style: normal; color: #616e7c; margin-right: 4px; }
  .patient .wide { grid-column: 1 / -1; font-size: 11pt; }
  .allergy { color: #b42318; font-weight: 700; }
  h3 { font-size: 11.5pt; color: #0b2252; margin: 14px 0 2px; border-left: 4px solid #1f6f8b; padding-left: 8px; }
  h4 { font-size: 9.5pt; text-transform: uppercase; letter-spacing: .05em; color: #1f6f8b; margin: 8px 0 2px; }
  .visit { page-break-inside: avoid; border-bottom: 1px dashed #d9dee3; padding-bottom: 8px; }
  .meta { margin: 2px 0 4px; font-size: 9.5pt; color: #52606d; }
  .vitals { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 9.5pt; margin: 4px 0; }
  ul { margin: 0; padding-left: 18px; } li { margin: 1px 0; }
  .muted { color: #616e7c; } .tag { font-size: 8pt; background: #e6f1f6; color: #1f6f8b; border-radius: 4px; padding: 0 5px; }
  .comment { margin-top: 12px; padding: 8px 12px; border: 1px solid #d9dee3; border-radius: 8px; }
  .sign { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; margin-top: 22px; page-break-inside: avoid; }
  .sign .who b { display: block; font-size: 10.5pt; } .sign .who span { font-size: 9pt; color: #52606d; }
  .sign .line { margin-top: 30px; border-top: 1px solid #1f2933; width: 200px; font-size: 8.5pt; color: #616e7c; padding-top: 2px; }
  .stamp { width: 100px; height: 100px; border: 1.5px dashed #9aa5b1; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 8.5pt; color: #9aa5b1; text-align: center; }
  footer { margin-top: 14px; border-top: 1px solid #d9dee3; padding-top: 5px; font-size: 8pt; color: #616e7c; }
  @media screen { body { background: #eef2f5; padding: 20px; } .sheet { background: #fff; max-width: 210mm; margin: 0 auto; padding: 13mm; box-shadow: 0 6px 24px rgba(0,0,0,.12); } }
</style></head><body><div class="sheet">
<header><img src="${esc(d.clinic.logoUrl)}" alt=""><div class="clinic"><b>${esc(d.clinic.name)}</b><span>${esc(d.clinic.address)}</span><span>${esc(d.clinic.contacts)}</span>${d.clinic.licences ? `<span>${esc(d.clinic.licences)}</span>` : ''}</div>
<div class="doc"><b>${esc(title)}</b>${one ? `<span>${esc(l.visitOf(d.visits[0]?.date ?? formatDate(now)))}</span>` : `<span>${esc(l.visitsCount(d.visits.length))}</span>`}<span>${esc(l.produced)} ${esc(`${formatDate(now)} ${formatTime(now)}`)}</span></div></header>
<div class="patient">
  <div class="wide"><i>${esc(l.patient)}</i><b>${esc(d.patient.name)}</b></div>
  <div><i>${esc(l.file)}</i>${esc(d.patient.fileNumber)}</div>
  <div><i>${esc(l.ageSex)}</i>${esc(d.patient.ageSex)}</div>
  ${d.patient.phone === undefined ? '' : `<div><i>${esc(l.phone)}</i>${esc(d.patient.phone || '—')}</div>`}
  <div><i>${esc(l.bloodGroup)}</i>${esc(d.patient.bloodGroup || '—')}</div>
  <div class="wide"><i>${esc(l.allergies)}</i>${d.patient.allergies ? `<span class="allergy">${esc(d.patient.allergies)}</span>` : esc(l.none)}</div>
</div>
${d.visits.map((v) => visitBlock(v, l, one)).join('')}
${d.comment ? `<div class="comment"><h4>${esc(l.comment)}</h4>${esc(d.comment).replace(/\n/g, '<br>')}</div>` : ''}
<div class="sign"><div class="who"><span>${esc(l.author)}</span><b>${esc(d.author.name)}</b><span>${esc(d.author.title)}</span><div class="line">${esc(l.signature)}</div></div><div class="stamp">${esc(l.stamp)}</div></div>
<footer>${esc(l.confidential)}<br>${esc(d.clinic.name)} · ${esc(d.clinic.contacts)}</footer>
</div><script>window.addEventListener('load', () => setTimeout(() => window.print(), 400))</script></body></html>`
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.open()
  w.document.write(html)
  w.document.close()
  return true
}

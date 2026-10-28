import i18next from 'i18next'
import { resources } from '@mmc/shared/i18n'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  chipHtml,
  documentHtml,
  footerLines,
  keyFiguresHtml,
  makeDocLabels,
  tableHtml,
  titleBlockHtml,
  type DocLabels,
  type Letterhead,
  type TFn,
} from './doc-style'
import { buildMedicalReportHtml, type MedicalReportLabels } from './medical-report'
import { buildPrescriptionHtml, type RxDoc } from './prescription-doc'
import { buildReceiptHtml, receiptSums, receiptText, type ReceiptDoc } from './receipt-doc'
import { buildWorkbook, reportHtml, type Report } from './report'

/** The app's English wording, through a separate i18next instance (no React). */
let t: TFn
let dl: DocLabels
beforeAll(async () => {
  const i = i18next.createInstance()
  await i.init({ lng: 'en', resources, interpolation: { escapeValue: false } })
  t = (key, vars) => i.t(key, vars ?? {}) as string
  dl = makeDocLabels(t)
})

const lh: Letterhead = {
  legalName: 'Muhazi Medical Clinic Ltd',
  addressLine: 'Kiramuruzi, Gatsibo District, Eastern Province, Rwanda',
  phone: '+250 788 300 400',
  email: 'info@example.rw',
  tin: '108765432',
  mohLicence: 'MOH/PC/0123',
  fdaLicence: null,
  poBox: null,
  logoUrl: 'http://localhost/logo.jpg',
  openingHours: null,
}
const fonts = { latin: 'http://localhost/a.woff2', latinExt: 'http://localhost/b.woff2' }
const at = new Date('2026-10-24T12:35:00Z')

describe('document standard v2', () => {
  it('prints the footer on every page: clinic, number, page x of y, printed by', () => {
    const html = documentHtml({
      base: {
        page: 'a4',
        title: 'Medical report',
        docNo: 'MR-V-1',
        clinicName: lh.legalName,
        printedBy: 'Dr. A',
        printedAt: at,
        labels: dl,
        fonts,
      },
      body: '<p>x</p>',
      autoPrint: false,
    })
    expect(html).toContain('@bottom-left')
    expect(html).toMatch(
      /@bottom-right \{ content: "Page " counter\(page\) " of " counter\(pages\)/,
    )
    expect(html).toContain('"Muhazi Medical Clinic Ltd  ·  MR-V-1"')
    expect(html).toContain('Printed 24/10/2026 14:35 by Dr. A')
    // the fallback for browsers without page margin boxes carries the same lines
    expect(html).toMatch(/class="printed-fallback">Muhazi Medical Clinic Ltd {2}· {2}MR-V-1/)
    expect(html).toContain('print-color-adjust: exact')
  })

  it('adds the confidentiality note to a medical footer, none on thermal pages', () => {
    const [line] = footerLines({ clinicName: 'C', docNo: 'N', medical: true, labels: dl })
    expect(line).toBe(`C  ·  N  ·  ${dl.confidential}`)
    const receipt = documentHtml({
      base: { page: 'receipt', title: 'R', clinicName: 'C', labels: dl, fonts },
      body: '',
      autoPrint: false,
    })
    expect(receipt).not.toContain('@bottom-left')
    expect(receipt).not.toContain('printed-fallback">')
  })

  it('lays the title meta out as a label | value box and leaves empty values out', () => {
    const html = titleBlockHtml({
      title: 'T',
      meta: [
        ['No.', 'X-1'],
        ['Empty', null],
      ],
      badges: chipHtml('Paid', 'ok'),
    })
    expect(html).toContain('<dl class="tb-meta"><dt>No.</dt><dd>X-1</dd></dl>')
    expect(html).not.toContain('Empty')
    expect(html).toContain('<span class="chip ok">Paid</span>')
  })

  it('draws key figures as tinted tiles, in rows of 3 beyond 4 tiles', () => {
    const html = keyFiguresHtml(['a', 'b', 'c', 'd', 'e'].map((label) => ({ label, value: '1' })))
    expect(html).toContain('--kf-cols:3')
    expect(html.match(/class="tile /g)).toHaveLength(5)
    expect(html).toContain('class="tile teal"')
    expect(html).toContain('class="tile navy"')
  })

  it('escapes chip text and right-aligns numbers with an emphasised total', () => {
    expect(chipHtml('<b>', 'alert')).toBe('<span class="chip alert">&lt;b&gt;</span>')
    const html = tableHtml([{ label: 'Item' }, { label: 'Amount', money: true }], [['x', 1200]], {
      totals: [{ cells: ['Total', 1200], grand: true }],
    })
    expect(html).toContain('<td class="num">1,200</td>')
    expect(html).toContain('<tr class="total grand">')
  })
})

const rx = (over: Partial<RxDoc> = {}): RxDoc => ({
  number: 'RX-2026-000321',
  date: new Date('2026-10-24T09:30:00Z'),
  clinic: lh,
  patient: { name: 'Uwimana Josiane', fileNumber: 'MMC-1', birthDate: '1995-03-14', sex: 'female' },
  diagnosis: { text: 'Malaria', icd10: 'B50.9' },
  medicines: [
    {
      name: 'Amoxicillin 500 mg capsule',
      quantity: 15,
      dose: '1 capsule',
      route: 'oral',
      frequency: 'TDS',
      days: 5,
      instructions: null,
    },
  ],
  givenHere: [
    {
      name: 'Paracetamol 500 mg tablet',
      quantity: 2,
      dose: '2 tablets',
      route: 'oral',
      frequency: 'STAT',
      days: null,
      instructions: null,
    },
  ],
  prescriber: { name: 'Dr. B', title: 'Medical doctor', registrationNo: 'RMDC/1' },
  printedBy: 'Dr. B',
  ...over,
})

describe('prescription', () => {
  it('prints the validity, the quantity in words and never a medicine given here', () => {
    const html = buildPrescriptionHtml(
      rx(),
      { t, lang: 'en' },
      { autoPrint: false, printedAt: at, fonts },
    )
    expect(html).toContain('<dt>Valid until</dt><dd>31/10/2026</dd>')
    expect(html).toContain('Valid for 7 days from date of issue')
    expect(html).toContain('(fifteen)')
    expect(html).not.toContain('Paracetamol')
    expect(html).toContain('"Muhazi Medical Clinic Ltd  ·  RX-2026-000321"')
  })

  it('outside version: only the outside lines, its own title and note', () => {
    const html = buildPrescriptionHtml(
      rx({
        outside: true,
        medicines: [
          {
            name: 'Ceftriaxone 1 g injection',
            quantity: 5,
            dose: '1 g',
            route: 'IV',
            frequency: 'OD',
            days: 5,
            instructions: null,
          },
        ],
        givenHere: [],
      }),
      { t, lang: 'en' },
      { autoPrint: false, printedAt: at, fonts },
    )
    expect(html).toContain(t('rxDoc.outsideTitle'))
    expect(html).toContain(t('rxDoc.outsideNote'))
    expect(html).toContain('Ceftriaxone')
    expect(html).not.toContain('Amoxicillin')
    expect(html).not.toContain('Paracetamol')
    expect(html.match(/<span class="rx-n">/g)).toHaveLength(1)
  })
})

const receipt = (over: Partial<ReceiptDoc> = {}): ReceiptDoc => ({
  receiptNo: 'RCT-1',
  invoiceNo: 'INV-1',
  visitNo: 'V-2026-1',
  at,
  clinic: { name: lh.legalName, address: '', contacts: '', ...lh },
  patient: { name: 'P', fileNumber: 'F-1', insurer: 'RSSB', memberNo: 'M-1' },
  lines: [
    { description: 'Consultation', quantity: 1, unitPrice: 14100, fullAmount: 14100, amount: 1410 },
  ],
  total: 1410,
  subtotal: 14100,
  insurer: { name: 'RSSB', amount: 12690, pct: 90 },
  payment: { method: 'momo', amount: 1000, reference: 'MP1' },
  paid: 1000,
  balance: 410,
  cashier: 'C',
  ...over,
})

describe('receipt', () => {
  it('splits the bill: insurer share + patient share = subtotal', () => {
    const s = receiptSums(receipt())
    expect(s.insurer + s.patient).toBe(s.subtotal)
    expect(s.insurerPct).toBe(90)
    expect(s.patientPct).toBe(10)
    expect(s.totalDue).toBe(1410)
    // the percentage is worked out when the caller does not give it
    expect(receiptSums(receipt({ insurer: { name: 'X', amount: 11280 } })).insurerPct).toBe(80)
    // no insurer: the patient pays everything
    const cash = receiptSums({ total: 5000, insurer: null })
    expect(cash).toMatchObject({ subtotal: 5000, insurer: 0, patient: 5000, totalDue: 5000 })
  })

  it('prints the visit no., method, reference, balance and a PART PAID chip', () => {
    const html = buildReceiptHtml(receipt(), receiptText(t), dl, {
      autoPrint: false,
      printedAt: at,
    })
    expect(html).toContain('V-2026-1')
    expect(html).toContain('MP1')
    expect(html).toContain('RWF 410')
    expect(html).toContain('<span class="chip warn">PART PAID</span>')
    const paid = buildReceiptHtml(receipt({ paid: 1410, balance: 0 }), receiptText(t), dl, {
      autoPrint: false,
    })
    expect(paid).toContain(`<span class="chip ok">${t('receipt.settled')}</span>`)
  })
})

describe('result report', () => {
  const labels = {
    conclusion: 'Conclusion',
    title: 'Medical report',
    titleHistory: 'History',
  } as MedicalReportLabels
  it('flags results with a chip and the word, and says who validated', () => {
    const html = buildMedicalReportHtml(
      {
        kind: 'visit',
        title: 'Laboratory result report',
        clinic: { name: lh.legalName, address: '', contacts: '', ...lh },
        patient: { name: 'P', fileNumber: 'F-1', ageSex: '' },
        visits: [
          {
            date: '24/10/2026',
            vitals: [],
            notes: [],
            diagnoses: [],
            treatments: [],
            medicines: [],
            tests: [
              {
                name: 'Hb',
                value: '9.8',
                unit: 'g/dL',
                range: '12–16',
                flag: 'L',
                verified: true,
                findings: null,
                impression: null,
              },
              {
                name: 'Glucose',
                value: '2.1',
                unit: 'mmol/L',
                range: '3.9–7.8',
                flag: 'CRIT',
                verified: true,
                findings: null,
                impression: null,
              },
            ],
          },
        ],
        author: { name: 'Lab tech', title: 'Technician' },
        lab: { validatedBy: { name: 'Validator' }, validatedAt: '2026-10-24T09:05:00Z' },
      },
      labels,
      { t, now: at, autoPrint: false, fonts },
    )
    expect(html).toContain(
      '<span class="chip info">L</span></strong> <span class="flag-txt">Low</span>',
    )
    expect(html).toContain('<span class="chip alert">CRIT</span>')
    expect(html).toContain('VALIDATED – 24/10/2026 11:05 by Validator')
    expect(html).toContain('<span class="chip ok">Validated</span>')
  })
})

describe('management report', () => {
  const report = (): Report => ({
    title: 'Cashier day close',
    period: '24/10/2026',
    clinic: { name: lh.legalName } as Report['clinic'],
    producedBy: 'C',
    code: 'DAY',
    periodKey: '20261024',
    fileName: 'day-close',
    figures: [{ label: 'Collected', value: 1000, unit: 'RWF' }],
    notes: { title: 'How the figures are counted', lines: ['All amounts are in RWF.'] },
    sections: [
      {
        name: 'day',
        tables: [
          {
            title: 'Collections',
            columns: [{ label: 'Method' }, { label: 'Amount', kind: 'money' }],
            rows: [
              ['Cash', 600],
              ['MoMo', 400],
            ],
            totals: [1],
          },
        ],
      },
    ],
    doc: dl,
    words: {
      reportNo: 'Report no.',
      printed: 'Printed',
      preparedBy: 'Prepared by',
      checkedBy: 'Checked by',
      period: 'Period',
      total: 'Total',
      summarySheet: 'Summary',
      figure: 'Key figure',
      value: 'Value',
      unit: 'Unit',
    },
    letterhead: lh,
    printedAt: at,
  })

  it('prints the key figures as tiles and the notes on how figures are counted', () => {
    const html = reportHtml(report(), { autoPrint: false })
    expect(html).toContain('class="tile teal"')
    expect(html).toContain('RWF 1,000')
    expect(html).toContain('<div class="rp-notes-h">How the figures are counted</div>')
    expect(html).toContain('<tr class="total grand">')
  })

  it('styles the Excel sheets: navy band, tinted bold header, frozen, SUM total on a tint', async () => {
    const wb = await buildWorkbook(report())
    const ws = wb.getWorksheet('Collections')!
    expect(ws.getCell(5, 1).fill).toMatchObject({ fgColor: { argb: 'FF1B3A75' } })
    const head = ws.getCell(6, 1)
    expect(head.value).toBe('Method')
    expect(head.font?.bold).toBe(true)
    expect(head.fill).toMatchObject({ fgColor: { argb: 'FFE4ECF5' } })
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 6 })
    const total = ws.getCell(9, 2)
    expect(total.value).toMatchObject({ formula: 'SUM(B7:B8)', result: 1000 })
    expect(total.fill).toMatchObject({ fgColor: { argb: 'FFE6F1F5' } })
    expect(ws.headerFooter.oddFooter).toContain('Page &P of &N')
    const summary = wb.getWorksheet('Summary')!
    const texts = summary.getColumn(1).values.map(String)
    expect(texts).toContain('How the figures are counted')
  })
})

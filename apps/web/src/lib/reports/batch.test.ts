import i18next from 'i18next'
import { resources } from '@mmc/shared/i18n'
import { beforeAll, describe, expect, it } from 'vitest'
import type { VisitDocument } from '@/lib/api/analytics-documents'
import type { ReceiptRow } from '@/lib/api/analytics-receipts'
import type { TFn } from '@/lib/doc-style'
import type { MedicalReportLabels } from '@/lib/medical-report'
import { reportsBatchHtml } from './documents-print'
import { receiptsBatchHtml } from './receipts-print'

/** The app's English wording, through a separate i18next instance (no React). */
let t: TFn
beforeAll(async () => {
  const i = i18next.createInstance()
  await i.init({ lng: 'en', resources, interpolation: { escapeValue: false } })
  t = (key, vars) => i.t(key, vars ?? {}) as string
})

const clinic = {
  legalName: 'Muhazi Medical Clinic Ltd',
  name: 'Muhazi Medical Clinic Ltd',
  address: 'Kiramuruzi',
  contacts: '',
  licences: '',
  addressLine: 'Kiramuruzi, Gatsibo District',
  phone: '+250 788 300 400',
  email: null,
  tin: null,
  mohLicence: null,
  fdaLicence: null,
  poBox: null,
  logoUrl: 'http://localhost/logo.jpg',
  openingHours: null,
}
const now = new Date('2026-10-24T12:35:00Z')

const receipt = (n: number, method: string, amount: number): ReceiptRow => ({
  id: `pay-${n}`,
  receiptNo: `RCT-2026-00000${n}`,
  invoiceNo: `INV-2026-00000${n}`,
  visitNo: `V-2026-00012${n}`,
  encounterId: `e-${n}`,
  counterSaleId: null,
  at: `2026-10-24T0${7 + n}:1${n}:00Z`,
  method,
  amount,
  reference: method === 'cash' ? null : `MP${n}`,
  cashierId: 'u-cash',
  cashier: 'Mugisha Samuel',
  counted: false,
  patient: { name: `Patient ${n}`, fileNumber: `MMC-00010${n}`, insurer: null, memberNo: null },
  lines: [
    { description: 'Consultation', quantity: 1, unitPrice: amount, fullAmount: amount, amount },
  ],
  subtotal: amount,
  total: amount,
  insurerAmount: 0,
  insurerPct: null,
  paid: amount,
  balance: 0,
})

describe('receipts of a period in one document', () => {
  it('prints a cover line with the count and the total, then one receipt per page', () => {
    const rows = [receipt(1, 'cash', 5000), receipt(2, 'momo', 7000), receipt(3, 'cash', 3000)]
    const html = receiptsBatchHtml(
      { rows, from: '2026-10-24', to: '2026-10-24', clinic, printedBy: 'Mugabo Théogène' },
      t,
      { autoPrint: false, now },
    )
    expect(html).toContain('3 receipts · RWF 15,000 · 24/10/2026 · printed by Mugabo Théogène')
    expect(html.match(/<section class="r-copy">/g)).toHaveLength(3)
    expect(html).toContain('break-before: page')
    // each copy is the cash desk's receipt: its number, the title between rules, the sums
    expect(html).toContain('RCT-2026-000002')
    expect(html.match(/class="r-title"/g)).toHaveLength(3)
    expect(html).toContain('1 / 3')
    // the cover lists every receipt with its method in words
    expect(html).toContain('MTN MoMo')
    expect(html).toContain('<section class="r-cover">')
  })
  it('says the cashier and the method on the cover when filtered', () => {
    const html = receiptsBatchHtml(
      {
        rows: [receipt(1, 'momo', 5000)],
        from: '2026-10-01',
        to: '2026-10-24',
        clinic,
        printedBy: 'X',
        cashier: 'Mugisha Samuel',
        method: 'momo',
      },
      t,
      { autoPrint: false, now },
    )
    expect(html).toContain('01/10/2026 to 24/10/2026')
    expect(html).toContain('<dt>Cashier</dt><dd>Mugisha Samuel</dd>')
    expect(html).toContain('<dt>Method</dt><dd>MTN MoMo</dd>')
  })
})

const visit = (n: number, priv = false): VisitDocument => ({
  id: `e-${n}`,
  private: priv,
  patient: { id: `p-${n}`, name: `Patient ${n}`, fileNumber: `MMC-00010${n}` },
  clinical: {
    diagnoses: priv
      ? []
      : [
          {
            id: `dx-${n}`,
            text: 'Malaria',
            icd10: 'B54',
            type: 'primary',
            provisional: false,
            at: '2026-10-24T08:00:00Z',
            by: 'Dr. Mukamana Béatrice',
          },
        ],
    notes: priv
      ? []
      : [
          {
            id: `n-${n}`,
            text: 'Fever for two days.',
            at: '2026-10-24T08:05:00Z',
            by: 'Dr. Mukamana Béatrice',
          },
        ],
    prescriptions: [],
    orders: [],
    patient: {
      id: `p-${n}`,
      allergies: null,
      bloodGroup: null,
      notes: null,
      flags: {},
      birthDate: '1995-03-12',
      sex: 'female',
      phone: null,
      allergiesNone: true,
      insurer: null,
      memberNo: null,
      coveragePct: null,
      weightKg: null,
      weightAt: null,
    },
    visit: {
      id: `e-${n}`,
      reference: `V-2026-00012${n}`,
      at: '2026-10-24T07:30:00Z',
      status: 'closed',
      closedAt: '2026-10-24T09:00:00Z',
      service: 'consultation',
      department: 'Consultation',
      referredBy: null,
    },
    private: priv,
    view: priv ? null : 'manager',
  },
  vitals: [
    {
      code: 'temp',
      label: null,
      value: 38.2,
      text: null,
      unit: '°C',
      at: '2026-10-24T07:40:00Z',
      by: 'Nurse',
    },
  ],
  charges: [{ description: 'Consultation', quantity: 1 }],
})

describe('the medical reports of a period in one document', () => {
  const labels = {
    title: 'Medical report',
    titleHistory: 'Medical history',
    conclusion: 'Conclusion',
  } as MedicalReportLabels
  it('prints a cover listing every report, then each report on its own page', () => {
    const html = reportsBatchHtml(
      {
        docs: [visit(1), visit(2)],
        from: '2026-10-24',
        to: '2026-10-24',
        clinic,
        labels,
        author: { name: 'Mugabo Théogène', title: 'Manager' },
        printedBy: 'Mugabo Théogène',
        filters: [['Department', 'Consultation']],
      },
      t,
      { autoPrint: false, now },
    )
    expect(html).toContain('2 medical reports · 24/10/2026 · printed by Mugabo Théogène')
    expect(html).toContain('<dt>Department</dt><dd>Consultation</dd>')
    expect(html.match(/<section class="mr-copy">/g)).toHaveLength(2)
    expect(html).toContain('MR-V-2026-000121')
    expect(html).toContain('MR-V-2026-000122')
    expect(html).toContain('Malaria')
    expect(html).toContain('Patient 2')
  })
  it('leaves private records out and says how many', () => {
    const html = reportsBatchHtml(
      {
        docs: [visit(1), visit(2, true)],
        from: '2026-10-24',
        to: '2026-10-24',
        clinic,
        labels,
        author: { name: 'M', title: 'Manager' },
        printedBy: 'M',
        filters: [],
      },
      t,
      { autoPrint: false, now },
    )
    expect(html.match(/<section class="mr-copy">/g)).toHaveLength(1)
    expect(html).toContain('1 visits are not printed: their records are private.')
  })
})

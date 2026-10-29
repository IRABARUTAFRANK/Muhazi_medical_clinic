import { kigaliToday } from '@/lib/clock'
import type {
  BillRow,
  CashCountRow,
  ChargeRow,
  ClaimRow,
  CounterSaleRow,
  DebtRow,
  PaymentRow,
  RefundRow,
} from './reports-finance'
import { SAMPLE_OPENED } from './analytics-sample'
import { SAMPLE_CHOICES } from './reports-options'

/**
 * Sample mode of the finance reports: the clinic's days generated from a seeded random, so every
 * report agrees with the others (a bill's payments are the revenue report's rows, its unpaid
 * part is on the unpaid bills, the cash counts add up the payments of the day…) and stays the
 * same from one run to the next. At most the last 92 days of a period are generated.
 */

// ------------------------------------------------------------------ seeded randomness

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
function rng(seed: string): () => number {
  let a = hash(seed)
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T>(xs: readonly T[], r: () => number): T =>
  xs[Math.min(xs.length - 1, Math.floor(r() * xs.length))]!
const between = (lo: number, hi: number, r: () => number) => lo + Math.floor(r() * (hi - lo + 1))

// ------------------------------------------------------------------ days and times

const DAY_MS = 86_400_000
const toDay = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
const fromDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const shift = (iso: string, n: number) => fromDay(toDay(iso) + n * DAY_MS)
/** Kigali wall clock: "2026-10-28T09:05:00+02:00". */
const at = (day: string, minutes: number) => {
  const m = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)))
  return `${day}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00+02:00`
}
const nowMinutes = () => {
  const k = new Date(Date.now() + 2 * 3_600_000)
  return k.getUTCHours() * 60 + k.getUTCMinutes()
}
const weekday = (iso: string) => new Date(toDay(iso)).getUTCDay()

/** The days to generate: the period, from the clinic's opening, at most 92 days, up to today. */
function daysOf(from: string, to: string, before = 0): string[] {
  const today = kigaliToday()
  let a = from < to ? from : to
  let b = from < to ? to : from
  if (b > today) b = today
  if (toDay(b) - toDay(a) > 91 * DAY_MS) a = shift(b, -91)
  a = shift(a, -before)
  if (a < SAMPLE_OPENED) a = SAMPLE_OPENED
  const out: string[] = []
  for (let d = a; d <= b; d = shift(d, 1)) out.push(d)
  return out
}
const inPeriod = (iso: string | null | undefined, from: string, to: string) =>
  !!iso &&
  iso.slice(0, 10) >= (from < to ? from : to) &&
  iso.slice(0, 10) <= (from < to ? to : from)

// ------------------------------------------------------------------ the clinic

const CASHIERS = [
  { id: 'u-cash', name: 'Mugisha Samuel' },
  { id: 'p-cash2', name: 'Iradukunda Grace' },
]
const PHARMACIST = { id: 'p-pha', name: 'Mutoni Aline' }
const INSURERS = [
  { id: 'payer-rama', name: 'RSSB RAMA', pct: 85 },
  { id: 'payer-mmi', name: 'MMI', pct: 85 },
  { id: 'payer-mutuelle', name: 'Mutuelle de Santé', pct: 90 },
]
const PATIENTS = [
  'Uwase Marie Claire',
  'Habimana Jean Bosco',
  'Mukandayisenga Odette',
  'Niyonzima Jean Baptiste',
  'Ishimwe Aline',
  'Nshimiyimana Eric',
  'Mukamana Alice',
  'Hakizimana Emmanuel',
  'Uwimana Claudine',
  'Bizimana Innocent',
  'Ingabire Solange',
  'Mugisha Patrick',
  'Nyiramana Vestine',
  'Twagirayezu Fabrice',
  'Umutoni Gisele',
  'Ndayishimiye Olivier',
  'Mukeshimana Jeanne',
  'Rukundo Didier',
  'Uwamahoro Diane',
  'Kamanzi Yves',
].map((name, i) => ({
  id: `pt-${i}`,
  name,
  file: `MMC-${String(100 + i * 37).padStart(6, '0')}`,
  phone: `078${String(8_100_000 + i * 13_579).slice(0, 7)}`,
}))
const BUYERS = ['Nsengimana Jean', 'Mukarugwiza Jeanne', 'Tuyisenge Eric', 'Uwera Sandrine', null]

interface SampleService {
  code: string
  name: string
  price: number
  cat: string
  dep: string
  depName: string
  desk: string
  by: string
}
const S = (
  code: string,
  name: string,
  price: number,
  catKey: string,
  dep: string,
  depName: string,
  desk: string,
  by: string,
): SampleService => ({ code, name, price, cat: catKey, dep, depName, desk, by })
const OPD = ['dep-opd', 'Outpatient (OPD)'] as const
const LAB = ['dep-lab', 'Laboratory and imaging'] as const
const DEN = ['dep-dental', 'Dental'] as const
const SUR = ['dep-theatre', 'Minor surgery'] as const
const CONSULT = S(
  'CON-001',
  'General consultation',
  5000,
  'consultation',
  ...OPD,
  'consultation',
  'Uwimana Josiane',
)
const DENTAL_CONSULT = S(
  'DEN-001',
  'Dental consultation',
  5000,
  'dental',
  ...DEN,
  'dental',
  'Uwimana Josiane',
)
const EXTRACTION = S(
  'DEN-010',
  'Tooth extraction',
  10000,
  'dental',
  ...DEN,
  'dental',
  'Dr. Ndayisaba Félix',
)
const TESTS = [
  S('LAB-001', 'Malaria rapid test', 1500, 'laboratory', ...LAB, 'laboratory', 'Uwase Clarisse'),
  S('LAB-002', 'Full blood count', 4000, 'laboratory', ...LAB, 'laboratory', 'Uwase Clarisse'),
  S('LAB-003', 'Urinalysis', 2000, 'laboratory', ...LAB, 'laboratory', 'Uwase Clarisse'),
  S('LAB-004', 'Blood glucose', 1500, 'laboratory', ...LAB, 'laboratory', 'Uwase Clarisse'),
]
const ULTRASOUND = S(
  'IMG-001',
  'Abdominal ultrasound',
  15000,
  'imaging',
  ...LAB,
  'ultrasound',
  'Mutesi Ange',
)
const DRESSING = S(
  'NUR-001',
  'Wound dressing',
  3000,
  'nursing',
  ...OPD,
  'nursing',
  'Nyirahabimana Chantal',
)
const SUTURE = S(
  'SUR-001',
  'Minor suture',
  8000,
  'procedure',
  ...SUR,
  'theatre',
  'Dr. Niyonsenga Patrick',
)
const MEDICINES = [
  { code: 'MED-AMX5', name: 'Amoxicillin 500 mg capsule', price: 150, qty: 15, kind: 'medicine' },
  { code: 'MED-PCM5', name: 'Paracetamol 500 mg tablet', price: 50, qty: 10, kind: 'medicine' },
  { code: 'MED-ORS', name: 'Oral rehydration salts sachet', price: 300, qty: 2, kind: 'medicine' },
  { code: 'MED-MTZ2', name: 'Metronidazole 250 mg tablet', price: 60, qty: 21, kind: 'medicine' },
  { code: 'MED-IBU4', name: 'Ibuprofen 400 mg tablet', price: 80, qty: 10, kind: 'medicine' },
  { code: 'SUP-GAU', name: 'Sterile gauze pack', price: 500, qty: 1, kind: 'supply' },
] as const
const PHARMACY_DEP = ['dep-pharmacy', 'Pharmacy'] as const
const METHODS = [
  'cash',
  'cash',
  'cash',
  'cash',
  'cash',
  'momo',
  'momo',
  'momo',
  'airtel',
  'card',
] as const

// ------------------------------------------------------------------ one day of the clinic

interface SampleDay {
  payments: PaymentRow[]
  charges: ChargeRow[]
  bills: BillRow[]
  debts: DebtRow[]
  refunds: RefundRow[]
  claims: ClaimRow[]
  sales: CounterSaleRow[]
}

const dayCache = new Map<string, SampleDay>()
const year = (day: string) => day.slice(0, 4)
const yymmdd = (day: string) => day.slice(2).replace(/-/g, '')
const serial = (day: string, i: number) => {
  const n = Math.floor((toDay(day) - toDay(`${year(day)}-01-01`)) / DAY_MS) * 40 + i + 1
  return String(n).padStart(6, '0')
}
const cashierAt = (minutes: number) => (minutes < 13 * 60 ? CASHIERS[0]! : CASHIERS[1]!)

function buildDay(day: string): SampleDay {
  const hit = dayCache.get(day)
  if (hit) return hit
  const today = kigaliToday()
  const isToday = day === today
  const now = nowMinutes()
  const r = rng(`fin${day}`)
  const wd = weekday(day)
  const n = wd === 0 ? between(2, 3, r) : wd === 6 ? between(5, 7, r) : between(9, 14, r)
  const out: SampleDay = {
    payments: [],
    charges: [],
    bills: [],
    debts: [],
    refunds: [],
    claims: [],
    sales: [],
  }

  for (let i = 0; i < n; i++) {
    const v = rng(`fin${day}:${i}`)
    const arrive = 7 * 60 + 30 + (i * 600) / n + v() * 25
    if (isToday && arrive > now) break
    const patient = pick(PATIENTS, v)
    const insurer = v() < 0.3 ? pick(INSURERS, v) : null
    const visitNo = `V-${year(day)}-${serial(day, i)}`
    const encounterId = `enc-${day}-${i}`
    const dental = v() < 0.1
    const services: SampleService[] = [dental ? DENTAL_CONSULT : CONSULT]
    if (dental && v() < 0.5) services.push(EXTRACTION)
    if (!dental && v() < 0.5) services.push(pick(TESTS, v))
    if (!dental && v() < 0.15) services.push(pick(TESTS, v))
    if (!dental && v() < 0.08) services.push(ULTRASOUND)
    if (!dental && v() < 0.12) services.push(DRESSING)
    if (!dental && v() < 0.04) services.push(SUTURE)
    const meds = v() < 0.7 ? between(1, 3, v) : 0
    // a visit of today that began less than two hours ago is still open
    const open = isToday && now - arrive < 120
    const left = !open && v() < 0.015
    const posted = open ? null : at(day, arrive + 60 + v() * 60)
    const billNo = open ? null : `INV-${year(day)}-${serial(day, i)}`
    const billId = `bill-${day}-${i}`
    const lines: ChargeRow[] = []
    const addLine = (o: {
      description: string
      code: string
      catKey: string
      dep: readonly [string, string]
      desk: string | null
      quantity: number
      unitPrice: number
      by: string
      minutes: number
      itemId?: string
    }) => {
      const total = Math.round(o.unitPrice * o.quantity)
      const insurerShare = insurer ? Math.round((total * insurer.pct) / 100) : 0
      const c = SAMPLE_CHOICES.categories.find((x) => x.key === o.catKey)
      lines.push({
        id: `${billId}-l${lines.length}`,
        source: 'bill',
        at: posted ?? at(day, o.minutes),
        chargedAt: at(day, o.minutes),
        billNo,
        billStatus: open ? 'draft' : 'posted',
        visitNo,
        encounterId,
        patient: patient.name,
        fileNumber: patient.file,
        description: o.description,
        serviceId: o.itemId ? null : o.code,
        itemId: o.itemId ?? null,
        code: o.code,
        categoryId: c?.id ?? null,
        categoryKey: o.catKey,
        categoryEn: c?.nameEn ?? null,
        categoryKin: c?.nameKin ?? null,
        categoryFr: c?.nameFr ?? null,
        departmentId: o.dep[0],
        department: o.dep[1],
        desk: o.desk,
        store: null,
        quantity: o.quantity,
        packSize: null,
        units: o.quantity,
        unitPrice: o.unitPrice,
        listPrice: o.unitPrice,
        discount: 0,
        discountPct: null,
        discountReason: null,
        total,
        insurerShare,
        patientShare: total - insurerShare,
        insurerId: insurer?.id ?? null,
        insurer: insurer?.name ?? null,
        enteredById: null,
        enteredBy: o.by,
      })
    }
    services.forEach((s, k) =>
      addLine({
        description: s.name,
        code: s.code,
        catKey: s.cat,
        dep: [s.dep, s.depName],
        desk: s.desk,
        quantity: 1,
        unitPrice: s.price,
        by: s.by,
        minutes: arrive + 5 + k * 20,
      }),
    )
    for (let k = 0; k < meds; k++) {
      const m = MEDICINES[(i + k * 2) % MEDICINES.length]!
      addLine({
        description: m.name,
        code: m.code,
        catKey: m.kind,
        dep: PHARMACY_DEP,
        desk: 'pharmacy',
        quantity: m.qty,
        unitPrice: m.price,
        by: PHARMACIST.name,
        minutes: arrive + 50 + k,
        itemId: m.code,
      })
    }
    // a staff discount now and then (list price above the price charged)
    if (lines.length > 1 && v() < 0.05) {
      const l = lines[0]!
      l.listPrice = l.unitPrice
      l.unitPrice = Math.round(l.unitPrice * 0.5)
      l.total = l.unitPrice
      l.discount = l.listPrice - l.unitPrice
      l.discountPct = 50
      l.discountReason = 'Staff family'
      l.insurerShare = insurer ? Math.round((l.total * insurer.pct) / 100) : 0
      l.patientShare = l.total - l.insurerShare
    }
    out.charges.push(...lines)
    const total = lines.reduce((s, l) => s + l.total, 0)
    const insurerShare = lines.reduce((s, l) => s + l.insurerShare, 0)
    const patientShare = total - insurerShare

    // the patient's payments: in full (most), part, nothing, or later (a debt paid days after)
    const roll = v()
    const payMin = arrive + 70 + v() * 50
    const plan: { amount: number; day: string; minutes: number; kind: 'visit' | 'debt' }[] = []
    if (open) {
      if (v() < 0.5)
        plan.push({ amount: patientShare, day, minutes: Math.min(now, payMin), kind: 'visit' })
    } else if (left) {
      // left without paying
    } else if (roll < 0.9) plan.push({ amount: patientShare, day, minutes: payMin, kind: 'visit' })
    else if (roll < 0.93) {
      const part = Math.max(100, Math.round((patientShare * 0.5) / 100) * 100)
      plan.push({ amount: Math.min(part, patientShare), day, minutes: payMin, kind: 'visit' })
    } else if (roll < 0.97) {
      plan.push({
        amount: patientShare,
        day: shift(day, between(2, 9, v)),
        minutes: 9 * 60 + v() * 420,
        kind: 'debt',
      })
    }
    let paid = 0
    plan.forEach((p, k) => {
      if (p.amount <= 0 || p.day > today) return
      if (p.day === today && p.minutes > now) return
      const method = insurer && v() < 0.2 ? 'momo' : pick(METHODS, v)
      const cashier = cashierAt(p.minutes)
      paid += p.amount
      out.payments.push({
        id: `pay-${day}-${i}-${k}`,
        at: at(p.day, p.minutes),
        receiptNo: `RCT-${year(p.day)}-${serial(day, i)}`,
        billNo: billNo ?? null,
        visitNo,
        encounterId,
        counterSaleId: null,
        patient: patient.name,
        fileNumber: patient.file,
        kind: p.kind,
        method,
        reference:
          method === 'cash'
            ? null
            : `${method === 'card' ? 'POS' : 'MP'}${hash(`${day}${i}`) % 10_000_000}`,
        amount: p.amount,
        refunded: 0,
        net: p.amount,
        cashierId: cashier.id,
        cashier: cashier.name,
        insurerId: insurer?.id ?? null,
        insurer: insurer?.name ?? null,
        store: null,
        counted: p.day < today,
      })
    })
    // a test not done: its patient share given back
    let refunded = 0
    const paidRow = out.payments.find((x) => x.encounterId === encounterId && x.kind === 'visit')
    const test = lines.find((l) => l.categoryKey === 'laboratory')
    if (paidRow && test && paidRow.amount === patientShare && v() < 0.12) {
      refunded = test.patientShare
      const m = Number(paidRow.at.slice(11, 13)) * 60 + Number(paidRow.at.slice(14, 16)) + 45
      if (!(isToday && m > now)) {
        paidRow.refunded = refunded
        paidRow.net = paidRow.amount - refunded
        out.refunds.push({
          id: `ref-${day}-${i}`,
          at: at(day, m),
          amount: refunded,
          method: paidRow.method,
          reference: paidRow.reference,
          reason: 'Test not done: reagent out of stock',
          patient: patient.name,
          fileNumber: patient.file,
          visitNo,
          encounterId,
          billNo,
          cashierId: paidRow.cashierId,
          cashier: paidRow.cashier,
        })
      } else refunded = 0
    }
    // the test is taken off the bill with a credit note: what was given back is credited
    const due = Math.max(0, patientShare - paid)
    out.bills.push({
      id: billId,
      billNo,
      at: posted ?? at(day, arrive),
      visitAt: at(day, arrive),
      postedAt: posted,
      visitNo,
      encounterId,
      visitOpen: open,
      patient: patient.name,
      fileNumber: patient.file,
      insurerId: insurer?.id ?? null,
      insurer: insurer?.name ?? null,
      memberNo: insurer
        ? `${insurer.name.slice(0, 2).toUpperCase()}${String(hash(patient.id) % 100_000_000).padStart(8, '0')}`
        : null,
      total,
      insurerShare,
      patientShare,
      paid,
      refunded,
      credited: refunded,
      balance: due,
      lines: lines.length,
      status: due <= 0 ? 'paid' : open ? 'open' : paid - refunded > 0 ? 'part' : 'unpaid',
    })
    // unpaid when the visit ended and not paid since (as on the cash desk's "Unpaid bills")
    if (!open && due > 0) {
      const closedAt = at(day, arrive + 150)
      out.debts.push({
        id: encounterId,
        encounterId,
        patientId: patient.id,
        patient: patient.name,
        fileNumber: patient.file,
        phone: patient.phone,
        visitNo,
        visitAt: at(day, arrive),
        closedAt,
        billNo,
        insurerId: insurer?.id ?? null,
        insurer: insurer?.name ?? null,
        total: patientShare,
        paid,
        due,
        days: Math.round((toDay(today) - toDay(day)) / DAY_MS),
        status: left ? 'left' : 'closed',
        reason: left ? 'Left without paying' : null,
        closedBy: pick(CASHIERS, v).name,
      })
    }
    if (insurer && posted) {
      const age = (toDay(today) - toDay(day)) / DAY_MS
      const status =
        age > 45
          ? v() < 0.08
            ? 'rejected'
            : 'paid'
          : age > 20
            ? 'submitted'
            : age > 7
              ? 'batched'
              : 'open'
      out.claims.push({
        id: billId,
        insurerId: insurer.id,
        insurer: insurer.name,
        patient: patient.name,
        fileNumber: patient.file,
        memberNo: out.bills[out.bills.length - 1]!.memberNo,
        visitNo,
        encounterId,
        visitAt: at(day, arrive),
        billNo,
        postedAt: posted,
        billStatus: 'posted',
        total,
        insurerShare,
        patientShare,
        coveragePct: insurer.pct,
        claimed: insurerShare,
        status,
        batchNo:
          status === 'open'
            ? null
            : `${insurer.name.split(' ')[0]!.toUpperCase()}-${day.slice(0, 7)}`,
        rejection: status === 'rejected' ? 'Member number not valid on the visit day' : null,
      })
    }
  }

  // walk-in sales: the pharmacy most days, the dental room store now and then
  const sales = wd === 0 ? between(0, 2, r) : between(2, 5, r)
  for (let k = 0; k < sales + (r() < 0.2 ? 1 : 0); k++) {
    const v = rng(`sale${day}:${k}`)
    const minutes = 8 * 60 + (k * 540) / Math.max(1, sales) + v() * 30
    if (isToday && minutes > now) break
    const room = k >= sales
    const store = room ? SAMPLE_CHOICES.stores[1]! : SAMPLE_CHOICES.stores[0]!
    const items = [pick(MEDICINES, v), ...(v() < 0.4 ? [pick(MEDICINES, v)] : [])]
    const qty = items.map((m) => Math.max(1, Math.round(m.qty / 2)))
    const total = items.reduce((s, m, j) => s + m.price * qty[j]!, 0)
    const recent = isToday && now - minutes < 30
    const roll = v()
    const status = recent
      ? 'open'
      : roll < 0.07
        ? 'cancelled'
        : roll < 0.1 && isToday
          ? 'paid'
          : 'handed_over'
    const paidMin = minutes + 5 + v() * 10
    const takes = room ? cashierAt(paidMin) : PHARMACIST
    const method = v() < 0.7 ? 'cash' : 'momo'
    const number = `S-${yymmdd(day)}-${String(k + 1).padStart(3, '0')}`
    const paidAt = status === 'paid' || status === 'handed_over' ? at(day, paidMin) : null
    const seller = room ? { id: 'u-head', name: 'Dr. Ndayisaba Félix' } : PHARMACIST
    out.sales.push({
      id: `cs-${day}-${k}`,
      number,
      at: at(day, minutes),
      status,
      buyer: pick(BUYERS, v),
      phone: v() < 0.4 ? `0788${String(hash(number) % 1_000_000).padStart(6, '0')}` : null,
      storeId: store.id,
      store: store.name,
      roomStore: store.roomStore,
      total,
      note: null,
      lines: items.length,
      units: qty.reduce((s, q) => s + q, 0),
      items: items.map((m, j) => `${m.name} × ${qty[j]}`).join('; '),
      paidAt,
      method: paidAt ? method : null,
      receiptNo: paidAt ? `RCT-${year(day)}-${serial(day, 30 + k)}` : null,
      reference: paidAt && method === 'momo' ? `MP${hash(number) % 10_000_000}` : null,
      cashierId: paidAt ? takes.id : null,
      cashier: paidAt ? takes.name : null,
      sellerId: seller.id,
      seller: seller.name,
      handedOverAt: status === 'handed_over' ? at(day, paidMin + 3) : null,
      handedOverBy: status === 'handed_over' ? seller.name : null,
      cancelledAt: status === 'cancelled' ? at(day, minutes + 20) : null,
      cancelReason: status === 'cancelled' ? 'The buyer changed their mind' : null,
    })
    items.forEach((m, j) =>
      out.charges.push({
        id: `cs-${day}-${k}-l${j}`,
        source: 'sale',
        at: paidAt ?? at(day, minutes),
        chargedAt: at(day, minutes),
        billNo: number,
        billStatus: status,
        visitNo: null,
        encounterId: null,
        patient: out.sales[out.sales.length - 1]!.buyer,
        fileNumber: null,
        description: m.name,
        serviceId: null,
        itemId: m.code,
        code: m.code,
        categoryId: null,
        categoryKey: m.kind,
        categoryEn: null,
        categoryKin: null,
        categoryFr: null,
        departmentId: room ? DEN[0] : PHARMACY_DEP[0],
        department: room ? DEN[1] : PHARMACY_DEP[1],
        desk: room ? null : 'pharmacy',
        store: store.name,
        quantity: qty[j]!,
        packSize: null,
        units: qty[j]!,
        unitPrice: m.price,
        listPrice: m.price,
        discount: 0,
        discountPct: null,
        discountReason: null,
        total: m.price * qty[j]!,
        insurerShare: 0,
        patientShare: m.price * qty[j]!,
        insurerId: null,
        insurer: null,
        enteredById: seller.id,
        enteredBy: seller.name,
      }),
    )
    if (paidAt)
      out.payments.push({
        id: `pay-${number}`,
        at: paidAt,
        receiptNo: `RCT-${year(day)}-${serial(day, 30 + k)}`,
        billNo: number,
        visitNo: null,
        encounterId: null,
        counterSaleId: `cs-${day}-${k}`,
        patient: out.sales[out.sales.length - 1]!.buyer,
        fileNumber: null,
        kind: room ? 'walkin' : 'pharmacy',
        method,
        reference: out.sales[out.sales.length - 1]!.reference,
        amount: total,
        refunded: 0,
        net: total,
        cashierId: takes.id,
        cashier: takes.name,
        insurerId: null,
        insurer: null,
        store: store.name,
        counted: day < today,
      })
  }
  if (!isToday) dayCache.set(day, out)
  return out
}

/** Every generated day of the period (`before`: also that many days before it). */
const daysFor = (from: string, to: string, before = 0) => daysOf(from, to, before).map(buildDay)

// ------------------------------------------------------------------ the reports' rows

export const samplePayments = (from: string, to: string): PaymentRow[] =>
  daysFor(from, to, 10)
    .flatMap((d) => d.payments)
    .filter((p) => inPeriod(p.at, from, to))
    .sort((a, b) => a.at.localeCompare(b.at))

export const sampleCharges = (from: string, to: string, open: boolean): ChargeRow[] =>
  daysFor(from, to)
    .flatMap((d) => d.charges)
    .filter((c) => inPeriod(c.at, from, to))
    .filter((c) => open || !['draft', 'open', 'cancelled'].includes(c.billStatus ?? ''))
    .filter((c) => c.billStatus !== 'cancelled')
    .sort((a, b) => a.at.localeCompare(b.at))

export const sampleBills = (from: string, to: string): BillRow[] =>
  daysFor(from, to)
    .flatMap((d) => d.bills)
    .filter((b) => inPeriod(b.at, from, to))
    .sort((a, b) => a.at.localeCompare(b.at))

export const sampleDebts = (from: string, to: string): DebtRow[] =>
  daysFor(from, to)
    .flatMap((d) => d.debts)
    .filter((x) => inPeriod(x.visitAt, from, to))
    .sort((a, b) => b.visitAt.localeCompare(a.visitAt))

export const sampleRefunds = (from: string, to: string): RefundRow[] =>
  daysFor(from, to)
    .flatMap((d) => d.refunds)
    .filter((x) => inPeriod(x.at, from, to))
    .sort((a, b) => a.at.localeCompare(b.at))

export const sampleCounterSales = (from: string, to: string): CounterSaleRow[] =>
  daysFor(from, to)
    .flatMap((d) => d.sales)
    .filter((x) => inPeriod(x.at, from, to))
    .sort((a, b) => a.at.localeCompare(b.at))

export const sampleClaims = (from: string, to: string): ClaimRow[] =>
  daysFor(from, to)
    .flatMap((d) => d.claims)
    .filter((x) => inPeriod(x.postedAt, from, to))
    .sort(
      (a, b) =>
        a.insurer.localeCompare(b.insurer) || (a.postedAt ?? '').localeCompare(b.postedAt ?? ''),
    )

/** The day closes: each cashier's payments less refunds per method, counted (a few differ). */
export function sampleCashCounts(from: string, to: string): CashCountRow[] {
  const today = kigaliToday()
  const pays = samplePayments(from, to)
  const refunds = sampleRefunds(from, to)
  const keyOf = (day: string, cashierId: string) => `${day}|${cashierId}`
  const closes = new Map<
    string,
    { day: string; cashierId: string; cashier: string; byMethod: Map<string, number> }
  >()
  const add = (day: string, cashierId: string, cashier: string, method: string, amount: number) => {
    if (day >= today) return
    const k = keyOf(day, cashierId)
    const c = closes.get(k) ?? { day, cashierId, cashier, byMethod: new Map() }
    c.byMethod.set(method, (c.byMethod.get(method) ?? 0) + amount)
    closes.set(k, c)
  }
  for (const p of pays)
    add(p.at.slice(0, 10), p.cashierId ?? '', p.cashier ?? '', p.method, p.amount)
  for (const x of refunds)
    add(x.at.slice(0, 10), x.cashierId ?? '', x.cashier ?? '', x.method, -x.amount)
  const rows: CashCountRow[] = []
  for (const c of [...closes.values()].sort(
    (a, b) => a.day.localeCompare(b.day) || a.cashier.localeCompare(b.cashier),
  )) {
    const v = rng(`close${c.day}${c.cashierId}`)
    const short = v() < 0.12 ? -pick([200, 500, 1000, 1500], v) : v() < 0.05 ? 500 : 0
    let variance = 0
    for (const [method, expected] of [...c.byMethod.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const counted = method === 'cash' ? expected + short : expected
      variance += counted - expected
      rows.push({
        id: `close-${c.day}-${c.cashierId}:${method}`,
        closeId: `close-${c.day}-${c.cashierId}`,
        day: c.day,
        at: at(c.day, 17 * 60 + 40 + v() * 30),
        cashierId: c.cashierId,
        cashier: c.cashier,
        method,
        expected,
        counted,
        difference: counted - expected,
        variance: 0,
        note: method === 'cash' && short < 0 ? 'Change given short at the counter' : null,
      })
    }
    for (const r of rows) if (r.closeId === `close-${c.day}-${c.cashierId}`) r.variance = variance
  }
  return rows
}

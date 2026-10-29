import { useQuery } from '@tanstack/react-query'
import { formatDate } from '@mmc/shared'
import type { MedicalReportDoc, ReportMedicine, ReportVisit } from '@/lib/medical-report'
import type { LetterheadWithLegacy } from '@/lib/report-parts'
import { supabase } from '@/lib/supabase'
import { useSession } from '@/store/session'
import { apiError, isMissingFunction } from './errors'
import { allergiesForDoc, prescriptionState, type VisitClinical } from './patients'

/**
 * Patients' documents of a period (migration 0102): the visits treated between two days with
 * the page's filters (visits_in_period), and what the medical report of each needs
 * (visit_documents). The manager sees the whole clinic or one department; a head of department
 * their department; everyone else is refused (42501, analytics_scope). Each visit is read through
 * visit_clinical(), so the opening of a closed visit is logged as a single opening is (0088).
 * Before 0102: empty lists with `needsUpdate`.
 */

export interface VisitRow {
  id: string
  reference: string | null
  at: string
  closedAt: string | null
  status: 'open' | 'closed' | string
  service: string | null
  patient: { id: string; name: string; fileNumber: string }
  doctor: { id: string; name: string } | null
  department: { id: string; name: string } | null
  diagnosis: string | null
  icd10: string | null
  insurer: string | null
}
export interface VisitsInPeriod {
  needsUpdate: boolean
  from: string
  to: string
  manager: boolean
  department: string | null
  count: number
  closed: number
  open: number
  options: {
    departments: { id: string; name: string }[]
    doctors: { id: string; name: string }[]
    services: string[]
    insurers: { id: string; name: string }[]
  }
  visits: VisitRow[]
}
export interface VisitFilters {
  department?: string | null
  doctor?: string | null
  service?: string | null
  insurer?: string | null
  closedOnly?: boolean
  search?: string | null
}

/** What one visit's report needs (visit_documents). */
export interface VisitDocument {
  id: string
  /** The reader may not see this visit's record (0088): not printed, counted as left out. */
  private: boolean
  patient: { id: string; name: string; fileNumber: string }
  clinical: VisitClinical
  vitals: {
    code: string
    label: string | null
    value: number | null
    text: string | null
    unit: string | null
    at: string
    by: string | null
  }[]
  charges: { description: string; quantity: number }[]
}

type Raw = Record<string, unknown>
const n0 = (v: unknown): number => {
  const x = Number(v ?? 0)
  return Number.isFinite(x) ? x : 0
}
const s0 = (v: unknown): string => (v == null ? '' : String(v))
const sn = (v: unknown): string | null => (v == null ? null : String(v))
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : [])
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {})
const idName = (v: unknown) => {
  const x = obj(v)
  return x.id == null ? null : { id: s0(x.id), name: s0(x.name) }
}

export function toVisitsInPeriod(data: unknown): VisitsInPeriod {
  const d = obj(data)
  const o = obj(d.options)
  return {
    needsUpdate: false,
    from: s0(d.from),
    to: s0(d.to),
    manager: !!d.manager,
    department: sn(d.department),
    count: n0(d.count),
    closed: n0(d.closed),
    open: n0(d.open),
    options: {
      departments: arr(o.departments).map((x) => ({ id: s0(x.id), name: s0(x.name) })),
      doctors: arr(o.doctors).map((x) => ({ id: s0(x.id), name: s0(x.name) })),
      services: Array.isArray(o.services) ? (o.services as unknown[]).map(s0) : [],
      insurers: arr(o.insurers).map((x) => ({ id: s0(x.id), name: s0(x.name) })),
    },
    visits: arr(d.visits).map((x) => {
      const p = obj(x.patient)
      return {
        id: s0(x.id),
        reference: sn(x.reference),
        at: s0(x.at),
        closedAt: sn(x.closedAt),
        status: s0(x.status) || 'open',
        service: sn(x.service),
        patient: { id: s0(p.id), name: s0(p.name), fileNumber: s0(p.fileNumber) },
        doctor: idName(x.doctor),
        department: idName(x.department),
        diagnosis: sn(x.diagnosis),
        icd10: sn(x.icd10),
        insurer: sn(x.insurer),
      }
    }),
  }
}

export const emptyVisitsInPeriod = (
  p: { from: string; to: string },
  needsUpdate = true,
): VisitsInPeriod => ({ ...toVisitsInPeriod({}), needsUpdate, from: p.from, to: p.to })

function toVisitDocument(x: Raw): VisitDocument {
  const p = obj(x.patient)
  const c = obj(x.clinical)
  return {
    id: s0(x.id),
    private: !!x.private || !!c.private,
    patient: { id: s0(p.id), name: s0(p.name), fileNumber: s0(p.fileNumber) },
    clinical: {
      diagnoses: arr(c.diagnoses) as unknown as VisitClinical['diagnoses'],
      notes: arr(c.notes) as unknown as VisitClinical['notes'],
      prescriptions: arr(c.prescriptions).map((r) => ({
        ...r,
        quantity: n0(r.quantity),
      })) as unknown as VisitClinical['prescriptions'],
      orders: arr(c.orders) as unknown as VisitClinical['orders'],
      patient: (c.patient as VisitClinical['patient']) ?? null,
      visit: (c.visit as VisitClinical['visit']) ?? null,
      private: !!c.private,
      view: (c.view as VisitClinical['view']) ?? null,
    },
    vitals: arr(x.vitals).map((v) => ({
      code: s0(v.code),
      label: sn(v.label),
      value: v.value == null ? null : n0(v.value),
      text: sn(v.text),
      unit: sn(v.unit),
      at: s0(v.at),
      by: sn(v.by),
    })),
    charges: arr(x.charges).map((l) => ({
      description: s0(l.description),
      quantity: n0(l.quantity),
    })),
  }
}

// ------------------------------------------------------------------ sample mode

const SAMPLE_DOCTORS = [
  { id: 'u-doc', name: 'Dr. Mukamana Béatrice' },
  { id: 'u-doc2', name: 'Dr. Habimana Jean' },
]
const SAMPLE_DEPTS = [
  { id: 'dep-consult', name: 'Consultation' },
  { id: 'dep-dental', name: 'Dental' },
]
const SAMPLE_PATIENTS = [
  ['p-1', 'Mukamana Alice', 'MMC-000124'],
  ['p-2', 'Rukundo Kevin', 'MMC-000131'],
  ['p-3', 'Uwase Claudine', 'MMC-000132'],
  ['p-4', 'Hakizimana Emmanuel', 'MMC-000133'],
  ['p-5', 'Kayitesi Rose', 'MMC-000135'],
] as const
const SAMPLE_DX = [
  ['Malaria', 'B54'],
  ['Upper respiratory tract infection', 'J06.9'],
  ['Gastroenteritis', 'A09'],
  ['Dental caries', 'K02.9'],
  [null, null],
] as const

function sampleVisits(p: { from: string; to: string }, f: VisitFilters): VisitsInPeriod {
  const day = 86_400_000
  const a = Date.parse(`${p.from}T00:00:00Z`)
  const b = Date.parse(`${p.to}T00:00:00Z`)
  const n = Math.max(1, Math.min(31, Math.round((b - a) / day) + 1))
  const rows: VisitRow[] = []
  let seq = 120
  for (let i = 0; i < n; i++) {
    const d = new Date(a + i * day)
    const dayNo = d.getUTCDate()
    for (let k = 0; k < 4 + (dayNo % 3); k++) {
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 8 + k, (k * 23 + dayNo) % 60)
      if (at.getTime() > Date.now()) continue
      const pt = SAMPLE_PATIENTS[(k + dayNo) % SAMPLE_PATIENTS.length]!
      const dx = SAMPLE_DX[(k + dayNo) % SAMPLE_DX.length]!
      const closed = !(i === n - 1 && k >= 3)
      seq += 1
      rows.push({
        id: `e-${k % 4}`,
        reference: `V-2026-${String(seq).padStart(6, '0')}`,
        at: at.toISOString(),
        closedAt: closed ? new Date(at.getTime() + 95 * 60_000).toISOString() : null,
        status: closed ? 'closed' : 'open',
        service: k % 3 === 2 ? 'dental' : 'consultation',
        patient: { id: pt[0], name: pt[1], fileNumber: pt[2] },
        doctor: SAMPLE_DOCTORS[k % 2]!,
        department: SAMPLE_DEPTS[k % 3 === 2 ? 1 : 0]!,
        diagnosis: dx[0],
        icd10: dx[1],
        insurer: k % 4 === 1 ? 'RSSB (CBHI)' : null,
      })
    }
  }
  const q = f.search?.trim().toLowerCase()
  const kept = rows.filter(
    (v) =>
      (!f.department || v.department?.id === f.department) &&
      (!f.doctor || v.doctor?.id === f.doctor) &&
      (!f.service || v.service === f.service) &&
      (!f.insurer || (f.insurer === 'ins-rssb' && v.insurer)) &&
      (!f.closedOnly || v.status === 'closed') &&
      (!q ||
        v.patient.name.toLowerCase().includes(q) ||
        v.patient.fileNumber.toLowerCase().includes(q) ||
        (v.diagnosis ?? '').toLowerCase().includes(q)),
  )
  return {
    needsUpdate: false,
    from: p.from,
    to: p.to,
    manager: true,
    department: null,
    count: kept.length,
    closed: kept.filter((v) => v.status === 'closed').length,
    open: kept.filter((v) => v.status === 'open').length,
    options: {
      departments: SAMPLE_DEPTS,
      doctors: SAMPLE_DOCTORS,
      services: ['consultation', 'dental'],
      insurers: [{ id: 'ins-rssb', name: 'RSSB (CBHI)' }],
    },
    visits: kept,
  }
}

function sampleDocument(row: VisitRow): VisitDocument {
  const dx = row.diagnosis
  return {
    id: row.id,
    private: false,
    patient: row.patient,
    clinical: {
      diagnoses: dx
        ? [
            {
              id: `dx-${row.id}`,
              text: dx,
              icd10: row.icd10,
              type: 'primary',
              provisional: false,
              at: row.at,
              by: row.doctor?.name ?? null,
            },
          ]
        : [],
      notes: [
        {
          id: `n-${row.id}`,
          text: 'Fever for two days, headache. No vomiting. Examination: temperature 38.2 °C, no neck stiffness.',
          at: row.at,
          by: row.doctor?.name ?? null,
        },
      ],
      prescriptions: dx
        ? [
            {
              id: `rx-${row.id}`,
              by: row.doctor?.name ?? null,
              item: 'Paracetamol 500 mg',
              dose: '2 tab',
              route: 'oral',
              frequency: 'TDS',
              days: 3,
              quantity: 18,
              instructions: null,
              at: row.at,
              dispensed: row.status === 'closed',
              supply: 'pharmacy',
            },
          ]
        : [],
      orders: dx
        ? [
            {
              id: `o-${row.id}`,
              test: 'Malaria RDT',
              category: 'lab',
              status: 'verified',
              reason: 'fever',
              at: row.at,
              result: { findings: 'Positive', impression: null, verified: true },
            },
          ]
        : [],
      patient: {
        id: row.patient.id,
        allergies: null,
        bloodGroup: null,
        notes: null,
        flags: {},
        birthDate: '1995-03-12',
        sex: 'female',
        phone: '0788000000',
        allergiesNone: true,
        insurer: row.insurer,
        memberNo: row.insurer ? '1198800123456' : null,
        coveragePct: row.insurer ? 85 : null,
        weightKg: 62,
        weightAt: row.at,
      },
      visit: {
        id: row.id,
        reference: row.reference,
        at: row.at,
        status: row.status,
        closedAt: row.closedAt,
        service: row.service,
        department: row.department?.name ?? null,
        referredBy: null,
      },
      private: false,
      view: 'manager',
    },
    vitals: [
      {
        code: 'temp',
        label: null,
        value: 38.2,
        text: null,
        unit: '°C',
        at: row.at,
        by: 'Nyirahabimana Chantal',
      },
      {
        code: 'pulse',
        label: null,
        value: 96,
        text: null,
        unit: 'bpm',
        at: row.at,
        by: 'Nyirahabimana Chantal',
      },
      {
        code: 'bp',
        label: null,
        value: null,
        text: '128/84',
        unit: 'mmHg',
        at: row.at,
        by: 'Nyirahabimana Chantal',
      },
    ],
    charges: [
      { description: 'Consultation', quantity: 1 },
      ...(dx ? [{ description: 'Malaria RDT', quantity: 1 }] : []),
    ],
  }
}

// ------------------------------------------------------------------ hooks

export function useVisitsInPeriod(
  period: { from: string; to: string },
  filters: VisitFilters = {},
  enabled = true,
) {
  const userId = useSession((s) => s.user?.id ?? null)
  return useQuery({
    queryKey: [
      'analytics',
      'documents',
      userId,
      period.from,
      period.to,
      filters.department ?? null,
      filters.doctor ?? null,
      filters.service ?? null,
      filters.insurer ?? null,
      !!filters.closedOnly,
      filters.search?.trim() ?? '',
    ] as const,
    enabled: enabled && !!userId,
    staleTime: 60_000,
    queryFn: async (): Promise<VisitsInPeriod> => {
      if (!supabase) return sampleVisits(period, filters)
      const { data, error } = await supabase.rpc('visits_in_period', {
        p_from: period.from,
        p_to: period.to,
        p_department: filters.department ?? null,
        p_doctor: filters.doctor ?? null,
        p_service: filters.service ?? null,
        p_insurer: filters.insurer ?? null,
        p_closed_only: !!filters.closedOnly,
        p_search: filters.search?.trim() || null,
      })
      if (error) {
        if (isMissingFunction(error)) return emptyVisitsInPeriod(period)
        throw apiError(error)
      }
      return toVisitsInPeriod(data)
    },
  })
}

/**
 * The documents of these visits (at most 300 a call; more are fetched in turn). Each visit is
 * opened through visit_clinical() in the database, which logs the opening of a closed visit.
 */
export async function fetchVisitDocuments(rows: VisitRow[]): Promise<VisitDocument[]> {
  if (!supabase) return rows.map(sampleDocument)
  const out: VisitDocument[] = []
  for (let i = 0; i < rows.length; i += 300) {
    const ids = rows.slice(i, i + 300).map((r) => r.id)
    const { data, error } = await supabase.rpc('visit_documents', { p_encounter_ids: ids })
    if (error) throw apiError(error)
    out.push(...arr(data).map(toVisitDocument))
  }
  return out
}

// ------------------------------------------------------------------ to the report builder

type TFn = (key: string, vars?: Record<string, unknown>) => string

/**
 * One visit's document as the medical report builder prints it: the same mapping as the visit
 * screen's "Medical report" (clinical-card), from what visit_documents returns.
 */
export function reportDocOf(
  d: VisitDocument,
  clinic: LetterheadWithLegacy,
  author: { name: string; title: string; registrationNo?: string | null },
  t: TFn,
  printedBy: string,
): MedicalReportDoc {
  const c = d.clinical
  const p = c.patient
  const visitAt = c.visit?.at ?? d.vitals[0]?.at ?? c.notes[0]?.at ?? null
  const medicines: ReportMedicine[] = c.prescriptions
    // a cancelled line was never taken: it is not part of the record of care
    .filter((r) => !r.cancelledAt)
    .map((r) => {
      const state = prescriptionState(r)
      const route = r.route ? t(`clinical.routes.${r.route}`, { defaultValue: r.route }) : null
      const frequency = r.frequency
        ? t(`clinical.frequencies.${r.frequency}`, { defaultValue: r.frequency })
        : null
      const duration = r.days ? t('clinical.forDays', { count: r.days }) : null
      return {
        name: r.item,
        how: [r.dose, route, frequency, duration, r.instructions].filter(Boolean).join(' · '),
        dose: r.dose,
        route,
        frequency,
        duration,
        quantity: r.quantity,
        status: state === 'room' ? 'given' : state === 'returned' ? 'stopped' : 'new',
      }
    })
  const measured = [...d.vitals].sort((a, b) => b.at.localeCompare(a.at))[0]
  const visit: ReportVisit = {
    date: formatDate(visitAt ? new Date(visitAt) : new Date()),
    at: visitAt,
    reference: c.visit?.reference ?? null,
    department: c.visit?.department ?? null,
    referredBy: c.visit?.referredBy ?? null,
    doctor: c.diagnoses[0]?.by ?? c.notes[0]?.by ?? null,
    vitals: d.vitals.map((v) => ({
      label: v.label ?? t(`triage.vitals.${v.code}`, { defaultValue: v.code }),
      value: `${v.value ?? v.text ?? ''}${v.unit ? ` ${v.unit}` : ''}`,
      code: v.code,
      unit: v.unit,
    })),
    vitalsBy: measured?.by ?? null,
    vitalsAt: measured?.at ?? null,
    notes: c.notes.map((n) => n.text),
    diagnoses: c.diagnoses.map((x) => ({
      text: x.text,
      icd10: x.icd10,
      primary: x.type === 'primary',
      provisional: x.provisional,
    })),
    tests: c.orders.map((o) => ({
      name: o.test,
      findings: o.result?.findings ?? null,
      impression: o.result?.impression ?? null,
      verified: !!o.result?.verified,
    })),
    treatments: d.charges.map((x) => `${x.description}${x.quantity > 1 ? ` × ${x.quantity}` : ''}`),
    medicines,
  }
  return {
    kind: 'visit',
    clinic,
    patient: {
      name: d.patient.name,
      fileNumber: d.patient.fileNumber,
      ageSex: '',
      birthDate: p?.birthDate ?? null,
      sex: p?.sex ? t(`register.sexes.${p.sex}`, { defaultValue: p.sex }) : null,
      phone: p?.phone ?? null,
      insurer: p?.insurer ?? null,
      memberNo: p?.memberNo ?? null,
      weightKg: p?.weightKg ?? null,
      allergies: allergiesForDoc(p),
      bloodGroup: p?.bloodGroup ?? null,
    },
    visits: [visit],
    comment: null,
    author,
    printedBy,
  }
}

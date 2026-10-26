import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Triage } from '@mmc/shared'
import { apiError, isMissingFunction, sampleRefusal } from './errors'
import {
  sampleAccess,
  sampleVisitView,
  type PatientAccess,
  type SafetySummary,
  type VisitView,
} from './privacy'
import { isRoomStore, sampleIsManager, sampleStock } from './stock'
import { supabase } from '@/lib/supabase'
import type { Sex, Station } from '@/lib/api/visits'

/**
 * The patient register and the patient file. Every patient the clinic registers stays in
 * `patient` for good; `patients_list()` searches and pages it, `patient_file()` returns one
 * patient with visits, vitals, diagnoses and bills, `update_patient()` edits the file.
 * The clinical record of a visit (diagnoses, notes, prescriptions, orders) is read with
 * `visit_clinical()` and written with `add_diagnosis()`, `add_clinical_note()`, `prescribe()`,
 * `order_test()` and `finish_visit()`.
 *
 * 0088 (privacy): patient_file and visit_clinical return only what the reader's level allows
 * (see ./privacy.ts): a visit the reader may not see comes with `private: true` and no clinical
 * content; the file carries `access`, the safety `summary` and `safetyHidden`.
 */

/** A staff member as a printed document names them (0084): prescriber, result author. */
export interface DocPerson {
  id: string
  name: string
  role: string
  /** Specialty or title ("General practitioner", "Midwife"). */
  specialty: string | null
  /** Professional council number; null = not recorded (the document prints a ruled blank). */
  registrationNo: string | null
  /** The council (RMDC, NCNM, NPC, RAHPC…). */
  registrationBody: string | null
}

/**
 * The patient details a printed document needs (0084). For a visit: that visit's insurer (none
 * for cash) and the weight measured then (else within the 90 days before); for the patient file:
 * the current insurance and the last weight.
 */
export interface DocPatient {
  /** yyyy-mm-dd. */
  birthDate: string | null
  ageEstimated?: boolean
  sex: Sex
  phone: string | null
  /** Known allergies (free text); null = none known or not recorded (see allergiesNone). */
  allergies: string | null
  /** "No known allergies" was recorded by a nurse or doctor. */
  allergiesNone: boolean
  bloodGroup: string | null
  /** Insurer name; null = cash / none. */
  insurer: string | null
  insurerType?: string | null
  memberNo: string | null
  /** The insurer's cover in percent (the plan). */
  coveragePct: number | null
  weightKg: number | null
  /** When that weight was measured. */
  weightAt: string | null
}

/** The visit as a document prints it (0084). */
export interface DocVisit {
  id: string
  /** V-YYYY-NNNNNN: the medical report prints MR-{reference}. */
  reference: string | null
  at: string
  status: string
  closedAt: string | null
  /** The service chosen at registration (consultation, dental…). */
  service: string | null
  /** The department the patient was last sent to. */
  department: string | null
  referredBy: string | null
}

/**
 * The allergy text the document builders take: the allergies, "none" when "no known allergies"
 * was recorded, null when nothing was recorded.
 */
export const allergiesForDoc = (
  p: { allergies?: string | null; allergiesNone?: boolean | null } | null | undefined,
): string | null => (p?.allergies?.trim() ? p.allergies : p?.allergiesNone ? 'none' : null)

/** The printed prescription's number (0084, prescription_number). */
export interface PrescriptionNumber {
  /** RX-YYYY-NNNNNN. */
  number: string
  issuedAt: string
  issuedBy: string | null
  /** The prescription lines it covers. */
  lineIds: string[]
  /** A new number (a line was added since the last one printed). */
  isNew: boolean
  /** Who wrote the lines for the pharmacy (else the first line), with the registration. */
  prescriber: DocPerson | null
}

export interface PatientRow {
  id: string
  fileNumber: string
  surname: string
  givenNames: string
  sex: Sex
  birthDate: string | null
  phone: string | null
  sector: string | null
  registeredAt: string
  lastVisitAt: string | null
  visits: number
  openEncounterId: string | null
  balanceDue: number
  flags: Record<string, unknown>
  hasAllergies: boolean
}

export interface PatientRecord {
  id: string
  file_number: string
  surname: string
  given_names: string
  sex: Sex
  birth_date: string | null
  age_estimated: boolean
  national_id: string | null
  /** Why there is no national ID (child, not issued yet, foreign national), if so. */
  no_national_id?: 'child' | 'not_issued' | 'foreigner' | null
  phone_1: string | null
  phone_2: string | null
  preferred_channel: string
  language: string
  district: string | null
  sector: string | null
  cell: string | null
  village: string | null
  ubudehe_category: number | null
  occupation: string | null
  emergency_name: string | null
  emergency_phone: string | null
  blood_group: string | null
  allergies: string | null
  /** "No known allergies" recorded (0084; absent before). */
  allergies_none?: boolean
  notes: string | null
  flags: Record<string, unknown>
  /** Values of the clinic's custom fields and one-off fields, label → value. */
  extra: Record<string, string>
  created_at: string
}

/** A field the manager added to every patient file (setting `patient.fields`). */
export interface PatientFieldDef {
  key: string
  label: string
  type: 'text' | 'number' | 'date' | 'choice' | 'yesno'
  options?: string[]
}

export interface PatientVisit {
  id: string
  /** V-YYYY-NNNNNN (0084; absent before). */
  reference?: string | null
  arrivedAt: string
  status: 'open' | 'closed'
  type: string
  triage: Triage | null
  triageReason: string | null
  practitioner: string | null
  stations: Station[]
  currentStation: Station | null
  diagnosis: string | null
  total: number | null
  balance: number | null
  billStatus: string | null
  closedAt: string | null
  /** 0088: the reader may not see this visit's clinical record (diagnosis, triage reason null). */
  private?: boolean
  /** 0088: how the reader sees it ('visit' today's, 'own' treated it, 'manager', 'head'…). */
  view?: VisitView | null
}
export interface PatientVital {
  encounterId: string
  code: string
  value: number | null
  text: string | null
  unit: string | null
  at: string
  by: string | null
}
export interface PatientCondition {
  id: string
  encounterId: string
  text: string
  icd10: string | null
  type: 'primary' | 'secondary'
  provisional: boolean
  at: string
  by: string | null
}
export interface PatientBill {
  invoiceId: string
  encounterId: string
  number: string | null
  status: string
  total: number
  patientShare: number
  insurerShare: number
  balance: number
  payer: string | null
  at: string
}
export interface PatientFile {
  patient: PatientRecord
  visits: PatientVisit[]
  vitals: PatientVital[]
  conditions: PatientCondition[]
  bills: PatientBill[]
  /** What the printed history needs: insurer, member number, last weight… (0084; absent before). */
  document?: DocPatient | null
  /**
   * 0088: what the reader may see and ask for. Absent on an older database (everything visible).
   */
  access?: PatientAccess
  /** 0088: the safety summary, from level 2 (treating now); null at level 1. */
  summary?: SafetySummary | null
  /**
   * 0088: level 1. patient.allergies, allergies_none, blood_group and notes come null and are
   * not the real values: do not show them as "none"; the database ignores them if sent empty.
   */
  safetyHidden?: boolean
}

// ---------------------------------------------------------------- sample data
const sampleRows: PatientRow[] = [
  {
    id: 'p-1',
    fileNumber: 'MMC-000124',
    surname: 'Mukamana',
    givenNames: 'Alice',
    sex: 'female',
    birthDate: '1995-03-12',
    phone: '0788123456',
    sector: 'Kiramuruzi',
    registeredAt: '2026-10-02T08:10:00Z',
    lastVisitAt: '2026-10-15T09:20:00Z',
    visits: 3,
    openEncounterId: null,
    balanceDue: 0,
    flags: {},
    hasAllergies: true,
  },
  {
    id: 'p-2',
    fileNumber: 'MMC-000131',
    surname: 'Habimana',
    givenNames: 'Eric',
    sex: 'male',
    birthDate: '2018-07-01',
    phone: '0722987654',
    sector: 'Kiramuruzi',
    registeredAt: '2026-10-10T10:00:00Z',
    lastVisitAt: '2026-10-17T07:50:00Z',
    visits: 1,
    openEncounterId: 'e-1',
    balanceDue: 8000,
    flags: {},
    hasAllergies: false,
  },
  {
    id: 'p-3',
    fileNumber: 'MMC-000140',
    surname: 'Niyonzima',
    givenNames: 'Jean Bosco',
    sex: 'male',
    birthDate: '1972-01-20',
    phone: '0733111222',
    sector: 'Rugarama',
    registeredAt: '2026-09-21T11:30:00Z',
    lastVisitAt: '2026-10-12T14:00:00Z',
    visits: 5,
    openEncounterId: null,
    balanceDue: 0,
    flags: { vip: true },
    hasAllergies: false,
  },
]
/** Sample-mode files, kept so edits made in the UI survive a refetch. */
const sampleFileCache = new Map<string, PatientFile>()
const sampleFile = (id: string): PatientFile => {
  const cached = sampleFileCache.get(id)
  if (cached) return cached
  const built = buildSampleFile(id)
  sampleFileCache.set(id, built)
  return built
}
/** Sample insurance and weight per patient (p-1 insured, p-2 a child, p-3 cash). */
const SAMPLE_DOC: Record<
  string,
  { insurer: string | null; memberNo: string | null; pct: number | null; kg: number; none: boolean }
> = {
  'p-1': { insurer: 'RSSB (RAMA)', memberNo: '1234567', pct: 85, kg: 62, none: false },
  'p-2': {
    insurer: 'Mutuelle de santé (CBHI)',
    memberNo: '01-0412-07731',
    pct: 90,
    kg: 21.5,
    none: false,
  },
  'p-3': { insurer: null, memberNo: null, pct: null, kg: 78, none: true },
}
/** The sample patient's document details. */
const sampleDocPatient = (r: PatientRow): DocPatient => {
  const d = SAMPLE_DOC[r.id] ?? SAMPLE_DOC['p-1']!
  return {
    birthDate: r.birthDate,
    ageEstimated: false,
    sex: r.sex,
    phone: r.phone,
    allergies: r.hasAllergies ? 'Penicillin (rash)' : null,
    allergiesNone: !r.hasAllergies && d.none,
    bloodGroup: 'O+',
    insurer: d.insurer,
    insurerType: d.insurer ? (d.insurer.startsWith('RSSB') ? 'rssb_rama' : 'cbhi') : null,
    memberNo: d.memberNo,
    coveragePct: d.pct,
    weightKg: d.kg,
    weightAt: r.lastVisitAt ?? r.registeredAt,
  }
}
const buildSampleFileBase = (id: string): PatientFile => {
  const r = sampleRows.find((x) => x.id === id) ?? sampleRows[0]!
  const doc = sampleDocPatient(r)
  return {
    document: doc,
    patient: {
      id: r.id,
      file_number: r.fileNumber,
      surname: r.surname,
      given_names: r.givenNames,
      sex: r.sex,
      birth_date: r.birthDate,
      age_estimated: false,
      national_id: null,
      phone_1: r.phone,
      phone_2: null,
      preferred_channel: 'sms',
      language: 'kin',
      district: 'Gatsibo',
      sector: r.sector,
      cell: null,
      village: null,
      ubudehe_category: 3,
      occupation: null,
      emergency_name: null,
      emergency_phone: null,
      blood_group: 'O+',
      allergies: r.hasAllergies ? 'Penicillin (rash)' : null,
      allergies_none: doc.allergiesNone,
      notes: null,
      flags: r.flags,
      extra:
        r.id === 'p-1'
          ? {
              next_of_kin: 'Mukamana Jeanne (sister)',
              church: 'ADEPR Kiramuruzi',
              'Insurance card no.': 'RSSB 1234567',
            }
          : {},
      created_at: r.registeredAt,
    },
    visits: [
      {
        id: r.openEncounterId ?? 'e-9',
        reference: `V-2026-${String(100 + sampleRows.indexOf(r)).padStart(6, '0')}`,
        arrivedAt: r.lastVisitAt ?? r.registeredAt,
        status: r.openEncounterId ? 'open' : 'closed',
        type: 'opd',
        triage: 'yellow',
        triageReason: null,
        practitioner: 'Dr. Mukamana Béatrice',
        stations: ['triage', 'consultation', 'laboratory', 'cashier'],
        currentStation: r.openEncounterId ? 'consultation' : null,
        diagnosis: 'Malaria (uncomplicated)',
        total: 18300,
        balance: r.balanceDue,
        billStatus: r.openEncounterId ? 'draft' : 'posted',
        closedAt: r.openEncounterId ? null : r.lastVisitAt,
      },
    ],
    vitals: [
      {
        encounterId: 'e-9',
        code: 'bp_sys',
        value: 128,
        text: null,
        unit: 'mmHg',
        at: r.lastVisitAt ?? r.registeredAt,
        by: 'Nyirahabimana Chantal',
      },
      {
        encounterId: 'e-9',
        code: 'weight',
        value: doc.weightKg,
        text: null,
        unit: 'kg',
        at: r.lastVisitAt ?? r.registeredAt,
        by: 'Nyirahabimana Chantal',
      },
      {
        encounterId: 'e-9',
        code: 'temp',
        value: 38.2,
        text: null,
        unit: '°C',
        at: r.lastVisitAt ?? r.registeredAt,
        by: 'Nyirahabimana Chantal',
      },
    ],
    conditions: [
      {
        id: 'c-1',
        encounterId: 'e-9',
        text: 'Malaria (uncomplicated)',
        icd10: 'B54',
        type: 'primary',
        provisional: false,
        at: r.lastVisitAt ?? r.registeredAt,
        by: 'Dr. Mukamana Béatrice',
      },
    ],
    bills: [
      {
        invoiceId: 'i-1',
        encounterId: 'e-9',
        number: 'INV-2026-000012',
        status: 'posted',
        total: 18300,
        patientShare: 18300,
        insurerShare: 0,
        balance: r.balanceDue,
        payer: doc.insurer,
        at: r.lastVisitAt ?? r.registeredAt,
      },
    ],
  }
}

/** Habimana Eric (p-2, here today) also came in August: a past visit to show the privacy rules. */
const buildSampleFile = (id: string): PatientFile => {
  const f = buildSampleFileBase(id)
  if (id !== 'p-2') return f
  const at = '2026-08-20T08:40:00Z'
  return {
    ...f,
    visits: [
      ...f.visits,
      {
        id: 'e-8',
        reference: 'V-2026-000097',
        arrivedAt: at,
        status: 'closed',
        type: 'opd',
        triage: 'green',
        triageReason: 'Ear pain for 2 days',
        practitioner: 'Dr. Mukamana Béatrice',
        stations: ['triage', 'consultation', 'pharmacy', 'cashier'],
        currentStation: null,
        diagnosis: 'Acute otitis media',
        total: 9500,
        balance: 0,
        billStatus: 'posted',
        closedAt: '2026-08-20T10:05:00Z',
      },
    ],
    vitals: [
      ...f.vitals,
      {
        encounterId: 'e-8',
        code: 'temp',
        value: 38.6,
        text: null,
        unit: '°C',
        at,
        by: 'Nyirahabimana Chantal',
      },
      {
        encounterId: 'e-8',
        code: 'weight',
        value: 20.8,
        text: null,
        unit: 'kg',
        at,
        by: 'Nyirahabimana Chantal',
      },
    ],
    conditions: [
      ...f.conditions,
      {
        id: 'c-8',
        encounterId: 'e-8',
        text: 'Acute otitis media',
        icd10: 'H66.9',
        type: 'primary',
        provisional: false,
        at,
        by: 'Dr. Mukamana Béatrice',
      },
    ],
  }
}

/**
 * The sample file as the signed-in sample person may see it (0088): the manager and a head see
 * everything; a doctor or nurse treating today's visit sees the safety summary and today's
 * visit, past visits private; others see the identity only.
 */
const withSamplePrivacy = (f: PatientFile): PatientFile => {
  const access = sampleAccess(f.patient.id, f.visits)
  const views = new Map(f.visits.map((v) => [v.id, sampleVisitView(access, v)]))
  const seen = (encounterId: string) => views.get(encounterId) != null
  const p = f.patient
  const lastVitals = [...new Map(f.vitals.map((v) => [v.code, v])).values()]
  const identity = access.level === 'identity'
  return {
    ...f,
    access,
    safetyHidden: identity,
    patient: identity
      ? { ...p, allergies: null, allergies_none: undefined, blood_group: null, notes: null }
      : p,
    document:
      identity && f.document
        ? {
            ...f.document,
            allergies: null,
            allergiesNone: false,
            bloodGroup: null,
            weightKg: null,
            weightAt: null,
          }
        : f.document,
    visits: f.visits.map((v) => {
      const view = views.get(v.id) ?? null
      return view
        ? { ...v, private: false, view }
        : { ...v, private: true, view: null, diagnosis: null, triageReason: null }
    }),
    vitals: f.vitals.filter((v) => seen(v.encounterId)),
    conditions: f.conditions.filter((c) => seen(c.encounterId)),
    summary: identity
      ? null
      : {
          allergies: p.allergies,
          allergiesNone: !!p.allergies_none,
          bloodGroup: p.blood_group,
          alerts: p.notes,
          flags: p.flags,
          chronic:
            p.id === 'p-3'
              ? [
                  {
                    text: 'Essential hypertension',
                    icd10: 'I10',
                    since: '2025-11-04T09:00:00Z',
                    lastAt: '2026-10-12T14:00:00Z',
                  },
                ]
              : [],
          medications:
            p.id === 'p-3'
              ? [
                  {
                    item: 'Amlodipine 5 mg',
                    dose: '1 tablet',
                    frequency: 'once a day',
                    days: 30,
                    at: '2026-10-12T14:20:00Z',
                    until: '2026-11-11T14:20:00Z',
                    by: 'Dr. Mukamana Béatrice',
                  },
                ]
              : [],
          lastVitals: lastVitals.map((v) => ({
            code: v.code,
            value: v.value,
            unit: v.unit,
            at: v.at,
            by: v.by,
          })),
          lastVisitAt: f.visits[0]?.arrivedAt ?? null,
        },
  }
}

// ---------------------------------------------------------------- register
const PAGE = 50
export function usePatientsList(query: string, page: number) {
  return useQuery({
    queryKey: ['patients', 'list', query, page],
    queryFn: async (): Promise<{ total: number; rows: PatientRow[] }> => {
      if (!supabase) {
        const q = query.trim().toLowerCase()
        const rows = sampleRows.filter(
          (r) =>
            !q ||
            `${r.surname} ${r.givenNames} ${r.fileNumber} ${r.phone ?? ''}`
              .toLowerCase()
              .includes(q),
        )
        return { total: rows.length, rows }
      }
      const { data, error } = await supabase.rpc('patients_list', {
        p_query: query.trim() || null,
        p_limit: PAGE,
        p_offset: page * PAGE,
      })
      if (error) throw new Error(error.message)
      const d = data as { total: number; rows: PatientRow[] }
      return {
        total: Number(d.total),
        rows: d.rows.map((r) => ({
          ...r,
          visits: Number(r.visits),
          balanceDue: Number(r.balanceDue),
        })),
      }
    },
  })
}
export const PATIENTS_PAGE_SIZE = PAGE

// ---------------------------------------------------------------- file
export function usePatientFile(id: string) {
  return useQuery({
    queryKey: ['patients', 'file', id],
    // another desk works on the same visit: keep it fresh while open
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<PatientFile> => {
      if (!supabase) return withSamplePrivacy(sampleFile(id))
      const { data, error } = await supabase.rpc('patient_file', { p_patient_id: id })
      if (error) throw new Error(error.message)
      const f = data as PatientFile
      return {
        ...f,
        visits: f.visits.map((v) => ({
          ...v,
          total: v.total == null ? null : Number(v.total),
          balance: v.balance == null ? null : Number(v.balance),
        })),
        vitals: f.vitals.map((v) => ({ ...v, value: v.value == null ? null : Number(v.value) })),
        bills: f.bills.map((b) => ({
          ...b,
          total: Number(b.total),
          patientShare: Number(b.patientShare),
          insurerShare: Number(b.insurerShare),
          balance: Number(b.balance),
        })),
      }
    },
  })
}

export type NoIdReason = 'child' | 'not_issued' | 'foreigner'

/** Records why a patient has no national ID (null clears it); the file stops asking for one. */
export async function setNoNationalId(patientId: string, reason: NoIdReason | null) {
  if (!supabase) return
  const { error } = await supabase.rpc('set_no_national_id', {
    p_patient_id: patientId,
    p_reason: reason,
  })
  if (error) throw new Error(error.message)
}

export function usePatientActions(id: string) {
  const qc = useQueryClient()
  const update = useMutation({
    /**
     * `allergies_none: true` records "no known allergies" (0084): it clears the allergy text;
     * writing an allergy clears it again.
     */
    mutationFn: async (
      fields: Record<string, string | number | boolean | null | Record<string, string>>,
    ) => {
      if (!supabase) {
        const f = sampleFileCache.get(id)
        if (f && fields.extra && typeof fields.extra === 'object') f.patient.extra = fields.extra
        if (f) {
          const text = typeof fields.allergies === 'string' ? fields.allergies.trim() : ''
          if (text) Object.assign(f.patient, { allergies: text, allergies_none: false })
          else if ('allergies' in fields || fields.allergies_none === true)
            Object.assign(f.patient, {
              allergies: null,
              allergies_none:
                fields.allergies_none === true ||
                (!('allergies_none' in fields) && !!f.patient.allergies_none),
            })
          else if (fields.allergies_none === false) f.patient.allergies_none = false
          if (f.document)
            Object.assign(f.document, {
              allergies: f.patient.allergies,
              allergiesNone: !!f.patient.allergies_none,
            })
        }
        return
      }
      const { error } = await supabase.rpc('update_patient', { p_patient_id: id, p_fields: fields })
      if (error) throw new Error(error.message)
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['patients'] }),
  })
  return { update }
}

// ---------------------------------------------------------------- clinical record of a visit
export interface Diagnosis {
  id: string
  text: string
  icd10: string | null
  type: 'primary' | 'secondary'
  provisional: boolean
  at: string
  by: string | null
}
export interface ClinicalNote {
  id: string
  text: string
  at: string
  by: string | null
}
export interface Prescription {
  id: string
  /** Who prescribed it (migration 0060). */
  by?: string | null
  item: string
  dose: string | null
  route: string | null
  frequency: string | null
  days: number | null
  quantity: number
  instructions: string | null
  at: string
  dispensed: boolean
  /** Collected at the pharmacy, or given in the room by the prescriber (migration 0035). */
  supply?: 'pharmacy' | 'room'
  givenAt?: string | null
  givenBy?: string | null
  /** The pharmacy could not hand it over, and why (migration 0056). */
  notGivenAt?: string | null
  notGivenReason?: string | null
  /** Who wrote it: the prescriber (or the manager) may cancel it while it waits (0082). */
  prescriberId?: string | null
  /** Still waiting at the pharmacy (not handed over, not given, not cancelled). */
  pending?: boolean
  cancelledAt?: string | null
  cancelReason?: string | null
  cancelledBy?: string | null
  /** Who wrote it, with title and registration, for the printed prescription (0084). */
  prescriber?: DocPerson | null
}

/** A warning when prescribing (never a refusal): the medicine's rule and the prescriber. */
export interface RxWarning {
  kind: 'prescribingRule' | 'hospitalOnly' | 'needsNote'
  rule: string | null
  specialty?: string | null
}

/** What prescribe answers: for 'room' (given here), whether it was charged and taken from a store. */
export interface PrescribeResult {
  id: string | null
  supply: 'pharmacy' | 'room'
  charged: boolean
  stockTaken: boolean
  /** The room store it was taken from. */
  locationId: string | null
  warnings: RxWarning[]
}

/** Where a prescription line stands. */
export type PrescriptionState = 'waiting' | 'given' | 'room' | 'notGiven' | 'returned' | 'cancelled'
export function prescriptionState(p: Prescription): PrescriptionState {
  if (p.cancelledAt) return 'cancelled'
  if (p.notGivenAt) return /^returned:/i.test(p.notGivenReason ?? '') ? 'returned' : 'notGiven'
  if (p.supply === 'room') return 'room'
  if (p.dispensed || p.givenAt) return 'given'
  return 'waiting'
}
export interface TestOrder {
  id: string
  test: string
  category: 'lab' | 'imaging'
  /** The desk that carries it out (migration 0052). */
  station?: string | null
  status: string
  reason: string | null
  at: string
  result: {
    findings: string | null
    impression: string | null
    verified: boolean
    corrected?: boolean
    correctionReason?: string | null
    at?: string | null
    by?: string | null
    /** Who validated (else entered) it, with title and registration (0084). */
    byPerson?: DocPerson | null
  } | null
}

/** A test result in the patient file (all visits). */
export interface PatientResult {
  id: string
  encounterId: string
  test: string
  category: 'lab' | 'imaging'
  status: string
  reason: string | null
  orderedAt: string
  orderedBy: string | null
  findings: string | null
  impression: string | null
  verified: boolean
  resultAt: string | null
  resultBy: string | null
}

export function usePatientResults(patientId: string) {
  return useQuery({
    queryKey: ['patients', patientId, 'results'],
    // another desk works on the same visit: keep it fresh while open
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<PatientResult[]> => {
      if (!supabase) return []
      const { data, error } = await supabase.rpc('patient_results', { p_patient_id: patientId })
      if (error) throw new Error(error.message)
      return (data as PatientResult[]) ?? []
    },
  })
}
export interface VisitClinical {
  diagnoses: Diagnosis[]
  notes: ClinicalNote[]
  prescriptions: Prescription[]
  orders: TestOrder[]
  /** With the document details (birth date, phone, insurer, member no., weight…) from 0084. */
  patient:
    | ({
        id: string
        allergies: string | null
        bloodGroup: string | null
        notes: string | null
        flags: Record<string, unknown>
      } & Partial<DocPatient>)
    | null
  /** Reference, date, service and department of the visit (0084; absent before). */
  visit?: DocVisit | null
  /**
   * 0088: the reader may not see this visit's record: the lists come empty (not "nothing
   * recorded"); show "Past records are private" with the Request / Emergency buttons (access).
   */
  private?: boolean
  /** 0088: how the reader sees this visit (null when private). */
  view?: VisitView | null
  /** 0088: present when private: what the reader may ask for. */
  access?: PatientAccess
}
const EMPTY_CLINICAL: VisitClinical = {
  diagnoses: [],
  notes: [],
  prescriptions: [],
  orders: [],
  patient: null,
}
const sampleClinical = new Map<string, VisitClinical>()
/** The sample visit's patient (the visit header's Mukamana Alice, insured, 62 kg). */
const sampleClinicalPatient = (): NonNullable<VisitClinical['patient']> => ({
  id: 'p-sample',
  allergies: 'Penicillin (rash)',
  bloodGroup: 'O+',
  notes: null,
  flags: {},
  birthDate: '1995-03-12',
  ageEstimated: false,
  sex: 'female',
  phone: '0788123456',
  allergiesNone: false,
  insurer: 'RSSB (RAMA)',
  insurerType: 'rssb_rama',
  memberNo: '1234567',
  coveragePct: 85,
  weightKg: 62,
  weightAt: new Date().toISOString(),
})
const sampleVisitRefs = new Map<string, string>()
const sampleVisit = (encounterId: string): DocVisit => {
  let ref = sampleVisitRefs.get(encounterId)
  if (!ref) {
    ref = `V-2026-${String(124 + sampleVisitRefs.size).padStart(6, '0')}`
    sampleVisitRefs.set(encounterId, ref)
  }
  return {
    id: encounterId,
    reference: ref,
    at: new Date(Date.now() - 45 * 60_000).toISOString(),
    status: 'open',
    closedAt: null,
    service: 'consultation',
    department: null,
    referredBy: null,
  }
}
/** Sample prescription numbers: the last one per visit and the year's counter. */
const sampleRx = new Map<string, PrescriptionNumber>()
let sampleRxSeq = 122

export function useVisitClinical(encounterId: string) {
  return useQuery({
    queryKey: ['visit', encounterId, 'clinical'],
    // another desk works on the same visit: keep it fresh while open
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<VisitClinical> => {
      if (!supabase)
        return (
          sampleClinical.get(encounterId) ?? {
            ...EMPTY_CLINICAL,
            patient: sampleClinicalPatient(),
            visit: sampleVisit(encounterId),
          }
        )
      const { data, error } = await supabase.rpc('visit_clinical', { p_encounter_id: encounterId })
      if (error) throw new Error(error.message)
      const d = (data ?? EMPTY_CLINICAL) as VisitClinical
      return {
        ...d,
        prescriptions: d.prescriptions.map((p) => ({ ...p, quantity: Number(p.quantity) })),
      }
    },
  })
}

export interface Item {
  id: string
  code: string
  name: string
  strength: string | null
  form: string | null
  unit: string | null
  cashPrice: number | null
}
export function useItems() {
  return useQuery({
    queryKey: ['catalogue', 'items'],
    queryFn: async (): Promise<Item[]> => {
      if (!supabase)
        return [
          {
            id: 'it-1',
            code: 'AMOX500',
            name: 'Amoxicillin',
            strength: '500 mg',
            form: 'capsule',
            unit: 'cap',
            cashPrice: 300,
          },
          {
            id: 'it-2',
            code: 'PARA500',
            name: 'Paracetamol',
            strength: '500 mg',
            form: 'tablet',
            unit: 'tab',
            cashPrice: 50,
          },
          {
            id: 'it-3',
            code: 'AL20120',
            name: 'Artemether-lumefantrine',
            strength: '20/120 mg',
            form: 'tablet',
            unit: 'tab',
            cashPrice: 500,
          },
        ]
      const { data, error } = await supabase
        .from('items_catalogue')
        .select('*')
        .eq('active', true)
        .order('name_generic')
      if (error) throw new Error(error.message)
      return (
        data as {
          id: string
          code: string
          name_generic: string
          strength: string | null
          form: string | null
          unit: string | null
          cash_price: number | string | null
        }[]
      ).map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name_generic,
        strength: r.strength,
        form: r.form,
        unit: r.unit,
        cashPrice: r.cash_price == null ? null : Number(r.cash_price),
      }))
    },
  })
}

export function useClinicalActions(encounterId: string) {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['visit', encounterId] })
    void qc.invalidateQueries({ queryKey: ['queue'] })
    void qc.invalidateQueries({ queryKey: ['patients'] })
    void qc.invalidateQueries({ queryKey: ['access', encounterId] })
    void qc.invalidateQueries({ queryKey: ['routing', encounterId] })
  }
  const local = () => {
    const c = sampleClinical.get(encounterId) ?? {
      ...EMPTY_CLINICAL,
      diagnoses: [],
      notes: [],
      prescriptions: [],
      orders: [],
      patient: sampleClinicalPatient(),
      visit: sampleVisit(encounterId),
    }
    sampleClinical.set(encounterId, c)
    return c
  }
  const call = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await supabase!.rpc(fn, args)
    if (error) throw apiError(error)
    return data
  }
  const now = () => new Date().toISOString()

  const addDiagnosis = useMutation({
    mutationFn: async (i: {
      text: string
      icd10?: string
      type: 'primary' | 'secondary'
      provisional: boolean
    }) => {
      if (!supabase) {
        local().diagnoses.push({
          id: `d-${Date.now()}`,
          text: i.text,
          icd10: i.icd10 ?? null,
          type: i.type,
          provisional: i.provisional,
          at: now(),
          by: null,
        })
        return
      }
      await call('add_diagnosis', {
        p_encounter_id: encounterId,
        p_text: i.text,
        p_icd10: i.icd10 || null,
        p_type: i.type,
        p_provisional: i.provisional,
      })
    },
    onSuccess: refresh,
  })
  const addNote = useMutation({
    mutationFn: async (text: string) => {
      if (!supabase) {
        local().notes.push({ id: `n-${Date.now()}`, text, at: now(), by: null })
        return
      }
      await call('add_clinical_note', { p_encounter_id: encounterId, p_text: text })
    },
    onSuccess: refresh,
  })
  /**
   * One medicine. 'pharmacy': it waits at the pharmacy, the patient collects it (and pays at the
   * end of the visit). 'room' (given here): taken now from a room store the prescriber holds
   * (`locationId`, else their own), never expired, charged to the visit's bill; refused when the
   * store has not enough (MS003: offer "for the pharmacy"), when the prescriber holds no store
   * (42501 no_room_store) or a store they do not hold (42501 not_holder). Never refused for the
   * prescribing rule: `warnings` say it.
   */
  const prescribe = useMutation({
    mutationFn: async (i: {
      item: Item
      quantity: number
      dose?: string
      route?: string
      frequency?: string
      days?: number
      instructions?: string
      supply?: 'pharmacy' | 'room'
      station?: string
      /** Given here: the room store to take it from (default: the prescriber's own). */
      locationId?: string | null
    }): Promise<PrescribeResult> => {
      const supply = i.supply ?? 'pharmacy'
      if (!supabase) {
        let loc: string | null = null
        if (supply === 'room') {
          const q = Math.ceil(i.quantity)
          const mine = sampleStock.locations.filter(
            (l) =>
              l.active !== false &&
              isRoomStore(l) &&
              (sampleIsManager() || sampleStock.holds(l.id)) &&
              (!i.locationId || l.id === i.locationId),
          )
          if (!mine.length) throw sampleRefusal(i.locationId ? 'notHolder' : 'noRoomStore', '42501')
          loc = mine.find((l) => sampleStock.usable(i.item.id, l.id) >= q)?.id ?? null
          if (!loc) throw sampleRefusal('roomShort', 'MS003')
          sampleStock.move(i.item.id, loc, null, q)
        }
        const id = `rx-${Date.now()}-${local().prescriptions.length}`
        local().prescriptions.push({
          supply,
          givenAt: supply === 'room' ? now() : null,
          givenBy: null,
          id,
          item: `${i.item.name} ${i.item.strength ?? ''}`.trim(),
          dose: i.dose ?? null,
          route: i.route ?? null,
          frequency: i.frequency ?? null,
          days: i.days ?? null,
          quantity: i.quantity,
          instructions: i.instructions ?? null,
          at: now(),
          dispensed: supply === 'room',
          prescriberId: 'u-doc',
          pending: supply === 'pharmacy',
        })
        return {
          id,
          supply,
          charged: supply === 'room' && i.item.cashPrice != null,
          stockTaken: supply === 'room',
          locationId: loc,
          warnings: [],
        }
      }
      const args: Record<string, unknown> = {
        p_supply: supply,
        p_station: i.station ?? null,
        p_encounter_id: encounterId,
        p_item_id: i.item.id,
        p_quantity: i.quantity,
        p_dose: i.dose || null,
        p_route: i.route || null,
        p_frequency: i.frequency || null,
        p_duration_days: i.days ?? null,
        p_instructions: i.instructions || null,
      }
      // only when chosen, so a database before 0082 (ten arguments) still takes it
      if (i.locationId) args.p_location_id = i.locationId
      let res = await supabase.rpc('prescribe', args)
      if (res.error && i.locationId && isMissingFunction(res.error)) {
        delete args.p_location_id
        res = await supabase.rpc('prescribe', args)
      }
      if (res.error) throw apiError(res.error)
      const r = (res.data ?? null) as Partial<PrescribeResult> | null
      return {
        id: r?.id ?? null,
        supply: r?.supply === 'room' ? 'room' : supply,
        charged: r?.charged ?? true,
        stockTaken: r?.stockTaken ?? supply === 'room',
        locationId: r?.locationId ?? null,
        warnings: Array.isArray(r?.warnings) ? r.warnings : [],
      }
    },
    onSuccess: () => {
      refresh()
      // given here: the room store's figures follow
      void qc.invalidateQueries({ queryKey: ['stock'] })
    },
  })
  /**
   * The prescriber (or the manager) cancels a line still waiting at the pharmacy, with a reason
   * of at least 3 characters; the pharmacy is told. `pending`: lines still waiting on the visit.
   */
  const cancelPrescription = useMutation({
    mutationFn: async (i: {
      requestId: string
      reason: string
    }): Promise<{ id: string; pending: number; balance: number | null }> => {
      if (!supabase) {
        const p = local().prescriptions.find((x) => x.id === i.requestId)
        if (p)
          Object.assign(p, {
            cancelledAt: now(),
            cancelReason: i.reason.trim(),
            cancelledBy: null,
            pending: false,
          })
        return {
          id: i.requestId,
          pending: local().prescriptions.filter((x) => x.pending).length,
          balance: null,
        }
      }
      const d = (await call('cancel_prescription', {
        p_request_id: i.requestId,
        p_reason: i.reason.trim(),
      })) as { id: string; pending: number | string; balance: number | string | null } | null
      return {
        id: d?.id ?? i.requestId,
        pending: Number(d?.pending ?? 0),
        balance: d?.balance == null ? null : Number(d.balance),
      }
    },
    onSuccess: () => {
      refresh()
      void qc.invalidateQueries({ queryKey: ['stock'] })
      void qc.invalidateQueries({ queryKey: ['my-prescriptions'] })
    },
  })
  /**
   * A medicine given here by mistake is put back (0083 undo_given_here): the person who gave it
   * (the same day) or the manager, with a reason. The units go back into the room store; an open
   * bill loses the line, a posted bill gets a credit note (mode 'credit').
   */
  const undoGivenHere = useMutation({
    mutationFn: async (i: {
      requestId: string
      reason: string
    }): Promise<{
      units: number
      mode: 'bill' | 'credit'
      credit: number
      balance: number | null
    }> => {
      if (!supabase) {
        const p = local().prescriptions.find((x) => x.id === i.requestId)
        if (p)
          Object.assign(p, {
            givenAt: null,
            givenBy: null,
            notGivenAt: now(),
            notGivenReason: `returned: ${i.reason.trim()}`,
          })
        return { units: p ? Math.ceil(p.quantity) : 0, mode: 'bill', credit: 0, balance: null }
      }
      const d = (await call('undo_given_here', {
        p_request_id: i.requestId,
        p_reason: i.reason.trim(),
      })) as {
        units?: number | string
        mode?: string
        credit?: number | string
        balance?: number | string | null
      } | null
      return {
        units: Number(d?.units ?? 0),
        mode: d?.mode === 'credit' ? 'credit' : 'bill',
        credit: Number(d?.credit ?? 0),
        balance: d?.balance == null ? null : Number(d.balance),
      }
    },
    onSuccess: () => {
      refresh()
      void qc.invalidateQueries({ queryKey: ['stock'] })
      void qc.invalidateQueries({ queryKey: ['my-prescriptions'] })
    },
  })
  /** One or several tests; with `from`, the patient goes to the test desk now and comes back to
   *  that desk (and this clinician) once the last result is written. */
  const orderTests = useMutation({
    mutationFn: async (i: {
      tests: { serviceId: string; name: string; group: string }[]
      reason?: string
      from?: string | null
      /** Urgent: to the top of the lab's list (migration 0060). */
      urgent?: boolean
    }) => {
      if (!supabase) {
        i.tests.forEach((x, k) =>
          local().orders.push({
            id: `o-${Date.now()}-${k}`,
            test: x.name,
            category: x.group === 'imaging' ? 'imaging' : 'lab',
            status: 'ordered',
            reason: i.reason ?? null,
            at: now(),
            result: null,
          }),
        )
        return
      }
      const { error } = await supabase.rpc('order_tests', {
        p_encounter_id: encounterId,
        p_service_ids: i.tests.map((x) => x.serviceId),
        p_reason: i.reason || null,
        p_from: i.from ?? null,
        // only when urgent, so a database without migration 0060 still takes the order
        ...(i.urgent ? { p_priority: 2 } : {}),
      })
      if (!error) return
      // Database without migration 0044 yet: order one by one (the patient is not sent back).
      if (!/order_tests/.test(error.message)) throw new Error(error.message)
      for (const x of i.tests)
        await call('order_test', {
          p_encounter_id: encounterId,
          p_service_id: x.serviceId,
          p_reason: i.reason || null,
          p_priority: 3,
        })
    },
    onSuccess: refresh,
  })
  const finishVisit = useMutation({
    mutationFn: async () => {
      if (!supabase) return
      await call('finish_visit', { p_encounter_id: encounterId })
    },
    onSuccess: refresh,
  })
  /** The lab or ultrasound records the result of a test (the ordering doctor is told). */
  const recordResult = useMutation({
    mutationFn: async (i: {
      requestId: string
      findings: string
      impression: string
      verify: boolean
      /** The reason, when a verified result is corrected. */
      correction?: string | null
    }) => {
      if (!supabase) {
        const o = local().orders.find((x) => x.id === i.requestId)
        if (o)
          Object.assign(o, {
            status: i.verify ? 'verified' : 'resulted',
            result: {
              findings: i.findings || null,
              impression: i.impression || null,
              verified: i.verify,
              at: now(),
              by: null,
            },
          })
        return
      }
      if (i.correction != null) {
        await call('correct_result', {
          p_request_id: i.requestId,
          p_findings: i.findings || null,
          p_impression: i.impression || null,
          p_reason: i.correction,
        })
        return
      }
      await call('record_result', {
        p_request_id: i.requestId,
        p_findings: i.findings || null,
        p_impression: i.impression || null,
        p_verify: i.verify,
      })
    },
    onSuccess: refresh,
  })
  /**
   * The printed prescription's number (0084): the visit's last RX-YYYY-NNNNNN while no line was
   * added since, else a new one; with the prescriber's title and registration. Null on a database
   * before 0084 (the caller prints its own reference). Refused (22023, hint no_lines) when nothing
   * is prescribed.
   */
  const prescriptionNumber = useMutation({
    mutationFn: async (): Promise<PrescriptionNumber | null> => {
      if (!supabase) {
        const lines = local()
          .prescriptions.filter((p) => !p.cancelledAt)
          .map((p) => p.id)
        if (!lines.length) throw new Error('nothing is prescribed for this visit')
        const last = sampleRx.get(encounterId)
        if (last && lines.every((x) => last.lineIds.includes(x))) return { ...last, isNew: false }
        const issued: PrescriptionNumber = {
          number: `RX-${new Date().getFullYear()}-${String(++sampleRxSeq).padStart(6, '0')}`,
          issuedAt: now(),
          issuedBy: null,
          lineIds: lines,
          isNew: true,
          prescriber: {
            id: 'u-doc',
            name: 'Dr. Mukamana Béatrice',
            role: 'doctor',
            specialty: 'General practitioner',
            registrationNo: '2017/0458',
            registrationBody: 'RMDC',
          },
        }
        sampleRx.set(encounterId, issued)
        return issued
      }
      const { data, error } = await supabase.rpc('prescription_number', {
        p_encounter_id: encounterId,
      })
      if (error) {
        if (isMissingFunction(error)) return null
        throw apiError(error)
      }
      const d = data as PrescriptionNumber
      return { ...d, lineIds: d.lineIds ?? [], prescriber: d.prescriber ?? null }
    },
  })
  return {
    addDiagnosis,
    addNote,
    prescribe,
    prescriptionNumber,
    cancelPrescription,
    undoGivenHere,
    orderTests,
    finishVisit,
    recordResult,
  }
}

// ---------------------------------------------------------------- custom fields of the file
let sampleFields: PatientFieldDef[] = [
  { key: 'next_of_kin', label: 'Next of kin', type: 'text' },
  { key: 'church', label: 'Church / community', type: 'text' },
  {
    key: 'chronic',
    label: 'Chronic condition',
    type: 'choice',
    options: ['None', 'Diabetes', 'Hypertension', 'HIV', 'Asthma', 'Epilepsy'],
  },
]
const FIELDS_KEY = ['settings', 'patient.fields'] as const

/** The fields the manager added to every patient file. */
export function usePatientFields() {
  return useQuery({
    queryKey: FIELDS_KEY,
    staleTime: 60_000,
    queryFn: async (): Promise<PatientFieldDef[]> => {
      if (!supabase) return sampleFields
      const { data, error } = await supabase.rpc('patient_fields')
      if (error) throw new Error(error.message)
      return Array.isArray(data) ? (data as PatientFieldDef[]) : []
    },
  })
}

/** Manager only: replace the list of custom fields. */
export function useSavePatientFields() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (fields: PatientFieldDef[]) => {
      if (!supabase) {
        sampleFields = fields
        return
      }
      const { error } = await supabase.rpc('save_setting', {
        p_key: 'patient.fields',
        p_value: fields,
      })
      if (error) throw new Error(error.message)
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: FIELDS_KEY }),
  })
}

/** "31 F", "8 M", "4m" for babies. */
export const ageSexOf = (birth: string | null, sex: Sex): string => {
  const letter = { female: 'F', male: 'M', other: '', unknown: '' }[sex]
  if (!birth) return letter || '—'
  const b = new Date(birth)
  const n = new Date()
  let y = n.getFullYear() - b.getFullYear()
  if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) y -= 1
  const age =
    y >= 2
      ? String(y)
      : `${Math.max(0, (n.getFullYear() - b.getFullYear()) * 12 + n.getMonth() - b.getMonth())}m`
  return `${age} ${letter}`.trim()
}

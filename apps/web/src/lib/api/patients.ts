import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Triage } from '@mmc/shared'
import { supabase } from '@/lib/supabase'
import type { Sex, Station } from '@/lib/api/visits'

/**
 * The patient register and the patient file. Every patient the clinic registers stays in
 * `patient` for good; `patients_list()` searches and pages it, `patient_file()` returns one
 * patient with visits, vitals, diagnoses and bills, `update_patient()` edits the file.
 * The clinical record of a visit (diagnoses, notes, prescriptions, orders) is read with
 * `visit_clinical()` and written with `add_diagnosis()`, `add_clinical_note()`, `prescribe()`,
 * `order_test()` and `finish_visit()`.
 */

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
const buildSampleFile = (id: string): PatientFile => {
  const r = sampleRows.find((x) => x.id === id) ?? sampleRows[0]!
  return {
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
        payer: null,
        at: r.lastVisitAt ?? r.registeredAt,
      },
    ],
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
      if (!supabase) return sampleFile(id)
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
    mutationFn: async (fields: Record<string, string | number | null | Record<string, string>>) => {
      if (!supabase) {
        const f = sampleFileCache.get(id)
        if (f && fields.extra && typeof fields.extra === 'object') f.patient.extra = fields.extra
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
  patient: {
    id: string
    allergies: string | null
    bloodGroup: string | null
    notes: string | null
    flags: Record<string, unknown>
  } | null
}
const EMPTY_CLINICAL: VisitClinical = {
  diagnoses: [],
  notes: [],
  prescriptions: [],
  orders: [],
  patient: null,
}
const sampleClinical = new Map<string, VisitClinical>()

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
            patient: {
              id: 'p-sample',
              allergies: 'Penicillin (rash)',
              bloodGroup: 'O+',
              notes: null,
              flags: {},
            },
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
  }
  const local = () => {
    const c = sampleClinical.get(encounterId) ?? {
      ...EMPTY_CLINICAL,
      diagnoses: [],
      notes: [],
      prescriptions: [],
      orders: [],
      patient: {
        id: 'p-sample',
        allergies: 'Penicillin (rash)',
        bloodGroup: 'O+',
        notes: null,
        flags: {},
      },
    }
    sampleClinical.set(encounterId, c)
    return c
  }
  const call = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await supabase!.rpc(fn, args)
    if (error) throw new Error(error.message)
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
    }) => {
      if (!supabase) {
        local().prescriptions.push({
          supply: i.supply ?? 'pharmacy',
          givenAt: i.supply === 'room' ? now() : null,
          givenBy: null,
          id: `rx-${Date.now()}`,
          item: `${i.item.name} ${i.item.strength ?? ''}`.trim(),
          dose: i.dose ?? null,
          route: i.route ?? null,
          frequency: i.frequency ?? null,
          days: i.days ?? null,
          quantity: i.quantity,
          instructions: i.instructions ?? null,
          at: now(),
          dispensed: i.supply === 'room',
        })
        return
      }
      // a medicine given in the room: was it billed, did it leave a store?
      const r = (await call('prescribe', {
        p_supply: i.supply ?? 'pharmacy',
        p_station: i.station ?? null,
        p_encounter_id: encounterId,
        p_item_id: i.item.id,
        p_quantity: i.quantity,
        p_dose: i.dose || null,
        p_route: i.route || null,
        p_frequency: i.frequency || null,
        p_duration_days: i.days ?? null,
        p_instructions: i.instructions || null,
      })) as { charged?: boolean; stockTaken?: boolean } | null
      return { charged: r?.charged ?? true, stockTaken: r?.stockTaken ?? true }
    },
    onSuccess: refresh,
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
  return { addDiagnosis, addNote, prescribe, orderTests, finishVisit, recordResult }
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

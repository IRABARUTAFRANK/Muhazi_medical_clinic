import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { isDoctorUser } from '@/lib/roles'
import { useSession } from '@/store/session'
import { apiError, isMissingFunction } from './errors'
import type { PatientAccess, SafetySummary } from './privacy'
import { useStaffSettings } from './settings'

/**
 * Step 1 of the visit (0127 visit_past_history): the patient's earlier visits for the doctor —
 * date, desk and doctor, chief complaint, definitive diagnoses, plan, medicines, nurse orders,
 * tests with results — and the allergies and long-term conditions. The past is private
 * (0088/0126): a doctor with access sees it; with the clinic setting on, so does the doctor
 * working on the patient's open visit ('treating'), each opening written to the access log.
 */
export interface PastVisit {
  id: string
  reference: string | null
  at: string
  status: 'open' | 'closed'
  service: string | null
  department: string | null
  desks: string[]
  doctor: string | null
  complaint: string | null
  plan: string | null
  diagnoses: { text: string; icd10: string | null; type: 'primary' | 'secondary' }[]
  noDiagnosis: { kind: string; note: string | null } | null
  medicines: {
    item: string
    dose: string | null
    frequency: string | null
    days: number | null
    quantity: number
    supply: string | null
  }[]
  nurseOrders: {
    kind: 'act' | 'drug'
    text: string
    status: string
    dose: string | null
    frequency: string | null
    planned: number
    given: number
  }[]
  tests: {
    test: string
    status: string
    findings: string | null
    impression: string | null
    verified: boolean
  }[]
}
export type PastHistoryRefusal = 'not_doctor' | 'setting_off' | 'not_treating'
export interface PastHistory {
  allowed: boolean
  /** How it is seen: 'treating' (the setting), or the ways of 0088 (manager, head, request…). */
  via?: string | null
  /** Why not (allowed false). */
  reason?: PastHistoryRefusal
  /** Earlier visits of the patient (the list of visits is not a record). */
  count: number
  /** The clinic setting records.history_for_treating_doctor. */
  setting: boolean
  safety?: Pick<SafetySummary, 'allergies' | 'allergiesNone' | 'alerts' | 'chronic'> | null
  visits?: PastVisit[]
  /** Not allowed, a doctor: what may be asked (request / emergency). */
  access?: PatientAccess
}

const day = (n: number, h = 9) => {
  const d = new Date(Date.now() - n * 86_400_000)
  d.setHours(h, 20, 0, 0)
  return d.toISOString()
}
/** Sample mode: Mukamana Alice (e-1) came twice before. */
const SAMPLE_PAST: PastVisit[] = [
  {
    id: 'e-past1',
    reference: 'V-2026-000081',
    at: day(41),
    status: 'closed',
    service: 'consultation',
    department: 'Consultation (OPD)',
    desks: ['triage', 'consultation', 'laboratory'],
    doctor: 'Dr. Mukamana Béatrice',
    complaint: 'Burning when passing urine for 4 days',
    plan: 'Nitrofurantoin 5 days, drink more water; come back if fever or back pain.',
    diagnoses: [{ text: 'Urinary tract infection', icd10: 'N39.0', type: 'primary' }],
    noDiagnosis: null,
    medicines: [
      {
        item: 'Nitrofurantoin 100 mg',
        dose: '1 cap',
        frequency: 'BD',
        days: 5,
        quantity: 10,
        supply: 'pharmacy',
      },
    ],
    nurseOrders: [],
    tests: [
      {
        test: 'Urinalysis (dipstick)',
        status: 'verified',
        findings: 'Leucocytes +++, nitrites positive',
        impression: 'Urinary infection',
        verified: true,
      },
    ],
  },
  {
    id: 'e-past2',
    reference: 'V-2026-000032',
    at: day(132, 10),
    status: 'closed',
    service: 'consultation',
    department: 'Consultation (OPD)',
    desks: ['consultation', 'nursing'],
    doctor: 'Dr. Habimana Jean',
    complaint: 'Cut on the left hand (kitchen knife)',
    plan: 'Wound cleaned and closed with 3 stitches; tetanus vaccine; stitches out in 7 days.',
    diagnoses: [{ text: 'Open wound of the hand', icd10: 'S61.9', type: 'primary' }],
    noDiagnosis: null,
    medicines: [],
    nurseOrders: [
      {
        kind: 'act',
        text: 'Suture of the wound (3 stitches)',
        status: 'done',
        dose: null,
        frequency: null,
        planned: 1,
        given: 1,
      },
      {
        kind: 'act',
        text: 'Tetanus vaccine IM',
        status: 'done',
        dose: '0.5 ml',
        frequency: 'STAT',
        planned: 1,
        given: 1,
      },
    ],
    tests: [],
  },
]

/** The past for step 1 (null before 0127: the panel shows nothing). */
export function usePastHistory(encounterId: string, enabled = true) {
  const settings = useStaffSettings().data
  return useQuery({
    queryKey: ['visit', encounterId, 'past-history', settings?.historyForTreatingDoctor ?? true],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<PastHistory | null> => {
      if (!supabase) {
        const user = useSession.getState().user
        const on = settings?.historyForTreatingDoctor ?? true
        const visits = encounterId === 'e-1' ? SAMPLE_PAST : []
        if (!isDoctorUser(user))
          return { allowed: false, reason: 'not_doctor', count: visits.length, setting: on }
        // the manager (a doctor) sees the past as in 0088; the others need the setting
        if (!on && user?.role !== 'manager')
          return { allowed: false, reason: 'setting_off', count: visits.length, setting: on }
        return {
          allowed: true,
          via: user?.role === 'manager' ? 'manager' : 'treating',
          count: visits.length,
          setting: on,
          safety: {
            allergies: 'Penicillin (rash)',
            allergiesNone: false,
            alerts: null,
            chronic: [],
          },
          visits,
        }
      }
      const { data, error } = await supabase.rpc('visit_past_history', {
        p_encounter_id: encounterId,
      })
      if (error) {
        if (isMissingFunction(error)) return null
        throw apiError(error)
      }
      return data as PastHistory
    },
  })
}

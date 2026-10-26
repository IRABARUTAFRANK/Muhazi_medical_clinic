import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

/** Everything that happened in a visit (visit_journey), in order. */
export interface Journey {
  encounterId: string
  arrivedAt: string
  status: 'open' | 'closed'
  closedAt: string | null
  closedBy: string | null
  /** When the doctor finished the treatment (0070); why the patient left without paying. */
  treatmentDoneAt?: string | null
  leftReason?: string | null
  /** What the patient came for (consultation, dental, circ…). */
  service?: string | null
  triage: string | null
  triageReason: string | null
  steps: {
    station: string
    queuedAt: string
    calledAt: string | null
    startedAt: string | null
    finishedAt: string | null
    takenBy: string | null
    assignedTo: string | null
    referredBy: string | null
    note: string | null
    enteredBy: string | null
    service?: string | null
    department?: string | null
  }[]
  vitals: {
    code: string
    value: number | string | null
    unit: string | null
    at: string
    by: string | null
  }[]
  diagnoses: {
    text: string
    icd10: string | null
    type: string
    provisional: boolean
    at: string
    by: string | null
  }[]
  medicines: {
    item: string
    quantity: number | string
    dose: string | null
    frequency: string | null
    days: number | null
    supply: string
    givenAt: string | null
    givenBy: string | null
    at: string
    by: string | null
    dispensed: boolean
    /** The pharmacy could not hand it over (or it came back: 'returned: …'), and who (0082). */
    notGivenAt?: string | null
    notGivenReason?: string | null
    notGivenBy?: string | null
    /** The prescriber (or the manager) cancelled it before the hand-over (0082). */
    cancelledAt?: string | null
    cancelReason?: string | null
    cancelledBy?: string | null
  }[]
  tests: {
    test: string
    status: string
    priority: number
    at: string
    by: string | null
    result: string | null
  }[]
  charges: {
    description: string
    quantity: number | string
    unitPrice: number | string
    total: number | string
    office: string
    at: string
    by: string | null
  }[]
  payments: {
    amount: number | string
    method: string
    reference: string | null
    at: string
    by: string | null
  }[]
  bill: {
    status: string
    total: number | string
    balance: number | string
    paid: number | string
    number: string | null
    settledBy: string | null
    settledAt: string | null
  } | null
  /**
   * 0088: true when the reader may not see this visit's clinical record (vitals, diagnoses,
   * medicines, tests come empty; the triage reason and step notes null). Absent before 0088.
   */
  private?: boolean
}

const SAMPLE: Journey = {
  encounterId: 'e-1',
  arrivedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  status: 'open',
  closedAt: null,
  closedBy: null,
  triage: 'yellow',
  triageReason: 'Fever for 3 days',
  steps: [
    {
      station: 'reception',
      queuedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      calledAt: null,
      startedAt: null,
      finishedAt: new Date(Date.now() - 2.9 * 3_600_000).toISOString(),
      takenBy: null,
      assignedTo: null,
      referredBy: null,
      note: null,
      enteredBy: 'Uwimana Josiane',
    },
    {
      station: 'consultation',
      queuedAt: new Date(Date.now() - 2.9 * 3_600_000).toISOString(),
      calledAt: null,
      startedAt: new Date(Date.now() - 2.5 * 3_600_000).toISOString(),
      finishedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      takenBy: 'Dr. Mukamana Béatrice',
      assignedTo: null,
      referredBy: null,
      note: null,
      enteredBy: null,
    },
    {
      station: 'laboratory',
      queuedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      calledAt: null,
      startedAt: null,
      finishedAt: new Date(Date.now() - 1.2 * 3_600_000).toISOString(),
      takenBy: 'Uwera Diane',
      assignedTo: null,
      referredBy: null,
      note: null,
      enteredBy: null,
    },
    {
      station: 'cashier',
      queuedAt: new Date(Date.now() - 1.2 * 3_600_000).toISOString(),
      calledAt: null,
      startedAt: null,
      finishedAt: null,
      takenBy: null,
      assignedTo: null,
      referredBy: null,
      note: null,
      enteredBy: null,
    },
  ],
  vitals: [
    {
      code: 'temp',
      value: 38.2,
      unit: '°C',
      at: new Date(Date.now() - 2.8 * 3_600_000).toISOString(),
      by: 'Nyirahabimana Chantal',
    },
    {
      code: 'bp_sys',
      value: 128,
      unit: 'mmHg',
      at: new Date(Date.now() - 2.8 * 3_600_000).toISOString(),
      by: 'Nyirahabimana Chantal',
    },
  ],
  diagnoses: [
    {
      text: 'Uncomplicated malaria',
      icd10: 'B50.9',
      type: 'primary',
      provisional: false,
      at: new Date(Date.now() - 1.1 * 3_600_000).toISOString(),
      by: 'Dr. Mukamana Béatrice',
    },
  ],
  medicines: [
    {
      item: 'Artemether-lumefantrine 20/120 mg',
      quantity: 24,
      dose: '4 tab',
      frequency: 'twice a day',
      days: 3,
      supply: 'pharmacy',
      givenAt: null,
      givenBy: null,
      at: new Date(Date.now() - 1.1 * 3_600_000).toISOString(),
      by: 'Dr. Mukamana Béatrice',
      dispensed: false,
    },
    {
      item: 'Ciprofloxacin 500 mg',
      quantity: 10,
      dose: '1 tab',
      frequency: 'twice a day',
      days: 5,
      supply: 'pharmacy',
      givenAt: null,
      givenBy: null,
      at: new Date(Date.now() - 1.1 * 3_600_000).toISOString(),
      by: 'Dr. Mukamana Béatrice',
      dispensed: false,
      notGivenAt: new Date(Date.now() - 0.6 * 3_600_000).toISOString(),
      notGivenReason: 'Out of stock',
      notGivenBy: 'Kalisa Pascal',
    },
  ],
  tests: [
    {
      test: 'Malaria RDT',
      status: 'verified',
      priority: 2,
      at: new Date(Date.now() - 2.1 * 3_600_000).toISOString(),
      by: 'Dr. Mukamana Béatrice',
      result: 'Positive',
    },
  ],
  charges: [
    {
      description: 'General consultation',
      quantity: 1,
      unitPrice: 8000,
      total: 8000,
      office: 'consultation',
      at: new Date(Date.now() - 2.4 * 3_600_000).toISOString(),
      by: 'Dr. Mukamana Béatrice',
    },
    {
      description: 'Malaria RDT',
      quantity: 1,
      unitPrice: 2500,
      total: 2500,
      office: 'laboratory',
      at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      by: 'Dr. Mukamana Béatrice',
    },
  ],
  payments: [],
  bill: {
    status: 'draft',
    total: 10500,
    balance: 10500,
    paid: 0,
    number: null,
    settledBy: null,
    settledAt: null,
  },
}

/** Where a medicine of the visit stands, for the track. */
export type JourneyMedicineState =
  'given' | 'room' | 'notGiven' | 'returned' | 'cancelled' | 'toCollect'
export function journeyMedicineState(m: Journey['medicines'][number]): JourneyMedicineState {
  if (m.cancelledAt) return 'cancelled'
  if (m.notGivenAt) return /^returned:/i.test(m.notGivenReason ?? '') ? 'returned' : 'notGiven'
  if (m.supply === 'room') return 'room'
  if (m.dispensed || m.givenAt) return 'given'
  return 'toCollect'
}

export function useVisitJourney(encounterId: string | null) {
  return useQuery({
    queryKey: ['visit', encounterId, 'journey'],
    // another desk works on the same visit: keep it fresh while open
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    enabled: !!encounterId,
    queryFn: async (): Promise<Journey> => {
      if (!supabase) return { ...SAMPLE, encounterId: encounterId ?? 'e-1' }
      const { data, error } = await supabase.rpc('visit_journey', { p_encounter_id: encounterId })
      if (error) throw new Error(error.message)
      return data as Journey
    },
  })
}

import { outcomeOf } from './diagnosis-outcome'
import type { ReportVisit } from './medical-report'

/** What the medical report needs of a visit's record (visit_clinical, 0127): a loose shape so a
 *  record from before 0127 (no sections, no stage) still fits. */
export interface SixStepsSource {
  diagnoses: {
    id?: string
    text: string
    icd10: string | null
    type: 'primary' | 'secondary'
    provisional: boolean
    stage?: 'differential' | 'definitive' | null
    differentialId?: string | null
    removedAt?: string | null
    /** 0192: a possible diagnosis the doctor saved unticked in step 5 (visit_clinical). */
    notConfirmedAt?: string | null
    /** 0192: the same, as the patient file says it (patient_file). */
    notConfirmed?: boolean
  }[]
  sections?: Partial<
    Record<'complaint' | 'hpi' | 'exam' | 'plan', { text: string } | null | undefined>
  > | null
  nurseOrders?:
    | {
        text: string
        kind: 'act' | 'drug'
        dose: string | null
        route: string | null
        frequency: string | null
        dosesPlanned: number
        given: number
        notGiven: number
        status: 'open' | 'done' | 'not_done' | 'cancelled'
      }[]
    | null
}

type TFn = (key: string, vars?: Record<string, unknown>) => string

/** A differential (step 3): its stage, or the provisional mark of before 0127. */
export const isDifferential = (d: SixStepsSource['diagnoses'][number]) =>
  d.stage ? d.stage === 'differential' : d.provisional

/**
 * The six steps of a visit for the medical report (0127): the chief complaint and history (step
 * 1), the examination (2), the differential diagnoses with what the doctor decided about each
 * (3: confirmed, not confirmed or not decided — 0192: from what he saved, never from the words),
 * the definitive diagnoses (5), the plan and the orders to the nurses (6). The tests (4),
 * medicines and treatments are mapped by the callers as before. A removed diagnosis is not part
 * of the record of care.
 */
export function sixStepsOfVisit(
  c: SixStepsSource,
  t: TFn,
): Pick<
  ReportVisit,
  'complaint' | 'history' | 'examination' | 'plan' | 'diagnoses' | 'differentials' | 'nurseOrders'
> {
  const standing = c.diagnoses.filter((d) => !d.removedAt)
  const definitive = standing.filter((d) => !isDifferential(d))
  const text = (k: 'complaint' | 'hpi' | 'exam' | 'plan') => c.sections?.[k]?.text?.trim() || null
  const route = (r: string) => t(`clinical.routes.${r}`, { defaultValue: r })
  const frequency = (f: string) => t(`clinical.frequencies.${f}`, { defaultValue: f })
  return {
    complaint: text('complaint'),
    history: text('hpi'),
    examination: text('exam'),
    plan: text('plan'),
    diagnoses: definitive.map((d) => ({
      text: d.text,
      icd10: d.icd10,
      primary: d.type === 'primary',
      provisional: false,
    })),
    differentials: standing.filter(isDifferential).map((d) => ({
      text: d.text,
      icd10: d.icd10,
      // 0192: confirmed only when the doctor ticked it (a definitive one points at it), not
      // confirmed when he saved it unticked, else not decided — the same words count for nothing
      outcome: outcomeOf(d, standing),
    })),
    nurseOrders: (c.nurseOrders ?? [])
      .filter((o) => o.status !== 'cancelled')
      .map((o) => ({
        text: o.text,
        how: [
          o.dose,
          o.route ? route(o.route) : null,
          o.frequency ? frequency(o.frequency) : null,
          t('nurseOrders.times', { count: o.dosesPlanned }),
        ]
          .filter(Boolean)
          .join(' · '),
        status: t(o.kind === 'drug' ? 'nurseOrders.progressDrug' : 'nurseOrders.progressAct', {
          given: o.given,
          count: o.dosesPlanned,
        }),
      })),
  }
}

import { formatDate, formatTime } from '@mmc/shared'
import { outcomeOf } from './diagnosis-outcome'
import type { ReportVisit } from './medical-report'
import { isOnce, isRepeated } from './api/nurse-orders'
import { orderAction, partLines, stateWord } from './order-words'

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
        /** null: a repeated order until stopped (0198). */
        dosesPlanned: number | null
        given: number
        notGiven: number
        status: 'open' | 'done' | 'not_done' | 'cancelled'
        /** 0193: how many (an act: on the bill; a medicine: given here) and the take-home part. */
        quantity?: number
        unit?: string | null
        service?: string | null
        serviceId?: string | null
        homeQuantity?: number | null
        homeDose?: string | null
        homeFrequency?: string | null
        homeDays?: number | null
        homeInstructions?: string | null
        /** 0198: repeated every … minutes; the part of a piece given here. */
        everyMinutes?: number | null
        untilStopped?: boolean
        part?: number | null
        partText?: string | null
        doses?: { given: boolean; by: string | null; at: string; byId?: string | null }[]
        /** 0204: who wrote it and for whom (null: all the nurses); a nurse's record for a task. */
        by?: string | null
        byId?: string | null
        assignedTo?: string | null
        assignedName?: string | null
        taskId?: string | null
        taskTitle?: string | null
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
      .map((o) =>
        // 0193: an order carried out once prints its parts (given here; to take home and how)
        // and who carried it out; an older order keeps its times
        isOnce(o)
          ? {
              text: o.text,
              how: partLines(t, { ...o, quantity: Number(o.quantity ?? 1) }).join('; '),
              ordered: orderedBy(t, o),
              status: onceState(t, o),
            }
          : isRepeated(o)
            ? {
                // 0198: a repeated order: what each time, how often, and how many were given
                text: o.text,
                how: partLines(t, { ...o, quantity: Number(o.quantity ?? 1) }).join('; '),
                ordered: orderedBy(t, o),
                status:
                  o.dosesPlanned == null
                    ? t('nurseOrders.givenSoFar', { count: o.given })
                    : t(
                        o.kind === 'drug' ? 'nurseOrders.progressDrug' : 'nurseOrders.progressAct',
                        {
                          given: o.given,
                          count: o.dosesPlanned,
                        },
                      ),
              }
            : {
                text: o.text,
                how: [
                  o.dose,
                  o.route ? route(o.route) : null,
                  o.frequency ? frequency(o.frequency) : null,
                  t('nurseOrders.times', { count: o.dosesPlanned ?? 0 }),
                ]
                  .filter(Boolean)
                  .join(' · '),
                ordered: orderedBy(t, o),
                status: t(
                  o.kind === 'drug' ? 'nurseOrders.progressDrug' : 'nurseOrders.progressAct',
                  {
                    given: o.given,
                    count: o.dosesPlanned,
                  },
                ),
              },
      ),
  }
}

type SourceOrder = NonNullable<SixStepsSource['nurseOrders']>[number]
/**
 * 0204 · Who asked for it, for the record (Frank: what the doctor did himself read as an order to
 * the nurses): "Dr. A, for the nurses", "Dr. A, for Nurse B", "Dr. A, done in person" (kept for
 * himself, or carried out by the one who wrote it), or a nurse's record for a task of the doctor.
 */
function orderedBy(t: TFn, o: SourceOrder): string | null {
  if (!o.by) return null
  if (o.taskId) return t('nurseOrders.reportRecorded', { name: o.by, title: o.taskTitle ?? '' })
  const doneBy = [...(o.doses ?? [])].reverse().find((x) => x.given)?.byId ?? null
  if ((o.byId && o.assignedTo === o.byId) || (o.byId && doneBy === o.byId))
    return t('nurseOrders.reportSelf', { name: o.by })
  return o.assignedTo
    ? t('nurseOrders.reportForOne', { name: o.by, nurse: o.assignedName ?? '' })
    : t('nurseOrders.reportForAll', { name: o.by })
}
/** A one-time order's state for the record: "Given by Nurse A, 20/11/2026 10:52", or "To do". */
function onceState(t: TFn, o: SourceOrder): string {
  const d = [...(o.doses ?? [])].reverse().find((x) => x.given)
  if (o.status !== 'done' || !d) return stateWord(t, { ...o, quantity: Number(o.quantity ?? 1) })
  const action = orderAction({ ...o, quantity: Number(o.quantity ?? 1) })
  return t(
    action === 'done'
      ? 'nurseOrders.doneBy'
      : action === 'hand'
        ? 'nurseOrders.handedBy'
        : 'nurseOrders.givenBy',
    {
      name: d.by ?? '',
      when: `${formatDate(new Date(d.at))} ${formatTime(new Date(d.at))}`,
    },
  )
}

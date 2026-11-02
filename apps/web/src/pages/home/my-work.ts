import type { StaffUser } from '@mmc/shared'
import type { AnalyticsSearch } from '@/components/dash/analytics-links'
import type { ActivityKind, AnalyticsView } from '@/lib/api/analytics'

/*
 * The words and addresses of "My work" (0120): the kinds each home lists first, the Analytics
 * view behind each kind, the name of a kind. Kept apart from the panels (fast refresh).
 */

/** The address of an Analytics view, or undefined when the person may not open it. */
export type LinkFn = (view: AnalyticsView, extra?: AnalyticsSearch) => string | undefined

/** The kinds of work each home lists first (others show when they happened). */
export const WORK_OF: Record<
  'reception' | 'nurse' | 'doctor' | 'lab' | 'pharmacy' | 'cashier',
  readonly string[]
> = {
  reception: ['registered', 'visitsStarted', 'charges'],
  nurse: ['vitals', 'patientsSeen', 'tasksDone', 'admissions', 'procedures'],
  doctor: ['patientsSeen', 'diagnoses', 'prescriptions', 'orders', 'procedures'],
  lab: ['results', 'charges'],
  pharmacy: ['medicinesGiven', 'handovers', 'charges'],
  cashier: ['payments', 'refunds'],
}

/** The Analytics view behind one kind of my work: my own dashboard's view when it has one, else
 *  "Who did what" for me (the manager and the heads). */
export function kindLink(kind: string, link: LinkFn, user: StaffUser): string | undefined {
  const own: Partial<Record<string, AnalyticsView>> = {
    registered: 'registrations',
    vitals: 'vitals',
    patientsSeen: 'myPatients',
    diagnoses: 'diagnoses',
    prescriptions: 'prescriptions',
    orders: 'orders',
    results: 'verification',
    medicinesGiven: 'handovers',
    handovers: 'walkIn',
    payments: 'collections',
    refunds: 'refunds',
    voided: 'refunds',
    tasksDone: 'tasks',
  }
  const v = own[kind]
  return (
    (v && link(v)) ??
    (kind === 'visitsStarted'
      ? undefined
      : link('staff', { person: user.id, kind: kind as ActivityKind }))
  )
}

/** "registered" → "Patients registered" (analytics.kinds.*; visitsStarted has its own word). */
export const kindWord = (
  kind: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
) => (kind === 'visitsStarted' ? t('desk.mine.visits') : t(`analytics.kinds.${kind}`))

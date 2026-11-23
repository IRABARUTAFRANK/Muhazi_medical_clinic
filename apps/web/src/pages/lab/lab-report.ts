import { CircleCheck, Clock, FlaskConical, Hourglass, Siren, TestTube } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate } from '@mmc/shared'
import type { Tint } from '@/components/dash/kit-style'
import type { LabOrder, TestStatus } from '@/lib/api/lab'
import { allergiesForDoc } from '@/lib/api/patients'
import { registrationText } from '@/lib/api/staff'
import { openMedicalReport } from '@/lib/medical-report'
import { useLetterhead, useMedicalReportLabels, usePrintedBy } from '@/lib/report-parts'

/* What a test's row and the block of a patient's tests share: the look of a state, the age, the
 * wait, and the result report (one test, or several results of one visit on one report). */

export const STATUS_LOOK: Record<TestStatus, { tint: Tint; icon: LucideIcon }> = {
  ordered: { tint: 'amber', icon: Hourglass },
  collected: { tint: 'teal', icon: TestTube },
  in_process: { tint: 'violet', icon: FlaskConical },
  resulted: { tint: 'navy', icon: Clock },
  verified: { tint: 'mint', icon: CircleCheck },
  cancelled: { tint: 'coral', icon: Siren },
}

/** The states in the order of the work, for "3 tests · Waiting for sample: 2 · To verify: 1". */
export const STATUS_ORDER: readonly TestStatus[] = [
  'ordered',
  'collected',
  'in_process',
  'resulted',
  'verified',
  'cancelled',
]

export const ageOf = (birth: string | null) => {
  if (!birth) return ''
  const b = new Date(birth)
  const now = new Date()
  let y = now.getFullYear() - b.getFullYear()
  if (now < new Date(now.getFullYear(), b.getMonth(), b.getDate())) y -= 1
  return String(y)
}
export const sexLetterOf = (o: Pick<LabOrder, 'sex'>) =>
  o.sex === 'female' ? 'F' : o.sex === 'male' ? 'M' : ''
export const minutesSince = (iso: string, now: number) =>
  Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))

/**
 * The result report the patient (or the doctor) takes away: of one test, or of several results of
 * one visit signed by the same person, on one report. Gives false when the browser blocked the
 * new window. `desk`: an order done at another desk (Nursing, Dental…) is that desk's report.
 */
export function useLabReport(desk = false) {
  const { t } = useTranslation()
  const letterhead = useLetterhead()
  const labels = useMedicalReportLabels()
  const printedBy = usePrintedBy()
  return (list: LabOrder[]): boolean => {
    const o = list[0]
    if (!o) return true
    const requested = list.map((x) => x.orderedAt).sort()[0] ?? o.orderedAt
    const reported =
      list
        .map((x) => x.resultAt)
        .filter((x): x is string => !!x)
        .sort()
        .pop() ?? o.resultAt
    const allVerified = list.every((x) => x.verified)
    const reasons = [...new Set(list.map((x) => x.reason).filter((x): x is string => !!x))]
    // who entered (or validated) the result, with title and registration (0084; absent before)
    const person = o.resultByPerson ?? null
    // An order done at another desk (Nursing, Dental…) is that desk's report, signed with the
    // role of whoever wrote it; the bench title is only the fallback for an older row.
    const deskName =
      desk && o.station ? t(`register.stations.${o.station}`, { defaultValue: o.station }) : null
    const benchTitle =
      deskName ??
      (o.category === 'imaging' ? t('staff.roles.sonographer') : t('staff.roles.lab_tech'))
    const personTitle = person
      ? person.specialty?.trim() || t(`staff.roles.${person.role}`, { defaultValue: benchTitle })
      : benchTitle
    return openMedicalReport(
      {
        kind: 'visit',
        title: deskName
          ? t('lab.slipTitleDesk', { desk: deskName })
          : o.category === 'imaging'
            ? t('lab.slipTitleImaging')
            : t('lab.slipTitle'),
        clinic: letterhead,
        patient: {
          name: o.patient,
          fileNumber: o.fileNumber,
          // only read when the birth date and sex are missing
          ageSex: [ageOf(o.birthDate), sexLetterOf(o)].filter(Boolean).join(' '),
          birthDate: o.birthDate,
          sex: t(`register.sexes.${o.sex}`),
          phone: o.phone ?? null,
          insurer: o.insurer ?? null,
          memberNo: o.memberNo ?? null,
          weightKg: o.weightKg ?? null,
          allergies: allergiesForDoc(o),
          bloodGroup: o.bloodGroup ?? null,
        },
        visits: [
          {
            date: formatDate(new Date(o.visitAt ?? o.orderedAt)),
            at: o.visitAt ?? null,
            reference: o.visitReference ?? null,
            // "Requested by" on the result report
            doctor: o.orderedBy,
            vitals: [],
            notes: reasons,
            diagnoses: [],
            tests: list.map((x) => ({
              name: x.test,
              findings: x.findings,
              impression: x.impression,
              verified: x.verified,
            })),
            treatments: [],
            medicines: [],
          },
        ],
        author: {
          name: person?.name ?? o.resultBy ?? '',
          title: personTitle,
          registrationNo: registrationText(person),
        },
        printedBy: printedBy || null,
        lab: {
          reason: reasons.join(' · ') || null,
          requestedAt: requested,
          reportedAt: reported,
          performedAt: reported,
          // a result not verified yet prints as preliminary, with "Validated by" left blank
          validatedBy:
            allVerified && (person || o.resultBy)
              ? {
                  name: person?.name ?? o.resultBy ?? '',
                  title: personTitle,
                  registrationNo: registrationText(person),
                }
              : null,
          validatedAt: allVerified ? reported : null,
          // a verified result corrected afterwards prints with the "Amended report" banner (the
          // worklist says only that it was corrected, not when the first report was issued)
          amended: list.some((x) => x.corrected === true),
        },
      },
      labels,
    )
  }
}

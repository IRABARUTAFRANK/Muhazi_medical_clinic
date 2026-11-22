import { useState, type CSSProperties } from 'react'
import {
  ArrowUpRight,
  Ban,
  BellRing,
  CircleCheck,
  Clock,
  FlaskConical,
  Hourglass,
  Paperclip,
  PencilLine,
  Printer,
  Siren,
  TestTube,
  Undo2,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDuration } from '@/lib/duration'
import { formatDate, formatTime } from '@mmc/shared'
import { Pill } from '@/components/dash/kit'
import { card, focusedForm, tagClass, type Tint } from '@/components/dash/kit-style'
import { Button, buttonVariants } from '@/components/ui/button'
import { WideResult } from '@/components/clinical/wide-result'
import { controlClass, labelClass } from '@/components/ui/field'
import { StaffLink } from '@/components/staff/staff-link'
import { useLabActions, type LabOrder, type TestStatus } from '@/lib/api/lab'
import { useCallPatient } from '@/lib/api/display'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/lib/confirm'
import { openMedicalReport } from '@/lib/medical-report'
import { useLetterhead, useMedicalReportLabels, usePrintedBy } from '@/lib/report-parts'
import { allergiesForDoc } from '@/lib/api/patients'
import { registrationText } from '@/lib/api/staff'
import { deskOfRequest } from '@/lib/api/desks'
import { useSessionCan, useSessionCanDesk } from '@/components/clinical/session-desks'
import { TestFilesPanel } from '@/components/clinical/supporting-files'
import { useVisitFiles } from '@/lib/api/files'

const STATUS_LOOK: Record<TestStatus, { tint: Tint; icon: LucideIcon }> = {
  ordered: { tint: 'amber', icon: Hourglass },
  collected: { tint: 'teal', icon: TestTube },
  in_process: { tint: 'violet', icon: FlaskConical },
  resulted: { tint: 'navy', icon: Clock },
  verified: { tint: 'mint', icon: CircleCheck },
  cancelled: { tint: 'coral', icon: Siren },
}

const ageOf = (birth: string | null) => {
  if (!birth) return ''
  const b = new Date(birth)
  const now = new Date()
  let y = now.getFullYear() - b.getFullYear()
  if (now < new Date(now.getFullYear(), b.getMonth(), b.getDate())) y -= 1
  return String(y)
}
const minutesSince = (iso: string, now: number) =>
  Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`

/**
 * One test on the bench: priority, patient, test and why, who ordered it and how long ago, the
 * status, and the next step (sample taken → enter result → verify) with the visit one click away.
 */
export function LabOrderRow({
  order: o,
  i = 0,
  now,
  desk = false,
  visitResults,
  onSaved,
}: {
  order: LabOrder
  i?: number
  now: number
  /** An order done at another desk (Nursing…): no sample steps. */
  desk?: boolean
  /** The verified results of the same visit signed by the same person (this one included): with
   *  two or more, one report prints them together. */
  visitResults?: LabOrder[]
  /** A result was just saved: it stays in the open list (not verified) or went to the done one. */
  onSaved?: (where: 'open' | 'done') => void
}) {
  const { t } = useTranslation()
  const actions = useLabActions()
  // "Call": the waiting-room screen tells the patient to come to the bench (0114)
  const call = useCallPatient()
  // The steps of a laboratory test are the laboratory desk's, of an imaging one the ultrasound
  // desk's (a department of the person gives it). Someone without it sees the test, not the steps.
  // An order done at another desk: that desk's staff work it (the database checks).
  const canDesk = useSessionCanDesk()
  // …and the manager's switch "Request tests and write results" (Who may do what)
  const can = useSessionCan()
  const mayWork = desk || (canDesk(deskOfRequest(null, o.category)) && can('orders.write'))
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    findings: o.findings ?? '',
    impression: o.impression ?? '',
    verify: true,
    // why a verified result is corrected (kept with the first report)
    reason: '',
  })
  // a verified result is not typed over: it is corrected, with the reason
  const correcting = o.status === 'verified'
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [why, setWhy] = useState('')
  // the test's supporting files (images, printouts): shown with the result entry, or on demand
  const [showFiles, setShowFiles] = useState(false)
  const filesShown = showFiles || (open && mayWork)
  // how many, once the list was fetched (not fetched for every row of the worklist)
  const { data: filesKnown } = useVisitFiles(o.encounterId, {
    patientId: o.patientId,
    serviceRequestId: o.id,
    enabled: false,
  })
  const filesCount = filesKnown?.available
    ? filesKnown.files.filter((f) => !f.removed).length
    : null
  const letterhead = useLetterhead()
  const labels = useMedicalReportLabels()
  const printedBy = usePrintedBy()
  // The result report the patient (or the doctor) takes away: of this test only, or of every
  // verified result of the visit signed by the same person, on one report.
  const printReport = (list: LabOrder[]) => {
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
    const ok = openMedicalReport(
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
          ageSex: [ageOf(o.birthDate), o.sex === 'female' ? 'F' : o.sex === 'male' ? 'M' : '']
            .filter(Boolean)
            .join(' '),
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
    if (!ok) setError(t('report.popupBlocked'))
  }
  const printSlip = () => printReport([o])
  // the other verified results of this visit that the same person signed
  const together = o.verified && visitResults && visitResults.length > 1 ? visitResults : null
  const look = STATUS_LOOK[o.status]
  const urgent = o.priority <= 2
  const confirm = useConfirm()
  const names = { test: o.test, patient: o.patient }
  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const sexLetter = o.sex === 'female' ? 'F' : o.sex === 'male' ? 'M' : ''
  return (
    <div
      className={cn(
        'border-grid anim-enter -mx-2 flex flex-col gap-2 rounded-md border-b px-2 py-3 text-[14px] transition-colors duration-120 last:border-b-0',
        urgent && o.status !== 'verified' ? 'bg-red-bg/40' : 'hover:bg-hover',
      )}
      style={{ '--i': Math.min(i, 12) } as CSSProperties}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Pill tint={urgent ? 'coral' : 'violet'} icon={urgent ? Siren : FlaskConical}>
          {o.ticket ?? '—'}
        </Pill>
        <span className="min-w-[180px] flex-1">
          <span className="block font-medium">
            {o.test}
            <span className="text-ink-2 font-normal"> · {o.patient}</span>
          </span>
          <span className="text-ink-3 block text-[13px]">
            {[
              [ageOf(o.birthDate), sexLetter].filter(Boolean).join(' '),
              o.fileNumber,
              o.reason,
              o.orderedBy ? t('lab.orderedBy', { name: o.orderedBy }) : null,
              o.status === 'verified' || o.status === 'resulted'
                ? null
                : t('lab.waitingFor', { time: formatDuration(minutesSince(o.orderedAt, now), t) }),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        <Pill tint={look.tint} icon={look.icon}>
          {t(`lab.status.${o.status}`)}
        </Pill>
        {o.corrected && <Pill tint="amber">{t('home.correctedResult')}</Pill>}
        <span className="flex flex-wrap gap-1">
          {mayWork && o.status === 'ordered' && !desk && (
            <Button
              size="sm"
              variant="success"
              loading={actions.setStatus.isPending && actions.setStatus.variables?.id === o.id}
              onClick={async () => {
                if (
                  !(await confirm({
                    title: t('confirm.lab.sampleTitle', names),
                    confirmLabel: t('confirm.lab.sampleYes'),
                  }))
                )
                  return
                void run(() => actions.setStatus.mutateAsync({ id: o.id, status: 'collected' }))
              }}
            >
              <TestTube size={14} aria-hidden="true" />
              {t('lab.sampleTaken')}
            </Button>
          )}
          {mayWork && o.status === 'collected' && !desk && (
            <Button
              size="sm"
              variant="tint-violet"
              loading={actions.setStatus.isPending && actions.setStatus.variables?.id === o.id}
              onClick={async () => {
                if (
                  !(await confirm({
                    title: t('confirm.lab.analysingTitle', names),
                    confirmLabel: t('confirm.lab.analysingYes'),
                  }))
                )
                  return
                void run(() => actions.setStatus.mutateAsync({ id: o.id, status: 'in_process' }))
              }}
              title={t('lab.analysingHint')}
            >
              <FlaskConical size={14} aria-hidden="true" />
              {t('lab.analysing')}
            </Button>
          )}
          {mayWork && !desk && (o.status === 'ordered' || o.status === 'collected') && (
            <Button
              size="sm"
              variant="tint-amber"
              loading={
                call.isPending &&
                'encounterId' in (call.variables ?? {}) &&
                (call.variables as { encounterId: string }).encounterId === o.encounterId
              }
              onClick={async () => {
                if (
                  !(await confirm({
                    title: t('confirm.nextPatient.call.title', {
                      name: o.patient,
                      ticket: o.ticket ?? '',
                    }),
                    body: t('lab.callHint'),
                    confirmLabel: t('confirm.nextPatient.call.yes'),
                  }))
                )
                  return
                void run(() =>
                  call.mutateAsync({
                    encounterId: o.encounterId,
                    station: o.category === 'imaging' ? 'ultrasound' : 'laboratory',
                  }),
                )
              }}
              title={t('lab.callHint')}
            >
              <BellRing size={14} aria-hidden="true" />
              {t('common.call')}
            </Button>
          )}
          {mayWork && o.status !== 'verified' && o.status !== 'cancelled' && !open && (
            <Button
              size="sm"
              variant={
                o.status === 'resulted'
                  ? 'success'
                  : o.status === 'ordered'
                    ? 'tint-violet'
                    : 'primary'
              }
              onClick={() => setOpen(true)}
            >
              {o.status === 'resulted' ? (
                <CircleCheck size={14} aria-hidden="true" />
              ) : (
                <FlaskConical size={14} aria-hidden="true" />
              )}
              {t(o.status === 'resulted' ? 'lab.verify' : 'lab.enterResult')}
            </Button>
          )}
          {/* a verified result is not typed over: it is corrected, with the reason (the first
              report is kept and the doctor who ordered the test is told) */}
          {mayWork && correcting && !open && (
            <Button size="sm" variant="tint-amber" onClick={() => setOpen(true)}>
              <PencilLine size={14} aria-hidden="true" />
              {t('clinical.correctResult')}
            </Button>
          )}
          {(o.status === 'verified' || o.status === 'resulted') && (
            <Button size="sm" variant="tint-grey" onClick={printSlip} title={t('lab.slipHint')}>
              <Printer size={14} aria-hidden="true" />
              {t('lab.printSlip')}
            </Button>
          )}
          {together && (
            <Button
              size="sm"
              variant="tint-grey"
              onClick={() => printReport(together)}
              title={t('lab.printVisitHint')}
            >
              <Printer size={14} aria-hidden="true" />
              {t('lab.printVisit', { count: together.length })}
            </Button>
          )}
          {mayWork &&
            (o.status === 'ordered' || o.status === 'collected' || o.status === 'in_process') &&
            !cancelling && (
              <Button
                size="sm"
                variant="tint-coral"
                onClick={() => setCancelling(true)}
                title={t('lab.cannotHint')}
              >
                <Ban size={14} aria-hidden="true" />
                {t('lab.cannot')}
              </Button>
            )}
          {!(open && mayWork) && (
            <Button
              size="sm"
              variant="tint-grey"
              aria-expanded={showFiles}
              onClick={() => setShowFiles((v) => !v)}
              title={t('supportingFiles.titleTest', { test: o.test })}
            >
              <Paperclip size={14} aria-hidden="true" />
              {t('supportingFiles.title')}
              {filesCount != null && filesCount > 0 && ` (${filesCount})`}
            </Button>
          )}
          <StaffLink
            to="/app/visit"
            search={{ encounter: o.encounterId }}
            className={buttonVariants({ size: 'sm', variant: 'tint-blue' })}
          >
            <ArrowUpRight size={14} aria-hidden="true" />
            {t('visits.openVisit')}
          </StaffLink>
        </span>
      </div>
      {cancelling && mayWork && (
        <div className={cn(card, 'border-red/30 gap-2 p-3')}>
          <span className="text-ink-2 flex items-center gap-1.5 text-[13px] font-medium">
            <Ban size={14} aria-hidden="true" className="text-red" />
            {t('lab.cannotWhy', { doctor: o.orderedBy ?? '' })}
          </span>
          <span className="flex flex-wrap gap-1.5">
            {(['reagent', 'sample', 'machine', 'refused'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setWhy(t(`lab.cannotReasons.${r}`))}
                className={cn(
                  'inline-flex min-h-7 max-w-full items-center rounded-md border px-2.5 py-1 text-left text-[12px] leading-tight font-medium transition-colors duration-120',
                  why === t(`lab.cannotReasons.${r}`)
                    ? tagClass.coral
                    : 'border-border bg-card text-ink-2 hover:bg-hover',
                )}
              >
                {t(`lab.cannotReasons.${r}`)}
              </button>
            ))}
          </span>
          <input
            className={controlClass}
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            placeholder={t('lab.cannotPh')}
            aria-label={t('lab.cannotPh')}
          />
          <span className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="danger-solid"
              disabled={why.trim().length < 2}
              loading={actions.setStatus.isPending}
              onClick={async () => {
                if (
                  !(await confirm({
                    title: t('confirm.lab.notDoneTitle', names),
                    body: t('confirm.lab.notDoneBody', { reason: why.trim() }),
                    confirmLabel: t('confirm.lab.notDoneYes'),
                    tone: 'danger',
                  }))
                )
                  return
                void run(async () => {
                  await actions.setStatus.mutateAsync({
                    id: o.id,
                    status: 'cancelled',
                    reason: why.trim(),
                  })
                  setCancelling(false)
                })
              }}
            >
              <Ban size={14} aria-hidden="true" />
              {t('lab.cannotConfirm')}
            </Button>
            <Button size="sm" variant="tint-grey" onClick={() => setCancelling(false)}>
              <Undo2 size={14} aria-hidden="true" />
              {t('staff.form.cancel')}
            </Button>
          </span>
        </div>
      )}
      {(o.findings || o.impression) && !open && (
        <span className="border-green/30 bg-green-bg/60 flex gap-2 rounded-md border px-3 py-2 text-[13px]">
          <CircleCheck size={14} aria-hidden="true" className="text-green mt-0.5 flex-none" />
          {/* "Open wide" at the top right; in a narrow box it takes its own line and the result
              keeps the whole width (it used to float, squeezing the words beside it) */}
          <span className="flex min-w-0 flex-1 flex-row-reverse flex-wrap items-start gap-x-2 gap-y-0.5">
            <span className="flex-none">
              <WideResult
                result={{
                  test: o.test,
                  patient: o.patient,
                  findings: o.findings,
                  impression: o.impression,
                  verified: !!o.verified,
                  by: o.resultBy ?? null,
                  at: o.resultAt ?? null,
                }}
              />
            </span>
            <span className="min-w-0 flex-[1_1_8rem]">
              {o.findings && <span className="block">{o.findings}</span>}
              {o.impression && <span className="block font-semibold">{o.impression}</span>}
              {o.resultBy && o.resultAt && (
                <span className="text-ink-3 block text-xs">
                  {[
                    o.verified ? t('clinical.verified') : t('clinical.notVerified'),
                    o.resultBy,
                    when(o.resultAt),
                  ].join(' · ')}
                </span>
              )}
            </span>
          </span>
        </span>
      )}
      {open && mayWork && (
        <form
          className={cn(card, 'p-3', focusedForm)}
          // Enter in a one-line field does not save the result (it used to send the form and the
          // result was verified before it was read again): only the button saves
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              e.target instanceof HTMLInputElement &&
              e.target.type !== 'checkbox'
            )
              e.preventDefault()
          }}
          onSubmit={async (e) => {
            e.preventDefault()
            if (correcting) {
              if (
                !(await confirm({
                  title: t('confirm.visit.resultCorrect', { test: o.test, name: o.patient }),
                  body: t('confirm.visit.resultCorrectBody'),
                  confirmLabel: t('confirm.visit.resultCorrectYes'),
                }))
              )
                return
              void run(async () => {
                await actions.correct.mutateAsync({
                  id: o.id,
                  findings: form.findings,
                  impression: form.impression,
                  reason: form.reason,
                })
                setForm((f) => ({ ...f, reason: '' }))
              })
              return
            }
            if (
              !(await confirm({
                title: t(
                  form.verify ? 'confirm.lab.resultVerifyTitle' : 'confirm.lab.resultTitle',
                  names,
                ),
                body: t(form.verify ? 'confirm.lab.resultVerifyBody' : 'confirm.lab.resultBody'),
                confirmLabel: t('confirm.lab.resultYes'),
              }))
            )
              return
            void run(async () => {
              await actions.result.mutateAsync({
                id: o.id,
                findings: form.findings,
                impression: form.impression,
                verify: form.verify,
              })
              onSaved?.(form.verify ? 'done' : 'open')
            })
          }}
        >
          <label className={labelClass}>
            {t('clinical.findings')}
            <textarea
              rows={2}
              autoFocus
              className={cn(controlClass, 'h-auto py-2')}
              value={form.findings}
              onChange={(e) => setForm({ ...form, findings: e.target.value })}
            />
          </label>
          <label className={labelClass}>
            {t('clinical.impression')}
            <input
              className={controlClass}
              value={form.impression}
              onChange={(e) => setForm({ ...form, impression: e.target.value })}
            />
          </label>
          {correcting ? (
            <label className={labelClass}>
              {t('clinical.correctionWhy')}
              <input
                required
                minLength={3}
                className={controlClass}
                placeholder={t('clinical.correctionPh')}
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
              />
            </label>
          ) : (
            <label className="text-ink-2 flex items-center gap-2 text-[13px] font-medium">
              <input
                type="checkbox"
                className="accent-primary size-4"
                checked={form.verify}
                onChange={(e) => setForm({ ...form, verify: e.target.checked })}
              />
              {t('clinical.verifyNow')}
            </label>
          )}
          <span className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              loading={actions.result.isPending || actions.correct.isPending}
            >
              {correcting ? (
                <PencilLine size={14} aria-hidden="true" />
              ) : (
                <CircleCheck size={14} aria-hidden="true" />
              )}
              {t(correcting ? 'clinical.correctResult' : 'clinical.saveResult')}
            </Button>
            <Button type="button" size="sm" variant="tint-grey" onClick={() => setOpen(false)}>
              <Undo2 size={14} aria-hidden="true" />
              {t('staff.form.cancel')}
            </Button>
          </span>
        </form>
      )}
      {filesShown && (
        <TestFilesPanel
          encounterId={o.encounterId}
          patientId={o.patientId}
          patientName={o.patient}
          serviceRequestId={o.id}
          test={o.test}
          imaging={o.category === 'imaging'}
        />
      )}
      {error && (
        <p
          role="alert"
          className="bg-red-bg text-red border-red/30 m-0 rounded-md border px-3 py-2 text-[14px] font-medium"
        >
          {error}
        </p>
      )}
    </div>
  )
}

import { useState, type CSSProperties } from 'react'
import {
  ArrowUpRight,
  Ban,
  BellRing,
  CircleCheck,
  FlaskConical,
  Paperclip,
  PencilLine,
  Printer,
  Search,
  Siren,
  TestTube,
  Undo2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDuration } from '@/lib/duration'
import { formatDate, formatTime } from '@mmc/shared'
import { Pill } from '@/components/dash/kit'
import { card, focusedForm, tagClass } from '@/components/dash/kit-style'
import { Button, buttonVariants } from '@/components/ui/button'
import { WideResult } from '@/components/clinical/wide-result'
import { controlClass, labelClass } from '@/components/ui/field'
import { StaffLink } from '@/components/staff/staff-link'
import { useLabActions, type LabOrder } from '@/lib/api/lab'
import { useCallPatient } from '@/lib/api/display'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/lib/confirm'
import { deskOfRequest } from '@/lib/api/desks'
import { useSessionCan, useSessionCanDesk } from '@/components/clinical/session-desks'
import { TestFilesPanel } from '@/components/clinical/supporting-files'
import { useVisitFiles } from '@/lib/api/files'
import { STATUS_LOOK, ageOf, minutesSince, sexLetterOf, useLabReport } from './lab-report'

const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`

/**
 * One test on the bench: priority, patient, test and why, who ordered it and how long ago, the
 * status, and the next step (sample taken → enter result → verify) with the visit one click away.
 * Inside the block of its patient's visit (`grouped`, lab-visit-block.tsx) the row is the test
 * alone: the ticket, the patient, Call and "Work on" are on the block's heading, once.
 */
export function LabOrderRow({
  order: o,
  i = 0,
  now,
  desk = false,
  visitResults,
  onSaved,
  grouped,
  hit = null,
  note = null,
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
  /** One test inside the block of its patient's visit; what the row still says itself because
   *  the tests of the block differ on it (who requested it, since when it waits). */
  grouped?: { orderedBy: boolean; waiting: boolean }
  /** The search or the filter keeps the block for some of its tests only: this one (true) or
   *  not this one (false). Nothing to point out: null. */
  hit?: boolean | null
  /** Said after the details: the other tests of the visit that are in the other list. */
  note?: string | null
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
  // The result report the patient (or the doctor) takes away: of this test only, or of every
  // verified result of the visit signed by the same person, on one report.
  const openReport = useLabReport(desk)
  const printReport = (list: LabOrder[]) => {
    if (!openReport(list)) setError(t('report.popupBlocked'))
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
  // the patient's part is on the block's heading when the test stands in a block
  const details = [
    grouped ? null : [ageOf(o.birthDate), sexLetterOf(o)].filter(Boolean).join(' '),
    grouped ? null : o.fileNumber,
    o.reason,
    o.orderedBy && (!grouped || grouped.orderedBy)
      ? t('lab.orderedBy', { name: o.orderedBy })
      : null,
    o.status === 'verified' || o.status === 'resulted' || (grouped && !grouped.waiting)
      ? null
      : t('lab.waitingFor', { time: formatDuration(minutesSince(o.orderedAt, now), t) }),
    note,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      className={cn(
        'border-grid anim-enter flex flex-col gap-2 border-b py-3 text-[14px] transition-colors duration-120 last:border-b-0',
        grouped ? 'px-3 last:rounded-b-[7px]' : '-mx-2 rounded-md px-2',
        // the test the search or the filter asked for, among the tests of its block
        hit === true && 'border-l-primary border-l-[3px] pl-[9px]',
        urgent && o.status !== 'verified'
          ? 'bg-red-bg/40'
          : hit === true
            ? 'bg-primary-tint/50'
            : 'hover:bg-hover',
      )}
      style={{ '--i': Math.min(i, 12) } as CSSProperties}
    >
      <div className="flex flex-wrap items-center gap-3">
        {!grouped && (
          <Pill tint={urgent ? 'coral' : 'violet'} icon={urgent ? Siren : FlaskConical}>
            {o.ticket ?? '—'}
          </Pill>
        )}
        <span className={cn('flex-1', grouped ? 'min-w-[min(180px,100%)]' : 'min-w-[180px]')}>
          <span className={cn('block font-medium', hit === false && 'text-ink-2')}>
            {hit === true && (
              <Search
                size={13}
                aria-hidden="true"
                className="text-primary mr-1.5 inline-block align-[-1px]"
              />
            )}
            {o.test}
            {!grouped && <span className="text-ink-2 font-normal"> · {o.patient}</span>}
            {hit === true && <span className="sr-only"> ({t('lab.block.hitTag')})</span>}
          </span>
          {details && <span className="text-ink-3 block text-[13px]">{details}</span>}
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
          {mayWork && !desk && !grouped && (o.status === 'ordered' || o.status === 'collected') && (
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
          {together && !grouped && (
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
          {!grouped && (
            <StaffLink
              to="/app/visit"
              search={{ encounter: o.encounterId }}
              className={buttonVariants({ size: 'sm', variant: 'tint-blue' })}
            >
              <ArrowUpRight size={14} aria-hidden="true" />
              {t('visits.openVisit')}
            </StaffLink>
          )}
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

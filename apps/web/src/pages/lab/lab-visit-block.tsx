import { useState, type CSSProperties } from 'react'
import {
  ArrowUpRight,
  BellRing,
  FlaskConical,
  Printer,
  Search,
  Siren,
  TestTube,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Pill } from '@/components/dash/kit'
import { Button, buttonVariants } from '@/components/ui/button'
import { StaffLink } from '@/components/staff/staff-link'
import { useSessionCan, useSessionCanDesk } from '@/components/clinical/session-desks'
import { useLabActions, type LabOrder } from '@/lib/api/lab'
import { useCallPatient } from '@/lib/api/display'
import { deskOfRequest } from '@/lib/api/desks'
import { useConfirm } from '@/lib/confirm'
import { formatDuration } from '@/lib/duration'
import { cn } from '@/lib/utils'
import { countByState, partialHits, type VisitBlock } from '@/lib/visit-blocks'
import { LabOrderRow } from './lab-parts'
import { STATUS_ORDER, ageOf, minutesSince, sexLetterOf, useLabReport } from './lab-report'

/** Tests requested in one go are written within the same minute or two. */
const SAME_MOMENT_MS = 2 * 60_000

/**
 * "The file of that patient": the tests of one patient's visit together. One heading with the
 * ticket, the patient, who requested the tests and how long they wait, how many tests and where
 * they stand; what concerns the patient once is there, once (Call, Work on, the sample taken for
 * all the tests, every result on one report). Under it each test with its own state and steps.
 * A visit with a single test stays the plain row it always was.
 */
export function LabVisitBlock({
  block,
  i = 0,
  now,
  desk = false,
  onSaved,
  also,
}: {
  block: VisitBlock<LabOrder>
  i?: number
  now: number
  /** Orders done at another desk (Nursing…): no sample steps, no call. */
  desk?: boolean
  onSaved?: (where: 'open' | 'done') => void
  /** How many other tests of the same visit are in the other list (done, or still to do). */
  also?: { done?: number; open?: number }
}) {
  const { t } = useTranslation()
  const actions = useLabActions()
  const call = useCallPatient()
  const canDesk = useSessionCanDesk()
  const can = useSessionCan()
  const confirm = useConfirm()
  const openReport = useLabReport(desk)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { rows } = block
  const first = rows[0]
  if (!first) return null

  const alsoNote =
    [
      also?.done ? t('lab.block.alsoDone', { count: also.done }) : null,
      also?.open ? t('lab.block.alsoOpen', { count: also.open }) : null,
    ]
      .filter(Boolean)
      .join(' · ') || null

  // a single test: the row as it always was (nothing to put together)
  if (rows.length === 1)
    return (
      <LabOrderRow order={first} i={i} now={now} desk={desk} onSaved={onSaved} note={alsoNote} />
    )

  const mayWork = (o: LabOrder) =>
    desk || (canDesk(deskOfRequest(null, o.category)) && can('orders.write'))
  const hits = partialHits(block)
  const urgent = rows.some((o) => o.priority <= 2 && o.status !== 'verified')
  // who requested them and since when they wait: on the heading when the tests agree, else on
  // each test
  const requesters = [...new Set(rows.map((o) => o.orderedBy).filter((x): x is string => !!x))]
  const oneRequester = requesters.length === 1 && rows.every((o) => o.orderedBy === requesters[0])
  const waiting = rows.filter(
    (o) => o.status === 'ordered' || o.status === 'collected' || o.status === 'in_process',
  )
  const waitingSince = waiting.map((o) => new Date(o.orderedAt).getTime())
  const oldest = waitingSince.length > 0 ? Math.min(...waitingSince) : null
  const oneMoment = oldest == null || Math.max(...waitingSince) - oldest <= SAME_MOMENT_MS
  const states = countByState(
    rows.map((o) => o.status),
    STATUS_ORDER,
  )
  // one draw serves the laboratory tests still waiting for their sample
  const toSample = desk
    ? []
    : rows.filter((o) => o.status === 'ordered' && o.category === 'lab' && mayWork(o))
  // the patient is called once, to the desk of the first test that still needs them
  const toCall = desk
    ? undefined
    : rows.find((o) => mayWork(o) && (o.status === 'ordered' || o.status === 'collected'))
  // every verified result of the visit signed by the same person prints on one report
  const signed = new Map<string, LabOrder[]>()
  for (const o of rows) {
    if (!o.verified || !o.resultBy) continue
    signed.set(o.resultBy, [...(signed.get(o.resultBy) ?? []), o])
  }
  const reports = [...signed.entries()].filter(([, list]) => list.length > 1)

  const sampleAll = async () => {
    if (
      !(await confirm({
        title: t('confirm.lab.sampleAllTitle', { count: toSample.length, patient: first.patient }),
        body: toSample.map((o) => o.test).join(' · '),
        confirmLabel: t('confirm.lab.sampleAllYes'),
      }))
    )
      return
    setError(null)
    setBusy(true)
    // one after the other: a test the database refuses does not stop the others, and is named
    const refused: string[] = []
    for (const o of toSample) {
      try {
        await actions.setStatus.mutateAsync({ id: o.id, status: 'collected' })
      } catch (e) {
        refused.push(`${o.test} (${e instanceof Error ? e.message : String(e)})`)
      }
    }
    setBusy(false)
    if (refused.length > 0) setError(t('lab.block.notMarked', { list: refused.join(' · ') }))
  }

  const callPatient = async (o: LabOrder) => {
    if (
      !(await confirm({
        title: t('confirm.nextPatient.call.title', { name: o.patient, ticket: o.ticket ?? '' }),
        body: t('lab.callHint'),
        confirmLabel: t('confirm.nextPatient.call.yes'),
      }))
    )
      return
    setError(null)
    try {
      await call.mutateAsync({
        encounterId: o.encounterId,
        station: o.category === 'imaging' ? 'ultrasound' : 'laboratory',
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section
      aria-label={t('lab.block.aria', { patient: first.patient })}
      className={cn(
        'anim-enter my-2 flex min-w-0 flex-col rounded-lg border text-[14px] first:mt-0 last:mb-0',
        urgent ? 'border-red/30' : 'border-border',
      )}
      style={{ '--i': Math.min(i, 12) } as CSSProperties}
    >
      <header
        className={cn(
          'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-t-[7px] border-b px-3 py-2.5',
          urgent ? 'border-red/30 bg-red-bg/60' : 'border-border bg-hover',
        )}
      >
        <Pill tint={urgent ? 'coral' : 'violet'} icon={urgent ? Siren : FlaskConical}>
          {first.ticket ?? '—'}
        </Pill>
        <span className="min-w-[min(200px,100%)] flex-1">
          <span className="block text-[15px] font-semibold">{first.patient}</span>
          <span className="text-ink-3 block text-[13px]">
            {[
              [ageOf(first.birthDate), sexLetterOf(first)].filter(Boolean).join(' '),
              first.fileNumber,
              oneRequester ? t('lab.block.orderedBy', { name: requesters[0] }) : null,
              oneMoment && oldest != null
                ? t('lab.waitingFor', {
                    time: formatDuration(minutesSince(new Date(oldest).toISOString(), now), t),
                  })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <span className="text-ink-2 block text-[13px] font-medium">
            {[
              t(desk ? 'lab.block.requests' : 'lab.block.tests', { count: rows.length }),
              // "Waiting for sample" is the laboratory's word: not said of a dressing or an injection
              ...(desk ? [] : states.map((s) => `${t(`lab.status.${s.state}`)}: ${s.count}`)),
              alsoNote,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        <span className="flex flex-wrap gap-1">
          {toSample.length > 1 && (
            <Button
              size="sm"
              variant="success"
              loading={busy}
              onClick={() => void sampleAll()}
              title={t('lab.block.sampleAllHint')}
            >
              <TestTube size={14} aria-hidden="true" />
              {t('lab.block.sampleAll', { count: toSample.length })}
            </Button>
          )}
          {toCall && (
            <Button
              size="sm"
              variant="tint-amber"
              loading={call.isPending}
              onClick={() => void callPatient(toCall)}
              title={t('lab.callHint')}
            >
              <BellRing size={14} aria-hidden="true" />
              {t('common.call')}
            </Button>
          )}
          {reports.map(([signer, list]) => (
            <Button
              key={signer}
              size="sm"
              variant="tint-grey"
              onClick={() => {
                setError(null)
                if (!openReport(list)) setError(t('report.popupBlocked'))
              }}
              title={t('lab.block.printAllHint')}
            >
              <Printer size={14} aria-hidden="true" />
              {signed.size > 1
                ? t('lab.block.printAllBy', { name: signer, count: list.length })
                : t('lab.block.printAll', { count: list.length })}
            </Button>
          ))}
          <StaffLink
            to="/app/visit"
            search={{ encounter: first.encounterId }}
            className={buttonVariants({ size: 'sm', variant: 'tint-blue' })}
          >
            <ArrowUpRight size={14} aria-hidden="true" />
            {t('visits.openVisit')}
          </StaffLink>
        </span>
        {hits && (
          <span className="text-primary flex basis-full items-start gap-1.5 text-[13px] font-medium">
            <Search size={14} aria-hidden="true" className="mt-0.5 flex-none" />
            {t('lab.block.hits', { hits: hits.size, count: rows.length })}
          </span>
        )}
        {error && (
          <p
            role="alert"
            className="bg-red-bg text-red border-red/30 m-0 basis-full rounded-md border px-3 py-2 text-[14px] font-medium"
          >
            {error}
          </p>
        )}
      </header>
      <div className="flex flex-col">
        {rows.map((o, n) => (
          <LabOrderRow
            key={o.id}
            order={o}
            i={i + n}
            now={now}
            desk={desk}
            onSaved={onSaved}
            grouped={{ orderedBy: !oneRequester, waiting: !oneMoment }}
            hit={hits ? hits.has(o.id) : null}
          />
        ))}
      </div>
    </section>
  )
}

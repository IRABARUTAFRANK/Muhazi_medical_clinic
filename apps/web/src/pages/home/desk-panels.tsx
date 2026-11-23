import { useState, type CSSProperties, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  AlarmClock,
  BedDouble,
  CalendarCheck,
  CalendarPlus,
  Check,
  Clock,
  FilePen,
  FolderOpen,
  ListTodo,
  Sparkles,
  Ticket,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf, formatTime, isoDate, type Role } from '@mmc/shared'
import { Empty, Hint, Panel, Pill } from '@/components/dash/kit'
import { PeriodFilter } from '@/components/dash/period-filter'
import { usePeriod } from '@/lib/period'
import { type Tint } from '@/components/dash/kit-style'
import { Button, buttonVariants } from '@/components/ui/button'
import { OpenFileLink } from '@/components/clinical/file-panel'
import { Reveal } from '@/components/ui/reveal'
import { Pager, ShownList } from '@/components/ui/list-tools'
import { usePaged } from '@/lib/paging'
import { StaffLink } from '@/components/staff/staff-link'
import {
  useAppointmentsDay,
  useDeskOps,
  useFilesToComplete,
  useOpenTasks,
  type BoardBed,
  type DayAppointment,
} from '@/lib/api/desk-ops'
import { openItems, useQueueBoard } from '@/lib/api/visits'
import { useStaffSettings } from '@/lib/api/settings'
import { useConfirm } from '@/lib/confirm'
import { focusAttr, useFocusFirst } from '@/lib/notice-focus'
import { FOCUS_PANEL } from '@/lib/notice-target'
import { cn } from '@/lib/utils'
import { StartVisitConfirm } from '@/components/clinical/start-visit-confirm'
import { ArrivalFileCard } from '@/components/clinical/arrival-file-card'
import { useMissingLabel } from '@/components/clinical/use-field-settings'
import { Flash } from '@/components/ui/flash'
import { BedStayForm, StayActions, StayFacts } from '@/components/clinical/bed-stay'
import { stayOf, useBedStays } from '@/lib/api/beds'

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
const errorLine = 'bg-red-bg text-red m-0 rounded-lg px-2.5 py-1.5 text-[13px] font-semibold'
const rowClass =
  'border-grid flex min-h-10 flex-wrap items-center gap-2 border-b py-1.5 text-[14px] last:border-b-0'

/** Runs an action and keeps its error next to the panel that caused it. */
function useRun() {
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      return await fn()
    } catch (e) {
      setError(describe(e))
      return undefined
    }
  }
  return { error, run, setError }
}

const apptTint: Record<string, Tint> = {
  approved: 'navy',
  confirmed: 'teal',
  arrived: 'mint',
  in_progress: 'mint',
  completed: 'mint',
  no_show: 'coral',
  cancelled: 'coral',
  declined: 'coral',
}

/* ---------------------------------------------------------------- appointments */

/**
 * The day's booked patients. "Arrived" opens a visit and queues the patient at triage, so the
 * nurse sees them at once; No-show and Cancel (with a reason) close the booking. A booking
 * without a file (0108) first finds the patient's file or registers them with the clinic's
 * fields; a linked file that still lacks details says so, with "Complete the file".
 */
export function AppointmentsPanel({
  i = 1,
  day = new Date(),
  limit,
  canAct,
  footer,
  onSelect,
  onRebook,
  canArrive,
}: {
  i?: number
  day?: Date
  limit?: number
  canAct: boolean
  footer?: ReactNode
  /** Opens the booking's details (appointments page). */
  onSelect?: (id: string) => void
  /** "Book again" on a booking the doctor declined. */
  onRebook?: (a: DayAppointment) => void
  /** "Arrived" starts a visit (Who may do what: start visits); default: canAct. */
  canArrive?: boolean
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data: appts = [], isLoading } = useAppointmentsDay(day)
  const ops = useDeskOps()
  const confirm = useConfirm()
  const { error, run } = useRun()
  // "Arrived" queues the patient at triage or at the doctor's desk: the clinic's choice (Settings)
  const { data: staffSettings } = useStaffSettings()
  const triageFirst = staffSettings?.triageFirst ?? false
  const waiting = appts.filter((a) => a.status === 'approved' || a.status === 'confirmed')
  // Arrived only on the day itself; no-show once the day has come; cancel until the day is over.
  const dayKey = isoDate(day)
  const todayKey = isoDate(new Date())
  const isToday = dayKey === todayKey
  const isPast = dayKey < todayKey
  const rows = limit ? appts.slice(0, limit) : appts
  const paged = usePaged(rows, limit ? rows.length || 1 : 10, String(day.getTime()))

  // "Arrived" starts the visit (ticket, triage queue, a new bill): asked first.
  const [arriving, setArriving] = useState<DayAppointment | null>(null)
  // a booking without a file: the file is found or registered first (0108)
  const [filing, setFiling] = useState<DayAppointment | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const missingLabel = useMissingLabel()
  const arrive = (a: DayAppointment) =>
    void run(async () => {
      const v = await ops.arrived.mutateAsync({ id: a.id })
      setArriving(null)
      if (v.existing) void navigate({ to: '/app/visit', search: { encounter: v.encounterId } })
    })
  const noShow = async (a: DayAppointment) => {
    if (
      !(await confirm({
        title: t('confirm.desks.appointment.noShow', { name: a.name, time: a.time }),
        body: t('confirm.desks.appointment.noShowBody'),
        confirmLabel: t('confirm.desks.appointment.noShowYes'),
        tone: 'danger',
      }))
    )
      return
    void run(() => ops.outcome.mutateAsync({ id: a.id, status: 'no_show' }))
  }
  const cancel = async (a: DayAppointment) => {
    const r = await confirm({
      title: t('ops.appts.cancelReason', { name: a.name }),
      input: {
        label: t('confirm.reasonLabel'),
        placeholder: t('confirm.reasonPh'),
        required: true,
        multiline: true,
      },
      confirmLabel: t('confirm.desks.appointment.cancelYes'),
      tone: 'danger',
    })
    if (!r.ok) return
    void run(() => ops.outcome.mutateAsync({ id: a.id, status: 'cancelled', reason: r.value }))
  }

  return (
    <Panel
      i={i}
      icon={CalendarCheck}
      tint="violet"
      title={t('desk.receptionist.appointments')}
      right={t('ops.appts.toCome', { count: waiting.length })}
    >
      {error && <p className={errorLine}>{error}</p>}
      {notice && (
        <Flash key={notice} onClose={() => setNotice(null)}>
          {notice}
        </Flash>
      )}
      {!isLoading && rows.length === 0 ? (
        <Empty>{t('desk.receptionist.noAppointments')}</Empty>
      ) : (
        <ShownList items={limit ? rows : paged.slice} step={limit ?? 10}>
          {(shown) => (
            <div className="flex flex-col">
              {shown.map((a, k) => {
                const open = a.status === 'approved' || a.status === 'confirmed'
                return (
                  <div key={a.id} className={rowClass} style={{ '--i': k } as CSSProperties}>
                    <Pill
                      tint={a.late ? 'coral' : (apptTint[a.status] ?? 'teal')}
                      icon={a.late ? AlarmClock : Clock}
                    >
                      {a.time}
                    </Pill>
                    <span className="min-w-[140px] flex-1">
                      {onSelect ? (
                        <button
                          type="button"
                          onClick={() => onSelect(a.id)}
                          className="text-primary block max-w-full text-left font-semibold break-words underline-offset-2 hover:underline"
                        >
                          {a.name}
                        </button>
                      ) : (
                        <span className="block font-semibold break-words">{a.name}</span>
                      )}
                      {open && !a.patientId && (
                        <span className="text-amber block text-[12px] font-semibold">
                          {t('patientFields.arrival.noFileYet')}
                        </span>
                      )}
                      <span className="text-ink-3 block text-[13px] break-words">
                        {[a.doctor, a.reason, a.phone].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'text-[13px] font-semibold',
                        a.late ? 'text-red' : open ? 'text-ink-2' : 'text-ink-3',
                      )}
                    >
                      {a.late ? t('ops.appts.late') : t(`ops.appts.status.${a.status}`)}
                    </span>
                    {/* Arrived needs only "Start visits" (appointment_arrived asks for nothing
                        else that the manager switches); No-show and Cancel answer the booking */}
                    {(canAct || (canArrive ?? canAct)) && open && (
                      <span className="flex flex-wrap gap-1">
                        {isToday && (canArrive ?? canAct) && (
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => {
                              setNotice(null)
                              if (a.patientId) {
                                setFiling(null)
                                setArriving(a)
                              } else {
                                setArriving(null)
                                setFiling(a)
                              }
                            }}
                            disabled={arriving?.id === a.id || filing?.id === a.id}
                            title={
                              a.patientId
                                ? t(
                                    triageFirst
                                      ? 'ops.appts.arrivedHint'
                                      : 'ops.appts.arrivedHintDesk',
                                  )
                                : t('patientFields.arrival.buttonHint')
                            }
                          >
                            {t('ops.appts.arrived')}
                          </Button>
                        )}
                        {canAct && (isToday || isPast) && (
                          <Button size="sm" variant="tint-coral" onClick={() => void noShow(a)}>
                            <X size={14} aria-hidden="true" />
                            {t('ops.appts.noShow')}
                          </Button>
                        )}
                        {canAct && !isPast && (
                          <Button
                            size="sm"
                            variant="tint-coral"
                            aria-label={t('ops.appts.cancel')}
                            title={t('ops.appts.cancel')}
                            onClick={() => void cancel(a)}
                          >
                            <X size={14} aria-hidden="true" />
                          </Button>
                        )}
                      </span>
                    )}
                    {a.status === 'declined' && (
                      <span className="text-ink-3 basis-full text-[13px]">
                        {t('ops.appts.declinedWhy', {
                          doctor: a.doctor ?? '',
                          reason: a.declineReason || '—',
                        })}
                        {a.rebooked && <> · {t('ops.appts.rebooked')}</>}
                      </span>
                    )}
                    {a.status === 'declined' && !a.rebooked && canAct && onRebook && (
                      <Button size="sm" variant="primary" onClick={() => onRebook(a)}>
                        <CalendarPlus size={14} aria-hidden="true" />
                        {t('ops.appts.bookAgain')}
                      </Button>
                    )}
                    {!open &&
                      (a.status === 'arrived' || a.status === 'in_progress') &&
                      (a.encounterId ? (
                        <StaffLink
                          to="/app/visit"
                          search={{ encounter: a.encounterId }}
                          className={buttonVariants({ size: 'sm', variant: 'tint-blue' })}
                        >
                          <FolderOpen size={14} aria-hidden="true" />
                          {t('visits.openVisit')}
                        </StaffLink>
                      ) : (
                        a.patientId && (
                          // the file opens in the side panel; the link underneath keeps
                          // middle-click and ctrl-click on the whole page
                          <OpenFileLink
                            patientId={a.patientId}
                            className={buttonVariants({ size: 'sm', variant: 'tint-blue' })}
                          />
                        )
                      ))}
                    {/* the booked file still lacks what the clinic needs: completed from here */}
                    {open && a.patientId && (a.missing?.length ?? 0) > 0 && (
                      <span className="bg-amber-bg/60 flex basis-full flex-wrap items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px]">
                        <span className="text-amber min-w-0 flex-1 font-semibold">
                          {t('files.lacks', {
                            missing: (a.missing ?? []).map(missingLabel).join(', '),
                          })}
                        </span>
                        <OpenFileLink
                          patientId={a.patientId}
                          tab="complete"
                          className={buttonVariants({ size: 'sm' })}
                        >
                          <FilePen size={14} aria-hidden="true" />
                          {t('files.complete')}
                        </OpenFileLink>
                      </span>
                    )}
                    {filing?.id === a.id && (
                      <ArrivalFileCard
                        appt={a}
                        desk={triageFirst ? 'triage' : 'consultation'}
                        onCancel={() => setFiling(null)}
                        onArrived={(v) => {
                          setFiling(null)
                          setNotice(
                            t(
                              v.newFile
                                ? 'patientFields.arrival.doneNew'
                                : 'patientFields.arrival.doneLinked',
                              {
                                name: v.name,
                                file: v.fileNumber ?? '',
                              },
                            ),
                          )
                          if (v.existing)
                            void navigate({
                              to: '/app/visit',
                              search: { encounter: v.encounterId },
                            })
                        }}
                      />
                    )}
                    {arriving?.id === a.id && (
                      <Reveal block="nearest">
                        <StartVisitConfirm
                          mode="arrival"
                          className="basis-full"
                          name={a.name}
                          desk={triageFirst ? 'triage' : 'consultation'}
                          busy={ops.arrived.isPending}
                          onConfirm={() => arrive(a)}
                          onCancel={() => setArriving(null)}
                        />
                      </Reveal>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </ShownList>
      )}
      {!limit && <Pager {...paged} onPage={paged.setPage} />}
      {footer}
    </Panel>
  )
}

/* ---------------------------------------------------------------- tasks */

/** What doctors asked the nurses to do, with times; "Done" ticks it off (recorded with you). */
export function TasksPanel({
  i = 2,
  canAct = true,
  className,
}: {
  i?: number
  canAct?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const { data: open = [] } = useOpenTasks()
  // a notice points to one task (?focus=task:<id>): it comes first and is outlined
  const tasks = useFocusFirst(open, 'task')
  const ops = useDeskOps()
  const confirm = useConfirm()
  const { error, run } = useRun()
  // asked the same way as on the visit page: "are you sure" and the reason in one box
  const notDone = async (id: string, task: string) => {
    const r = await confirm({
      title: t('confirm.visit.taskNotDone', { task }),
      body: t('confirm.visit.taskNotDoneBody'),
      input: { label: t('ops.tasks.notDoneWhy'), required: true, multiline: true },
      confirmLabel: t('confirm.visit.taskNotDoneYes'),
      tone: 'danger',
    })
    if (r.ok) void run(() => ops.cancelTask.mutateAsync({ id, reason: r.value }))
  }
  const overdue = tasks.filter((x) => x.overdue).length
  return (
    <Panel
      i={i}
      id={FOCUS_PANEL.task}
      icon={ListTodo}
      tint="amber"
      className={className}
      title={t('desk.nurse.tasks')}
      right={t('ops.tasks.count', { count: tasks.length, overdue })}
    >
      {error && <p className={errorLine}>{error}</p>}
      {tasks.length === 0 ? (
        <Empty>{t('desk.nurse.noTasks')}</Empty>
      ) : (
        <ShownList items={tasks} step={5}>
          {(shown) => (
            <div className="flex flex-col">
              {shown.map((x, k) => (
                <div
                  key={x.id}
                  {...focusAttr('task', x.id)}
                  className={rowClass}
                  style={{ '--i': k } as CSSProperties}
                >
                  <Pill tint={x.overdue ? 'coral' : 'teal'} icon={x.overdue ? AlarmClock : Clock}>
                    {x.dueAt ? formatTime(new Date(x.dueAt)) : '—'}
                  </Pill>
                  <span className="min-w-[140px] flex-1">
                    <span className="block font-semibold break-words">{x.title}</span>
                    <span className="text-ink-3 block text-[13px] break-words">
                      {[x.patient, x.detail, x.by && t('ops.tasks.by', { name: x.by })]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  {x.encounterId && (
                    <StaffLink
                      to="/app/visit"
                      search={{ encounter: x.encounterId }}
                      className={buttonVariants({ size: 'sm', variant: 'tint-blue' })}
                    >
                      <FolderOpen size={14} aria-hidden="true" />
                      {t('visits.openVisit')}
                    </StaffLink>
                  )}
                  {canAct && (
                    <>
                      <Button
                        size="sm"
                        variant="tint-coral"
                        onClick={() => void notDone(x.id, x.title)}
                      >
                        <X size={14} aria-hidden="true" />
                        {t('ops.tasks.notDone')}
                      </Button>
                      <Button
                        size="sm"
                        variant="success"
                        onClick={async () => {
                          if (
                            !(await confirm({
                              title: t('confirm.desks.task.done', { task: x.title }),
                              body: x.patient
                                ? t('confirm.desks.task.doneBody', { patient: x.patient })
                                : undefined,
                              confirmLabel: t('confirm.desks.task.doneYes'),
                            }))
                          )
                            return
                          void run(() => ops.completeTask.mutateAsync(x.id))
                        }}
                      >
                        <Check size={14} aria-hidden="true" />
                        {t('common.done')}
                      </Button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </ShownList>
      )}
    </Panel>
  )
}

/* ---------------------------------------------------------------- beds */

const bedTint: Record<BoardBed['state'], string> = {
  free: 'border-green-dot/40 bg-green-bg/50',
  occupied: 'border-primary/30 bg-primary-tint/60',
  cleaning: 'border-yellow-dot/40 bg-yellow-bg/60',
  out_of_service: 'border-border bg-hover opacity-60',
}

/**
 * The beds: give a free bed to a patient in the clinic (0197: for the days expected or not decided
 * yet, and why), move, extend or end a stay (the bed goes to cleaning), mark a bed ready again.
 * 0197: a stay is billed by the day (one day when the bed is given, one more each new day until the
 * stay ends); each occupied bed says since when, the days so far and their amount. The doctor also
 * gives a bed from the visit (step 6), and every stay is on "Patients in beds".
 */
export function BedsPanel({
  i = 1,
  userRole,
  className,
  canAct = true,
  onBedsPage = false,
}: {
  i?: number
  userRole: Role
  className?: string
  /** Give, move, extend, end, mark ready (clinical work, switched in Who may do what). */
  canAct?: boolean
  /** On "Patients in beds": each stay is listed above with its actions; here the bed only says
   *  who is in it (no link to the page itself). */
  onBedsPage?: boolean
}) {
  const { t } = useTranslation()
  const { beds, free } = useBedStays()
  const { data: queue = [] } = useQueueBoard('all', userRole)
  const ops = useDeskOps()
  const confirm = useConfirm()
  const { error, run } = useRun()
  const [admitting, setAdmitting] = useState<string | null>(null)
  const [wide, setWide] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const inBed = new Set(beds.map((b) => b.encounterId).filter(Boolean))
  // Patients in the clinic now who are not already in a bed (one row per visit).
  const candidates = [
    ...new Map(
      openItems(queue)
        .filter((q) => !inBed.has(q.encounterId))
        .map((q) => [q.encounterId, q]),
    ).values(),
  ]
  const done = (m: string) => {
    setAdmitting(null)
    setWide(null)
    setNotice(m)
  }

  return (
    <Panel
      i={i}
      icon={BedDouble}
      tint="navy"
      className={className}
      title={t('desk.nurse.beds')}
      right={t('desk.nurse.bedsFree', { count: free.length })}
      to={onBedsPage ? undefined : '/app/beds'}
      toLabel={onBedsPage ? undefined : t('nav.patientsInBeds')}
    >
      {error && <p className={errorLine}>{error}</p>}
      {notice && (
        <Flash key={notice} onClose={() => setNotice(null)}>
          {notice}
        </Flash>
      )}
      {beds.length === 0 ? (
        <Empty icon={BedDouble}>{t('desk.nurse.noBeds')}</Empty>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,max(12.5rem,calc(50%_-_0.25rem))),1fr))] items-start gap-2">
          {beds.map((b, k) => {
            const stay = stayOf(b)
            const open = admitting === b.id || wide === b.id
            return (
              <div
                key={b.id}
                className={cn(
                  'flex min-w-0 flex-col gap-1.5 rounded-md border px-3 py-2',
                  bedTint[b.state],
                  open && 'col-span-full',
                )}
                style={{ '--i': k } as CSSProperties}
              >
                <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] font-semibold">
                    <BedDouble size={15} aria-hidden="true" className="flex-none" />
                    <span className="min-w-0 break-words">{b.name}</span>
                  </span>
                  <span className="text-ink-3 text-[12px]">{t(`desk.bedState.${b.state}`)}</span>
                </span>
                <span className="text-ink-3 text-[12px] break-words">
                  {t('beds.perDay', { price: formatRwf(b.nightlyPrice) })}
                </span>
                {stay && onBedsPage && (
                  <span className="min-w-0 text-[13px] break-words">
                    <span className="font-semibold">{stay.patient}</span>
                    {' · '}
                    {t('beds.daysSoFar', { count: stay.days })}
                  </span>
                )}
                {stay && !onBedsPage && (
                  <>
                    <span className="text-[13px] font-semibold break-words">{stay.patient}</span>
                    <StayFacts stay={stay} showBed={false} className="flex-col gap-y-0.5" />
                    <span className="flex flex-wrap gap-2">
                      <StaffLink
                        to="/app/visit"
                        search={{ encounter: stay.encounterId }}
                        className={buttonVariants({ size: 'sm', variant: 'tint-blue' })}
                      >
                        <FolderOpen size={14} aria-hidden="true" />
                        {t('visits.openVisit')}
                      </StaffLink>
                    </span>
                    {canAct && (
                      <StayActions
                        stay={stay}
                        free={free}
                        onDone={done}
                        onFormChange={(o) => setWide(o ? b.id : null)}
                      />
                    )}
                  </>
                )}
                {b.state === 'free' &&
                  canAct &&
                  (admitting === b.id ? (
                    <BedStayForm
                      mode="keep"
                      bedId={b.id}
                      free={[b]}
                      candidates={candidates}
                      onCancel={() => setAdmitting(null)}
                      onDone={done}
                    />
                  ) : (
                    <Button size="sm" variant="primary" onClick={() => setAdmitting(b.id)}>
                      <BedDouble size={14} aria-hidden="true" />
                      {t('ops.beds.admit')}
                    </Button>
                  ))}
                {/* clinical work like the rest (bed_ready asks for it); a bed out of service
                    is the manager's to put back, not the nurse's */}
                {b.state === 'cleaning' && canAct && (
                  <Button
                    size="sm"
                    variant="success"
                    onClick={async () => {
                      if (
                        await confirm({
                          title: t('confirm.desks.bed.ready', { bed: b.name }),
                          body: t('confirm.desks.bed.readyBody'),
                          confirmLabel: t('confirm.desks.bed.readyYes'),
                        })
                      )
                        void run(() => ops.ready.mutateAsync(b.id))
                    }}
                  >
                    <Sparkles size={14} aria-hidden="true" />
                    {t('ops.beds.ready')}
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}
      <Hint>{t('beds.panelHint')}</Hint>
    </Panel>
  )
}

/* ---------------------------------------------------------------- files to complete */

/**
 * Patients the nurse registered with what she could (name, sex, age). Reception completes
 * the rest (phone, national ID, address) and then sends the patient on to the doctor.
 */
export function FilesToCompletePanel({ i = 1 }: { i?: number }) {
  const { t } = useTranslation()
  const missingLabel = useMissingLabel()
  // today's files; an earlier day only when the period asks for it (0123)
  const period = usePeriod('today')
  const { data: files = [] } = useFilesToComplete(
    period.range === 'today' ? null : { from: period.from, to: period.to },
  )
  const atReception = files.filter((f) => f.station === 'reception').length
  return (
    <Panel
      i={i}
      icon={FilePen}
      tint="coral"
      title={t('files.title')}
      right={t('files.count', { count: files.length, here: atReception })}
    >
      <PeriodFilter period={period} />
      {files.length === 0 ? (
        <Empty>{t('files.none')}</Empty>
      ) : (
        <ShownList items={files} step={5}>
          {(shown) => (
            <div className="flex flex-col">
              {shown.map((f, k) => (
                <div key={f.patientId} className={rowClass} style={{ '--i': k } as CSSProperties}>
                  <Pill tint={f.station === 'reception' ? 'amber' : 'teal'} icon={Ticket}>
                    {f.ticket ?? '—'}
                  </Pill>
                  <span className="min-w-[140px] flex-1">
                    <span className="block font-semibold break-words">{f.name}</span>
                    <span className="text-ink-3 block text-[13px] break-words">
                      {t('files.lacks', {
                        missing: f.missing.map(missingLabel).join(', '),
                      })}
                      {f.station
                        ? ` · ${t('files.now', { station: t(`register.stations.${f.station}`) })}`
                        : ''}
                    </span>
                  </span>
                  {/* the file opens on its "Complete" tab in the side panel; the link
                      underneath keeps middle-click and ctrl-click on the whole page */}
                  <OpenFileLink
                    patientId={f.patientId}
                    tab="complete"
                    className={buttonVariants({
                      size: 'sm',
                      variant: f.station === 'reception' ? 'primary' : 'default',
                    })}
                  >
                    <FilePen size={14} aria-hidden="true" />
                    {t('files.complete')}
                  </OpenFileLink>
                </div>
              ))}
            </div>
          )}
        </ShownList>
      )}
      <Hint>{t('files.hint')}</Hint>
    </Panel>
  )
}

export { InquiriesPanel } from './inquiries-panel'

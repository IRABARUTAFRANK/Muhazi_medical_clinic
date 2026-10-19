import { useState, type CSSProperties, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Check, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatTime, type Role } from '@mmc/shared'
import { Empty, Panel, Pill } from '@/components/dash/kit'
import { type Tint } from '@/components/dash/kit-style'
import { Button, buttonVariants } from '@/components/ui/button'
import { StaffLink } from '@/components/staff/staff-link'
import {
  useAppointmentsDay,
  useBedBoard,
  useDeskOps,
  useOpenTasks,
  type BoardBed,
  type DayAppointment,
} from '@/lib/api/desk-ops'
import { useHomeActions, useHomeSummary } from '@/lib/api/home'
import { openItems, useQueueBoard } from '@/lib/api/visits'
import { cn } from '@/lib/utils'

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
const errorLine = 'bg-red-bg text-red m-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold'
const rowClass =
  'border-grid anim-enter flex min-h-11 flex-wrap items-center gap-2 border-b py-1.5 text-[13px] last:border-b-0'

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
}

/* ---------------------------------------------------------------- appointments */

/**
 * The day's booked patients. "Arrived" opens a visit and queues the patient at triage, so the
 * nurse sees them at once; No-show and Cancel (with a reason) close the booking.
 */
export function AppointmentsPanel({
  i = 1,
  day = new Date(),
  limit,
  canAct,
  footer,
}: {
  i?: number
  day?: Date
  limit?: number
  canAct: boolean
  footer?: ReactNode
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data: appts = [], isLoading } = useAppointmentsDay(day)
  const ops = useDeskOps()
  const { error, run } = useRun()
  const waiting = appts.filter((a) => a.status === 'approved' || a.status === 'confirmed')
  const rows = limit ? appts.slice(0, limit) : appts

  const arrive = (a: DayAppointment) =>
    void run(async () => {
      const v = await ops.arrived.mutateAsync(a.id)
      if (v.existing) void navigate({ to: '/app/visit', search: { encounter: v.encounterId } })
    })
  const noShow = (a: DayAppointment) =>
    void run(() => ops.outcome.mutateAsync({ id: a.id, status: 'no_show' }))
  const cancel = (a: DayAppointment) => {
    const reason = window.prompt(t('ops.appts.cancelReason', { name: a.name }))
    if (!reason) return
    void run(() => ops.outcome.mutateAsync({ id: a.id, status: 'cancelled', reason }))
  }

  return (
    <Panel
      i={i}
      title={t('desk.receptionist.appointments')}
      right={t('ops.appts.toCome', { count: waiting.length })}
    >
      {error && <p className={errorLine}>{error}</p>}
      {!isLoading && rows.length === 0 ? (
        <Empty>{t('desk.receptionist.noAppointments')}</Empty>
      ) : (
        <div className="flex flex-col">
          {rows.map((a, k) => {
            const open = a.status === 'approved' || a.status === 'confirmed'
            return (
              <div key={a.id} className={rowClass} style={{ '--i': k } as CSSProperties}>
                <Pill tint={a.late ? 'coral' : (apptTint[a.status] ?? 'teal')}>{a.time}</Pill>
                <span className="min-w-[140px] flex-1">
                  <span className="block truncate font-semibold">{a.name}</span>
                  <span className="text-ink-3 block truncate text-xs">
                    {[a.doctor, a.reason, a.phone].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span
                  className={cn(
                    'text-xs font-semibold',
                    a.late ? 'text-red' : open ? 'text-ink-2' : 'text-ink-3',
                  )}
                >
                  {a.late ? t('ops.appts.late') : t(`ops.appts.status.${a.status}`)}
                </span>
                {canAct && open && (
                  <span className="flex gap-1">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => arrive(a)}
                      disabled={!a.patientId}
                      title={
                        a.patientId ? t('ops.appts.arrivedHint') : t('ops.appts.registerFirst')
                      }
                    >
                      {t('ops.appts.arrived')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => noShow(a)}>
                      {t('ops.appts.noShow')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t('ops.appts.cancel')}
                      title={t('ops.appts.cancel')}
                      onClick={() => cancel(a)}
                    >
                      <X size={14} aria-hidden="true" />
                    </Button>
                  </span>
                )}
                {!open && a.patientId && (a.status === 'arrived' || a.status === 'in_progress') && (
                  <StaffLink
                    to="/app/patient"
                    search={{ id: a.patientId }}
                    className={buttonVariants({ size: 'sm' })}
                  >
                    {t('patients.openFile')}
                  </StaffLink>
                )}
              </div>
            )
          })}
        </div>
      )}
      {footer}
    </Panel>
  )
}

/* ---------------------------------------------------------------- inquiries */

/**
 * Booking requests from the website or phone. Approve links them to the patient's file
 * (matched by phone); the doctor then accepts. Reject asks for a reason.
 */
export function InquiriesPanel({ i = 2, canAct }: { i?: number; canAct: boolean }) {
  const { t } = useTranslation()
  const { data } = useHomeSummary()
  const actions = useHomeActions()
  const { error, run } = useRun()
  const inquiries = data?.inquiries ?? []

  const approve = (id: string) => void run(() => actions.approveInquiry.mutateAsync({ id }))
  const reject = (id: string, name: string) => {
    const reason = window.prompt(t('ops.inquiries.rejectReason', { name }))
    if (!reason) return
    void run(() => actions.rejectInquiry.mutateAsync({ id, reason }))
  }

  return (
    <Panel i={i} title={t('desk.receptionist.inquiries')} right={String(inquiries.length)}>
      {error && (
        <p className={errorLine}>
          {error}
          {/register the patient first/i.test(error) && (
            <>
              {' '}
              <StaffLink to="/app/register" className="underline">
                {t('ops.inquiries.registerNow')}
              </StaffLink>
            </>
          )}
        </p>
      )}
      {inquiries.length === 0 ? (
        <Empty>{t('desk.receptionist.noInquiries')}</Empty>
      ) : (
        <div className="flex flex-col">
          {inquiries.slice(0, 8).map((q, k) => (
            <div key={q.id} className={rowClass} style={{ '--i': k } as CSSProperties}>
              <Pill tint="violet">{q.when ?? '?'}</Pill>
              <span className="min-w-[140px] flex-1">
                <span className="block truncate font-semibold">{q.name}</span>
                <span className="text-ink-3 block truncate text-xs">
                  {[q.phone, q.doctor, q.note].filter(Boolean).join(' · ')}
                </span>
              </span>
              {canAct && (
                <span className="flex gap-1">
                  <Button size="sm" variant="primary" onClick={() => approve(q.id)}>
                    <Check size={14} aria-hidden="true" />
                    {t('common.approve')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => reject(q.id, q.name)}>
                    {t('ops.inquiries.reject')}
                  </Button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="text-ink-3 m-0 text-xs">{t('ops.inquiries.hint')}</p>
    </Panel>
  )
}

/* ---------------------------------------------------------------- tasks */

/** What doctors asked the nurses to do, with times; "Done" ticks it off (recorded with you). */
export function TasksPanel({ i = 2 }: { i?: number }) {
  const { t } = useTranslation()
  const { data: tasks = [] } = useOpenTasks()
  const ops = useDeskOps()
  const { error, run } = useRun()
  const overdue = tasks.filter((x) => x.overdue).length
  return (
    <Panel
      i={i}
      title={t('desk.nurse.tasks')}
      right={t('ops.tasks.count', { count: tasks.length, overdue })}
    >
      {error && <p className={errorLine}>{error}</p>}
      {tasks.length === 0 ? (
        <Empty>{t('desk.nurse.noTasks')}</Empty>
      ) : (
        <div className="flex flex-col">
          {tasks.slice(0, 8).map((x, k) => (
            <div key={x.id} className={rowClass} style={{ '--i': k } as CSSProperties}>
              <Pill tint={x.overdue ? 'coral' : 'teal'}>
                {x.dueAt ? formatTime(new Date(x.dueAt)) : '—'}
              </Pill>
              <span className="min-w-[140px] flex-1">
                <span className="block truncate font-semibold">{x.title}</span>
                <span className="text-ink-3 block truncate text-xs">
                  {[x.patient, x.detail, x.by && t('ops.tasks.by', { name: x.by })]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              {x.encounterId && (
                <StaffLink
                  to="/app/visit"
                  search={{ encounter: x.encounterId }}
                  className={buttonVariants({ size: 'sm', variant: 'ghost' })}
                >
                  {t('visits.openVisit')}
                </StaffLink>
              )}
              <Button
                size="sm"
                variant="primary"
                onClick={() => void run(() => ops.completeTask.mutateAsync(x.id))}
              >
                <Check size={14} aria-hidden="true" />
                {t('common.done')}
              </Button>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

/* ---------------------------------------------------------------- beds */

const bedTint: Record<BoardBed['state'], string> = {
  free: 'border-green-dot/40 bg-green-bg/50',
  occupied: 'border-primary/30 bg-primary-tint/60',
  cleaning: 'border-amber/30 bg-amber-bg/60',
  out_of_service: 'border-border bg-hover opacity-60',
}

/**
 * Short-stay beds: admit a patient who is in the clinic, discharge (the bed goes to
 * cleaning), mark it ready again.
 */
export function BedsPanel({ i = 1, userRole }: { i?: number; userRole: Role }) {
  const { t } = useTranslation()
  const { data: beds = [] } = useBedBoard()
  const { data: queue = [] } = useQueueBoard('all', userRole)
  const ops = useDeskOps()
  const { error, run } = useRun()
  const [admitting, setAdmitting] = useState<string | null>(null)
  const inBed = new Set(beds.map((b) => b.encounterId).filter(Boolean))
  // Patients in the clinic now who are not already in a bed (one row per visit).
  const candidates = [
    ...new Map(
      openItems(queue)
        .filter((q) => !inBed.has(q.encounterId))
        .map((q) => [q.encounterId, q]),
    ).values(),
  ]
  const free = beds.filter((b) => b.state === 'free').length

  return (
    <Panel i={i} title={t('desk.nurse.beds')} right={t('desk.nurse.bedsFree', { count: free })}>
      {error && <p className={errorLine}>{error}</p>}
      {beds.length === 0 ? (
        <Empty>{t('desk.nurse.noBeds')}</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {beds.map((b, k) => (
            <div
              key={b.id}
              className={cn(
                'anim-enter flex flex-col gap-1 rounded-xl border px-3 py-2',
                bedTint[b.state],
              )}
              style={{ '--i': k } as CSSProperties}
            >
              <span className="flex items-center justify-between gap-1">
                <span className="text-xs font-bold">{b.name}</span>
                <span className="text-ink-3 text-[11px]">
                  {t(`desk.bedState.${b.state}`)}
                  {b.since ? ` · ${formatTime(new Date(b.since))}` : ''}
                </span>
              </span>
              {b.patient && <span className="truncate text-[12px] font-semibold">{b.patient}</span>}
              {b.state === 'free' &&
                (admitting === b.id ? (
                  <select
                    autoFocus
                    className="border-border bg-card h-9 rounded-lg border px-2 text-[12px]"
                    defaultValue=""
                    onChange={(e) => {
                      const q = candidates.find((c) => c.encounterId === e.target.value)
                      if (!q) return
                      setAdmitting(null)
                      void run(() =>
                        ops.admit.mutateAsync({
                          bedId: b.id,
                          encounterId: q.encounterId,
                          patient: q.name,
                        }),
                      )
                    }}
                    onBlur={() => setAdmitting(null)}
                  >
                    <option value="" disabled>
                      {candidates.length ? t('ops.beds.pick') : t('ops.beds.nobody')}
                    </option>
                    {candidates.map((c) => (
                      <option key={c.encounterId} value={c.encounterId}>
                        {c.ticket} · {c.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Button size="sm" onClick={() => setAdmitting(b.id)}>
                    {t('ops.beds.admit')}
                  </Button>
                ))}
              {b.state === 'occupied' && (
                <span className="flex flex-wrap gap-1">
                  {b.encounterId && (
                    <StaffLink
                      to="/app/visit"
                      search={{ encounter: b.encounterId }}
                      className={buttonVariants({ size: 'sm', variant: 'ghost' })}
                    >
                      {t('visits.openVisit')}
                    </StaffLink>
                  )}
                  <Button
                    size="sm"
                    onClick={() => {
                      if (window.confirm(t('ops.beds.confirmDischarge', { name: b.patient ?? '' })))
                        void run(() => ops.discharge.mutateAsync(b.id))
                    }}
                  >
                    {t('ops.beds.discharge')}
                  </Button>
                </span>
              )}
              {(b.state === 'cleaning' || b.state === 'out_of_service') && (
                <Button size="sm" onClick={() => void run(() => ops.ready.mutateAsync(b.id))}>
                  {t('ops.beds.ready')}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

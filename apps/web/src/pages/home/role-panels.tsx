import { useState, type CSSProperties, type ReactNode } from 'react'
import {
  Activity,
  AlarmClock,
  ArrowRight,
  ArrowRightLeft,
  BedDouble,
  Building2,
  CalendarCheck,
  CalendarDays,
  Check,
  CircleCheck,
  Clock,
  FileText,
  FlaskConical,
  HandHelping,
  Hourglass,
  ListTodo,
  Lock,
  MessageSquare,
  Receipt,
  Stethoscope,
  UserRoundCheck,
  Users,
  Wallet,
  X,
} from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { formatDuration } from '@/lib/duration'
import { rowSignature, useChanged } from '@/lib/motion'
import {
  formatDate,
  formatRwf,
  formatTime,
  type ApptStatus,
  type HomeRole,
  type QueueCounts,
  type QueueRow,
} from '@mmc/shared'
import { Empty, Hint, Panel, Pill } from '@/components/dash/kit'
import { triageIcon, type Tint } from '@/components/dash/kit-style'
import { Button, actionLink, buttonVariants } from '@/components/ui/button'
import { controlClass, labelClass } from '@/components/ui/field'
import { Reveal } from '@/components/ui/reveal'
import { ShownList } from '@/components/ui/list-tools'
import { StaffLink } from '@/components/staff/staff-link'
import { useHomeActions, type HomeBed, type HomeSummary } from '@/lib/api/home'
import { useTakePatient } from '@/lib/api/visits'
import { useConfirm } from '@/lib/confirm'
import { useSessionCan } from '@/components/clinical/session-desks'
import { HandoverBadge } from '@/components/clinical/handover-badge'
import type { QueueHandover } from '@/lib/api/visits'
import { useSession } from '@/store/session'
import { cn } from '@/lib/utils'

/*
 * Panels of the role homes (doctor, cashier, and the lab / pharmacy / sonography desks that
 * share the doctor home) in the dashboard kit: icon-titled panels, rows with symbol pills,
 * the same sizes as the manager, reception and nursing dashboards.
 */

const apptTint: Record<ApptStatus, Tint> = { arrived: 'mint', due: 'teal', late: 'coral' }
const apptIcon = { arrived: CircleCheck, due: Clock, late: AlarmClock } as const
const triageTint: Record<string, Tint> = { red: 'coral', yellow: 'amber', green: 'mint' }
const bedClass: Record<HomeBed['state'], string> = {
  occupied: 'bg-hover text-ink border-border',
  free: 'bg-green-bg text-green border-green-dot/30',
  cleaning: 'bg-yellow-bg text-yellow border-yellow-dot/30',
  out_of_service: 'bg-red-bg text-red border-red-dot/30',
}
const rowClass =
  'border-grid flex min-h-10 flex-wrap items-center gap-2.5 border-b py-1.5 text-[14px] last:border-b-0'
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
// "24/10/2026 10:30" for a datetime-local value
const at = (v: string) => `${formatDate(new Date(v))} ${formatTime(new Date(v))}`

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="border-red/25 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium"
    >
      {children}
    </p>
  )
}

/* ---------------------------------------------------------------- my queue */

export function MyQueuePanel({
  title,
  rows,
  counts,
  rowAction,
}: {
  title: string
  rows: (QueueRow & {
    queueId?: string
    poolId?: string | null
    takenBy?: string | null
    referredBy?: string | null
    referralNote?: string | null
    assignedName?: string | null
    vitalsAt?: string | null
    departmentName?: string | null
    canWork?: boolean
    service?: string | null
    /** 0088: handed over by a colleague (waiting for an answer, or taken). */
    handover?: QueueHandover | null
  })[]
  counts: QueueCounts
  rowAction: 'open' | 'call'
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const take = useTakePatient()
  const confirm = useConfirm()
  // a patient at triage opens on the triage form for whoever may record vital signs
  const can = useSessionCan()
  const me = useSession((s) => s.user?.id)
  const [error, setError] = useState<string | null>(null)
  // "Take": claims the patient here (a shared patient leaves the other desks), then opens the visit
  // (a patient at triage opens on the triage form).
  const takeAndOpen = async (q: {
    queueId?: string
    encounterId?: string
    station?: string
    name: string
    ticket: string
    takenBy?: string | null
  }) => {
    // taking claims the patient: ask first (opening one already taken does not)
    if (
      q.queueId &&
      !q.takenBy &&
      !(await confirm({
        title: t('confirm.desks.queue.take', { name: q.name, ticket: q.ticket }),
        body: t('confirm.desks.queue.takeBody'),
        confirmLabel: t('confirm.desks.queue.takeYes'),
      }))
    )
      return
    setError(null)
    try {
      if (q.queueId) await take.mutateAsync(q.queueId)
      if (q.encounterId)
        await navigate({
          to: q.station === 'triage' && can('vitals.write') ? '/app/vitals' : '/app/visit',
          search: { encounter: q.encounterId },
        })
    } catch (e) {
      setError(describe(e))
    }
  }
  // a row whose patient moved (triage colour, station, taken by) flashes once
  const changed = useChanged(rows, (q) => q.queueId ?? q.ticket, rowSignature)
  return (
    <Panel
      i={1}
      icon={Users}
      tint="amber"
      title={title}
      right={`${t('home.waiting', { count: counts.waiting })} · ${t('home.inProgress', { count: counts.inProgress })} · ${t('home.done', { count: counts.done })}`}
    >
      {error && <ErrorBox>{error}</ErrorBox>}
      {rows.length === 0 ? (
        <Empty>{t('home.emptyQueueTitle')}</Empty>
      ) : (
        <ShownList items={rows} step={5}>
          {(shown) => (
            <div className="flex flex-col">
              {shown.map((q, i) => (
                <div
                  // the change count in the key replays the flash on the next change
                  key={`${q.queueId ?? q.ticket}:${changed.get(q.queueId ?? q.ticket) ?? 0}`}
                  className={cn(rowClass, changed.get(q.queueId ?? q.ticket) && 'anim-row')}
                  style={{ '--i': i } as CSSProperties}
                >
                  <Pill tint={triageTint[q.triage] ?? 'teal'} icon={triageIcon[q.triage]}>
                    {q.ticket}
                  </Pill>
                  <span className="min-w-[140px] flex-1">
                    <span className="block truncate font-semibold">{q.name}</span>
                    <span className="text-ink-3 flex flex-wrap items-center gap-x-2 text-[13px]">
                      <span>{q.ageSex}</span>
                      {/* what the patient comes for (chosen at registration) */}
                      {q.service && (
                        <span className="text-primary font-semibold">
                          {q.service === 'pharmacy'
                            ? t('register.stations.pharmacy')
                            : t('categories.' + q.service, { defaultValue: q.service })}
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1">
                        <Hourglass size={12} aria-hidden="true" />
                        {formatDuration(q.waitMin, t)}
                      </span>
                      {q.insurer && (
                        <span className="inline-flex items-center gap-1">
                          <Wallet size={12} aria-hidden="true" />
                          {q.insurer}
                        </span>
                      )}
                      {'vitalsAt' in q && !q.vitalsAt && (
                        <span className="text-yellow inline-flex items-center gap-1 font-semibold">
                          <Activity size={12} aria-hidden="true" />
                          {t('vitalsForm.noneShort')}
                        </span>
                      )}
                      {q.poolId && (
                        <span className="text-blue inline-flex items-center gap-1 font-semibold">
                          <Users size={12} aria-hidden="true" />
                          {t('home.sharedQueue')}
                        </span>
                      )}
                      {q.referredBy && (
                        <span
                          className="text-blue inline-flex items-center gap-1 font-semibold"
                          title={q.referralNote ?? undefined}
                        >
                          <ArrowRightLeft size={12} aria-hidden="true" />
                          {t('refer.from', { name: q.referredBy })}
                          {q.assignedName ? ` → ${q.assignedName}` : ''}
                        </span>
                      )}
                      {q.departmentName && !q.assignedName && (
                        <span className="text-blue inline-flex items-center gap-1 font-semibold">
                          <Building2 size={12} aria-hidden="true" />
                          {q.departmentName}
                        </span>
                      )}
                      <HandoverBadge handover={q.handover} />
                      {q.takenBy && (
                        <span className="text-primary inline-flex items-center gap-1 font-semibold">
                          <Stethoscope size={12} aria-hidden="true" />
                          {t('home.takenBy', { name: q.takenBy })}
                        </span>
                      )}
                    </span>
                  </span>
                  {q.encounterId && q.handover?.status === 'pending' && q.handover.toId === me ? (
                    // handed over to me: Take or Decline on the visit (the patient is not mine yet)
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() =>
                        void navigate({ to: '/app/visit', search: { encounter: q.encounterId! } })
                      }
                    >
                      <UserRoundCheck size={14} aria-hidden="true" />
                      {t('handover.answer')}
                    </Button>
                  ) : q.encounterId && q.canWork === false ? (
                    // sent to someone else: in the clinic, but not ours to work on
                    <Button
                      size="sm"
                      variant="tint-blue"
                      title={t('access.notYours', {
                        holder: q.takenBy ?? q.assignedName ?? q.departmentName ?? '',
                      })}
                      onClick={() =>
                        void navigate({ to: '/app/visit', search: { encounter: q.encounterId! } })
                      }
                    >
                      <Lock size={14} aria-hidden="true" />
                      {t('access.view')}
                    </Button>
                  ) : q.encounterId ? (
                    <Button
                      size="sm"
                      variant={i === 0 ? 'primary' : 'default'}
                      loading={take.isPending && take.variables === q.queueId}
                      onClick={() => void takeAndOpen(q)}
                    >
                      <HandHelping size={14} aria-hidden="true" />
                      {t(q.takenBy ? 'common.open' : 'home.take')}
                    </Button>
                  ) : (
                    <StaffLink
                      to="/app/queue"
                      className={buttonVariants({
                        size: 'sm',
                        variant: i === 0 ? 'primary' : 'default',
                      })}
                    >
                      {t(rowAction === 'open' ? 'common.open' : 'common.call')}
                    </StaffLink>
                  )}
                </div>
              ))}
            </div>
          )}
        </ShownList>
      )}
      <StaffLink to="/app/visits" className={cn(actionLink, 'self-start text-[13px]')}>
        {t('desk.allInClinic')}
        <ArrowRight size={14} aria-hidden="true" />
      </StaffLink>
    </Panel>
  )
}

/* ---------------------------------------------------------------- per role */

/** What this role must do next, live from `home_summary()`. */
export function RolePanels({ role, data }: { role: HomeRole; data: HomeSummary }) {
  const [actionError, setActionError] = useState<string | null>(null)
  const common = { data, onError: setActionError }
  return (
    <>
      {actionError && (
        <div className="pc:col-span-2">
          <ErrorBox>{actionError}</ErrorBox>
        </div>
      )}
      {role === 'receptionist' && <ReceptionistPanels {...common} />}
      {role === 'nurse' && <NursePanels {...common} />}
      {role === 'doctor' && <DoctorPanels {...common} />}
      {role === 'cashier' && <CashierPanels {...common} />}
    </>
  )
}

interface PanelProps {
  data: HomeSummary
  onError: (m: string | null) => void
}

function ReceptionistPanels({ data, onError }: PanelProps) {
  const { t } = useTranslation()
  const actions = useHomeActions()
  const confirm = useConfirm()
  const appts = data.appointments
  const approve = async (id: string, name: string) => {
    if (
      !(await confirm({
        title: t('confirm.desks.inquiry.approve', { name }),
        body: t('confirm.desks.inquiry.approveBody'),
        confirmLabel: t('confirm.desks.inquiry.approveYes'),
      }))
    )
      return
    onError(null)
    try {
      await actions.approveInquiry.mutateAsync({ id })
    } catch (e) {
      onError(t('home.inquiryApproveFailed', { message: describe(e) }))
    }
  }
  const reject = async (id: string) => {
    const reason = window.prompt(t('home.inquiryRejectReason'))
    if (!reason) return
    onError(null)
    try {
      await actions.rejectInquiry.mutateAsync({ id, reason })
    } catch (e) {
      onError(describe(e))
    }
  }
  return (
    <>
      <Panel
        i={2}
        icon={CalendarCheck}
        tint="violet"
        title={t('home.todaysAppointments')}
        right={t('home.arrived', { count: appts.filter((a) => a.status === 'arrived').length })}
      >
        {appts.length === 0 ? (
          <Empty>{t('home.noAppointmentsTitle')}</Empty>
        ) : (
          <ShownList items={appts} step={5}>
            {(shown) => (
              <div className="flex flex-col">
                {shown.map((a, i) => (
                  <div key={a.id} className={rowClass} style={{ '--i': i } as CSSProperties}>
                    <Pill tint={apptTint[a.status]} icon={apptIcon[a.status]}>
                      {a.time}
                    </Pill>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{a.name}</span>
                      <span className="text-ink-3 block truncate text-[13px]">
                        {a.doctor}
                        {a.station ? ` · ${a.station}` : ''}
                      </span>
                    </span>
                    <span className="text-ink-2 text-[13px] font-semibold">
                      {t(`home.apptStatus.${a.status}`)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </ShownList>
        )}
      </Panel>
      <Panel
        i={3}
        icon={MessageSquare}
        tint="teal"
        title={t('home.inquiries')}
        right={t('home.pending', { count: data.inquiries.length })}
      >
        {data.inquiries.length === 0 && <Empty>{t('home.noInquiries')}</Empty>}
        <ShownList items={data.inquiries} step={5}>
          {(shown) => (
            <div className="flex flex-col">
              {shown.map((q, i) => (
                <div key={q.id} className={rowClass} style={{ '--i': i } as CSSProperties}>
                  <Pill tint="violet" icon={MessageSquare}>
                    {q.when ?? '?'}
                  </Pill>
                  <span className="min-w-[140px] flex-1">
                    <span className="block truncate font-semibold">{q.name}</span>
                    <span className="text-ink-3 block truncate text-[13px]">
                      {[q.category && t(`categories.${q.category}`), q.doctor, q.phone, q.note]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="flex gap-1">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={actions.approveInquiry.isPending}
                      onClick={() => void approve(q.id, q.name)}
                    >
                      <Check size={14} aria-hidden="true" />
                      {t('common.approve')}
                    </Button>
                    <Button
                      variant="tint-coral"
                      size="sm"
                      disabled={actions.rejectInquiry.isPending}
                      onClick={() => void reject(q.id)}
                    >
                      <X size={14} aria-hidden="true" />
                      {t('common.reject')}
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </ShownList>
      </Panel>
      {/* the manager's home uses these panels: the bookings made with the manager's own calendar */}
      {data.toAccept.length > 0 && <ToAcceptPanel items={data.toAccept} onError={onError} />}
    </>
  )
}

function NursePanels({ data, onError }: PanelProps) {
  const { t } = useTranslation()
  const actions = useHomeActions()
  const occupied = data.beds.filter((b) => b.state === 'occupied').length
  const free = data.beds.filter((b) => b.state === 'free').length
  const confirm = useConfirm()
  const done = async (id: string, title: string, patient?: string | null) => {
    if (
      !(await confirm({
        title: t('confirm.desks.task.done', { task: title }),
        body: patient ? t('confirm.desks.task.doneBody', { patient }) : undefined,
        confirmLabel: t('confirm.desks.task.doneYes'),
      }))
    )
      return
    onError(null)
    try {
      await actions.completeTask.mutateAsync({ id })
    } catch (e) {
      onError(describe(e))
    }
  }
  return (
    <>
      <Panel
        i={2}
        icon={ListTodo}
        tint="amber"
        title={t('home.tasksDue')}
        right={t('home.overdue', { count: data.tasks.filter((x) => x.overdue).length })}
      >
        {data.tasks.length === 0 && <Empty>{t('home.noTasks')}</Empty>}
        <ShownList items={data.tasks} step={5}>
          {(shown) => (
            <div className="flex flex-col">
              {shown.map((task, i) => (
                <div key={task.id} className={rowClass} style={{ '--i': i } as CSSProperties}>
                  <Pill
                    tint={task.overdue ? 'coral' : 'teal'}
                    icon={task.overdue ? AlarmClock : Clock}
                  >
                    {task.time ?? '—'}
                  </Pill>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{task.title}</span>
                    <span className="text-ink-3 block truncate text-[13px]">
                      {[task.patient, task.detail].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="success"
                    onClick={() => void done(task.id, task.title, task.patient)}
                  >
                    <Check size={14} aria-hidden="true" />
                    {t('common.done')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ShownList>
      </Panel>
      <Panel
        i={3}
        icon={BedDouble}
        tint="navy"
        title={t('home.bedBoard')}
        right={t('home.bedSummary', { occupied, free })}
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {data.beds.map((b, i) => (
            <div
              key={b.name}
              className={cn(
                'flex min-h-14 flex-col gap-0.5 rounded-md border px-3 py-2 text-[13px]',
                bedClass[b.state],
              )}
              style={{ '--i': i } as CSSProperties}
            >
              <span className="inline-flex items-center gap-1.5 font-semibold">
                <BedDouble size={15} aria-hidden="true" />
                {b.name}
              </span>
              <span className="truncate">
                {b.state === 'occupied' ? (b.who ?? '') : t(`home.bedState.${b.state}`)}
              </span>
            </div>
          ))}
        </div>
      </Panel>
      {/* a nurse keeps a calendar (0094): the bookings made with them */}
      {data.toAccept.length > 0 && <ToAcceptPanel items={data.toAccept} onError={onError} />}
    </>
  )
}

function DoctorPanels({ data, onError }: PanelProps) {
  const { t } = useTranslation()
  const mine = data.appointments.filter((a) => a.mine)
  const actions = useHomeActions()
  const confirm = useConfirm()
  return (
    <>
      <Panel
        i={2}
        icon={FlaskConical}
        tint="violet"
        title={t('home.resultsInbox')}
        right={t('home.resultsCount', { count: data.results.length })}
      >
        {data.results.length === 0 && <Empty>{t('home.noResults')}</Empty>}
        <ShownList items={data.results} step={5}>
          {(shown) => (
            <div className="flex flex-col">
              {shown.map((r, i) => (
                <div key={r.id} className={rowClass} style={{ '--i': i } as CSSProperties}>
                  <Pill
                    tint={!r.verified ? 'amber' : r.reviewed ? 'teal' : 'mint'}
                    icon={r.verified ? CircleCheck : Hourglass}
                  >
                    {t(
                      !r.verified ? 'home.unverified' : r.reviewed ? 'home.seen' : 'home.verified',
                    )}
                  </Pill>
                  <span className="min-w-[160px] flex-1">
                    <span className="block font-semibold">
                      {r.test} · {r.name}
                    </span>
                    <span className="text-ink-3 block text-[13px] tabular-nums">
                      {r.impression} · {r.at}
                      {r.corrected ? ` · ${t('home.correctedResult')}` : ''}
                    </span>
                  </span>
                  {r.verified && !r.reviewed && (
                    <Button
                      size="sm"
                      variant="tint-mint"
                      onClick={async () => {
                        if (
                          !(await confirm({
                            title: t('confirm.desks.result.seen', { test: r.test, name: r.name }),
                            body: t('confirm.desks.result.seenBody'),
                            confirmLabel: t('confirm.desks.result.seenYes'),
                          }))
                        )
                          return
                        void actions.markReviewed
                          .mutateAsync(r.id)
                          .catch((e: unknown) => onError(describe(e)))
                      }}
                    >
                      <Check size={14} aria-hidden="true" />
                      {t('home.markSeen')}
                    </Button>
                  )}
                  <StaffLink
                    to="/app/visit"
                    search={{ encounter: r.encounterId }}
                    className={buttonVariants({ size: 'sm', variant: 'tint-blue' })}
                  >
                    <FileText size={14} aria-hidden="true" />
                    {t('common.open')}
                  </StaffLink>
                </div>
              ))}
            </div>
          )}
        </ShownList>
      </Panel>
      <div className="flex min-w-0 flex-col gap-4">
        <Panel i={3} icon={CalendarDays} tint="teal" title={t('home.todaysCalendar')}>
          {mine.length === 0 && <Empty>{t('home.noCalendar')}</Empty>}
          <ShownList items={mine} step={5}>
            {(shown) => (
              <div className="flex flex-col">
                {shown.map((c, i) => (
                  <div key={c.id} className={rowClass} style={{ '--i': i } as CSSProperties}>
                    <Pill tint={apptTint[c.status]} icon={apptIcon[c.status]}>
                      {c.time}
                    </Pill>
                    <span className="min-w-0 flex-1 truncate font-semibold">{c.name}</span>
                    <span className="text-ink-2 text-[13px] font-semibold">
                      {t(`home.apptStatus.${c.status}`)}
                    </span>
                    {c.encounterId && (
                      <StaffLink
                        to="/app/visit"
                        search={{ encounter: c.encounterId }}
                        className={buttonVariants({ size: 'sm', variant: 'tint-blue' })}
                      >
                        <FileText size={14} aria-hidden="true" />
                        {t('common.open')}
                      </StaffLink>
                    )}
                  </div>
                ))}
              </div>
            )}
          </ShownList>
        </Panel>
        <ToAcceptPanel items={data.toAccept} onError={onError} />
      </div>
    </>
  )
}

/** Bookings approved by reception that this practitioner (doctor, sonographer) accepts or declines. */
export function ToAcceptPanel({
  items,
  onError,
}: {
  items: HomeSummary['toAccept']
  onError: (message: string | null) => void
}) {
  const { t } = useTranslation()
  const actions = useHomeActions()
  const confirm = useConfirm()
  // "Another time": the doctor arranges the day by priority before accepting
  const [moving, setMoving] = useState<string | null>(null)
  const [newTime, setNewTime] = useState('')
  const localInput = (iso?: string | null) => {
    if (!iso) return ''
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const accept = async (id: string, name: string, when: string, startsAt?: string) => {
    if (
      !(await confirm({
        title: t('confirm.desks.appointment.accept', {
          name,
          when: startsAt ? at(startsAt) : when,
        }),
        body: t('confirm.desks.appointment.acceptBody'),
        confirmLabel: t('confirm.desks.appointment.acceptYes'),
      }))
    )
      return
    onError(null)
    try {
      await actions.acceptAppointment.mutateAsync({
        id,
        startsAt: startsAt ? new Date(startsAt).toISOString() : null,
      })
      setMoving(null)
    } catch (e) {
      onError(describe(e))
    }
  }
  const decline = async (id: string) => {
    const reason = window.prompt(t('home.declineReason'))
    if (!reason) return
    onError(null)
    try {
      await actions.declineAppointment.mutateAsync({ id, reason })
    } catch (e) {
      onError(describe(e))
    }
  }
  const data = { toAccept: items }
  return (
    <Panel
      i={4}
      icon={MessageSquare}
      tint="amber"
      title={t('home.inquiriesToAccept')}
      right={String(data.toAccept.length)}
    >
      {data.toAccept.length === 0 && <Empty>{t('home.nothingToAccept')}</Empty>}
      <ShownList items={data.toAccept} step={5}>
        {(shown) => (
          <div className="flex flex-col">
            {shown.map((q, i) => (
              <div key={q.id} className={rowClass} style={{ '--i': i } as CSSProperties}>
                <Pill tint="violet" icon={CalendarCheck}>
                  {q.when}
                </Pill>
                <span className="min-w-[140px] flex-1">
                  <span className="block truncate font-semibold">{q.name}</span>
                  {(q.note || q.category) && (
                    <span className="text-ink-3 block text-[13px]">
                      {[q.category, q.note].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </span>
                <span className="flex flex-wrap gap-1">
                  <Button
                    variant="success"
                    size="sm"
                    onClick={() => void accept(q.id, q.name, q.when)}
                  >
                    <Check size={14} aria-hidden="true" />
                    {t('common.accept')}
                  </Button>
                  <Button
                    size="sm"
                    variant="tint-amber"
                    onClick={() => {
                      setMoving(moving === q.id ? null : q.id)
                      setNewTime(localInput(q.startsAt))
                    }}
                  >
                    <Clock size={14} aria-hidden="true" />
                    {t('home.otherTime')}
                  </Button>
                  <Button variant="tint-coral" size="sm" onClick={() => void decline(q.id)}>
                    <X size={14} aria-hidden="true" />
                    {t('common.decline')}
                  </Button>
                </span>
                {moving === q.id && (
                  <Reveal focus block="nearest">
                    <span className="flex basis-full flex-wrap items-end gap-2">
                      <label className={labelClass}>
                        {t('home.newTime')}
                        <input
                          type="datetime-local"
                          step={300}
                          value={newTime}
                          onChange={(e) => setNewTime(e.target.value)}
                          className={controlClass}
                        />
                      </label>
                      <Button
                        variant="success"
                        size="sm"
                        className="mb-0.5"
                        disabled={!newTime}
                        onClick={() => void accept(q.id, q.name, q.when, newTime)}
                      >
                        <Check size={14} aria-hidden="true" />
                        {t('home.acceptAt')}
                      </Button>
                    </span>
                  </Reveal>
                )}
              </div>
            ))}
          </div>
        )}
      </ShownList>
    </Panel>
  )
}

function CashierPanels({ data }: PanelProps) {
  const { t } = useTranslation()
  const due = data.openBills.reduce((s, b) => s + b.balance, 0)
  return (
    <>
      <Panel
        i={2}
        icon={Receipt}
        tint="coral"
        title={t('home.openBills')}
        right={t('home.billsDue', { count: data.openBills.length, amount: formatRwf(due) })}
      >
        {data.openBills.length === 0 && <Empty>{t('home.noOpenBills')}</Empty>}
        <ShownList items={data.openBills} step={5}>
          {(shown) => (
            <div className="flex flex-col">
              {shown.map((b, i) => (
                <div key={b.encounterId} className={rowClass} style={{ '--i': i } as CSSProperties}>
                  <Pill tint="amber" icon={Receipt}>
                    {b.ticket ?? '—'}
                  </Pill>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{b.name}</span>
                    <span className="text-ink-3 block truncate text-[13px]">
                      {b.file}
                      {b.station
                        ? ` · ${t('home.atStation', { station: t(`register.stations.${b.station}`) })}`
                        : ''}
                    </span>
                  </span>
                  <span className="font-semibold whitespace-nowrap tabular-nums">
                    {formatRwf(b.balance)}
                  </span>
                  <StaffLink
                    to="/app/visit"
                    search={{ encounter: b.encounterId }}
                    className={buttonVariants({
                      variant: i === 0 ? 'success' : 'tint-mint',
                      size: 'sm',
                    })}
                  >
                    <Wallet size={14} aria-hidden="true" />
                    {t('home.takePayment')}
                  </StaffLink>
                </div>
              ))}
            </div>
          )}
        </ShownList>
      </Panel>
      <Panel
        i={3}
        icon={Wallet}
        tint="mint"
        title={t('home.paidToday')}
        right={t('home.paymentsCount', { count: data.paidToday.count })}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-ink-2 font-semibold">{t('home.collectedToday')}</span>
          <span className="text-[28px] leading-8 font-semibold tracking-[-0.01em] tabular-nums">
            {formatRwf(data.paidToday.amount)}
          </span>
        </div>
        <Hint>{t('home.methodsHint')}</Hint>
      </Panel>
    </>
  )
}

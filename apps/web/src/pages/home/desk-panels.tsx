import { useState, type CSSProperties, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  AlarmClock,
  BedDouble,
  CalendarCheck,
  CalendarClock,
  CalendarPlus,
  Check,
  Clock,
  FilePen,
  ListTodo,
  Moon,
  Receipt,
  Sparkles,
  Ticket,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDayMonth, formatRwf, formatTime, type Role } from '@mmc/shared'
import { Empty, Hint, Panel, Pill } from '@/components/dash/kit'
import { type Tint } from '@/components/dash/kit-style'
import { Button, buttonVariants } from '@/components/ui/button'
import { ShownList } from '@/components/ui/list-tools'
import { StaffLink } from '@/components/staff/staff-link'
import {
  useAppointmentsDay,
  useBedBoard,
  useDeskOps,
  useFilesToComplete,
  useOpenTasks,
  type BoardBed,
  type DayAppointment,
} from '@/lib/api/desk-ops'
import { openItems, useQueueBoard } from '@/lib/api/visits'
import { cn } from '@/lib/utils'

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
const errorLine = 'bg-red-bg text-red m-0 rounded-lg px-2.5 py-1.5 text-[13px] font-semibold'
const rowClass =
  'border-grid anim-enter flex min-h-11 flex-wrap items-center gap-2 border-b py-1.5 text-[14px] last:border-b-0'

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
      icon={CalendarCheck}
      tint="violet"
      title={t('desk.receptionist.appointments')}
      right={t('ops.appts.toCome', { count: waiting.length })}
    >
      {error && <p className={errorLine}>{error}</p>}
      {!isLoading && rows.length === 0 ? (
        <Empty>{t('desk.receptionist.noAppointments')}</Empty>
      ) : (
        <ShownList items={rows} step={5}>
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
                      <span className="block truncate font-semibold">{a.name}</span>
                      <span className="text-ink-3 block truncate text-[13px]">
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
                    {!open &&
                      a.patientId &&
                      (a.status === 'arrived' || a.status === 'in_progress') && (
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
        </ShownList>
      )}
      {footer}
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
      icon={ListTodo}
      tint="amber"
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
                <div key={x.id} className={rowClass} style={{ '--i': k } as CSSProperties}>
                  <Pill tint={x.overdue ? 'coral' : 'teal'} icon={x.overdue ? AlarmClock : Clock}>
                    {x.dueAt ? formatTime(new Date(x.dueAt)) : '—'}
                  </Pill>
                  <span className="min-w-[140px] flex-1">
                    <span className="block truncate font-semibold">{x.title}</span>
                    <span className="text-ink-3 block truncate text-[13px]">
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
        </ShownList>
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
 * Short-stay beds: put a patient who is in the clinic in a bed for a number of nights (billed at
 * once: nights × the bed's price, or a price agreed for the period), extend the stay, discharge
 * (the bed goes to cleaning), mark it ready again.
 */
export function BedsPanel({
  i = 1,
  userRole,
  className,
}: {
  i?: number
  userRole: Role
  className?: string
}) {
  const { t } = useTranslation()
  const { data: beds = [] } = useBedBoard()
  const { data: queue = [] } = useQueueBoard('all', userRole)
  const ops = useDeskOps()
  const { error, run } = useRun()
  const [form, setForm] = useState<{ bedId: string; mode: 'admit' | 'extend' } | null>(null)
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
    <Panel
      i={i}
      icon={BedDouble}
      tint="navy"
      className={className}
      title={t('desk.nurse.beds')}
      right={t('desk.nurse.bedsFree', { count: free })}
    >
      {error && <p className={errorLine}>{error}</p>}
      {beds.length === 0 ? (
        <Empty icon={BedDouble}>{t('desk.nurse.noBeds')}</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {beds.map((b, k) => {
            const open = form?.bedId === b.id
            return (
              <div
                key={b.id}
                className={cn(
                  'anim-enter flex flex-col gap-1 rounded-xl border px-3 py-2',
                  bedTint[b.state],
                  open && 'col-span-2',
                )}
                style={{ '--i': k } as CSSProperties}
              >
                <span className="flex items-center justify-between gap-1">
                  <span className="inline-flex items-center gap-1.5 text-[13px] font-bold">
                    <BedDouble size={15} aria-hidden="true" />
                    {b.name}
                  </span>
                  <span className="text-ink-3 text-[12px]">{t(`desk.bedState.${b.state}`)}</span>
                </span>
                <span className="text-ink-3 inline-flex items-center gap-1 text-[12px]">
                  <Moon size={12} aria-hidden="true" />
                  {t('ops.beds.perNight', { price: formatRwf(b.nightlyPrice) })}
                </span>
                {b.patient && (
                  <span className="truncate text-[13px] font-semibold">{b.patient}</span>
                )}
                {b.state === 'occupied' && b.nights != null && b.until && (
                  <span className="text-ink-2 inline-flex items-center gap-1 text-[12px]">
                    <CalendarClock size={12} aria-hidden="true" />
                    {t('ops.beds.until', {
                      count: b.nights,
                      date: `${formatDayMonth(new Date(b.until))} ${formatTime(new Date(b.until))}`,
                    })}
                  </span>
                )}
                {open ? (
                  <StayForm
                    mode={form.mode}
                    nightlyPrice={b.nightlyPrice}
                    candidates={form.mode === 'admit' ? candidates : undefined}
                    onCancel={() => setForm(null)}
                    onSubmit={async (v) => {
                      const ok = await run(async () => {
                        if (form.mode === 'admit')
                          await ops.admit.mutateAsync({
                            bedId: b.id,
                            encounterId: v.encounterId!,
                            patient:
                              candidates.find((c) => c.encounterId === v.encounterId)?.name ?? '',
                            nights: v.nights,
                            periodPrice: v.periodPrice,
                          })
                        else
                          await ops.extend.mutateAsync({
                            bedId: b.id,
                            nights: v.nights,
                            periodPrice: v.periodPrice,
                          })
                        return true
                      })
                      if (ok) setForm(null)
                    }}
                  />
                ) : (
                  <>
                    {b.state === 'free' && (
                      <Button size="sm" onClick={() => setForm({ bedId: b.id, mode: 'admit' })}>
                        <BedDouble size={14} aria-hidden="true" />
                        {t('ops.beds.admit')}
                      </Button>
                    )}
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
                        <Button size="sm" onClick={() => setForm({ bedId: b.id, mode: 'extend' })}>
                          <CalendarPlus size={14} aria-hidden="true" />
                          {t('ops.beds.extend')}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => {
                            if (
                              window.confirm(
                                t('ops.beds.confirmDischarge', { name: b.patient ?? '' }),
                              )
                            )
                              void run(() => ops.discharge.mutateAsync(b.id))
                          }}
                        >
                          {t('ops.beds.discharge')}
                        </Button>
                      </span>
                    )}
                    {(b.state === 'cleaning' || b.state === 'out_of_service') && (
                      <Button size="sm" onClick={() => void run(() => ops.ready.mutateAsync(b.id))}>
                        <Sparkles size={14} aria-hidden="true" />
                        {t('ops.beds.ready')}
                      </Button>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
      <Hint>{t('ops.beds.hint')}</Hint>
    </Panel>
  )
}

/** Nights and price of a stay (admission or extension); the total goes on the bill. */
function StayForm({
  mode,
  nightlyPrice,
  candidates,
  onSubmit,
  onCancel,
}: {
  mode: 'admit' | 'extend'
  nightlyPrice: number
  candidates?: { encounterId: string; ticket: string; name: string }[]
  onSubmit: (v: {
    encounterId?: string
    nights: number
    periodPrice: number | null
  }) => Promise<void>
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [encounterId, setEncounterId] = useState('')
  const [nights, setNights] = useState(1)
  const [agree, setAgree] = useState(false)
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const agreed = agree && price !== '' ? Number(price) : null
  const total = agreed ?? nights * nightlyPrice
  const valid =
    nights >= 1 && nights <= 365 && (mode === 'extend' || !!encounterId) && (!agree || price !== '')
  const input = 'border-border bg-card h-10 w-full rounded-lg border px-2.5 text-[14px]'
  return (
    <form
      className="mt-1 flex flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!valid) return
        setBusy(true)
        await onSubmit({ encounterId: encounterId || undefined, nights, periodPrice: agreed })
        setBusy(false)
      }}
    >
      {mode === 'admit' && (
        <label className="flex flex-col gap-1 text-[13px] font-semibold">
          {t('ops.beds.patient')}
          <select
            autoFocus
            className={input}
            value={encounterId}
            onChange={(e) => setEncounterId(e.target.value)}
          >
            <option value="" disabled>
              {candidates?.length ? t('ops.beds.pick') : t('ops.beds.nobody')}
            </option>
            {candidates?.map((c) => (
              <option key={c.encounterId} value={c.encounterId}>
                {c.ticket} · {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1 text-[13px] font-semibold">
        {t(mode === 'admit' ? 'ops.beds.nights' : 'ops.beds.moreNights')}
        <input
          type="number"
          min={1}
          max={365}
          inputMode="numeric"
          className={input}
          value={nights}
          onChange={(e) => setNights(Math.max(1, Math.min(365, Number(e.target.value) || 1)))}
        />
      </label>
      <label className="flex items-center gap-2 text-[13px] font-semibold">
        <input
          type="checkbox"
          className="accent-primary size-4"
          checked={agree}
          onChange={(e) => setAgree(e.target.checked)}
        />
        {t('ops.beds.agree')}
      </label>
      {agree && (
        <label className="flex flex-col gap-1 text-[13px] font-semibold">
          {t('ops.beds.agreedPrice')}
          <input
            inputMode="numeric"
            className={input}
            value={price}
            onChange={(e) => setPrice(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </label>
      )}
      <p className="bg-card m-0 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px]">
        <Receipt size={14} aria-hidden="true" className="text-primary flex-none" />
        <span>
          {agreed != null
            ? t('ops.beds.totalAgreed', { count: nights, total: formatRwf(total) })
            : t('ops.beds.total', {
                count: nights,
                price: formatRwf(nightlyPrice),
                total: formatRwf(total),
              })}
        </span>
      </p>
      <span className="flex flex-wrap gap-1">
        <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!valid}>
          <Check size={14} aria-hidden="true" />
          {t(mode === 'admit' ? 'ops.beds.admitBtn' : 'ops.beds.extendBtn')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('staff.form.cancel')}
        </Button>
      </span>
    </form>
  )
}

/* ---------------------------------------------------------------- files to complete */

/**
 * Patients the nurse registered with what she could (name, sex, age). Reception completes
 * the rest (phone, national ID, address) and then sends the patient on to the doctor.
 */
export function FilesToCompletePanel({ i = 1 }: { i?: number }) {
  const { t } = useTranslation()
  const { data: files = [] } = useFilesToComplete()
  const atReception = files.filter((f) => f.station === 'reception').length
  return (
    <Panel
      i={i}
      icon={FilePen}
      tint="coral"
      title={t('files.title')}
      right={t('files.count', { count: files.length, here: atReception })}
    >
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
                    <span className="block truncate font-semibold">{f.name}</span>
                    <span className="text-ink-3 block truncate text-[13px]">
                      {t('files.lacks', {
                        missing: f.missing.map((m) => t(`files.missing.${m}`)).join(', '),
                      })}
                      {f.station
                        ? ` · ${t('files.now', { station: t(`register.stations.${f.station}`) })}`
                        : ''}
                    </span>
                  </span>
                  <StaffLink
                    to="/app/patient"
                    search={{ id: f.patientId, tab: 'complete' }}
                    className={buttonVariants({
                      size: 'sm',
                      variant: f.station === 'reception' ? 'primary' : 'default',
                    })}
                  >
                    {t('files.complete')}
                  </StaffLink>
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

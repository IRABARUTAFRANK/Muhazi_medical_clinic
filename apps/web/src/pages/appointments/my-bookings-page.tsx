import { useState, type CSSProperties } from 'react'
import {
  CalendarCheck,
  CalendarClock,
  CalendarPlus,
  CalendarSync,
  CalendarDays,
  CalendarRange,
  CalendarX,
  CircleAlert,
  FolderOpen,
  History,
  Info,
  MessageSquare,
  Phone,
  Stethoscope,
  Undo2,
  UserX,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime, isoDate, type StaffUser } from '@mmc/shared'
import { Empty, Kpi, Panel, Pill } from '@/components/dash/kit'
import { card } from '@/components/dash/kit-style'
import { PageBanner } from '@/components/dash/page-banner'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { ShownList } from '@/components/ui/list-tools'
import { SidePanel } from '@/components/ui/side-panel'
import type { HomeToAccept } from '@/lib/api/home'
import {
  useMyBookingActions,
  useMyBookings,
  type MyBooking,
  type MyBookingStatus,
} from '@/lib/api/my-bookings'
import { useConfirm } from '@/lib/confirm'
import { useDayNames } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { useOpenFile } from '@/lib/panel-url'
import { cn } from '@/lib/utils'
import { BookingAnswer } from '@/pages/home/booking-answer'
import { FollowUpForm } from '@/components/clinical/follow-up-form'
import { Flash } from '@/components/ui/flash'
import { Reveal } from '@/components/ui/reveal'
import { changeable } from '@/lib/api/follow-up'
import { ErrorBox } from '@/pages/home/role-panels'

/*
 * My bookings: the bookings made with the signed-in person (doctor, sonographer, nurse,
 * manager). Reception books; the person answers here (Accept, Another time, Decline), sees what
 * is coming over the next 3 weeks by day, and what happened over the last 30 days. A row opens
 * the booking beside the list (rose: bookings) with its history.
 * 0208: a booking whose time passed without the patient ("Not seen") is closed here: Did not
 * come, Another time, Cancel the booking (kept in the history), Call; a closed one is booked
 * again, and a wrong "Did not come" is taken back.
 */

const TONE: Record<string, 'blue' | 'green' | 'yellow' | 'red' | 'grey'> = {
  approved: 'yellow',
  confirmed: 'blue',
  arrived: 'green',
  in_progress: 'green',
  completed: 'green',
  no_show: 'red',
  cancelled: 'red',
  declined: 'red',
  left_unseen: 'yellow',
}
const CLOSED: readonly MyBookingStatus[] = ['declined', 'cancelled', 'left_unseen']
/** 0208: the bookings that will not happen any more: booked again from here. */
const ENDED: readonly MyBookingStatus[] = ['no_show', ...CLOSED]
/** 0208: booked or confirmed, its time passed, the patient not seen: to close ("Not seen"). */
const isMissed = (b: MyBooking) => changeable(b.status) && Date.parse(b.startsAt) <= Date.now()
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** A Rwandan number written 07…, 2507… or +2507… as +2507… (for the call link). */
const intl = (phone: string) => {
  const d = phone.replace(/[^\d]/g, '')
  if (d.startsWith('250')) return `+${d}`
  if (d.startsWith('0')) return `+250${d.slice(1)}`
  return `+250${d}`
}
const rowClass =
  'border-grid flex min-h-11 flex-wrap items-center gap-2.5 border-b py-2 text-[14px] last:border-b-0'

const when = (iso: string | null) =>
  iso ? `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}` : '—'
const startOfDay = (d: Date) => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}
const addDays = (d: Date, n: number) => {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

/** The booking as the answer buttons take it (the same as "Bookings to accept" on Home). */
const asToAccept = (b: MyBooking): HomeToAccept => ({
  id: b.id,
  name: b.name,
  when: when(b.startsAt),
  note: b.reason,
  category: b.category,
  startsAt: b.startsAt,
})

export function MyBookingsPage({ user, focus }: { user: StaffUser; focus?: string }) {
  const { t } = useTranslation()
  const dayNames = useDayNames()
  const { data, isLoading, error } = useMyBookings()
  const [selected, setSelected] = useState<string | null>(focus ?? null)
  const [answerError, setAnswerError] = useState<string | null>(null)
  // 0125: a booking made here (a patient found by a file search) and the message after it
  const [adding, setAdding] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const rows = data?.rows ?? []
  const today = startOfDay(new Date())
  const tomorrow = addDays(today, 1)
  const horizon = addDays(today, 22)
  // this week: Monday to Sunday
  const monday = addDays(today, -((today.getDay() + 6) % 7))
  const nextMonday = addDays(monday, 7)
  const at = (b: MyBooking) => new Date(b.startsAt)

  const toAnswer = rows.filter((b) => b.status === 'approved')
  const kept = rows.filter((b) => b.status !== 'approved' && !CLOSED.includes(b.status))
  const coming = kept.filter((b) => at(b) >= today && at(b) < horizon)
  // the bookings not seen (to close) first, then the latest first
  const earlier = rows
    .filter((b) => b.status !== 'approved' && (at(b) < today || CLOSED.includes(b.status)))
    .sort(
      (a, b) => Number(isMissed(b)) - Number(isMissed(a)) || b.startsAt.localeCompare(a.startsAt),
    )
  const notSeen = earlier.filter(isMissed).length
  const todayCount = kept.filter((b) => at(b) >= today && at(b) < tomorrow).length
  const weekCount = kept.filter((b) => at(b) >= monday && at(b) < nextMonday).length
  const closedCount = rows.filter((b) => CLOSED.includes(b.status)).length

  // the coming bookings by day ("Today", "Tomorrow", "Thursday 30/10/2026")
  const days: { key: string; label: string; items: MyBooking[] }[] = []
  for (const b of coming) {
    const d = startOfDay(at(b))
    const key = isoDate(d)
    let g = days.find((x) => x.key === key)
    if (!g) {
      const name =
        d.getTime() === today.getTime()
          ? t('ops.appts.today')
          : d.getTime() === tomorrow.getTime()
            ? t('ops.appts.tomorrow')
            : dayNames.long[d.getDay()]
      g = { key, label: `${name} · ${formatDate(d)}`, items: [] }
      days.push(g)
    }
    g.items.push(b)
  }

  const open = rows.find((b) => b.id === selected) ?? null
  const statusLabel = (s: string) => t(`ops.appts.status.${s}`, { defaultValue: s })

  /** The patient and what they come for; the name opens the booking beside the list. */
  const who = (b: MyBooking, extra?: string | null) => (
    <button
      type="button"
      onClick={() => setSelected(b.id)}
      className="hover:text-primary focus-visible:ring-primary/20 min-w-[160px] flex-1 rounded text-left outline-none focus-visible:ring-2"
    >
      <span className="block truncate font-semibold">{b.name}</span>
      {(b.reason || b.category || extra) && (
        <span className="text-ink-3 block text-[13px]">
          {[b.category, b.reason, extra].filter(Boolean).join(' · ')}
        </span>
      )}
    </button>
  )
  const statusBadge = (b: MyBooking) => (
    <Badge tone={b.late && b.status === 'confirmed' ? 'yellow' : (TONE[b.status] ?? 'grey')}>
      {b.late && b.status === 'confirmed' ? t('home.apptStatus.late') : statusLabel(b.status)}
    </Badge>
  )
  const visitLink = (b: MyBooking) =>
    b.encounterId &&
    (b.status === 'arrived' || b.status === 'in_progress') && (
      <StaffLink
        to="/app/visit"
        search={{ encounter: b.encounterId }}
        className={buttonVariants({ size: 'sm', variant: 'tint-blue' })}
      >
        <Stethoscope size={14} aria-hidden="true" />
        {t('myBookings.openVisit')}
      </StaffLink>
    )

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="my-bookings">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <PageBanner
          icon={CalendarCheck}
          tint="violet"
          title={t('myBookings.title')}
          lead={t('myBookings.lead')}
        >
          <Button variant="primary" aria-expanded={adding} onClick={() => setAdding((a) => !a)}>
            <CalendarPlus size={16} aria-hidden="true" />
            {t('followUp.newBooking')}
          </Button>
          <StaffLink
            to="/app/calendar"
            className={buttonVariants({ variant: 'tint-grey', size: 'md' })}
          >
            <CalendarDays size={16} aria-hidden="true" />
            {t('myBookings.myCalendar')}
          </StaffLink>
        </PageBanner>

        {data?.missing && (
          <p className="border-border bg-card text-ink-2 border-l-primary m-0 flex items-start gap-2 rounded-md border border-l-[3px] px-3 py-2 text-[14px]">
            <Info size={16} aria-hidden="true" className="text-primary mt-0.5 flex-none" />
            <span>{t('myBookings.needsUpdate')}</span>
          </p>
        )}
        {error && <ErrorBox>{error.message}</ErrorBox>}
        {notice && (
          <Flash key={notice} onClose={() => setNotice(null)}>
            {notice}
          </Flash>
        )}
        {adding && (
          <Reveal focus>
            <Panel i={0} icon={CalendarPlus} tint="violet" title={t('followUp.newBooking')}>
              <p className="text-ink-2 m-0 text-[14px]">{t('followUp.newLead')}</p>
              <FollowUpForm
                user={user}
                onDone={(m) => {
                  setAdding(false)
                  setNotice(m)
                }}
                onCancel={() => setAdding(false)}
              />
            </Panel>
          </Reveal>
        )}

        <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 lg:grid-cols-4">
          <Kpi
            i={0}
            icon={MessageSquare}
            tint="amber"
            label={t('myBookings.tiles.toAnswer')}
            value={toAnswer.length}
            unit={t('roleHome.units.toAnswer')}
            delta={
              toAnswer.length > 0
                ? { text: t('desk.answerSoon'), good: false, up: null }
                : undefined
            }
          />
          <Kpi
            i={1}
            icon={CalendarClock}
            tint="teal"
            label={t('myBookings.tiles.today')}
            value={todayCount}
            unit={t('myBookings.units.booked')}
          />
          <Kpi
            i={2}
            icon={CalendarRange}
            tint="navy"
            label={t('myBookings.tiles.week')}
            value={weekCount}
            unit={t('myBookings.units.booked')}
          />
          <Kpi
            i={3}
            icon={CalendarX}
            tint="coral"
            label={t('myBookings.tiles.closed')}
            value={closedCount}
            unit={t('myBookings.units.last30')}
          />
        </div>

        {answerError && <ErrorBox>{answerError}</ErrorBox>}
        <Panel
          i={4}
          icon={MessageSquare}
          tint="amber"
          title={t('myBookings.toAnswer')}
          right={String(toAnswer.length)}
        >
          {isLoading && <p className="text-ink-3 m-0 text-[14px]">…</p>}
          {!isLoading && toAnswer.length === 0 && <Empty>{t('myBookings.nothingToAnswer')}</Empty>}
          <ShownList items={toAnswer} step={6}>
            {(shown) => (
              <div className="flex flex-col">
                {shown.map((b, i) => (
                  <div key={b.id} className={rowClass} style={{ '--i': i } as CSSProperties}>
                    <Pill tint={b.late ? 'coral' : 'violet'} icon={CalendarCheck}>
                      {when(b.startsAt)}
                    </Pill>
                    {who(
                      b,
                      b.bookedBy ? t('myBookings.bookedBy', { name: b.bookedBy }) : undefined,
                    )}
                    <BookingAnswer
                      booking={asToAccept(b)}
                      slotMinutes={data?.slotMinutes}
                      onError={setAnswerError}
                    />
                  </div>
                ))}
              </div>
            )}
          </ShownList>
        </Panel>

        {/* two columns only where the second one is at least as wide as a phone (see the bookings page) */}
        <div className="@container">
          <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <Panel
              i={5}
              icon={CalendarDays}
              tint="teal"
              title={t('myBookings.coming')}
              right={t('myBookings.comingNote', { count: coming.length })}
            >
              {!isLoading && days.length === 0 && (
                <Empty icon={CalendarDays}>{t('myBookings.nothingComing')}</Empty>
              )}
              {days.map((g) => (
                <section key={g.key} className="flex flex-col">
                  <h4 className="text-ink-2 m-0 pb-1 text-[13px] font-semibold">{g.label}</h4>
                  {g.items.map((b) => (
                    <div key={b.id} className={rowClass}>
                      <Pill tint="teal">{formatTime(new Date(b.startsAt))}</Pill>
                      {who(b)}
                      {statusBadge(b)}
                      {/* 0208: today's time passed without the patient: say what happened */}
                      {isMissed(b) && (
                        <Button size="xs" variant="tint-coral" onClick={() => setSelected(b.id)}>
                          {t('myBookings.whatHappened')}
                        </Button>
                      )}
                      {visitLink(b)}
                    </div>
                  ))}
                </section>
              ))}
            </Panel>

            <Panel
              i={6}
              icon={History}
              tint="violet"
              title={t('myBookings.earlier')}
              right={
                <span className="inline-flex flex-wrap items-center justify-end gap-2">
                  {notSeen > 0 && (
                    <Badge tone="red" icon={<UserX size={12} aria-hidden="true" />}>
                      {t('myBookings.notSeenCount', { count: notSeen })}
                    </Badge>
                  )}
                  <span>{earlier.length}</span>
                </span>
              }
            >
              {!isLoading && earlier.length === 0 && (
                <Empty icon={History}>{t('myBookings.nothingEarlier')}</Empty>
              )}
              <ShownList items={earlier} step={8}>
                {(shown) => (
                  <div className="flex flex-col">
                    {shown.map((b) => (
                      <div key={b.id} className={rowClass}>
                        <Pill tint={isMissed(b) ? 'coral' : 'violet'}>{when(b.startsAt)}</Pill>
                        {who(b, CLOSED.includes(b.status) ? b.cancelReason : null)}
                        {isMissed(b) ? (
                          <>
                            <Badge tone="red" icon={<UserX size={12} aria-hidden="true" />}>
                              {t('myBookings.notSeen')}
                            </Badge>
                            <Button
                              size="xs"
                              variant="tint-coral"
                              onClick={() => setSelected(b.id)}
                            >
                              {t('myBookings.whatHappened')}
                            </Button>
                          </>
                        ) : (
                          statusBadge(b)
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </ShownList>
            </Panel>
          </div>
        </div>

        <BookingPanel
          user={user}
          booking={open}
          slotMinutes={data?.slotMinutes}
          onClose={() => setSelected(null)}
          onChanged={(m) => {
            setSelected(null)
            setNotice(m)
          }}
        />
      </main>
    </StaffShell>
  )
}

/** One booking beside the list: who, when, why, who booked it, and every step since. */
function BookingPanel({
  user,
  booking: b,
  slotMinutes,
  onClose,
  onChanged,
}: {
  user: StaffUser
  booking: MyBooking | null
  slotMinutes?: number
  onClose: () => void
  onChanged: (message: string) => void
}) {
  const { t } = useTranslation()
  const openFile = useOpenFile()
  const confirm = useConfirm()
  const actions = useMyBookingActions()
  const [error, setError] = useState<string | null>(null)
  // 0125: "Change booking": the same form as a new booking, on this one
  const [changing, setChanging] = useState<string | null>(null)
  // 0208: "Book again": a new booking for the same patient; the message after an action
  const [rebooking, setRebooking] = useState<string | null>(null)
  const [done, setDone] = useState<{ id: string; text: string } | null>(null)
  const busy = actions.outcome.isPending || actions.undo.isPending
  const missed = !!b && isMissed(b)
  const ended = !!b && ENDED.includes(b.status)
  const rows: [string, string | null | undefined][] = b
    ? [
        [t('ops.detail.when'), when(b.startsAt)],
        [t('ops.detail.patient'), b.fileNumber ? `${b.fileNumber} · ${b.name}` : b.name],
        [t('ops.detail.phone'), b.phone],
        [t('ops.detail.reason'), b.reason],
        [t('followUp.note'), b.note],
        [t('ops.detail.service'), b.category],
        [
          t('ops.detail.source'),
          b.source ? t(`ops.detail.sources.${b.source}`, { defaultValue: b.source }) : null,
        ],
        [
          t('ops.detail.channel'),
          b.channel ? t(`ops.detail.channels.${b.channel}`, { defaultValue: b.channel }) : null,
        ],
        [t('ops.detail.reference'), b.reference],
        [t('ops.detail.approved'), b.bookedBy ? `${b.bookedBy} · ${when(b.bookedAt)}` : null],
        [t('ops.detail.accepted'), b.acceptedBy ? `${b.acceptedBy} · ${when(b.acceptedAt)}` : null],
        [t('myBookings.declineReason'), b.cancelReason],
      ]
    : []
  const stepLabel = (s: string | null) =>
    s === 'inquiry'
      ? t('myBookings.step.requested')
      : t(`ops.appts.status.${s ?? ''}`, { defaultValue: s ?? '' })

  /** An action on the booking; the panel stays open with the message (then "Book again"). */
  const run = async (id: string, fn: () => Promise<unknown>, text: string) => {
    setError(null)
    setDone(null)
    try {
      await fn()
      setDone({ id, text })
    } catch (e) {
      setError(describe(e))
    }
  }
  const noShow = async (x: MyBooking) => {
    if (
      !(await confirm({
        title: t('myBookings.act.noShowConfirm', { name: x.name, when: when(x.startsAt) }),
        body: t('myBookings.act.noShowBody'),
        confirmLabel: t('myBookings.act.noShowYes'),
        tone: 'danger',
      }))
    )
      return
    await run(
      x.id,
      () => actions.outcome.mutateAsync({ id: x.id, status: 'no_show' }),
      t('myBookings.act.noShowDone', { name: x.name }),
    )
  }
  const cancel = async (x: MyBooking) => {
    const r = await confirm({
      title: t('myBookings.act.cancelConfirm', { name: x.name, when: when(x.startsAt) }),
      body: t('myBookings.act.cancelBody'),
      input: {
        label: t('myBookings.act.cancelWhy'),
        placeholder: t('myBookings.act.cancelPh'),
        required: true,
        multiline: true,
        maxLength: 300,
      },
      confirmLabel: t('confirm.desks.appointment.cancelYes'),
      tone: 'danger',
    })
    if (!r.ok) return
    await run(
      x.id,
      () => actions.outcome.mutateAsync({ id: x.id, status: 'cancelled', reason: r.value }),
      t('myBookings.act.cancelDone', { name: x.name }),
    )
  }
  const undo = async (x: MyBooking) => {
    if (
      !(await confirm({
        title: t('myBookings.act.undoConfirm', { name: x.name }),
        body: t('myBookings.act.undoBody'),
        confirmLabel: t('myBookings.act.undoYes'),
      }))
    )
      return
    await run(
      x.id,
      () => actions.undo.mutateAsync(x.id),
      t('myBookings.act.undoDone', { name: x.name }),
    )
  }
  const startChange = (x: MyBooking) => {
    setRebooking(null)
    setDone(null)
    setChanging(x.id)
  }

  // the patient's phone, to agree a new time or hear why they did not come
  const call = b?.phone ? (
    <a href={`tel:${intl(b.phone)}`} className={buttonVariants({ size: 'sm', variant: 'default' })}>
      <Phone size={14} aria-hidden="true" />
      {t('common.call')}
    </a>
  ) : null

  return (
    <SidePanel
      open={b !== null}
      onClose={onClose}
      hue="rose"
      icon={CalendarCheck}
      title={b ? b.name : t('ops.detail.title')}
      subtitle={b ? when(b.startsAt) : undefined}
      tags={
        b ? (
          <>
            <Badge tone={TONE[b.status] ?? 'grey'}>
              {t(`ops.appts.status.${b.status}`, { defaultValue: b.status })}
            </Badge>
            {missed && (
              <Badge tone="red" icon={<UserX size={12} aria-hidden="true" />}>
                {t('myBookings.notSeen')}
              </Badge>
            )}
          </>
        ) : undefined
      }
    >
      {b && (
        <div className="flex flex-col gap-4">
          {error && (
            <p
              role="alert"
              className="border-red/30 bg-red-bg text-red m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-[13px] font-medium"
            >
              <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
              <span>{error}</span>
            </p>
          )}
          {done?.id === b.id && (
            <Flash key={done.text} onClose={() => setDone(null)}>
              {done.text}
            </Flash>
          )}
          {b.status === 'approved' && (
            <div className="flex flex-wrap items-center gap-2">
              <BookingAnswer
                booking={asToAccept(b)}
                slotMinutes={slotMinutes}
                onError={setError}
                onAnswered={onClose}
              />
            </div>
          )}
          {/* 0208: the time passed without the patient: say what happened */}
          {missed && (
            <section className="border-red/25 bg-red-bg/60 flex flex-col gap-2.5 rounded-md border p-3">
              <p className="text-ink m-0 flex items-start gap-2 text-[14px] font-medium">
                <UserX size={16} aria-hidden="true" className="text-red mt-0.5 flex-none" />
                <span>{t('myBookings.act.missedLead', { name: b.name })}</span>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="danger-solid"
                  disabled={busy}
                  onClick={() => void noShow(b)}
                >
                  <UserX size={14} aria-hidden="true" />
                  {t('myBookings.act.noShow')}
                </Button>
                {b.status === 'confirmed' && changing !== b.id && (
                  <Button
                    size="sm"
                    variant="tint-violet"
                    disabled={busy}
                    onClick={() => startChange(b)}
                  >
                    <CalendarSync size={14} aria-hidden="true" />
                    {t('home.otherTime')}
                  </Button>
                )}
                {b.status === 'confirmed' && (
                  <Button
                    size="sm"
                    variant="tint-coral"
                    disabled={busy}
                    onClick={() => void cancel(b)}
                  >
                    <CalendarX size={14} aria-hidden="true" />
                    {t('myBookings.act.cancel')}
                  </Button>
                )}
                {call}
              </div>
            </section>
          )}
          <dl
            className={cn(
              card,
              'm-0 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[160px_minmax(0,1fr)]',
            )}
          >
            {rows
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-ink-3 text-[13px]">{k}</dt>
                  <dd className="text-ink m-0 text-[14px] font-medium">{v}</dd>
                </div>
              ))}
          </dl>
          {changing === b.id && (
            <Reveal>
              <FollowUpForm
                user={user}
                patient={{
                  id: b.patientId ?? b.id,
                  name: b.name,
                  fileNumber: b.fileNumber,
                  phone: b.phone,
                }}
                change={{
                  id: b.id,
                  startsAt: b.startsAt,
                  withUserId: user.id,
                  reason: b.reason,
                  note: b.note ?? null,
                }}
                onDone={(m) => {
                  setChanging(null)
                  onChanged(m)
                }}
                onCancel={() => setChanging(null)}
              />
            </Reveal>
          )}
          {/* 0208: a booking that will not happen: a new one for the same patient */}
          {rebooking === b.id && b.patientId && (
            <Reveal>
              <FollowUpForm
                user={user}
                patient={{
                  id: b.patientId,
                  name: b.name,
                  fileNumber: b.fileNumber,
                  phone: b.phone,
                }}
                reason={b.reason ?? ''}
                onDone={(m) => {
                  setRebooking(null)
                  onChanged(m)
                }}
                onCancel={() => setRebooking(null)}
              />
            </Reveal>
          )}
          <div className="flex flex-wrap gap-2">
            {changeable(b.status) && !missed && changing !== b.id && (
              <Button size="sm" variant="tint-violet" onClick={() => startChange(b)}>
                <CalendarSync size={14} aria-hidden="true" />
                {t('followUp.change.button')}
              </Button>
            )}
            {b.status === 'confirmed' && !missed && (
              <Button size="sm" variant="tint-coral" disabled={busy} onClick={() => void cancel(b)}>
                <CalendarX size={14} aria-hidden="true" />
                {t('myBookings.act.cancel')}
              </Button>
            )}
            {ended && b.patientId && rebooking !== b.id && (
              <Button
                size="sm"
                variant="tint-violet"
                onClick={() => {
                  setChanging(null)
                  setDone(null)
                  setRebooking(b.id)
                }}
              >
                <CalendarPlus size={14} aria-hidden="true" />
                {t('ops.appts.bookAgain')}
              </Button>
            )}
            {!missed && call}
            {b.patientId && (
              <Button
                size="sm"
                onClick={() => {
                  const id = b.patientId!
                  onClose()
                  // the file opens once the booking panel has gone (one panel at a time)
                  window.setTimeout(() => openFile(id), 0)
                }}
              >
                <FolderOpen size={14} aria-hidden="true" />
                {t('patients.openFile')}
              </Button>
            )}
            {b.encounterId && (
              <StaffLink
                to="/app/visit"
                search={{ encounter: b.encounterId }}
                className={buttonVariants({ size: 'sm', variant: 'primary' })}
              >
                <Stethoscope size={14} aria-hidden="true" />
                {t('myBookings.openVisit')}
              </StaffLink>
            )}
          </div>
          {/* 0208: a wrong "Did not come" is taken back (no visit came from the booking) */}
          {b.status === 'no_show' && !b.encounterId && (
            <div>
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => void undo(b)}>
                <Undo2 size={14} aria-hidden="true" />
                {t('myBookings.act.undo')}
              </Button>
            </div>
          )}
          {b.history.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-ink m-0 flex items-center gap-2 text-[15px] font-semibold">
                <History size={16} aria-hidden="true" className="text-ink-3" />
                {t('myBookings.history')}
              </h3>
              <ol className="border-border m-0 flex list-none flex-col gap-2 border-l-2 pl-4">
                {b.history.map((h, i) => (
                  <li key={`${h.at}-${i}`} className="text-[14px]">
                    <span className="text-ink font-medium">{stepLabel(h.status)}</span>
                    {h.moved && h.startsAt && (
                      <span className="text-ink-2">
                        {' · '}
                        {t('myBookings.movedTo', { when: when(h.startsAt) })}
                      </span>
                    )}
                    {h.why && <span className="text-ink-2 block text-[13px]">“{h.why}”</span>}
                    <span className="text-ink-3 block text-[13px]">
                      {[when(h.at), h.by].filter(Boolean).join(' · ')}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      )}
    </SidePanel>
  )
}

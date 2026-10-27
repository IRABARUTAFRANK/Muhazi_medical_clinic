import { useState, type CSSProperties } from 'react'
import {
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  CalendarX,
  CircleAlert,
  FolderOpen,
  History,
  Info,
  MessageSquare,
  Stethoscope,
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
import { useMyBookings, type MyBooking, type MyBookingStatus } from '@/lib/api/my-bookings'
import { useDayNames } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { useOpenFile } from '@/lib/panel-url'
import { cn } from '@/lib/utils'
import { BookingAnswer } from '@/pages/home/booking-answer'
import { ErrorBox } from '@/pages/home/role-panels'

/*
 * My bookings: the bookings made with the signed-in person (doctor, sonographer, nurse,
 * manager). Reception books; the person answers here (Accept, Another time, Decline), sees what
 * is coming over the next 3 weeks by day, and what happened over the last 30 days. A row opens
 * the booking beside the list (rose: bookings) with its history.
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
  const earlier = rows
    .filter((b) => b.status !== 'approved' && (at(b) < today || CLOSED.includes(b.status)))
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt))
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

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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

        <div className="pc:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] grid grid-cols-1 gap-4">
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
            right={String(earlier.length)}
          >
            {!isLoading && earlier.length === 0 && (
              <Empty icon={History}>{t('myBookings.nothingEarlier')}</Empty>
            )}
            <ShownList items={earlier} step={8}>
              {(shown) => (
                <div className="flex flex-col">
                  {shown.map((b) => (
                    <div key={b.id} className={rowClass}>
                      <Pill tint="violet">{when(b.startsAt)}</Pill>
                      {who(b, CLOSED.includes(b.status) ? b.cancelReason : null)}
                      {statusBadge(b)}
                    </div>
                  ))}
                </div>
              )}
            </ShownList>
          </Panel>
        </div>

        <BookingPanel
          booking={open}
          slotMinutes={data?.slotMinutes}
          onClose={() => setSelected(null)}
        />
      </main>
    </StaffShell>
  )
}

/** One booking beside the list: who, when, why, who booked it, and every step since. */
function BookingPanel({
  booking: b,
  slotMinutes,
  onClose,
}: {
  booking: MyBooking | null
  slotMinutes?: number
  onClose: () => void
}) {
  const { t } = useTranslation()
  const openFile = useOpenFile()
  const [error, setError] = useState<string | null>(null)
  const rows: [string, string | null | undefined][] = b
    ? [
        [t('ops.detail.when'), when(b.startsAt)],
        [t('ops.detail.patient'), b.fileNumber ? `${b.fileNumber} · ${b.name}` : b.name],
        [t('ops.detail.phone'), b.phone],
        [t('ops.detail.reason'), b.reason],
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
          <Badge tone={TONE[b.status] ?? 'grey'}>
            {t(`ops.appts.status.${b.status}`, { defaultValue: b.status })}
          </Badge>
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
          <div className="flex flex-wrap gap-2">
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

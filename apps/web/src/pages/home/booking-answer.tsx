import { useState } from 'react'
import { CalendarCheck, Check, Clock, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime, isoDate } from '@mmc/shared'
import { Button, actionLink } from '@/components/ui/button'
import { StaffLink } from '@/components/staff/staff-link'
import { Field } from '@/components/ui/field'
import { TimeSelect } from '@/components/ui/time-select'
import { Reveal } from '@/components/ui/reveal'
import { useHomeActions, useHomeSummary, type HomeToAccept } from '@/lib/api/home'
import { useNotificationActions, type Notice } from '@/lib/api/notifications'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
// "24/10/2026 10:30" for a "yyyy-mm-ddThh:mm" value
const at = (v: string) => `${formatDate(new Date(v))} ${formatTime(new Date(v))}`
const pad = (n: number) => String(n).padStart(2, '0')
// the day and the time of a booked time, for the day field and the time list
const dayOf = (iso?: string | null) => (iso ? isoDate(new Date(iso)) : '')
const timeOf = (iso?: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * The practitioner's answer to a booking reception approved: Accept, Another time (the doctor
 * arranges the day before accepting) or Decline with a reason, each asked in the app's dialog.
 * Used by "Bookings to accept" on Home and by the notice itself (bell, Notifications page).
 */
export function BookingAnswer({
  booking: q,
  onError,
  onAnswered,
  slotMinutes,
}: {
  booking: HomeToAccept
  /** The practitioner's booking length: the steps of the time list (15 minutes by default). */
  slotMinutes?: number
  onError: (message: string | null) => void
  /** After the answer was saved (the notice is then marked read). */
  onAnswered?: () => void
}) {
  const { t } = useTranslation()
  const actions = useHomeActions()
  const confirm = useConfirm()
  const [moving, setMoving] = useState(false)
  // "Another time": a day and a time picked from a list (not the browser's clock picker)
  const [newDay, setNewDay] = useState('')
  const [newTime, setNewTime] = useState('')
  const newAt = newDay && newTime ? `${newDay}T${newTime}` : ''
  const busy = actions.acceptAppointment.isPending || actions.declineAppointment.isPending

  const accept = async (startsAt?: string) => {
    if (
      !(await confirm({
        title: t('confirm.desks.appointment.accept', {
          name: q.name,
          when: startsAt ? at(startsAt) : q.when,
        }),
        body: t('confirm.desks.appointment.acceptBody'),
        confirmLabel: t('confirm.desks.appointment.acceptYes'),
      }))
    )
      return
    onError(null)
    try {
      await actions.acceptAppointment.mutateAsync({
        id: q.id,
        startsAt: startsAt ? new Date(startsAt).toISOString() : null,
      })
      setMoving(false)
      onAnswered?.()
    } catch (e) {
      onError(describe(e))
    }
  }
  const decline = async () => {
    const r = await confirm({
      title: t('confirm.desks.appointment.decline', { name: q.name }),
      input: {
        label: t('home.declineReason'),
        placeholder: t('confirm.reasonPh'),
        required: true,
        multiline: true,
      },
      confirmLabel: t('confirm.desks.appointment.declineYes'),
      tone: 'danger',
    })
    if (!r.ok) return
    onError(null)
    try {
      await actions.declineAppointment.mutateAsync({ id: q.id, reason: r.value })
      onAnswered?.()
    } catch (e) {
      onError(describe(e))
    }
  }

  return (
    <>
      <span className="flex flex-wrap gap-1">
        <Button variant="success" size="sm" disabled={busy} onClick={() => void accept()}>
          <Check size={14} aria-hidden="true" />
          {t('common.accept')}
        </Button>
        <Button
          size="sm"
          variant="tint-amber"
          aria-expanded={moving}
          disabled={busy}
          onClick={() => {
            setMoving(!moving)
            setNewDay(dayOf(q.startsAt))
            setNewTime(timeOf(q.startsAt))
          }}
        >
          <Clock size={14} aria-hidden="true" />
          {t('home.otherTime')}
        </Button>
        <Button variant="tint-coral" size="sm" disabled={busy} onClick={() => void decline()}>
          <X size={14} aria-hidden="true" />
          {t('common.decline')}
        </Button>
      </span>
      {moving && (
        <Reveal focus block="nearest" className="basis-full">
          <span className="flex flex-wrap items-end gap-2">
            <Field
              label={t('ops.inquiries.day')}
              type="date"
              value={newDay}
              min={isoDate(new Date())}
              onChange={(e) => setNewDay(e.target.value)}
            />
            <TimeSelect
              label={t('home.newTime')}
              value={newTime}
              onChange={setNewTime}
              step={slotMinutes ?? 15}
              day={newDay}
            />
            <Button
              variant="success"
              size="sm"
              className="mb-0.5"
              disabled={!newAt || busy}
              onClick={() => void accept(newAt)}
            >
              <Check size={14} aria-hidden="true" />
              {t('home.acceptAt')}
            </Button>
          </span>
        </Reveal>
      )}
    </>
  )
}

/** "See all my bookings": the person's own bookings page (/app/my-bookings). */
export function MyBookingsLink({ onClick }: { onClick?: () => void }) {
  const { t } = useTranslation()
  return (
    <StaffLink to="/app/my-bookings" className={actionLink} onClick={onClick}>
      <CalendarCheck size={14} aria-hidden="true" />
      {t('myBookings.seeAll')}
    </StaffLink>
  )
}

/**
 * A "Booking to accept" notice answered where it is read: the same three answers while the
 * booking still waits for this practitioner (it is in their "Bookings to accept"); once
 * answered, the notice is marked read (the database then removes it). "See all my bookings"
 * leads to the person's own bookings page (`onLeave` closes the bell's list on the way).
 */
export function NoticeBookingAnswer({
  notice: n,
  className,
  onLeave,
}: {
  notice: Notice
  className?: string
  onLeave?: () => void
}) {
  const id = n.kind === 'to_accept' ? (n.params?.appointment ?? null) : null
  const { data } = useHomeSummary(null, { enabled: !!id })
  const notices = useNotificationActions()
  const [error, setError] = useState<string | null>(null)
  if (n.kind !== 'to_accept') return null
  const booking = id ? data?.toAccept.find((x) => x.id === id) : undefined
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {booking && (
        <BookingAnswer
          booking={booking}
          onError={setError}
          onAnswered={() => {
            if (!n.read) notices.markRead.mutate([n.id])
          }}
        />
      )}
      <MyBookingsLink onClick={onLeave} />
      {error && (
        <p
          role="alert"
          className="border-red/25 bg-red-bg text-red m-0 basis-full rounded-md border px-3 py-1.5 text-[13px] font-medium"
        >
          {error}
        </p>
      )}
    </div>
  )
}

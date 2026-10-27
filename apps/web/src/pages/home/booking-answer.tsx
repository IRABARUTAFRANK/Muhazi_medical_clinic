import { useState } from 'react'
import { Check, Clock, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { controlClass, labelClass } from '@/components/ui/field'
import { Reveal } from '@/components/ui/reveal'
import { useHomeActions, useHomeSummary, type HomeToAccept } from '@/lib/api/home'
import { useNotificationActions, type Notice } from '@/lib/api/notifications'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
// "24/10/2026 10:30" for a datetime-local value
const at = (v: string) => `${formatDate(new Date(v))} ${formatTime(new Date(v))}`
// the datetime-local value of a booked time
const localInput = (iso?: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
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
}: {
  booking: HomeToAccept
  onError: (message: string | null) => void
  /** After the answer was saved (the notice is then marked read). */
  onAnswered?: () => void
}) {
  const { t } = useTranslation()
  const actions = useHomeActions()
  const confirm = useConfirm()
  const [moving, setMoving] = useState(false)
  const [newTime, setNewTime] = useState('')
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
            setNewTime(localInput(q.startsAt))
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
              disabled={!newTime || busy}
              onClick={() => void accept(newTime)}
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

/**
 * A "Booking to accept" notice answered where it is read: the same three answers while the
 * booking still waits for this practitioner (it is in their "Bookings to accept"); once
 * answered, the notice is marked read (the database then removes it).
 */
export function NoticeBookingAnswer({
  notice: n,
  className,
}: {
  notice: Notice
  className?: string
}) {
  const id = n.kind === 'to_accept' ? (n.params?.appointment ?? null) : null
  const { data } = useHomeSummary(null, { enabled: !!id })
  const notices = useNotificationActions()
  const [error, setError] = useState<string | null>(null)
  const booking = id ? data?.toAccept.find((x) => x.id === id) : undefined
  if (!booking) return null
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <BookingAnswer
        booking={booking}
        onError={setError}
        onAnswered={() => {
          if (!n.read) notices.markRead.mutate([n.id])
        }}
      />
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

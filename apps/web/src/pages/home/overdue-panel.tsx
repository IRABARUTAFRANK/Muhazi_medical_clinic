import { useState, type CSSProperties } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AlarmClock, CalendarPlus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDayMonth, isoDate } from '@mmc/shared'
import { Empty, Hint, Panel, Pill } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { Flash } from '@/components/ui/flash'
import { StartVisitConfirm } from '@/components/clinical/start-visit-confirm'
import { ArrivalFileCard } from '@/components/clinical/arrival-file-card'
import { useDeskOps, useOverdueBookings, type DayAppointment } from '@/lib/api/desk-ops'
import { requestTimePassed, useOpenInquiries } from '@/lib/api/home'
import { useStaffSettings } from '@/lib/api/settings'
import { useConfirm } from '@/lib/confirm'
import { useNow } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import { InquiriesPanel, type RegisterRequest } from './inquiries-panel'

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
const errorLine = 'bg-red-bg text-red m-0 rounded-lg px-2.5 py-1.5 text-[13px] font-semibold'
const rowClass =
  'border-grid flex min-h-10 flex-wrap items-center gap-2 border-b py-1.5 text-[14px] last:border-b-0'
const subTitle = 'text-ink-3 m-0 text-[12px] font-bold tracking-wide uppercase'

/**
 * 0153: "Late and overdue" — the bookings past their time (15 minutes, the patient not arrived)
 * and the requests whose asked-for time has passed, apart from the day's list and the requests
 * still in time. Reception answers each one here: Arrived (today) / No-show / Cancel / Book again
 * for a booking; Book another time / Reject for a request. The database tells reception once of
 * each (overdue_booking_notices, asked while this panel is open).
 */
export function OverduePanel({
  i = 2,
  canAct,
  canArrive,
  onSelect,
  onRebook,
  onRegister,
  onBookingClosed,
  hideWhenEmpty,
}: {
  i?: number
  canAct: boolean
  canArrive?: boolean
  onSelect?: (id: string) => void
  /** "Book again" for a late booking (Bookings page). */
  onRebook?: (a: DayAppointment) => void
  onRegister?: (r: RegisterRequest) => void
  onBookingClosed?: () => void
  /** The front-desk home: the panel only shows when something is overdue. */
  hideWhenEmpty?: boolean
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const now = useNow(60_000)
  const { data: bookings = [], isLoading } = useOverdueBookings()
  const { data: requests = [] } = useOpenInquiries()
  const overdueRequests = requests.filter((q) => requestTimePassed(q, now))
  const ops = useDeskOps()
  const confirm = useConfirm()
  const { data: staffSettings } = useStaffSettings()
  const triageFirst = staffSettings?.triageFirst ?? false
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [arriving, setArriving] = useState<DayAppointment | null>(null)
  const [filing, setFiling] = useState<DayAppointment | null>(null)
  const todayKey = isoDate(new Date())
  const total = bookings.length + overdueRequests.length

  if (hideWhenEmpty && total === 0) return null

  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(describe(e))
    }
  }
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
      icon={AlarmClock}
      tint="coral"
      title={t('ops.overdue.title')}
      right={String(total)}
    >
      {error && <p className={errorLine}>{error}</p>}
      {notice && (
        <Flash key={notice} onClose={() => setNotice(null)}>
          {notice}
        </Flash>
      )}
      <div className={subTitle}>{t('ops.overdue.bookings')}</div>
      {!isLoading && bookings.length === 0 ? (
        <Empty>{t('ops.overdue.noBookings')}</Empty>
      ) : (
        <div className="flex flex-col">
          {bookings.map((a, k) => {
            const isToday = (a.day ?? isoDate(new Date(a.startsAt))) === todayKey
            return (
              <div key={a.id} className={rowClass} style={{ '--i': k } as CSSProperties}>
                <Pill tint="coral" icon={AlarmClock}>
                  {isToday ? a.time : `${formatDayMonth(new Date(a.startsAt))} ${a.time}`}
                </Pill>
                <span className="min-w-[140px] flex-1">
                  {onSelect ? (
                    <button
                      type="button"
                      onClick={() => onSelect(a.id)}
                      className="text-primary block max-w-full truncate text-left font-semibold underline-offset-2 hover:underline"
                    >
                      {a.name}
                    </button>
                  ) : (
                    <span className="block truncate font-semibold">{a.name}</span>
                  )}
                  <span className="text-ink-3 block truncate text-[13px]">
                    {[a.doctor, a.reason, a.phone].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="text-red text-[13px] font-semibold">
                  {t(isToday ? 'ops.overdue.notArrived' : 'ops.overdue.notArrivedDay')}
                </span>
                {(canAct || (canArrive ?? canAct)) && (
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
                            ? t(triageFirst ? 'ops.appts.arrivedHint' : 'ops.appts.arrivedHintDesk')
                            : t('patientFields.arrival.buttonHint')
                        }
                      >
                        {t('ops.appts.arrived')}
                      </Button>
                    )}
                    {canAct && (
                      <Button size="sm" variant="tint-coral" onClick={() => void noShow(a)}>
                        <X size={14} aria-hidden="true" />
                        {t('ops.appts.noShow')}
                      </Button>
                    )}
                    {canAct && (
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
                    {canAct && onRebook && a.patientId && (
                      <Button size="sm" variant="default" onClick={() => onRebook(a)}>
                        <CalendarPlus size={14} aria-hidden="true" />
                        {t('ops.appts.bookAgain')}
                      </Button>
                    )}
                  </span>
                )}
                {arriving?.id === a.id && (
                  <StartVisitConfirm
                    mode="arrival"
                    className="basis-full"
                    name={a.name}
                    desk={triageFirst ? 'triage' : 'consultation'}
                    busy={ops.arrived.isPending}
                    onConfirm={() => arrive(a)}
                    onCancel={() => setArriving(null)}
                  />
                )}
                {filing?.id === a.id && (
                  <div className="basis-full">
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
                            { name: v.name, file: v.fileNumber ?? '' },
                          ),
                        )
                        if (v.existing)
                          void navigate({ to: '/app/visit', search: { encounter: v.encounterId } })
                      }}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      <div className={cn(subTitle, 'mt-2')}>{t('ops.overdue.requests')}</div>
      <InquiriesPanel
        overdue
        embedded
        canAct={canAct}
        onRegister={onRegister}
        onBookingClosed={onBookingClosed}
      />
      <Hint>{t('ops.overdue.hint')}</Hint>
    </Panel>
  )
}

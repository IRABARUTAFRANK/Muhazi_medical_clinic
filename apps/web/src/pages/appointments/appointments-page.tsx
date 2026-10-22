import { useState } from 'react'
import { CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, UserPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, isoDate, type StaffUser } from '@mmc/shared'
import { AppointmentDetail } from './appointment-detail'
import { PageBanner } from '@/components/dash/page-banner'
import { sectionTitle } from '@/components/dash/kit-style'
import { Button, buttonVariants } from '@/components/ui/button'
import { Reveal } from '@/components/ui/reveal'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { useDayNames } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { AppointmentsPanel, InquiriesPanel } from '@/pages/home/desk-panels'
import { NewPatientForm } from '@/components/clinical/new-patient-form'
import type { RegisterRequest } from '@/pages/home/inquiries-panel'
import { NewBookingCard, type BookingPrefill } from '@/pages/home/inquiries-panel'
import { Flash } from '@/components/ui/flash'
import { useCan } from '@/lib/api/permissions'

/**
 * Appointments and inquiries (doc §5.2). Reception approves booking requests, then on the day
 * marks each booked patient as arrived: a visit opens and the patient is queued at triage,
 * where the nurse takes the first measurements. No-show and cancel close a booking.
 */
/** Days from today to an ISO day (yyyy-mm-dd), on the local calendar; null when not a day. */
function offsetOf(iso?: string): number | null {
  const [y, m, d] = (iso ?? '').split('-').map(Number)
  if (!y || !m || !d) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((new Date(y, m - 1, d).getTime() - today.getTime()) / 86_400_000)
}

export function AppointmentsPage({ user, initialDay }: { user: StaffUser; initialDay?: string }) {
  const { t } = useTranslation()
  const dayNames = useDayNames()
  const [offset, setOffset] = useState(() => offsetOf(initialDay) ?? 0)
  const [selected, setSelected] = useState<string | null>(null)
  // "Register the patient now" from a booking request: the new-file form opens on the left.
  const [registering, setRegistering] = useState<RegisterRequest | null>(null)
  // "New booking": a phone caller or a patient at the desk
  const [booking, setBooking] = useState<false | { prefill?: BookingPrefill }>(false)
  const [booked, setBooked] = useState<string | null>(null)
  const day = new Date()
  day.setDate(day.getDate() + offset)
  const pickDay = (iso: string) => {
    const o = offsetOf(iso)
    if (o === null) return
    setOffset(o)
    setSelected(null)
  }
  // booking, cancelling and the arrival follow Who may do what (the manager's switches)
  const can = useCan(user)
  const canAct = can('appointment.approve')
  const label =
    offset === 0
      ? t('ops.appts.today')
      : offset === 1
        ? t('ops.appts.tomorrow')
        : offset === -1
          ? t('ops.appts.yesterday')
          : dayNames.long[day.getDay()]

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="appointments">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <PageBanner
          icon={CalendarDays}
          tint="violet"
          title={t('ops.appts.title')}
          lead={t('ops.appts.lead')}
        >
          <div className="bg-card shadow-card flex items-center gap-1 rounded-xl p-1">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setOffset((o) => o - 1)}
              aria-label={t('ops.appts.prevDay')}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </Button>
            <span className="min-w-[150px] text-center text-sm font-semibold tabular-nums">
              {label} · {formatDate(day)}
            </span>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setOffset((o) => o + 1)}
              aria-label={t('ops.appts.nextDay')}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </Button>
          </div>
          <label className="border-border bg-card flex h-10 items-center gap-2 rounded-lg border px-3 text-[14px]">
            <span className="sr-only">{t('ops.appts.pickDay')}</span>
            <input
              type="date"
              value={isoDate(day)}
              onChange={(e) => e.target.value && pickDay(e.target.value)}
              className="bg-transparent outline-none"
            />
          </label>
          {offset !== 0 && (
            <Button size="md" onClick={() => setOffset(0)}>
              {t('ops.appts.today')}
            </Button>
          )}
          {canAct && (
            <Button size="md" onClick={() => setBooking({})}>
              <CalendarPlus size={16} aria-hidden="true" />
              {t('ops.booking.open')}
            </Button>
          )}
          <StaffLink
            to="/app/register"
            className={buttonVariants({ variant: 'primary', size: 'md' })}
          >
            <UserPlus size={16} aria-hidden="true" />
            {t('dashboard.registerPatient')}
          </StaffLink>
        </PageBanner>

        {/* the manager oversees the bookings; reception books them and the doctor accepts */}
        {!canAct && user.role === 'manager' && (
          <p className="bg-primary-tint text-primary m-0 rounded-xl px-3 py-2.5 text-[14px]">
            {t('ops.appts.managerOversees')}
          </p>
        )}
        <section className="flex flex-col gap-3">
          <div className={sectionTitle}>{t('ops.appts.section')}</div>
          <div className="pc:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] grid grid-cols-1 gap-4">
            {registering ? (
              <Reveal focus>
                <NewPatientForm
                  key={registering.initial.surname + registering.initial.phone}
                  initial={registering.initial}
                  fileOnly={{
                    onSaved: (r) => {
                      registering.onSaved(r)
                      setRegistering(null)
                    },
                    onCancel: () => setRegistering(null),
                  }}
                />
              </Reveal>
            ) : selected ? (
              <Reveal>
                <AppointmentDetail id={selected} onBack={() => setSelected(null)} />
              </Reveal>
            ) : (
              <AppointmentsPanel
                key={offset}
                day={day}
                canAct={canAct}
                canArrive={can('visit.start')}
                onSelect={setSelected}
                onRebook={(a) =>
                  a.patientId &&
                  setBooking({
                    prefill: {
                      patientId: a.patientId,
                      patientLabel: `${a.fileNumber ?? ''} · ${a.name}`,
                      doctorUserId: a.doctorUserId,
                      reason: a.reason,
                    },
                  })
                }
              />
            )}
            <div className="flex min-w-0 flex-col gap-4">
              {booked && (
                <Flash key={booked} onClose={() => setBooked(null)}>
                  {booked}
                </Flash>
              )}
              {booking && canAct && (
                <Reveal focus>
                  <NewBookingCard
                    key={booking.prefill?.patientId ?? 'new'}
                    prefill={booking.prefill}
                    onDone={(msg) => {
                      setBooked(msg)
                      setBooking(false)
                    }}
                    onCancel={() => setBooking(false)}
                    onRegister={setRegistering}
                  />
                </Reveal>
              )}
              <InquiriesPanel
                canAct={canAct}
                onRegister={setRegistering}
                onBookingClosed={() => setRegistering(null)}
              />
            </div>
          </div>
          <p className="text-ink-3 m-0 text-xs">{t('ops.appts.flow')}</p>
        </section>
      </main>
    </StaffShell>
  )
}

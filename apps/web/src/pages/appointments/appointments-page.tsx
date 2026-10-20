import { useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, UserPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, isoDate, type StaffUser } from '@mmc/shared'
import { AppointmentDetail } from './appointment-detail'
import { PageBanner } from '@/components/dash/page-banner'
import { sectionTitle } from '@/components/dash/kit-style'
import { Button, buttonVariants } from '@/components/ui/button'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { useDayNames } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { AppointmentsPanel, InquiriesPanel } from '@/pages/home/desk-panels'

/**
 * Appointments and inquiries (doc §5.2). Reception approves booking requests, then on the day
 * marks each booked patient as arrived: a visit opens and the patient is queued at triage,
 * where the nurse takes the first measurements. No-show and cancel close a booking.
 */
export function AppointmentsPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const dayNames = useDayNames()
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const day = new Date()
  day.setDate(day.getDate() + offset)
  const pickDay = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number)
    if (!y || !m || !d) return
    const chosen = new Date(y, m - 1, d)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    setOffset(Math.round((chosen.getTime() - today.getTime()) / 86_400_000))
    setSelected(null)
  }
  const canAct = ['receptionist', 'manager'].includes(user.role)
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
          <StaffLink
            to="/app/register"
            className={buttonVariants({ variant: 'primary', size: 'md' })}
          >
            <UserPlus size={16} aria-hidden="true" />
            {t('dashboard.registerPatient')}
          </StaffLink>
        </PageBanner>

        <section className="flex flex-col gap-3">
          <div className={sectionTitle}>{t('ops.appts.section')}</div>
          <div className="pc:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] grid grid-cols-1 gap-4">
            {selected ? (
              <AppointmentDetail id={selected} onBack={() => setSelected(null)} />
            ) : (
              <AppointmentsPanel
                key={offset}
                day={day}
                canAct={canAct && offset === 0}
                onSelect={setSelected}
              />
            )}
            <InquiriesPanel canAct={canAct} />
          </div>
          <p className="text-ink-3 m-0 text-xs">{t('ops.appts.flow')}</p>
        </section>
      </main>
    </StaffShell>
  )
}

import { CalendarDays, Pencil } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { startOfDay, workingAt, type StaffUser } from '@mmc/shared'
import { Empty, Panel, SectionTitle } from '@/components/dash/kit'
import { buttonVariants } from '@/components/ui/button'
import { StaffLink } from '@/components/staff/staff-link'
import { asPractitioner, useStaffCalendars } from '@/lib/api/calendar'
import { bookedFor, useBookedSlots } from '@/lib/api/public'
import { useNow } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import { ScheduleBoard } from './schedule-board'

/**
 * "Doctors' calendars" on every staff home page: the week of each doctor who shares the
 * calendar with the staff (or the public), so the desk knows who works when.
 */
export function DoctorCalendarsSection({ user, i = 4 }: { user: StaffUser; i?: number }) {
  const { t } = useTranslation()
  const now = new Date(useNow(60_000))
  const { data: calendars = [] } = useStaffCalendars()
  const { data: booked } = useBookedSlots(startOfDay(now), 21)
  const canEdit = user.role === 'doctor' || user.role === 'manager' || user.dbRole === 'sonographer'
  const inNow = calendars.filter((c) => workingAt(asPractitioner(c), now)).length

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle icon={CalendarDays}>{t('calendar.board.section')}</SectionTitle>
      <Panel
        i={i}
        icon={CalendarDays}
        tint="violet"
        title={t('calendar.board.title')}
        right={t('calendar.board.inNowCount', { count: inNow, total: calendars.length })}
      >
        {calendars.length === 0 ? (
          <Empty icon={CalendarDays}>{t('calendar.board.emptyStaff')}</Empty>
        ) : (
          <ScheduleBoard
            variant="staff"
            now={now}
            bookedFor={(p) => bookedFor(booked, p)}
            doctors={calendars.map((c) => ({
              p: asPractitioner(c),
              department: c.department,
              visibility: c.visibility,
              mine: c.mine,
              userId: c.userId,
            }))}
            action={(d) =>
              d.mine || user.role === 'manager' ? (
                <Link
                  to="/app/calendar"
                  search={d.mine || !d.userId ? {} : { user: d.userId }}
                  className={buttonVariants({ size: 'sm' })}
                >
                  <Pencil size={13} aria-hidden="true" />
                  {t('calendar.board.edit')}
                </Link>
              ) : null
            }
          />
        )}
        {canEdit && (
          <StaffLink
            to="/app/calendar"
            className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'self-start')}
          >
            <CalendarDays size={14} aria-hidden="true" />
            {t(user.role === 'manager' ? 'calendar.board.manage' : 'calendar.board.mine')}
          </StaffLink>
        )}
      </Panel>
    </section>
  )
}

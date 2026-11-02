import { useState } from 'react'
import { CalendarCheck, CalendarPlus, CalendarSync, History, Info, Stethoscope } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime, type StaffUser } from '@mmc/shared'
import { Empty } from '@/components/dash/kit'
import { StaffLink } from '@/components/staff/staff-link'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Flash } from '@/components/ui/flash'
import { ShownList } from '@/components/ui/list-tools'
import { Reveal } from '@/components/ui/reveal'
import { changeable, usePatientBookings, type PatientBooking } from '@/lib/api/follow-up'
import { FollowUpForm, type FollowUpPatient } from './follow-up-form'

const TONE: Record<string, 'blue' | 'green' | 'yellow' | 'red' | 'grey'> = {
  approved: 'yellow',
  confirmed: 'blue',
  arrived: 'green',
  in_progress: 'green',
  completed: 'green',
  no_show: 'red',
  cancelled: 'red',
  declined: 'red',
}
const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`

/**
 * The patient file's "Bookings" (0125): the bookings still to come and the earlier ones, with
 * whom, why, who booked it and from which visit; "Book an appointment" for the people who may
 * book, and "Change booking" on one not yet seen.
 */
export function PatientBookings({
  user,
  patient,
  mayBook,
  startOpen = false,
}: {
  user: StaffUser
  patient: FollowUpPatient
  mayBook: boolean
  /** Opened by the header's "Book an appointment". */
  startOpen?: boolean
}) {
  const { t } = useTranslation()
  const { data, isLoading, error } = usePatientBookings(patient.id)
  const [adding, setAdding] = useState(startOpen)
  const [changing, setChanging] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const rows = data?.rows ?? []
  const upcoming = rows
    .filter((b) => b.upcoming)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  const past = rows.filter((b) => !b.upcoming)

  const line = (b: PatientBooking) => (
    <Row key={b.id} className="flex-col items-stretch gap-2 py-2.5">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[14px] font-semibold tabular-nums">{when(b.startsAt)}</span>
        <span className="text-ink-2 text-[14px]">
          {t('followUp.withName', { name: b.with ?? '—' })}
          {b.withRole && b.withRole !== 'doctor'
            ? ` · ${t(`booking.roleLabel.${b.withRole}`, { defaultValue: b.withRole })}`
            : ''}
        </span>
        <Badge tone={TONE[b.status] ?? 'grey'}>
          {t(`ops.appts.status.${b.status}`, { defaultValue: b.status })}
        </Badge>
        <span className="flex-1" />
        {mayBook && changeable(b.status) && changing !== b.id && (
          <Button size="sm" variant="tint-violet" onClick={() => setChanging(b.id)}>
            <CalendarSync size={14} aria-hidden="true" />
            {t('followUp.change.button')}
          </Button>
        )}
        {b.encounterId && (
          <StaffLink
            to="/app/visit"
            search={{ encounter: b.encounterId }}
            className={buttonVariants({ size: 'sm', variant: 'tint-blue' })}
          >
            <Stethoscope size={14} aria-hidden="true" />
            {t('myBookings.openVisit')}
          </StaffLink>
        )}
      </span>
      {(b.reason || b.note) && (
        <span className="text-ink-2 text-[14px]">
          {[b.reason, b.note].filter(Boolean).join(' · ')}
        </span>
      )}
      <span className="text-ink-3 text-[12px]">
        {[
          b.bookedBy &&
            t('followUp.bookedByLine', {
              name: b.bookedBy,
              when: b.bookedAt ? when(b.bookedAt) : '',
            }),
          b.source && t(`ops.detail.sources.${b.source}`, { defaultValue: b.source }),
          b.fromReference && t('followUp.fromVisit', { reference: b.fromReference }),
          b.cancelReason,
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
      {changing === b.id && (
        <FollowUpForm
          user={user}
          patient={patient}
          change={{
            id: b.id,
            startsAt: b.startsAt,
            withUserId: b.withUserId,
            reason: b.reason,
            note: b.note,
          }}
          onDone={(m) => {
            setChanging(null)
            setNotice(m)
          }}
          onCancel={() => setChanging(null)}
        />
      )}
    </Row>
  )

  return (
    <div className="flex flex-col gap-4">
      {notice && (
        <Flash key={notice} onClose={() => setNotice(null)}>
          {notice}
        </Flash>
      )}
      {error && (
        <p className="bg-red-bg text-red border-red/30 m-0 rounded-md border px-3 py-2 text-[13px] font-semibold">
          {error.message}
        </p>
      )}
      {data?.missing && (
        <p className="text-ink-2 m-0 flex items-center gap-2 text-[14px]">
          <Info size={16} aria-hidden="true" />
          {t('myBookings.needsUpdate')}
        </p>
      )}
      <Card className="anim-enter">
        <CardHeader icon={CalendarCheck} hue="violet">
          <span>{t('followUp.upcoming')}</span>
          <span className="flex items-center gap-2">
            <span className="text-ink-3 text-[13px]">{upcoming.length}</span>
            {mayBook && !adding && (
              <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
                <CalendarPlus size={14} aria-hidden="true" />
                {t('followUp.bookAppointment')}
              </Button>
            )}
          </span>
        </CardHeader>
        {adding && (
          <CardBody>
            <Reveal focus>
              <FollowUpForm
                user={user}
                patient={patient}
                onDone={(m) => {
                  setAdding(false)
                  setNotice(m)
                }}
                onCancel={() => setAdding(false)}
              />
            </Reveal>
          </CardBody>
        )}
        {isLoading && <CardBody className="text-ink-3 text-[13px]">…</CardBody>}
        {!isLoading && upcoming.length === 0 && (
          <CardBody>
            <Empty icon={CalendarCheck}>{t('followUp.noneUpcoming')}</Empty>
          </CardBody>
        )}
        {upcoming.map(line)}
      </Card>
      <Card className="anim-enter">
        <CardHeader icon={History} hue="violet">
          <span>{t('followUp.earlier')}</span>
          <span className="text-ink-3 text-[13px]">{past.length}</span>
        </CardHeader>
        {!isLoading && past.length === 0 && (
          <CardBody>
            <Empty icon={History}>{t('followUp.noneEarlier')}</Empty>
          </CardBody>
        )}
        <ShownList items={past} step={8}>
          {(shown) => <>{shown.map(line)}</>}
        </ShownList>
      </Card>
    </div>
  )
}

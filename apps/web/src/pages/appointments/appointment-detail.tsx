import { useState } from 'react'
import {
  CalendarCheck,
  CalendarPlus,
  CalendarSync,
  CalendarX,
  CircleAlert,
  FolderOpen,
  Phone,
  Stethoscope,
  Undo2,
  UserX,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { FollowUpForm } from '@/components/clinical/follow-up-form'
import { Flash } from '@/components/ui/flash'
import { Reveal } from '@/components/ui/reveal'
import { changeable } from '@/lib/api/follow-up'
import { useMyBookingActions } from '@/lib/api/my-bookings'
import { useConfirm } from '@/lib/confirm'
import { useNow } from '@/lib/hooks'
import { useSession } from '@/store/session'
import { card } from '@/components/dash/kit-style'
import { SidePanel } from '@/components/ui/side-panel'
import { StaffLink } from '@/components/staff/staff-link'
import { useAppointmentDetail } from '@/lib/api/desk-ops'
import { cn } from '@/lib/utils'

const when = (iso: string | null) =>
  iso ? `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}` : '—'
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** A Rwandan number written 07…, 2507… or +2507… as +2507… (for the call link). */
const intl = (phone: string) => {
  const d = phone.replace(/[^\d]/g, '')
  if (d.startsWith('250')) return `+${d}`
  if (d.startsWith('0')) return `+250${d.slice(1)}`
  return `+250${d}`
}

const TONE: Record<string, 'blue' | 'green' | 'yellow' | 'red' | 'grey'> = {
  inquiry: 'yellow',
  approved: 'yellow',
  confirmed: 'blue',
  arrived: 'green',
  in_progress: 'green',
  completed: 'green',
  no_show: 'red',
  cancelled: 'red',
  rejected: 'red',
  declined: 'red',
}
/** A booking that will not happen: a new one may be made for the same patient (0208). */
const ENDED = ['no_show', 'cancelled', 'declined', 'left_unseen']

/**
 * Everything about one booking, in a side panel (rose: bookings) over the day's list, which
 * keeps the chosen row tinted. Closing it (Escape, the overlay, ×) returns to the list.
 *
 * 0210: a booking whose time passed without the patient is closed here too — Did not come,
 * Another time, Cancel (with the reason), Call; one that ended: Book again, and a wrong "Did not
 * come" taken back. `mayClose` says who may (reception, the manager, the booking's own doctor, as
 * the database allows since 0208). `changeFirst` opens the form for another time at once.
 */
export function AppointmentDetail({
  id,
  onClose,
  mayClose,
  changeFirst = false,
}: {
  id: string | null
  onClose: () => void
  mayClose?: (doctorUserId: string | null) => boolean
  changeFirst?: boolean
}) {
  const { t } = useTranslation()
  const { data: a, isLoading, error } = useAppointmentDetail(id)
  const user = useSession((s) => s.user)
  const actions = useMyBookingActions()
  const confirm = useConfirm()
  const now = useNow(60_000)
  // 0125: "Change booking" (time, person, reason, note) with the booking form
  const [changing, setChanging] = useState<string | null>(null)
  // 0210: "Book again": a new booking for the same patient
  const [rebooking, setRebooking] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  // "Another time" from the list opens this booking with its form already open (once per booking)
  const [openedFor, setOpenedFor] = useState<string | null>(null)
  if (changeFirst && id && openedFor !== id) {
    setOpenedFor(id)
    setChanging(id)
    setRebooking(null)
  }
  const busy = actions.outcome.isPending || actions.undo.isPending
  const canClose = !!a && !!mayClose?.(a.doctorUserId)
  const missed = !!a && changeable(a.status) && !!a.startsAt && Date.parse(a.startsAt) <= now
  const ended = !!a && ENDED.includes(a.status)
  const name = a ? (a.patientName ?? a.contactName ?? '') : ''
  const phone = a ? (a.patientPhone ?? a.contactPhone) : null

  const run = async (fn: () => Promise<unknown>, text: string) => {
    setFailed(null)
    setNotice(null)
    try {
      await fn()
      setNotice(text)
    } catch (e) {
      setFailed(describe(e))
    }
  }
  const noShow = async () => {
    if (!a) return
    if (
      !(await confirm({
        title: t('myBookings.act.noShowConfirm', { name, when: when(a.startsAt) }),
        body: t('myBookings.act.noShowBody'),
        confirmLabel: t('myBookings.act.noShowYes'),
        tone: 'danger',
      }))
    )
      return
    await run(
      () => actions.outcome.mutateAsync({ id: a.id, status: 'no_show' }),
      t('myBookings.act.noShowDone', { name }),
    )
  }
  const cancel = async () => {
    if (!a) return
    const r = await confirm({
      title: t('myBookings.act.cancelConfirm', { name, when: when(a.startsAt) }),
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
      () => actions.outcome.mutateAsync({ id: a.id, status: 'cancelled', reason: r.value }),
      t('myBookings.act.cancelDone', { name }),
    )
  }
  const undo = async () => {
    if (!a) return
    if (
      !(await confirm({
        title: t('myBookings.act.undoConfirm', { name }),
        body: t('myBookings.act.undoBody'),
        confirmLabel: t('myBookings.act.undoYes'),
      }))
    )
      return
    await run(() => actions.undo.mutateAsync(a.id), t('myBookings.act.undoDone', { name }))
  }
  const startChange = () => {
    if (!a) return
    setRebooking(null)
    setNotice(null)
    setChanging(a.id)
  }

  const call = phone ? (
    <a href={`tel:${intl(phone)}`} className={buttonVariants({ size: 'sm', variant: 'default' })}>
      <Phone size={14} aria-hidden="true" />
      {t('common.call')}
    </a>
  ) : null

  const rows: [string, string | null | undefined][] = a
    ? [
        [t('ops.detail.when'), when(a.startsAt)],
        [t('ops.detail.doctor'), a.doctor],
        [t('ops.detail.reason'), a.reason],
        [t('followUp.note'), a.note],
        [t('followUp.change.lastWhy'), a.changeReason],
        [t('ops.detail.service'), a.category],
        [
          t('ops.detail.patient'),
          a.patientName ? `${a.patientFile ?? ''} · ${a.patientName}` : a.contactName,
        ],
        [t('ops.detail.phone'), phone],
        [
          t('ops.detail.channel'),
          a.channel ? t(`ops.detail.channels.${a.channel}`, { defaultValue: a.channel }) : null,
        ],
        [
          t('ops.detail.source'),
          a.source ? t(`ops.detail.sources.${a.source}`, { defaultValue: a.source }) : null,
        ],
        [t('ops.detail.reference'), a.reference],
        [t('ops.detail.requestedAt'), when(a.createdAt)],
        [t('ops.detail.preferred'), a.preferredAt ? when(a.preferredAt) : null],
        [t('ops.detail.approved'), a.approvedBy ? `${a.approvedBy} · ${when(a.approvedAt)}` : null],
        [t('ops.detail.accepted'), a.acceptedBy ? `${a.acceptedBy} · ${when(a.acceptedAt)}` : null],
        [t('ops.detail.cancelReason'), a.cancelReason],
        [t('ops.detail.insurer'), a.insurer],
      ]
    : []

  return (
    <SidePanel
      open={id !== null}
      onClose={onClose}
      hue="rose"
      icon={CalendarCheck}
      title={a ? name : t('ops.detail.title')}
      subtitle={a ? [when(a.startsAt), a.doctor].filter(Boolean).join(' · ') : undefined}
      tags={
        a ? (
          <>
            <Badge tone={TONE[a.status] ?? 'grey'}>
              {t(`ops.appts.status.${a.status}`, { defaultValue: a.status })}
            </Badge>
            {missed && <Badge tone="red">{t('myBookings.notSeen')}</Badge>}
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        {(error || failed) && (
          <p
            role="alert"
            className="border-red/30 bg-red-bg text-red m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-[13px] font-medium"
          >
            <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
            <span>{failed ?? error?.message}</span>
          </p>
        )}
        {isLoading && <p className="text-ink-3 m-0 text-[13px]">…</p>}
        {notice && (
          <Flash key={notice} onClose={() => setNotice(null)}>
            {notice}
          </Flash>
        )}
        {/* 0210: the time passed without the patient: say what happened */}
        {a && missed && canClose && (
          <section className="border-red/25 bg-red-bg/60 flex flex-col gap-2.5 rounded-md border p-3">
            <p className="text-ink m-0 flex items-start gap-2 text-[14px] font-medium">
              <UserX size={16} aria-hidden="true" className="text-red mt-0.5 flex-none" />
              <span>{t('myBookings.act.missedLead', { name })}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="danger-solid"
                disabled={busy}
                onClick={() => void noShow()}
              >
                <UserX size={14} aria-hidden="true" />
                {t('myBookings.act.noShow')}
              </Button>
              {changing !== a.id && a.startsAt && (
                <Button size="sm" variant="tint-violet" disabled={busy} onClick={startChange}>
                  <CalendarSync size={14} aria-hidden="true" />
                  {t('home.otherTime')}
                </Button>
              )}
              <Button size="sm" variant="tint-coral" disabled={busy} onClick={() => void cancel()}>
                <CalendarX size={14} aria-hidden="true" />
                {t('myBookings.act.cancel')}
              </Button>
              {call}
            </div>
          </section>
        )}
        {a && user && changing === a.id && a.startsAt && (
          <Reveal>
            <FollowUpForm
              user={user}
              patient={{
                id: a.patientId ?? a.id,
                name,
                fileNumber: a.patientFile,
                phone,
              }}
              change={{
                id: a.id,
                startsAt: a.startsAt,
                withUserId: a.doctorUserId,
                reason: a.reason,
                note: a.note ?? null,
              }}
              onDone={(m) => {
                setChanging(null)
                setNotice(m)
              }}
              onCancel={() => setChanging(null)}
            />
          </Reveal>
        )}
        {a && user && rebooking === a.id && a.patientId && (
          <Reveal>
            <FollowUpForm
              user={user}
              patient={{ id: a.patientId, name, fileNumber: a.patientFile, phone }}
              reason={a.reason ?? ''}
              onDone={(m) => {
                setRebooking(null)
                setNotice(m)
              }}
              onCancel={() => setRebooking(null)}
            />
          </Reveal>
        )}
        {a && (
          <>
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
              {changeable(a.status) && !(missed && canClose) && a.startsAt && changing !== a.id && (
                <Button size="sm" variant="tint-violet" onClick={startChange}>
                  <CalendarSync size={14} aria-hidden="true" />
                  {t('followUp.change.button')}
                </Button>
              )}
              {canClose && a.status === 'confirmed' && !missed && (
                <Button
                  size="sm"
                  variant="tint-coral"
                  disabled={busy}
                  onClick={() => void cancel()}
                >
                  <CalendarX size={14} aria-hidden="true" />
                  {t('myBookings.act.cancel')}
                </Button>
              )}
              {canClose && ended && a.patientId && rebooking !== a.id && (
                <Button
                  size="sm"
                  variant="tint-violet"
                  onClick={() => {
                    setChanging(null)
                    setNotice(null)
                    setRebooking(a.id)
                  }}
                >
                  <CalendarPlus size={14} aria-hidden="true" />
                  {t('ops.appts.bookAgain')}
                </Button>
              )}
              {!(missed && canClose) && call}
              {a.patientId && (
                <StaffLink
                  to="/app/patient"
                  search={{ id: a.patientId }}
                  className={buttonVariants({ size: 'sm' })}
                >
                  <FolderOpen size={14} aria-hidden="true" />
                  {t('patients.openFile')}
                </StaffLink>
              )}
              {a.encounterId && (
                <StaffLink
                  to="/app/visit"
                  search={{ encounter: a.encounterId }}
                  className={buttonVariants({ size: 'sm', variant: 'primary' })}
                >
                  <Stethoscope size={14} aria-hidden="true" />
                  {t('register.done.openVisit')}
                </StaffLink>
              )}
            </div>
            {canClose && a.status === 'no_show' && !a.encounterId && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void undo()}
                className="text-ink-2 hover:text-ink inline-flex w-fit items-center gap-1.5 text-[13px] font-medium underline-offset-2 hover:underline"
              >
                <Undo2 size={14} aria-hidden="true" />
                {t('myBookings.act.undo')}
              </button>
            )}
          </>
        )}
      </div>
    </SidePanel>
  )
}

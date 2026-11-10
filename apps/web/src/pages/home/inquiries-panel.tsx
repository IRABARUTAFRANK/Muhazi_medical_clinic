import { useState, type CSSProperties, type FormEvent } from 'react'
import {
  AlarmClock,
  CalendarCheck,
  CalendarPlus,
  CalendarX,
  Check,
  MessageSquare,
  Phone,
  UserRound,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatDayMonth, formatTime, isoDate, type DayKey } from '@mmc/shared'
import { Empty, Hint, Panel, Pill } from '@/components/dash/kit'
import { Button, actionLink } from '@/components/ui/button'
import { Reveal } from '@/components/ui/reveal'
import { Field } from '@/components/ui/field'
import { TimeSelect } from '@/components/ui/time-select'
import { ShownList } from '@/components/ui/list-tools'
import { Select } from '@/components/ui/select'
import { Flash } from '@/components/ui/flash'
import {
  requestTimePassed,
  useBookableDoctors,
  useHomeActions,
  useOpenInquiries,
  type OpenInquiry,
} from '@/lib/api/home'
import { useFindPatients } from '@/lib/api/visits'
import { useDeskOps } from '@/lib/api/desk-ops'
import { useNow } from '@/lib/hooks'
import { useFreeSlots } from '@/lib/api/follow-up'
import { useStaffCalendars } from '@/lib/api/calendar'
import { useConfirm } from '@/lib/confirm'
import { focusAttr, useFocusFirst } from '@/lib/notice-focus'
import { FOCUS_PANEL } from '@/lib/notice-target'
import { cn } from '@/lib/utils'
import { NewPatientForm } from '@/components/clinical/new-patient-form'

const errorLine = 'bg-red-bg text-red m-0 rounded-lg px-2.5 py-1.5 text-[13px] font-semibold'
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
const pad = (n: number) => String(n).padStart(2, '0')
const whenOf = (iso: string | null) => {
  if (!iso) return null
  const d = new Date(iso)
  return `${formatDate(d)} ${formatTime(d)}`
}

/**
 * Booking requests from the website or the phone. Reception books each one: the patient's file
 * (matched by phone, searched, or registered now), the doctor and the time. The doctor is then
 * asked to accept; their answer comes back as a notification. Reject asks for a reason.
 */
/** Prefill for a new file from a booking request ("Uwase Claudine", phone). */
export interface RegisterRequest {
  initial: { surname: string; givenNames: string; phone: string }
  onSaved: (r: { patientId: string; fileNumber: string; name: string }) => void
}

export function InquiriesPanel({
  i = 2,
  canAct,
  onRegister,
  onBookingClosed,
  overdue = false,
  embedded = false,
}: {
  i?: number
  canAct: boolean
  /** 0153: only the requests whose asked-for time has passed (else only those still in time). */
  overdue?: boolean
  /** 0153: the list alone, inside another panel ("Late and overdue"). */
  embedded?: boolean
  /** Open the new-file form beside the panel (Bookings page); without it the form opens inline. */
  onRegister?: (r: RegisterRequest) => void
  /** The booking being made was cancelled, rejected, finished or replaced: close what belongs to it. */
  onBookingClosed?: () => void
}) {
  const { t } = useTranslation()
  const { data: all = [] } = useOpenInquiries()
  // 0153: a request past its asked-for time is listed in "Late and overdue", not here
  const now = useNow(60_000)
  const waiting = all.filter((q) => requestTimePassed(q, now) === overdue)
  // a notice points to one request (?focus=inquiry:<id>): it comes first and is outlined
  const inquiries = useFocusFirst(waiting, 'inquiry')
  const actions = useHomeActions()
  const confirm = useConfirm()
  const [open, setOpenState] = useState<string | null>(null)
  // Leaving a booking (Cancel, another Book, booked, rejected) also closes its new-file form.
  const setOpen = (id: string | null) => {
    if (id !== open) onBookingClosed?.()
    setOpenState(id)
  }
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const reject = async (q: OpenInquiry) => {
    const r = await confirm({
      title: t('ops.inquiries.rejectReason', { name: q.name }),
      input: {
        label: t('confirm.reasonLabel'),
        placeholder: t('confirm.reasonPh'),
        required: true,
        multiline: true,
      },
      confirmLabel: t('confirm.desks.inquiry.rejectYes'),
      tone: 'danger',
    })
    if (!r.ok) return
    setError(null)
    try {
      await actions.rejectInquiry.mutateAsync({ id: q.id, reason: r.value })
      // the rejected request was the one being booked: its new-file form closes too
      if (open === q.id) setOpen(null)
    } catch (e) {
      setError(describe(e))
    }
  }
  const channel = (c: string | null) =>
    c === 'sms'
      ? t('landing.book.sms')
      : c === 'none'
        ? t('landing.book.callChannel')
        : t('landing.book.whatsapp')

  const body = (
    <>
      {error && <p className={errorLine}>{error}</p>}
      {done && (
        <Flash key={done} onClose={() => setDone(null)}>
          {done}
        </Flash>
      )}
      {inquiries.length === 0 ? (
        <Empty>{t(overdue ? 'ops.overdue.noRequests' : 'desk.receptionist.noInquiries')}</Empty>
      ) : (
        <ShownList items={inquiries} step={5}>
          {(shown) => (
            <div className="flex flex-col">
              {shown.map((q, k) => (
                <div
                  key={q.id}
                  {...focusAttr('inquiry', q.id)}
                  className="border-grid flex flex-col gap-2 border-b py-2.5 last:border-b-0"
                  style={{ '--i': k } as CSSProperties}
                >
                  <div className="flex flex-wrap items-start gap-2.5">
                    <Pill tint="violet" icon={MessageSquare}>
                      {q.reference ?? '—'}
                    </Pill>
                    <span className="min-w-[160px] flex-1">
                      <span className="block font-semibold">{q.name}</span>
                      <span className="text-ink-2 block text-[13px]">
                        <Phone size={12} aria-hidden="true" className="mr-1 inline" />
                        {q.phone} · {channel(q.channel)}
                      </span>
                      {/* the time asked for is already past: book another one with the person */}
                      {(q.startsAt ?? q.preferredAt) &&
                        new Date((q.startsAt ?? q.preferredAt)!).getTime() < Date.now() && (
                          <span className="text-yellow block text-[13px] font-semibold">
                            {t('ops.inquiries.timePassed')}
                          </span>
                        )}
                      {q.category && (
                        <span className="text-ink-2 block text-[13px]">
                          {t('ops.inquiries.service', { name: q.category })}
                        </span>
                      )}
                      {/* reception tells the person (call, WhatsApp or SMS from this device) */}
                      {q.phone && (
                        <span className="mt-0.5 flex flex-wrap gap-3 text-[13px]">
                          <a
                            className="text-primary inline-flex items-center font-semibold underline-offset-2 hover:underline"
                            href={`tel:${intl(q.phone)}`}
                          >
                            {t('ops.inquiries.call')}
                          </a>
                          <a
                            className="text-primary inline-flex items-center font-semibold underline-offset-2 hover:underline"
                            href={`https://wa.me/${intl(q.phone).replace('+', '')}?text=${encodeURIComponent(t('ops.inquiries.message', { name: q.name }))}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            WhatsApp
                          </a>
                          <a
                            className="text-primary inline-flex items-center font-semibold underline-offset-2 hover:underline"
                            href={`sms:${intl(q.phone)}?body=${encodeURIComponent(t('ops.inquiries.message', { name: q.name }))}`}
                          >
                            SMS
                          </a>
                        </span>
                      )}
                      {q.note && (
                        <span className="text-ink-2 block text-[13px]">
                          {t('ops.inquiries.asksFor', { text: q.note })}
                        </span>
                      )}
                      <span className="text-primary block text-[13px] font-semibold">
                        {q.doctor
                          ? t('ops.inquiries.wants', {
                              doctor: q.doctor,
                              when: whenOf(q.startsAt) ?? '',
                            })
                          : q.preferredAt
                            ? t('ops.inquiries.prefers', { when: whenOf(q.preferredAt) ?? '' })
                            : t('ops.inquiries.anyTime')}
                      </span>
                      <span
                        className={cn(
                          'block text-[13px]',
                          q.patientId ? 'text-green' : 'text-yellow',
                        )}
                      >
                        <UserRound size={12} aria-hidden="true" className="mr-1 inline" />
                        {q.patientId
                          ? t('ops.inquiries.fileFound', {
                              file: q.patientFile ?? '',
                              name: q.patientName ?? '',
                            })
                          : q.matches > 1
                            ? t('ops.inquiries.manyFiles', { count: q.matches })
                            : t('ops.inquiries.noFile')}
                      </span>
                    </span>
                    {canAct && (
                      <span className="flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant={open === q.id ? 'default' : 'primary'}
                          onClick={() => {
                            setDone(null)
                            setOpen(open === q.id ? null : q.id)
                          }}
                        >
                          {open === q.id ? (
                            <X size={14} aria-hidden="true" />
                          ) : (
                            <CalendarCheck size={14} aria-hidden="true" />
                          )}
                          {open === q.id ? t('staff.form.cancel') : t('ops.inquiries.book')}
                        </Button>
                        <Button size="sm" variant="tint-coral" onClick={() => void reject(q)}>
                          <X size={14} aria-hidden="true" />
                          {t('ops.inquiries.reject')}
                        </Button>
                      </span>
                    )}
                  </div>
                  {open === q.id && (
                    <Reveal focus block="nearest">
                      <BookForm
                        q={q}
                        onRegister={onRegister}
                        onDone={(msg) => {
                          setOpen(null)
                          setDone(msg)
                        }}
                      />
                    </Reveal>
                  )}
                </div>
              ))}
            </div>
          )}
        </ShownList>
      )}
    </>
  )
  if (embedded) return body
  return (
    <Panel
      i={i}
      id={overdue ? undefined : FOCUS_PANEL.inquiry}
      icon={overdue ? AlarmClock : MessageSquare}
      tint={overdue ? 'coral' : 'teal'}
      title={t(overdue ? 'ops.overdue.requests' : 'desk.receptionist.inquiries')}
      right={String(inquiries.length)}
    >
      {body}
      <Hint>{t(overdue ? 'ops.overdue.requestsHint' : 'ops.inquiries.hint')}</Hint>
    </Panel>
  )
}

/** A booking started from another one (a booking the doctor declined, booked again). */
export interface BookingPrefill {
  patientId: string
  patientLabel: string
  doctorUserId?: string | null
  reason?: string | null
}

/** A Rwandan number written 07…, 2507… or +2507… as +2507… (for call, WhatsApp and SMS links). */
const intl = (phone: string) => {
  const d = phone.replace(/[^\d]/g, '')
  if (d.startsWith('250')) return `+${d}`
  if (d.startsWith('0')) return `+250${d.slice(1)}`
  return `+250${d}`
}

/**
 * "New booking" (reception): a phone caller or a patient at the desk, with a doctor at a time.
 * The same form as for a website request, plus the reason and how the patient asked.
 */
export function NewBookingCard({
  onDone,
  onCancel,
  onRegister,
  prefill,
}: {
  onDone: (msg: string) => void
  onCancel: () => void
  onRegister?: (r: RegisterRequest) => void
  prefill?: BookingPrefill
}) {
  const { t } = useTranslation()
  return (
    <Panel
      i={1}
      icon={CalendarPlus}
      tint="violet"
      title={t('ops.booking.title')}
      right={
        <Button size="sm" variant="tint-coral" onClick={onCancel}>
          <X size={14} aria-hidden="true" />
          {t('staff.form.cancel')}
        </Button>
      }
    >
      <p className="text-ink-2 m-0 text-[13px]">{t('ops.booking.lead')}</p>
      <BookForm onDone={onDone} onRegister={onRegister} prefill={prefill} />
    </Panel>
  )
}

/** Patient file, doctor, day and time; then the doctor is asked to accept. */
function BookForm({
  q,
  onDone,
  onRegister,
  prefill,
}: {
  /** A website request being booked; none for a new booking made at the desk. */
  q?: OpenInquiry
  onDone: (msg: string) => void
  onRegister?: (r: RegisterRequest) => void
  prefill?: BookingPrefill
}) {
  const { t } = useTranslation()
  const actions = useHomeActions()
  const ops = useDeskOps()
  const confirm = useConfirm()
  const { data: doctors = [] } = useBookableDoctors()
  const start = q ? (q.startsAt ?? q.preferredAt) : null
  // 0108: a website request booked with its name and phone only; the file is made on arrival
  const [withoutFile, setWithoutFile] = useState(false)
  const [patientId, setPatientId] = useState(q?.patientId ?? prefill?.patientId ?? '')
  const [patientLabel, setPatientLabel] = useState(
    q?.patientId
      ? `${q.patientFile ?? ''} · ${q.patientName ?? ''}`
      : (prefill?.patientLabel ?? ''),
  )
  const [search, setSearch] = useState('')
  const { data: hits = [] } = useFindPatients(search)
  const [doctorUserId, setDoctorUserId] = useState(q?.doctorUserId ?? prefill?.doctorUserId ?? '')
  const [reason, setReason] = useState(prefill?.reason ?? '')
  const [source, setSource] = useState<'reception' | 'phone'>('phone')
  const [day, setDay] = useState(start ? isoDate(new Date(start)) : '')
  const [time, setTime] = useState(
    start ? `${pad(new Date(start).getHours())}:${pad(new Date(start).getMinutes())}` : '09:00',
  )
  const [error, setError] = useState<string | null>(null)
  const [registering, setRegistering] = useState(false)
  const doctor = doctors.find((d) => d.userId === doctorUserId)
  // 0154: the doctor's times for the day (working hours, days off, bookings): the form offers
  // only what can be booked, and the next working days when the chosen day cannot be
  const slots = useFreeSlots(doctorUserId || null, day || null)
  const s = slots.data
  const free = s?.slots.filter((x) => x.state === 'free') ?? []
  const { data: calendars = [] } = useStaffCalendars()
  const cal = calendars.find((c) => c.userId === doctorUserId)
  const nextDays: string[] = []
  if (cal && Object.keys(cal.hours).length > 0) {
    const from = new Date(`${day || isoDate(new Date())}T12:00:00`)
    for (let i = 1; i <= 28 && nextDays.length < 4; i++) {
      const d = new Date(from.getTime() + i * 86_400_000)
      const iso = isoDate(d)
      if ((cal.hours[String(d.getDay()) as DayKey]?.length ?? 0) > 0 && !cal.daysOff.includes(iso))
        nextDays.push(iso)
    }
  }
  const shortDays = t('days.short', { returnObjects: true }) as unknown
  const dayLabel = (iso: string) => {
    const d = new Date(`${iso}T12:00:00`)
    const wd = Array.isArray(shortDays) ? (shortDays as string[])[d.getDay()] : ''
    return `${wd} ${formatDayMonth(d)}`
  }
  const pickDay = (d: string) => {
    setDay(d)
    setTime('')
  }
  // "Uwase Claudine" → surname Uwase, given names Claudine (corrected in the form if needed).
  const [first, ...rest] = (q?.name ?? search).trim().split(/\s+/)
  const register: RegisterRequest = {
    initial: { surname: first ?? '', givenNames: rest.join(' '), phone: q?.phone ?? '' },
    onSaved: (r) => {
      setPatientId(r.patientId)
      setPatientLabel(`${r.fileNumber} · ${r.name}`)
      setRegistering(false)
    },
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!patientId && !(q && withoutFile)) return setError(t('ops.inquiries.errors.patient'))
    if (!doctorUserId) return setError(t('ops.inquiries.errors.doctor'))
    if (!day || !time) return setError(t('ops.inquiries.errors.when'))
    // a doctor with working hours: one of the free times, never a time outside them
    if (s?.hasHours && !free.some((x) => x.time === time))
      return setError(t('ops.inquiries.errors.freeTime'))
    const at = new Date(`${day}T${time}:00`)
    if (Number.isNaN(at.getTime())) return setError(t('ops.inquiries.errors.when'))
    const name = q?.name ?? patientLabel.split(' · ').slice(1).join(' · ')
    const when = `${formatDate(at)} ${formatTime(at)}`
    if (
      !(await confirm({
        title: t('confirm.desks.booking.book', { name, doctor: doctor?.name ?? '', when }),
        body: t('confirm.desks.booking.bookBody', { doctor: doctor?.name ?? '' }),
        confirmLabel: t('confirm.desks.booking.bookYes'),
      }))
    )
      return
    try {
      if (q && withoutFile && !patientId)
        await ops.bookWithoutFile.mutateAsync({
          id: q.id,
          doctorUserId,
          startsAt: at.toISOString(),
        })
      else if (q)
        await actions.approveInquiry.mutateAsync({
          id: q.id,
          patientId,
          doctorUserId,
          startsAt: at.toISOString(),
        })
      else
        await actions.bookAppointment.mutateAsync({
          patientId,
          doctorUserId,
          startsAt: at.toISOString(),
          reason,
          source,
        })
      onDone(t('ops.inquiries.booked', { name, doctor: doctor?.name ?? '', when }))
    } catch (err) {
      setError(describe(err))
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="border-primary/30 wash wash-teal rounded-lg2 flex flex-col gap-3 border p-3"
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-ink-2 text-[13px] font-semibold">{t('ops.inquiries.patient')}</span>
        {!patientId && q && withoutFile ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="border-amber/30 bg-amber-bg text-amber inline-flex min-h-5 items-center gap-1 rounded border px-1.5 py-0.5 text-[12px] font-medium">
              <UserRound size={14} aria-hidden="true" />
              {t('patientFields.booking.noFile', { name: q.name })}
            </span>
            <Button
              type="button"
              size="sm"
              variant="tint-grey"
              onClick={() => setWithoutFile(false)}
            >
              {t('patientFields.booking.chooseFile')}
            </Button>
          </span>
        ) : patientId ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="border-green/25 bg-green-bg text-green inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[11px] leading-none font-medium">
              <Check size={14} aria-hidden="true" />
              {patientLabel}
            </span>
            <Button
              type="button"
              size="sm"
              variant="tint-grey"
              onClick={() => {
                setPatientId('')
                setPatientLabel('')
              }}
            >
              <UserRound size={14} aria-hidden="true" />
              {t('ops.inquiries.otherFile')}
            </Button>
          </span>
        ) : (
          <>
            <Field
              label={t('ops.inquiries.searchFile')}
              value={search}
              placeholder={t('ops.inquiries.searchPh')}
              onChange={(e) => setSearch(e.target.value)}
            />
            {hits.length > 0 && (
              <div className="border-card-border bg-card shadow-card rounded-lg2 flex flex-col border">
                {hits.slice(0, 6).map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    className="border-grid hover:bg-hover flex items-center gap-2 border-b px-3 py-2 text-left text-[13px] last:border-b-0"
                    onClick={() => {
                      setPatientId(h.id)
                      setPatientLabel(`${h.fileNumber} · ${h.surname} ${h.givenNames}`)
                    }}
                  >
                    <span className="text-primary font-semibold tabular-nums">{h.fileNumber}</span>
                    <span className="flex-1 font-semibold">
                      {h.surname} {h.givenNames}
                    </span>
                    <span className="text-ink-3">{h.phone ?? ''}</span>
                  </button>
                ))}
              </div>
            )}
            <span className="text-ink-3 text-[12px]">
              {t('ops.inquiries.noFileHint')}{' '}
              <button
                type="button"
                className={actionLink}
                onClick={() => (onRegister ? onRegister(register) : setRegistering(true))}
              >
                <UserRound size={12} aria-hidden="true" />
                {t('ops.inquiries.registerNow')}
              </button>
            </span>
            {q && (
              <span className="text-ink-3 text-[12px]">
                {t('patientFields.booking.orLater')}{' '}
                <button type="button" className={actionLink} onClick={() => setWithoutFile(true)}>
                  <CalendarCheck size={12} aria-hidden="true" />
                  {t('patientFields.booking.withoutFile')}
                </button>
              </span>
            )}
            {registering && !onRegister && (
              <NewPatientForm
                fileOnly={{ onSaved: register.onSaved, onCancel: () => setRegistering(false) }}
                initial={register.initial}
              />
            )}
          </>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Select
          label={t('ops.inquiries.doctor')}
          wrapperClassName="col-span-2"
          value={doctorUserId}
          onChange={(e) => setDoctorUserId(e.target.value)}
          required
        >
          <option value="">{t('ops.inquiries.pickDoctor')}</option>
          {doctors.map((d) => (
            <option key={d.userId} value={d.userId}>
              {d.name}
              {d.role !== 'doctor' ? ` · ${t(`booking.roleLabel.${d.role}`)}` : ''}
              {d.title ? ` · ${d.title}` : ''}
              {d.hasHours ? '' : ` · ${t('ops.inquiries.noHours')}`}
            </option>
          ))}
        </Select>
        <Field
          label={t('ops.inquiries.day')}
          type="date"
          value={day}
          min={isoDate(new Date())}
          onChange={(e) => setDay(e.target.value)}
          required
        />
        {/* 0154: the time among the doctor's free times of that day */}
        <div className="col-span-2 flex flex-col gap-1.5">
          <span className="text-ink-2 text-[13px] font-semibold">
            {t('ops.inquiries.time')}
            {s?.hasHours && !s.dayOff && free.length > 0 && (
              <span className="text-ink-3 ml-2 font-normal">
                {t('followUp.freeCount', { count: free.length, minutes: s.slotMinutes })}
              </span>
            )}
          </span>
          {!doctorUserId && (
            <p className="text-ink-3 m-0 text-[13px]">{t('ops.inquiries.pickDoctorFirst')}</p>
          )}
          {doctorUserId && !day && (
            <p className="text-ink-3 m-0 text-[13px]">{t('ops.inquiries.pickDayFirst')}</p>
          )}
          {slots.isLoading && <div className="skeleton h-9 rounded-md" aria-busy="true" />}
          {slots.error && <p className={errorLine}>{describe(slots.error)}</p>}
          {s && s.hasHours && s.dayOff && (
            <p className="text-ink-2 m-0 flex items-center gap-2 text-[14px]">
              <CalendarX size={16} aria-hidden="true" className="text-red" />
              {t('followUp.dayOff', { who: doctor?.name ?? '' })}
            </p>
          )}
          {s && s.hasHours && !s.dayOff && s.slots.length === 0 && (
            <p className="text-ink-2 m-0 flex items-center gap-2 text-[14px]">
              <CalendarX size={16} aria-hidden="true" className="text-red" />
              {t('ops.inquiries.notThatDay', { who: doctor?.name ?? '' })}
            </p>
          )}
          {s && s.hasHours && !s.dayOff && s.slots.length > 0 && (
            <>
              <div
                className="grid grid-cols-[repeat(auto-fill,minmax(5.25rem,1fr))] gap-1.5"
                role="radiogroup"
                aria-label={t('ops.inquiries.time')}
              >
                {s.slots.map((x) => {
                  const on = time === x.time
                  return (
                    <button
                      key={x.at}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={x.state !== 'free'}
                      title={x.state === 'free' ? undefined : t(`followUp.slot.${x.state}`)}
                      onClick={() => setTime(x.time)}
                      className={cn(
                        'h-9 rounded-md border text-[14px] font-semibold tabular-nums transition-colors',
                        on
                          ? 'border-primary bg-primary text-white'
                          : x.state === 'free'
                            ? 'border-border bg-card text-ink hover:bg-hover'
                            : 'border-grid bg-surface text-ink-3 cursor-not-allowed line-through',
                      )}
                    >
                      {x.time}
                    </button>
                  )
                })}
              </div>
              {free.length === 0 && (
                <p className="text-ink-2 m-0 text-[14px]">{t('followUp.full')}</p>
              )}
            </>
          )}
          {s && s.hasHours && (s.dayOff || free.length === 0) && nextDays.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5 text-[13px]">
              <span className="text-ink-3">{t('ops.inquiries.nextDays')}</span>
              {nextDays.map((d) => (
                <Button
                  key={d}
                  type="button"
                  size="sm"
                  variant="tint-grey"
                  onClick={() => pickDay(d)}
                >
                  {dayLabel(d)}
                </Button>
              ))}
            </span>
          )}
          {s && !s.hasHours && (
            <>
              <TimeSelect
                label={t('ops.inquiries.time')}
                value={time}
                onChange={setTime}
                step={doctor?.slotMinutes ?? 15}
                day={day}
                required
              />
              <p className="text-ink-3 m-0 text-[12px]">
                {t('ops.inquiries.noHoursHint')}
                {s.booked.length > 0 &&
                  ` ${t('followUp.bookedAt', { times: s.booked.join(', ') })}`}
              </p>
            </>
          )}
        </div>
      </div>
      {!q && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Field
            label={t('ops.booking.reason')}
            value={reason}
            placeholder={t('ops.booking.reasonPh')}
            onChange={(e) => setReason(e.target.value)}
          />
          <Select
            label={t('ops.booking.source')}
            value={source}
            onChange={(e) => setSource(e.target.value as 'reception' | 'phone')}
          >
            <option value="phone">{t('ops.booking.byPhone')}</option>
            <option value="reception">{t('ops.booking.atDesk')}</option>
          </Select>
        </div>
      )}
      {error && (
        <p role="alert" className={errorLine}>
          {error}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        className="self-start"
        loading={
          actions.approveInquiry.isPending ||
          actions.bookAppointment.isPending ||
          ops.bookWithoutFile.isPending
        }
      >
        {!actions.approveInquiry.isPending &&
          !actions.bookAppointment.isPending &&
          !ops.bookWithoutFile.isPending && <CalendarCheck size={16} aria-hidden="true" />}
        {t('ops.inquiries.confirmBook')}
      </Button>
    </form>
  )
}

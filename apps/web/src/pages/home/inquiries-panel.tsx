import { useState, type CSSProperties, type FormEvent } from 'react'
import {
  CalendarCheck,
  CalendarPlus,
  Check,
  MessageSquare,
  Phone,
  UserRound,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime, isoDate } from '@mmc/shared'
import { Empty, Hint, Panel, Pill } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { ShownList } from '@/components/ui/list-tools'
import { Select } from '@/components/ui/select'
import { Flash } from '@/components/ui/flash'
import {
  useBookableDoctors,
  useHomeActions,
  useOpenInquiries,
  type OpenInquiry,
} from '@/lib/api/home'
import { useFindPatients } from '@/lib/api/visits'
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
}: {
  i?: number
  canAct: boolean
  /** Open the new-file form beside the panel (Bookings page); without it the form opens inline. */
  onRegister?: (r: RegisterRequest) => void
  /** The booking being made was cancelled, rejected, finished or replaced: close what belongs to it. */
  onBookingClosed?: () => void
}) {
  const { t } = useTranslation()
  const { data: inquiries = [] } = useOpenInquiries()
  const actions = useHomeActions()
  const [open, setOpenState] = useState<string | null>(null)
  // Leaving a booking (Cancel, another Book, booked, rejected) also closes its new-file form.
  const setOpen = (id: string | null) => {
    if (id !== open) onBookingClosed?.()
    setOpenState(id)
  }
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const reject = async (q: OpenInquiry) => {
    const reason = window.prompt(t('ops.inquiries.rejectReason', { name: q.name }))
    if (!reason) return
    setError(null)
    try {
      await actions.rejectInquiry.mutateAsync({ id: q.id, reason })
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

  return (
    <Panel
      i={i}
      icon={MessageSquare}
      tint="teal"
      title={t('desk.receptionist.inquiries')}
      right={String(inquiries.length)}
    >
      {error && <p className={errorLine}>{error}</p>}
      {done && (
        <Flash key={done} onClose={() => setDone(null)}>
          {done}
        </Flash>
      )}
      {inquiries.length === 0 ? (
        <Empty>{t('desk.receptionist.noInquiries')}</Empty>
      ) : (
        <ShownList items={inquiries} step={5}>
          {(shown) => (
            <div className="flex flex-col">
              {shown.map((q, k) => (
                <div
                  key={q.id}
                  className="border-grid anim-enter flex flex-col gap-2 border-b py-2.5 last:border-b-0"
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
                          <span className="text-amber block text-[13px] font-semibold">
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
                            className="text-primary font-semibold underline-offset-2 hover:underline"
                            href={`tel:${intl(q.phone)}`}
                          >
                            {t('ops.inquiries.call')}
                          </a>
                          <a
                            className="text-primary font-semibold underline-offset-2 hover:underline"
                            href={`https://wa.me/${intl(q.phone).replace('+', '')}?text=${encodeURIComponent(t('ops.inquiries.message', { name: q.name }))}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            WhatsApp
                          </a>
                          <a
                            className="text-primary font-semibold underline-offset-2 hover:underline"
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
                          q.patientId ? 'text-green' : 'text-amber',
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
                        <Button size="sm" variant="ghost" onClick={() => void reject(q)}>
                          {t('ops.inquiries.reject')}
                        </Button>
                      </span>
                    )}
                  </div>
                  {open === q.id && (
                    <BookForm
                      q={q}
                      onRegister={onRegister}
                      onDone={(msg) => {
                        setOpen(null)
                        setDone(msg)
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </ShownList>
      )}
      <Hint>{t('ops.inquiries.hint')}</Hint>
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
        <Button size="sm" variant="ghost" onClick={onCancel}>
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
  const { data: doctors = [] } = useBookableDoctors()
  const start = q ? (q.startsAt ?? q.preferredAt) : null
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
    if (!patientId) return setError(t('ops.inquiries.errors.patient'))
    if (!doctorUserId) return setError(t('ops.inquiries.errors.doctor'))
    if (!day || !time) return setError(t('ops.inquiries.errors.when'))
    const at = new Date(`${day}T${time}:00`)
    if (Number.isNaN(at.getTime())) return setError(t('ops.inquiries.errors.when'))
    try {
      if (q)
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
      onDone(
        t('ops.inquiries.booked', {
          name: q?.name ?? patientLabel.split(' · ').slice(1).join(' · '),
          doctor: doctor?.name ?? '',
          when: `${formatDate(at)} ${formatTime(at)}`,
        }),
      )
    } catch (err) {
      setError(describe(err))
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="border-primary/30 bg-primary-tint/40 flex flex-col gap-3 rounded-xl border p-3"
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-ink-2 text-[13px] font-semibold">{t('ops.inquiries.patient')}</span>
        {patientId ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="bg-green-bg text-green inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-bold">
              <Check size={14} aria-hidden="true" />
              {patientLabel}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setPatientId('')
                setPatientLabel('')
              }}
            >
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
              <div className="border-border bg-card flex flex-col rounded-lg border">
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
                    <span className="text-primary font-bold tabular-nums">{h.fileNumber}</span>
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
                className="text-primary font-semibold underline"
                onClick={() => (onRegister ? onRegister(register) : setRegistering(true))}
              >
                {t('ops.inquiries.registerNow')}
              </button>
            </span>
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
        <Field
          label={t('ops.inquiries.time')}
          type="time"
          step={300}
          value={time}
          onChange={(e) => setTime(e.target.value)}
          required
        />
      </div>
      {doctor && !doctor.hasHours && (
        <p className="text-ink-3 m-0 text-[12px]">{t('ops.inquiries.noHoursHint')}</p>
      )}
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
        loading={actions.approveInquiry.isPending || actions.bookAppointment.isPending}
      >
        {!actions.approveInquiry.isPending && !actions.bookAppointment.isPending && (
          <CalendarCheck size={16} aria-hidden="true" />
        )}
        {t('ops.inquiries.confirmBook')}
      </Button>
    </form>
  )
}

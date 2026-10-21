import { useState, type CSSProperties, type FormEvent } from 'react'
import { CalendarCheck, Check, MessageSquare, Phone, UserRound, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime, isoDate } from '@mmc/shared'
import { Empty, Hint, Panel, Pill } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { ShownList } from '@/components/ui/list-tools'
import { Select } from '@/components/ui/select'
import { Flash } from '@/components/ui/flash'
import { StaffLink } from '@/components/staff/staff-link'
import {
  useBookableDoctors,
  useHomeActions,
  useOpenInquiries,
  type OpenInquiry,
} from '@/lib/api/home'
import { useFindPatients } from '@/lib/api/visits'
import { cn } from '@/lib/utils'

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
export function InquiriesPanel({ i = 2, canAct }: { i?: number; canAct: boolean }) {
  const { t } = useTranslation()
  const { data: inquiries = [] } = useOpenInquiries()
  const actions = useHomeActions()
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const reject = async (q: OpenInquiry) => {
    const reason = window.prompt(t('ops.inquiries.rejectReason', { name: q.name }))
    if (!reason) return
    setError(null)
    try {
      await actions.rejectInquiry.mutateAsync({ id: q.id, reason })
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

/** Patient file, doctor, day and time; then the doctor is asked to accept. */
function BookForm({ q, onDone }: { q: OpenInquiry; onDone: (msg: string) => void }) {
  const { t } = useTranslation()
  const actions = useHomeActions()
  const { data: doctors = [] } = useBookableDoctors()
  const start = q.startsAt ?? q.preferredAt
  const [patientId, setPatientId] = useState(q.patientId ?? '')
  const [patientLabel, setPatientLabel] = useState(
    q.patientId ? `${q.patientFile ?? ''} · ${q.patientName ?? ''}` : '',
  )
  const [search, setSearch] = useState('')
  const { data: hits = [] } = useFindPatients(search)
  const [doctorUserId, setDoctorUserId] = useState(q.doctorUserId ?? '')
  const [day, setDay] = useState(start ? isoDate(new Date(start)) : '')
  const [time, setTime] = useState(
    start ? `${pad(new Date(start).getHours())}:${pad(new Date(start).getMinutes())}` : '09:00',
  )
  const [error, setError] = useState<string | null>(null)
  const doctor = doctors.find((d) => d.userId === doctorUserId)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!patientId) return setError(t('ops.inquiries.errors.patient'))
    if (!doctorUserId) return setError(t('ops.inquiries.errors.doctor'))
    if (!day || !time) return setError(t('ops.inquiries.errors.when'))
    const at = new Date(`${day}T${time}:00`)
    if (Number.isNaN(at.getTime())) return setError(t('ops.inquiries.errors.when'))
    try {
      await actions.approveInquiry.mutateAsync({
        id: q.id,
        patientId,
        doctorUserId,
        startsAt: at.toISOString(),
      })
      onDone(
        t('ops.inquiries.booked', {
          name: q.name,
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
              <StaffLink to="/app/register" className="text-primary font-semibold underline">
                {t('ops.inquiries.registerNow')}
              </StaffLink>
            </span>
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
      {error && (
        <p role="alert" className={errorLine}>
          {error}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        className="self-start"
        loading={actions.approveInquiry.isPending}
      >
        {!actions.approveInquiry.isPending && <CalendarCheck size={16} aria-hidden="true" />}
        {t('ops.inquiries.confirmBook')}
      </Button>
    </form>
  )
}

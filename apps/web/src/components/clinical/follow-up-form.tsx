import { useState, type FormEvent } from 'react'
import { CalendarCheck, CalendarX, Check, Phone, UserRound, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime, isoDate, type StaffUser } from '@mmc/shared'
import { Hint } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { TimeSelect } from '@/components/ui/time-select'
import { useBookFollowUp, useChangeBooking, useFreeSlots } from '@/lib/api/follow-up'
import { useBookableDoctors } from '@/lib/api/home'
import { useStaffSettings } from '@/lib/api/settings'
import { useFindPatients } from '@/lib/api/visits'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'

/** The roles that keep a calendar and can be booked (calendar_role_ok). */
const CALENDAR_ROLES = ['doctor', 'sonographer', 'nurse', 'midwife', 'manager']

export interface FollowUpPatient {
  id: string
  name: string
  fileNumber?: string | null
  phone?: string | null
}

const errorLine = 'bg-red-bg text-red m-0 rounded-lg px-2.5 py-1.5 text-[13px] font-semibold'
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
const addDays = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return isoDate(d)
}
const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (iso: string) => {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The booking being changed (0125 "Change booking"). */
export interface BookingToChange {
  id: string
  startsAt: string
  withUserId: string | null
  reason: string | null
  note: string | null
}

const QUICK = [
  ['today', 0],
  ['tomorrow', 1],
  ['week', 7],
  ['twoWeeks', 14],
] as const

/**
 * "Book a follow-up" / "Book an appointment" (0125): the person who treats the patient books
 * them with themselves (confirmed at once) or a colleague who keeps a calendar (asked to accept,
 * unless the manager chose otherwise), on a free time of that calendar: its working hours, not a
 * day off, not in a break, not past, not taken. From the visit (the visit is kept with the
 * booking and printed as the next appointment), the patient file, or My bookings (the patient is
 * found by a file search). The patient gets nothing automatically: the phone is shown to tell them.
 * With `change`: the same form changes a booking (its time, person, reason, note); a reason is
 * asked when the time or the person changes, and the booking keeps its id.
 */
export function FollowUpForm({
  user,
  patient,
  encounterId,
  reason: initialReason = '',
  change,
  onDone,
  onCancel,
}: {
  /** Change this booking instead of making a new one. */
  change?: BookingToChange | null
  user: StaffUser
  /** None: the patient is searched (My bookings). */
  patient?: FollowUpPatient | null
  encounterId?: string | null
  /** Prefilled reason ("Follow-up: Malaria"). */
  reason?: string
  onDone: (message: string) => void
  onCancel?: () => void
}) {
  const { t } = useTranslation()
  const book = useBookFollowUp()
  const changeBooking = useChangeBooking()
  const confirm = useConfirm()
  const { data: settings } = useStaffSettings()
  const { data: listed = [] } = useBookableDoctors()
  const role = user.dbRole ?? user.role
  // the person booking is first when they keep a calendar ("Me")
  const people =
    CALENDAR_ROLES.includes(role) && !listed.some((d) => d.userId === user.id)
      ? [
          {
            userId: user.id,
            name: user.name,
            role,
            staffId: user.staffId ?? null,
            hasHours: true,
            slotMinutes: 30,
            title: null,
          },
          ...listed,
        ]
      : listed
  const [chosen, setChosen] = useState<FollowUpPatient | null>(patient ?? null)
  const [search, setSearch] = useState('')
  const { data: hits = [] } = useFindPatients(patient ? '' : search)
  const [withUser, setWithUser] = useState(
    change
      ? (change.withUserId ?? '')
      : people.some((p) => p.userId === user.id) || CALENDAR_ROLES.includes(role)
        ? user.id
        : '',
  )
  const [day, setDay] = useState(change ? isoDate(new Date(change.startsAt)) : addDays(1))
  const [time, setTime] = useState(change ? hhmm(change.startsAt) : '')
  const [reason, setReason] = useState(change ? (change.reason ?? '') : initialReason)
  const [note, setNote] = useState(change?.note ?? '')
  const [why, setWhy] = useState('')
  const [error, setError] = useState<string | null>(null)
  const slots = useFreeSlots(withUser || null, day || null)
  const person = people.find((p) => p.userId === withUser)
  const self = withUser === user.id
  const asks = !self && (settings?.colleagueAccept ?? true)
  // the booking's own time is not "taken" while it is being changed
  const own = (x: { at: string }) =>
    !!change &&
    withUser === change.withUserId &&
    new Date(x.at).getTime() === new Date(change.startsAt).getTime()
  const s = slots.data && {
    ...slots.data,
    slots: slots.data.slots.map((x) => (own(x) ? { ...x, state: 'free' as const } : x)),
  }
  const free = s?.slots.filter((x) => x.state === 'free') ?? []
  const atNow = () => {
    const slot = s?.hasHours ? s.slots.find((x) => x.time === time) : null
    return slot ? new Date(slot.at) : new Date(`${day}T${time}:00`)
  }
  // a change that moves the booking (another time or person) says why
  const moved =
    !!change &&
    !!time &&
    (atNow().getTime() !== new Date(change.startsAt).getTime() || withUser !== change.withUserId)

  const pickDay = (d: string) => {
    setDay(d)
    setTime('')
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!chosen) return setError(t('followUp.errors.patient'))
    if (!withUser || !person) return setError(t('followUp.errors.who'))
    if (!day || !time) return setError(t('followUp.errors.when'))
    const at = atNow()
    if (Number.isNaN(at.getTime())) return setError(t('followUp.errors.when'))
    const when = `${formatDate(at)} ${formatTime(at)}`
    const who = self ? t('followUp.withMe') : person.name
    if (change) {
      if (moved && why.trim().length < 3) return setError(t('followUp.errors.why'))
      if (
        !(await confirm({
          title: t('followUp.change.confirm', { name: chosen.name, who, when }),
          body: t(
            !moved
              ? 'followUp.change.bodySame'
              : withUser !== change.withUserId && !self && asks
                ? 'followUp.confirm.ask'
                : 'followUp.change.bodyMoved',
            { who: person.name },
          ),
          confirmLabel: t('followUp.change.yes'),
        }))
      )
        return
      try {
        const r = await changeBooking.mutateAsync({
          id: change.id,
          patientId: chosen.id,
          startsAt: at.getTime() !== new Date(change.startsAt).getTime() ? at.toISOString() : null,
          withUserId: withUser !== change.withUserId ? withUser : null,
          withName: person.name,
          reason,
          note,
          why: moved ? why : null,
        })
        onDone(
          t(r.status === 'approved' ? 'followUp.change.doneAsked' : 'followUp.change.done', {
            name: chosen.name,
            who,
            when,
          }),
        )
      } catch (err) {
        setError(describe(err))
      }
      return
    }
    if (
      !(await confirm({
        title: t('followUp.confirm.title', { name: chosen.name, who, when }),
        body: t(
          self
            ? 'followUp.confirm.self'
            : asks
              ? 'followUp.confirm.ask'
              : 'followUp.confirm.direct',
          { who: person.name },
        ),
        confirmLabel: t('followUp.confirm.yes'),
      }))
    )
      return
    try {
      const r = await book.mutateAsync({
        patientId: chosen.id,
        patientName: chosen.name,
        withUserId: withUser,
        withName: person.name,
        startsAt: at.toISOString(),
        reason,
        note,
        encounterId: encounterId ?? null,
      })
      onDone(
        t(r.status === 'confirmed' ? 'followUp.doneConfirmed' : 'followUp.doneAsked', {
          name: chosen.name,
          who,
          when,
        }),
      )
    } catch (err) {
      setError(describe(err))
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="border-violet/30 wash wash-violet rounded-lg2 flex flex-col gap-3 border p-3"
    >
      {/* the patient: given (visit, file) or found by a file search (My bookings) */}
      <div className="flex flex-col gap-1.5">
        <span className="text-ink-2 text-[13px] font-semibold">{t('followUp.patient')}</span>
        {chosen ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="border-green/25 bg-green-bg text-green inline-flex min-h-6 items-center gap-1 rounded border px-2 text-[13px] font-semibold">
              <Check size={14} aria-hidden="true" />
              {[chosen.fileNumber, chosen.name].filter(Boolean).join(' · ')}
            </span>
            {chosen.phone ? (
              <span className="text-ink-2 inline-flex items-center gap-1 text-[13px] tabular-nums">
                <Phone size={14} aria-hidden="true" />
                {chosen.phone}
              </span>
            ) : (
              <span className="text-ink-3 text-[13px]">{t('followUp.noPhone')}</span>
            )}
            {!patient && (
              <Button type="button" size="sm" variant="tint-grey" onClick={() => setChosen(null)}>
                <UserRound size={14} aria-hidden="true" />
                {t('ops.inquiries.otherFile')}
              </Button>
            )}
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
                    onClick={() =>
                      setChosen({
                        id: h.id,
                        name: `${h.surname} ${h.givenNames}`,
                        fileNumber: h.fileNumber,
                        phone: h.phone,
                      })
                    }
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
          </>
        )}
      </div>

      {/* with whom: me by default, or a colleague who keeps a calendar */}
      <Select
        label={t('followUp.with')}
        value={withUser}
        onChange={(e) => {
          setWithUser(e.target.value)
          setTime('')
        }}
        required
      >
        <option value="">{t('ops.inquiries.pickDoctor')}</option>
        {people.map((d) => (
          <option key={d.userId} value={d.userId}>
            {d.userId === user.id ? `${t('followUp.me')} · ${d.name}` : d.name}
            {d.role !== 'doctor' ? ` · ${t(`booking.roleLabel.${d.role}`)}` : ''}
            {d.title ? ` · ${d.title}` : ''}
          </option>
        ))}
      </Select>

      {/* the day: a quick choice or any date */}
      <div className="flex flex-col gap-1.5">
        <span className="text-ink-2 text-[13px] font-semibold">{t('followUp.day')}</span>
        <div className="flex flex-wrap items-end gap-2">
          {QUICK.map(([k, n]) => {
            const d = addDays(n)
            const on = day === d
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                onClick={() => pickDay(d)}
                className={cn(
                  'min-h-9 rounded-md border px-3 text-[14px] font-semibold transition-colors',
                  on
                    ? 'border-violet bg-violet text-white'
                    : 'border-border bg-card text-ink-2 hover:bg-hover',
                )}
              >
                {t(`followUp.quick.${k}`)}
              </button>
            )
          })}
          <Field
            label={t('followUp.otherDate')}
            type="date"
            value={day}
            min={isoDate(new Date())}
            onChange={(e) => pickDay(e.target.value)}
            wrapperClassName="min-w-[170px]"
            required
          />
        </div>
      </div>

      {/* the time: only the free slots of that person's calendar */}
      {withUser && day && (
        <div className="flex flex-col gap-1.5">
          <span className="text-ink-2 text-[13px] font-semibold">
            {t('followUp.time')}
            {s?.hasHours && !s.dayOff && (
              <span className="text-ink-3 ml-2 font-normal">
                {t('followUp.freeCount', { count: free.length, minutes: s.slotMinutes })}
              </span>
            )}
          </span>
          {slots.isLoading && <div className="skeleton h-9 rounded-md" aria-busy="true" />}
          {slots.error && <p className={errorLine}>{describe(slots.error)}</p>}
          {s && s.hasHours && s.dayOff && (
            <p className="text-ink-2 m-0 flex items-center gap-2 text-[14px]">
              <CalendarX size={16} aria-hidden="true" className="text-red" />
              {t('followUp.dayOff', { who: self ? t('followUp.withMe') : (person?.name ?? '') })}
            </p>
          )}
          {s && s.hasHours && !s.dayOff && s.slots.length === 0 && (
            <p className="text-ink-2 m-0 text-[14px]">{t('followUp.notWorking')}</p>
          )}
          {s && s.hasHours && !s.dayOff && s.slots.length > 0 && (
            <>
              <div
                className="grid grid-cols-[repeat(auto-fill,minmax(5.25rem,1fr))] gap-1.5"
                role="radiogroup"
                aria-label={t('followUp.time')}
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
                          ? 'border-violet bg-violet text-white'
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
          {s && !s.hasHours && (
            <>
              <TimeSelect
                label={t('ops.inquiries.time')}
                value={time}
                onChange={setTime}
                step={s.slotMinutes}
                day={day}
                required
              />
              <Hint>
                {t('followUp.noHours', { who: self ? t('followUp.withMe') : (person?.name ?? '') })}
                {s.booked.length > 0 &&
                  ` ${t('followUp.bookedAt', { times: s.booked.join(', ') })}`}
              </Hint>
            </>
          )}
        </div>
      )}

      <Field
        label={t('followUp.reason')}
        value={reason}
        placeholder={t('ops.booking.reasonPh')}
        maxLength={300}
        onChange={(e) => setReason(e.target.value)}
      />
      <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
        {t('followUp.note')}
        <textarea
          rows={2}
          maxLength={1000}
          placeholder={t('followUp.notePh')}
          className="border-border bg-card focus:border-primary rounded-md border px-2.5 py-2 text-[14px] font-normal outline-none"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {moved && (
        <Field
          label={t('followUp.change.why')}
          value={why}
          placeholder={t('followUp.change.whyPh')}
          maxLength={500}
          required
          minLength={3}
          onChange={(e) => setWhy(e.target.value)}
        />
      )}
      {withUser && !change && (
        <Hint>
          {self
            ? t('followUp.selfHint')
            : asks
              ? t('followUp.askHint', { who: person?.name ?? '' })
              : t('followUp.directHint', { who: person?.name ?? '' })}{' '}
          {t('followUp.tellPatient')}
        </Hint>
      )}
      {error && (
        <p role="alert" className={errorLine}>
          {error}
        </p>
      )}
      <span className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={book.isPending || changeBooking.isPending}>
          {!book.isPending && !changeBooking.isPending && (
            <CalendarCheck size={16} aria-hidden="true" />
          )}
          {t(change ? 'followUp.change.submit' : 'followUp.submit')}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            <X size={16} aria-hidden="true" />
            {t('staff.form.cancel')}
          </Button>
        )}
      </span>
    </form>
  )
}

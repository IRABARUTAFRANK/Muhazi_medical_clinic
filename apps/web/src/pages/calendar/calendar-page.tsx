import { useState, type FormEvent } from 'react'
import {
  CalendarDays,
  CalendarOff,
  CircleAlert,
  Clock,
  Copy,
  Eye,
  Globe,
  Lock,
  Plus,
  Save,
  Stethoscope,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  CATEGORY_IDS,
  formatDate,
  isoDate,
  toMinutes,
  type CategoryId,
  type StaffUser,
  type TimeSpan,
  type WeeklyHours,
} from '@mmc/shared'
import { ScheduleBoard } from '@/components/calendar/schedule-board'
import { Empty, Hint, Panel } from '@/components/dash/kit'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { Flash } from '@/components/ui/flash'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  VISIBILITIES,
  asPractitioner,
  useCalendarPeople,
  useMyCalendar,
  useSaveCalendar,
  type DoctorCalendar,
  type Visibility,
} from '@/lib/api/calendar'
import { useConfirm } from '@/lib/confirm'
import { useDayNames } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { card } from '@/components/dash/kit-style'
import { lift } from '@/components/clinical/lift'
import { cn } from '@/lib/utils'

/** Monday first, as the clinic plans its week. */
const WEEK = ['1', '2', '3', '4', '5', '6', '0'] as const
const SLOTS = [15, 20, 30, 45, 60] as const
const VIS_ICON = { private: Lock, staff: Users, public: Globe } as const
const errorBox =
  'border-red/30 bg-red-bg text-red m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-[13px] font-medium'
const ErrorLine = ({ children }: { children: string }) => (
  <p role="alert" className={errorBox}>
    <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
    <span>{children}</span>
  </p>
)

/**
 * A doctor's own calendar: the hours of each weekday, the booking slot, days off, a note and
 * who may see it (only me, the staff, or the staff and the public). The manager keeps the
 * calendar of any doctor, sonographer or nurse, and their own, from the same page.
 */
export function CalendarPage({ user, initialUser }: { user: StaffUser; initialUser?: string }) {
  const { t } = useTranslation()
  const isManager = user.role === 'manager' || user.dashboard === 'manager'
  const { data: people = [] } = useCalendarPeople(isManager)
  const [picked, setPicked] = useState<string | null>(initialUser ?? null)
  const target = isManager ? (picked ?? people[0]?.userId ?? null) : null
  const { data: cal, error } = useMyCalendar(target)
  const waiting = isManager && people.length === 0

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="calendar">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <PageBanner
          icon={CalendarDays}
          tint="violet"
          title={t(isManager ? 'calendar.titleManager' : 'calendar.title')}
          lead={t(isManager ? 'calendar.leadManagerAll' : 'calendar.lead')}
          meta={
            cal?.saved ? (
              <BannerChip icon={VIS_ICON[cal.visibility]}>
                {t(`calendar.visibility.${cal.visibility}.short`)}
              </BannerChip>
            ) : undefined
          }
        >
          {isManager && people.length > 0 && (
            <Select
              label={t('calendar.whose')}
              value={target ?? ''}
              onChange={(e) => setPicked(e.target.value)}
            >
              {people.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                  {` · ${t(`booking.roleLabel.${p.role}`)}`}
                  {p.saved ? '' : ` · ${t('calendar.notSet')}`}
                </option>
              ))}
            </Select>
          )}
        </PageBanner>

        {error && <ErrorLine>{error.message}</ErrorLine>}
        {waiting && (
          <Panel i={1} icon={Stethoscope} tint="violet" title={t('calendar.noDoctors')}>
            <Hint>{t('calendar.noPeopleHint')}</Hint>
          </Panel>
        )}
        {cal && !waiting && cal.canKeep === false && (
          <Panel i={1} icon={Lock} tint="coral" title={t('calendar.cannotKeepAll')}>
            <Hint>{t('calendar.cannotKeepHint')}</Hint>
          </Panel>
        )}
        {cal && !waiting && cal.canKeep !== false && (
          <CalendarEditor
            key={`${target ?? 'me'}|${cal.id ?? 'new'}`}
            cal={cal.name ? cal : { ...cal, name: user.name }}
            userId={target}
          />
        )}
      </main>
    </StaffShell>
  )
}

function CalendarEditor({ cal, userId }: { cal: DoctorCalendar; userId: string | null }) {
  const { t } = useTranslation()
  const days = useDayNames()
  const save = useSaveCalendar()
  const confirm = useConfirm()
  const [hours, setHours] = useState<WeeklyHours>(cal.hours)
  const [slot, setSlot] = useState(cal.slotMinutes)
  const [visibility, setVisibility] = useState<Visibility>(cal.visibility)
  const [daysOff, setDaysOff] = useState<string[]>(cal.daysOff)
  const [newOff, setNewOff] = useState('')
  const [note, setNote] = useState(cal.note)
  const [title, setTitle] = useState(cal.title)
  const [cats, setCats] = useState<CategoryId[]>(cal.categories)
  const [langs, setLangs] = useState(cal.languages)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const today = isoDate(new Date())
  const upcomingOff = [...daysOff].filter((d) => d >= today).sort()
  const setDay = (k: string, spans: TimeSpan[]) => {
    setDone(false)
    setHours((h) => {
      const next = { ...h }
      if (spans.length) next[k as keyof WeeklyHours] = spans
      else delete next[k as keyof WeeklyHours]
      return next
    })
  }
  const bad = WEEK.some((k) => (hours[k] ?? []).some(([a, b]) => toMinutes(a) >= toMinutes(b)))
  const workdays = WEEK.filter((k) => (hours[k] ?? []).length > 0).length

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr(null)
    setDone(false)
    if (bad) {
      setErr(t('calendar.badPeriod'))
      return
    }
    // a public calendar the site cannot show: no working day, or under no service
    if (visibility === 'public' && (workdays === 0 || cats.length === 0)) {
      setErr(t(workdays === 0 ? 'calendar.publicNoHours' : 'calendar.publicNoService'))
      return
    }
    if (
      !(await confirm({
        title: t(!userId ? 'confirm.calendar.saveMine.title' : 'confirm.calendar.save.title', {
          name: cal.name,
        }),
        body: t(`confirm.calendar.body.${visibility}`),
        confirmLabel: t('confirm.calendar.yes'),
      }))
    )
      return
    try {
      await save.mutateAsync({
        userId,
        hours,
        slotMinutes: slot,
        visibility,
        daysOff: upcomingOff,
        note,
        title,
        categories: cats,
        languages: langs,
      })
      setDone(true)
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x))
    }
  }

  const preview = asPractitioner({
    ...cal,
    hours,
    slotMinutes: slot,
    daysOff: upcomingOff,
    note,
    title,
    categories: cats,
    languages: langs,
  })

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-5">
      {/* Who may see it */}
      <Panel i={1} icon={Eye} tint="violet" title={t('calendar.whoSees')}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {VISIBILITIES.map((v) => {
            const Icon = VIS_ICON[v]
            const on = visibility === v
            return (
              <button
                key={v}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setVisibility(v)
                  setDone(false)
                }}
                className={cn(
                  card,
                  lift,
                  'flex-row items-start gap-3 p-3 text-left',
                  on ? 'border-violet bg-violet-bg' : 'hover:border-violet/50',
                )}
              >
                <span
                  className={cn(
                    'inline-flex size-8 flex-none items-center justify-center rounded',
                    on ? 'bg-violet text-white' : 'bg-hover text-ink-2',
                  )}
                >
                  <Icon size={18} aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className={cn('block text-[14px] font-semibold', on && 'text-violet')}>
                    {t(`calendar.visibility.${v}.title`)}
                  </span>
                  <span className="text-ink-2 block text-[13px]">
                    {t(`calendar.visibility.${v}.desc`)}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </Panel>

      <div className="pc:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] grid grid-cols-1 gap-5">
        {/* Weekly hours */}
        <Panel
          i={2}
          icon={Clock}
          tint="teal"
          title={t('calendar.weekly')}
          right={t('calendar.workdays', { count: workdays })}
        >
          <div className="flex flex-col">
            {WEEK.map((k) => {
              const spans = hours[k] ?? []
              const works = spans.length > 0
              return (
                <div
                  key={k}
                  className="border-grid flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 border-b py-2 last:border-b-0"
                >
                  <label className="flex w-[150px] items-center gap-2 text-[14px] font-medium">
                    <input
                      type="checkbox"
                      className="accent-primary size-[18px]"
                      checked={works}
                      onChange={(e) => setDay(k, e.target.checked ? [['08:00', '17:00']] : [])}
                    />
                    <span className={works ? 'text-ink' : 'text-ink-3'}>
                      {days.long[Number(k)]}
                    </span>
                  </label>
                  {!works && (
                    <span className="text-ink-3 text-[13px]">{t('calendar.board.off')}</span>
                  )}
                  <span className="flex flex-1 flex-col gap-1.5">
                    {spans.map(([a, b], n) => (
                      <span key={n} className="flex flex-wrap items-center gap-2">
                        <input
                          type="time"
                          step={900}
                          value={a}
                          aria-label={t('calendar.from')}
                          onChange={(e) =>
                            setDay(
                              k,
                              spans.map((s, j) => (j === n ? [e.target.value || a, s[1]] : s)),
                            )
                          }
                          className="border-border bg-card focus:border-primary focus:ring-primary/20 h-[38px] rounded-md border px-2 text-[14px] tabular-nums outline-none focus:ring-2"
                        />
                        <span className="text-ink-3">–</span>
                        <input
                          type="time"
                          step={900}
                          value={b}
                          aria-label={t('calendar.to')}
                          onChange={(e) =>
                            setDay(
                              k,
                              spans.map((s, j) => (j === n ? [s[0], e.target.value || b] : s)),
                            )
                          }
                          className={cn(
                            'bg-card focus:border-primary focus:ring-primary/20 h-[38px] rounded-md border px-2 text-[14px] tabular-nums outline-none focus:ring-2',
                            toMinutes(a) >= toMinutes(b) ? 'border-red' : 'border-border',
                          )}
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="tint-coral"
                          aria-label={t('calendar.removePeriod')}
                          title={t('calendar.removePeriod')}
                          onClick={() =>
                            setDay(
                              k,
                              spans.filter((_, j) => j !== n),
                            )
                          }
                        >
                          <X size={14} aria-hidden="true" />
                        </Button>
                        {n < spans.length - 1 && (
                          <span className="text-amber border-amber/30 bg-amber-bg inline-flex h-6 items-center rounded border px-2 text-[12px] font-medium">
                            {t('calendar.breakBetween', { from: b, to: spans[n + 1]![0] })}
                          </span>
                        )}
                        {n === spans.length - 1 && spans.length === 1 && (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => {
                              // Split the day around a midday break when the hours allow it.
                              const [start, end] = spans[0]!
                              const midday = toMinutes(start) < 12 * 60 && toMinutes(end) > 14 * 60
                              setDay(
                                k,
                                midday
                                  ? [
                                      [start, '12:00'],
                                      ['14:00', end],
                                    ]
                                  : [...spans, ['14:00', '17:00']],
                              )
                            }}
                          >
                            <Plus size={14} aria-hidden="true" />
                            {t('calendar.addBreak')}
                          </Button>
                        )}
                        {n === spans.length - 1 && spans.length === 2 && (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => setDay(k, [...spans, ['16:00', '18:00']])}
                          >
                            <Plus size={14} aria-hidden="true" />
                            {t('calendar.addPeriod')}
                          </Button>
                        )}
                      </span>
                    ))}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="tint-grey"
              disabled={!(hours['1'] ?? []).length}
              onClick={() => {
                const mon = hours['1'] ?? []
                for (const k of ['2', '3', '4', '5'])
                  setDay(
                    k,
                    mon.map((s) => [...s] as TimeSpan),
                  )
              }}
            >
              <Copy size={14} aria-hidden="true" />
              {t('calendar.copyMonday')}
            </Button>
          </div>
          <Hint>{t('calendar.breakHint')}</Hint>
        </Panel>

        <div className="flex min-w-0 flex-col gap-5">
          {/* Details shown with the calendar */}
          <Panel i={3} icon={Stethoscope} tint="mint" title={t('calendar.details')}>
            <Field
              label={t('calendar.titleField')}
              value={title}
              placeholder={t('calendar.titlePh')}
              onChange={(e) => setTitle(e.target.value)}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label={t('calendar.languages')}
                value={langs}
                placeholder="KIN · EN · FR"
                onChange={(e) => setLangs(e.target.value)}
              />
              <Select
                label={t('calendar.slot')}
                value={String(slot)}
                onChange={(e) => setSlot(Number(e.target.value))}
              >
                {SLOTS.map((s) => (
                  <option key={s} value={s}>
                    {t('calendar.minutes', { count: s })}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-ink-2 text-[13px] font-medium">{t('calendar.services')}</span>
              <div className="flex flex-wrap gap-1.5">
                {CATEGORY_IDS.map((c) => {
                  const on = cats.includes(c)
                  return (
                    <button
                      key={c}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setCats((xs) => (on ? xs.filter((x) => x !== c) : [...xs, c]))}
                      className={cn(
                        'inline-flex h-8 items-center rounded-md border px-3 text-[13px] font-medium transition-colors duration-120',
                        on
                          ? 'border-green bg-green-bg text-green'
                          : 'border-border bg-card text-ink-2 hover:bg-hover',
                      )}
                    >
                      {t(`categories.${c}`)}
                    </button>
                  )
                })}
              </div>
            </div>
            <Field
              label={t('calendar.note')}
              value={note}
              maxLength={120}
              placeholder={t('calendar.notePh')}
              onChange={(e) => setNote(e.target.value)}
            />
          </Panel>

          {/* Days off */}
          <Panel
            i={4}
            icon={CalendarOff}
            tint="amber"
            title={t('calendar.daysOff')}
            right={String(upcomingOff.length)}
          >
            <div className="flex flex-wrap items-end gap-2">
              <Field
                type="date"
                label={t('calendar.addDayOff')}
                value={newOff}
                min={today}
                onChange={(e) => setNewOff(e.target.value)}
              />
              <Button
                type="button"
                disabled={!newOff || daysOff.includes(newOff)}
                onClick={() => {
                  setDaysOff((xs) => [...xs, newOff])
                  setNewOff('')
                  setDone(false)
                }}
              >
                <Plus size={16} aria-hidden="true" />
                {t('calendar.add')}
              </Button>
            </div>
            {upcomingOff.length === 0 ? (
              <Empty icon={CalendarDays}>{t('calendar.noDaysOff')}</Empty>
            ) : (
              <div className="flex flex-wrap gap-2">
                {upcomingOff.map((d) => (
                  <span
                    key={d}
                    className="border-amber/30 bg-amber-bg text-amber inline-flex h-8 items-center gap-1.5 rounded-md border py-1 pr-1 pl-2.5 text-[13px] font-medium"
                  >
                    <CalendarOff size={14} aria-hidden="true" />
                    {formatDate(new Date(`${d}T00:00:00`))}
                    <button
                      type="button"
                      aria-label={t('calendar.removeDayOff')}
                      onClick={() => setDaysOff((xs) => xs.filter((x) => x !== d))}
                      className="hover:bg-card/60 inline-flex size-6 items-center justify-center rounded"
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>

      {/* Preview */}
      <Panel i={5} icon={Eye} tint="navy" title={t('calendar.preview')}>
        <ScheduleBoard
          variant="staff"
          now={new Date()}
          doctors={[{ p: preview, visibility, department: cal.department, mine: cal.mine }]}
        />
      </Panel>

      {err && <ErrorLine>{err}</ErrorLine>}
      {done && <Flash onClose={() => setDone(false)}>{t(`calendar.saved.${visibility}`)}</Flash>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" size="lg" loading={save.isPending}>
          {!save.isPending && <Save size={18} aria-hidden="true" />}
          {t('calendar.save')}
        </Button>
        <span className="text-ink-3 text-[13px]">{t('calendar.saveHint')}</span>
      </div>
    </form>
  )
}

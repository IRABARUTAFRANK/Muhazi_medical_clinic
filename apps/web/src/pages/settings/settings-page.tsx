import { useState, type FormEvent } from 'react'
import {
  Activity,
  ALargeSmall,
  BedDouble,
  Building2,
  Check,
  ClipboardList,
  Clock,
  KeyRound,
  LayoutDashboard,
  Settings,
  ShieldCheck,
  type LucideIcon,
  UserPlus,
  Users,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { DAY_KEYS, type ClinicHours, type DayKey, type StaffUser, type TimeSpan } from '@mmc/shared'
import { IconChip } from '@/components/dash/kit'
import { tintClass, type Tint } from '@/components/dash/kit-style'
import { PageBanner } from '@/components/dash/page-banner'
import { TextSizeControl } from '@/components/staff/text-size-control'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { useClinicSettings, useSaveClinicSettings, type ClinicSettings } from '@/lib/api/settings'
import { useConfirm } from '@/lib/confirm'
import { useDayNames } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'
import { BedsCard } from './beds-card'
import { FlowCard } from './flow-card'
import { PatientFieldsCard } from './patient-fields-card'
import { PermissionsCard } from './permissions-card'
import { SessionCard } from './session-card'

/** The settings are split into sections; one is shown at a time (remembered on this device). */
type SectionId = 'clinic' | 'hours' | 'beds' | 'security' | 'access' | 'patient' | 'display'
const SECTIONS: { id: SectionId; icon: LucideIcon; tint: Tint }[] = [
  { id: 'clinic', icon: Building2, tint: 'teal' },
  { id: 'hours', icon: Clock, tint: 'amber' },
  { id: 'beds', icon: BedDouble, tint: 'navy' },
  { id: 'security', icon: ShieldCheck, tint: 'coral' },
  { id: 'access', icon: KeyRound, tint: 'violet' },
  { id: 'patient', icon: ClipboardList, tint: 'violet' },
  { id: 'display', icon: ALargeSmall, tint: 'mint' },
]
const SECTION_KEY = 'mmc.settings.section'
const readSection = (): SectionId => {
  try {
    const v = localStorage.getItem(SECTION_KEY) as SectionId | null
    return v && SECTIONS.some((x) => x.id === v) ? v : 'clinic'
  } catch {
    return 'clinic'
  }
}

type DayMode = 'closed' | 'allDay' | 'custom'
const modeOf = (span?: TimeSpan): DayMode =>
  !span ? 'closed' : span[0] === '00:00' && span[1] === '24:00' ? 'allDay' : 'custom'

const PROFILE_FIELDS = [
  'name',
  'tagline',
  'phone',
  'whatsapp',
  'email',
  'sector',
  'district',
  'province',
  'country',
  'tin',
  'moh_licence',
  'fda_licence',
] as const
type ProfileField = (typeof PROFILE_FIELDS)[number]

/**
 * Clinic settings (manager), in sections chosen from a menu so the page stays short: identity
 * and contacts, opening hours, beds and the price of a night, security (sign-out after hours
 * without activity), patient file fields, and display (text size) with shortcuts.
 */
export function SettingsPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const dayNames = useDayNames()
  const { data, isLoading, error } = useClinicSettings()
  const save = useSaveClinicSettings()
  const confirm = useConfirm()
  const [draft, setDraft] = useState<ClinicSettings | null>(null)
  const [seededFrom, setSeededFrom] = useState<ClinicSettings | null>(null)
  const [saved, setSaved] = useState(false)
  const [section, setSection] = useState<SectionId>(readSection)
  const choose = (id: SectionId) => {
    setSection(id)
    setSaved(false)
    try {
      localStorage.setItem(SECTION_KEY, id)
    } catch {
      /* private window: not remembered */
    }
  }

  // Seed the editable draft from the loaded settings (state derived during render, no effect).
  if (data && seededFrom !== data && draft === null) {
    setSeededFrom(data)
    setDraft(structuredClone(data))
  }

  const setProfile = (k: ProfileField, v: string) =>
    setDraft((d) => (d ? { ...d, profile: { ...d.profile, [k]: v } } : d))
  const setDay = (day: DayKey | 'lab', mode: DayMode, span?: TimeSpan) =>
    setDraft((d) => {
      if (!d) return d
      const hours: ClinicHours = { ...d.hours, days: { ...d.hours.days } }
      const next: TimeSpan | undefined =
        mode === 'closed'
          ? undefined
          : mode === 'allDay'
            ? ['00:00', '24:00']
            : (span ?? ['08:00', '17:00'])
      if (day === 'lab') hours.lab = next
      else if (next) hours.days[day] = next
      else delete hours.days[day]
      return { ...d, hours }
    })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!draft) return
    // the opening hours, or the clinic's name and contacts (each section has its own form)
    const k = section === 'hours' ? 'confirm.settings.hours' : 'confirm.settings.profile'
    if (
      !(await confirm({
        title: t(`${k}.title`, { name: draft.profile.name ?? '' }),
        body: t(`${k}.body`),
        confirmLabel: t('confirm.settings.saveYes'),
      }))
    )
      return
    setSaved(false)
    await save.mutateAsync(draft)
    setSaved(true)
  }

  const dayLabel = (k: DayKey) => dayNames.long[Number(k)] ?? k

  const saveBar = (
    <>
      {save.error && (
        <p
          role="alert"
          className="border-red/30 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium"
        >
          {t('settings.saveFailed', { message: save.error.message })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          <Check size={16} aria-hidden="true" />
          {save.isPending ? t('settings.saving') : t('settings.save')}
        </Button>
        {saved && !save.isPending && (
          <span className="text-green inline-flex items-center gap-1 text-[14px] font-semibold">
            <Check size={16} aria-hidden="true" />
            {t('settings.savedNote')}
          </span>
        )}
      </div>
    </>
  )

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="settings">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <PageBanner
          icon={Settings}
          tint="navy"
          title={t('settings.title')}
          lead={t('settings.leadShort')}
        />

        {error && (
          <p
            role="alert"
            className="border-red/30 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium"
          >
            {t('settings.loadFailed', { message: error.message })}
          </p>
        )}

        <div className="pc:grid-cols-[280px_minmax(0,1fr)] grid grid-cols-1 items-start gap-5">
          {/* Section menu: a column on PC, a scrolling row of tabs on tablets */}
          <nav
            aria-label={t('settings.title')}
            className="bg-card pc:sticky pc:top-0 pc:flex-col pc:flex-nowrap flex flex-wrap gap-1 rounded-md p-2"
          >
            {SECTIONS.map((sec) => {
              const on = section === sec.id
              return (
                <button
                  key={sec.id}
                  type="button"
                  aria-current={on ? 'page' : undefined}
                  onClick={() => choose(sec.id)}
                  className={cn(
                    'pc:flex-none flex flex-[1_1_150px] items-center gap-3 rounded-md px-3 py-2 text-left transition-colors duration-120',
                    on ? 'bg-primary-tint text-primary' : 'text-ink hover:bg-hover',
                  )}
                >
                  <span
                    className={cn(
                      'inline-flex size-9 flex-none items-center justify-center rounded-md',
                      tintClass[sec.tint],
                    )}
                  >
                    <sec.icon size={18} aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[14px] font-semibold whitespace-nowrap">
                      {t(`settings.sections.${sec.id}.title`)}
                    </span>
                    <span
                      className={cn(
                        'pc:block hidden text-[12px] leading-snug',
                        on ? 'text-primary/80' : 'text-ink-3',
                      )}
                    >
                      {t(`settings.sections.${sec.id}.hint`)}
                    </span>
                  </span>
                </button>
              )
            })}
          </nav>

          <div className="flex min-w-0 flex-col gap-4">
            {section === 'clinic' && draft && (
              <form onSubmit={submit} className="flex flex-col gap-4">
                <Card className="anim-enter">
                  <CardHeader>
                    <span className="flex items-center gap-2.5">
                      <IconChip icon={Building2} tint="teal" />
                      {t('settings.profile.title')}
                    </span>
                    <span className="text-ink-3 text-xs">{isLoading ? '…' : ''}</span>
                  </CardHeader>
                  <CardBody className="gap-3">
                    <p className="text-ink-2 m-0 text-[14px]">{t('settings.profile.lead')}</p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {PROFILE_FIELDS.map((k) => (
                        <Field
                          key={k}
                          label={t(`settings.profile.fields.${k}`)}
                          value={String(draft.profile[k] ?? '')}
                          onChange={(e) => setProfile(k, e.target.value)}
                          type={
                            k === 'email'
                              ? 'email'
                              : k === 'phone' || k === 'whatsapp'
                                ? 'tel'
                                : 'text'
                          }
                          required={k === 'name' || k === 'phone'}
                        />
                      ))}
                    </div>
                    {saveBar}
                  </CardBody>
                </Card>
              </form>
            )}

            {section === 'hours' && draft && (
              <form onSubmit={submit} className="flex flex-col gap-4">
                <Card className="anim-enter">
                  <CardHeader>
                    <span className="flex items-center gap-2.5">
                      <IconChip icon={Clock} tint="amber" />
                      {t('settings.hours.title')}
                    </span>
                    <span className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => {
                          for (const k of DAY_KEYS) setDay(k, 'allDay')
                          setDay('lab', 'allDay')
                        }}
                      >
                        {t('settings.hours.all247')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => {
                          for (const k of DAY_KEYS)
                            setDay(k, k === '0' ? 'closed' : 'custom', ['08:00', '17:00'])
                          setDay('lab', 'custom', ['08:00', '17:00'])
                        }}
                      >
                        {t('settings.hours.officeHours')}
                      </Button>
                    </span>
                  </CardHeader>
                  <CardBody className="gap-3">
                    <p className="text-ink-2 m-0 text-[14px]">{t('settings.hours.lead')}</p>
                    <div className="flex flex-col">
                      <div className="text-ink-3 hidden grid-cols-[130px_180px_120px_120px] gap-2 pb-1 text-[12px] font-medium sm:grid">
                        <span>{t('settings.hours.day')}</span>
                        <span>{t('settings.hours.mode')}</span>
                        <span>{t('settings.hours.open')}</span>
                        <span>{t('settings.hours.close')}</span>
                      </div>
                      {(['1', '2', '3', '4', '5', '6', '0'] as DayKey[]).map((k) => (
                        <HoursRow
                          key={k}
                          label={dayLabel(k)}
                          span={draft.hours.days[k]}
                          onChange={(mode, span) => setDay(k, mode, span)}
                        />
                      ))}
                      <HoursRow
                        label={t('settings.hours.lab')}
                        span={draft.hours.lab}
                        onChange={(mode, span) => setDay('lab', mode, span)}
                      />
                    </div>
                    {saveBar}
                  </CardBody>
                </Card>
              </form>
            )}

            {section === 'beds' && <BedsCard />}
            {section === 'hours' && <FlowCard />}

            {section === 'security' && (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <SessionCard />
              </div>
            )}

            {section === 'access' && <PermissionsCard />}
            {section === 'patient' && <PatientFieldsCard />}

            {section === 'display' && (
              <>
                <Card className="anim-enter">
                  <CardHeader>
                    <span className="flex items-center gap-2.5">
                      <IconChip icon={ALargeSmall} tint="violet" />
                      {t('textSize.title')}
                    </span>
                  </CardHeader>
                  <CardBody className="gap-3">
                    <p className="text-ink-2 m-0 text-[14px]">{t('textSize.leadSynced')}</p>
                    <div className="max-w-[520px]">
                      <TextSizeControl full />
                    </div>
                  </CardBody>
                </Card>
                <Card className="anim-enter">
                  <CardHeader>
                    <span className="flex items-center gap-2.5">
                      <IconChip icon={LayoutDashboard} tint="teal" />
                      {t('settings.manage.title')}
                    </span>
                  </CardHeader>
                  <CardBody className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Shortcut
                      to="/app/dashboard"
                      icon={<LayoutDashboard size={18} />}
                      label={t('nav.dashboard')}
                    />
                    <Shortcut
                      to="/app/register"
                      icon={<UserPlus size={18} />}
                      label={t('register.title')}
                    />
                    <Shortcut
                      to="/app/vitals"
                      icon={<Activity size={18} />}
                      label={t('triage.title')}
                    />
                    <Shortcut to="/app/staff" icon={<Users size={18} />} label={t('staff.title')} />
                  </CardBody>
                </Card>
              </>
            )}

            <p className="text-ink-3 m-0 text-xs">
              {t('settings.you', { id: user.staffId ?? '—', name: user.name })}
            </p>
          </div>
        </div>
      </main>
    </StaffShell>
  )
}

function Shortcut({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <StaffLink
      to={to}
      className={cn(
        buttonVariants({ variant: 'default' }),
        'min-h-14 justify-start gap-2 px-3 text-left',
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </StaffLink>
  )
}

const control =
  'border-border bg-card text-ink focus:border-primary h-10 w-full rounded-md border px-2.5 text-[14px] outline-none'

/** One compact row per day: name, mode, and the hours when they are custom. */
function HoursRow({
  label,
  span,
  onChange,
}: {
  label: string
  span?: TimeSpan
  onChange: (mode: DayMode, span?: TimeSpan) => void
}) {
  const { t } = useTranslation()
  const mode = modeOf(span)
  return (
    <div className="border-grid grid grid-cols-[110px_minmax(0,1fr)] items-center gap-2 border-b py-1.5 last:border-b-0 sm:grid-cols-[130px_180px_120px_120px]">
      <span className="text-[14px] font-semibold">{label}</span>
      <select
        aria-label={`${label} · ${t('settings.hours.mode')}`}
        className={control}
        value={mode}
        onChange={(e) => {
          const next = e.target.value as DayMode
          // Keep real custom hours; coming from "24 hours" or "closed" start from office hours.
          onChange(next, next === 'custom' && mode === 'custom' ? span : undefined)
        }}
      >
        <option value="allDay">{t('settings.hours.allDay')}</option>
        <option value="custom">{t('settings.hours.custom')}</option>
        <option value="closed">{t('settings.hours.closed')}</option>
      </select>
      {mode === 'custom' && span ? (
        <>
          <input
            type="time"
            aria-label={`${label} · ${t('settings.hours.open')}`}
            className={cn(control, 'col-start-2 sm:col-start-auto')}
            value={span[0]}
            onChange={(e) => onChange('custom', [e.target.value, span[1]])}
          />
          <input
            type="time"
            aria-label={`${label} · ${t('settings.hours.close')}`}
            className={cn(control, 'col-start-2 sm:col-start-auto')}
            value={span[1]}
            onChange={(e) => onChange('custom', [span[0], e.target.value])}
          />
        </>
      ) : (
        <span className="text-ink-3 hidden text-[13px] sm:col-span-2 sm:block">
          {mode === 'allDay' ? '00:00 – 24:00' : '—'}
        </span>
      )}
    </div>
  )
}

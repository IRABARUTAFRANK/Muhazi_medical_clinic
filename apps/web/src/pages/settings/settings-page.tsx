import { useState, type FormEvent } from 'react'
import { Activity, Building2, Check, Clock, LayoutDashboard, UserPlus, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { DAY_KEYS, type ClinicHours, type DayKey, type StaffUser, type TimeSpan } from '@mmc/shared'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { useClinicSettings, useSaveClinicSettings, type ClinicSettings } from '@/lib/api/settings'
import { useDayNames } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'

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
 * Clinic settings (manager): identity and contacts shown on the public site, opening hours
 * that drive "open now" and the booking calendar, and shortcuts to every part of the clinic.
 */
export function SettingsPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const dayNames = useDayNames()
  const { data, isLoading, error } = useClinicSettings()
  const save = useSaveClinicSettings()
  const [draft, setDraft] = useState<ClinicSettings | null>(null)
  const [seededFrom, setSeededFrom] = useState<ClinicSettings | null>(null)
  const [saved, setSaved] = useState(false)

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
    setSaved(false)
    await save.mutateAsync(draft)
    setSaved(true)
  }

  const dayLabel = (k: DayKey) => dayNames.long[Number(k)] ?? k

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="settings">
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[260px] flex-1">
            <h1 className="m-0 text-2xl font-bold">{t('settings.title')}</h1>
            <p className="text-ink-2 m-0 mt-1 max-w-[680px]">{t('settings.lead')}</p>
          </div>
        </div>

        {/* Everything the manager runs */}
        <Card>
          <CardHeader>
            <span>{t('settings.manage.title')}</span>
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
            <Shortcut to="/app/vitals" icon={<Activity size={18} />} label={t('triage.title')} />
            <Shortcut to="/app/staff" icon={<Users size={18} />} label={t('staff.title')} />
          </CardBody>
        </Card>

        {error && (
          <p
            role="alert"
            className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
          >
            {t('settings.loadFailed', { message: error.message })}
          </p>
        )}

        {draft && (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <span className="inline-flex items-center gap-2">
                  <Building2 size={16} aria-hidden="true" />
                  {t('settings.profile.title')}
                </span>
                <span className="text-ink-3 text-xs">{isLoading ? '…' : ''}</span>
              </CardHeader>
              <CardBody className="gap-3">
                <p className="text-ink-2 m-0 text-[13px]">{t('settings.profile.lead')}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {PROFILE_FIELDS.map((k) => (
                    <Field
                      key={k}
                      label={t(`settings.profile.fields.${k}`)}
                      value={String(draft.profile[k] ?? '')}
                      onChange={(e) => setProfile(k, e.target.value)}
                      type={
                        k === 'email' ? 'email' : k === 'phone' || k === 'whatsapp' ? 'tel' : 'text'
                      }
                      required={k === 'name' || k === 'phone'}
                    />
                  ))}
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <span className="inline-flex items-center gap-2">
                  <Clock size={16} aria-hidden="true" />
                  {t('settings.hours.title')}
                </span>
              </CardHeader>
              <CardBody className="gap-3">
                <p className="text-ink-2 m-0 text-[13px]">{t('settings.hours.lead')}</p>
                <div className="flex flex-wrap gap-2">
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
                </div>
                <div className="flex flex-col gap-2">
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
              </CardBody>
            </Card>

            {save.error && (
              <p
                role="alert"
                className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
              >
                {t('settings.saveFailed', { message: save.error.message })}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" size="lg" disabled={save.isPending}>
                {save.isPending ? t('settings.saving') : t('settings.save')}
              </Button>
              {saved && !save.isPending && (
                <span className="text-green inline-flex items-center gap-1 text-[13px] font-semibold">
                  <Check size={16} aria-hidden="true" />
                  {t('settings.savedNote')}
                </span>
              )}
              <span className="text-ink-3 text-xs">
                {t('settings.you', { id: user.staffId ?? '—', name: user.name })}
              </span>
            </div>
          </form>
        )}
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
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 sm:grid-cols-[160px_180px_1fr]">
      <span className="text-ink-2 pb-3 text-[13px] font-semibold">{label}</span>
      <Select
        label={t('settings.hours.mode')}
        value={mode}
        onChange={(e) => onChange(e.target.value as DayMode, span)}
      >
        <option value="allDay">{t('settings.hours.allDay')}</option>
        <option value="custom">{t('settings.hours.custom')}</option>
        <option value="closed">{t('settings.hours.closed')}</option>
      </Select>
      {mode === 'custom' && span && (
        <div className="col-span-2 flex gap-2 sm:col-span-1">
          <Field
            label={t('settings.hours.open')}
            type="time"
            value={span[0]}
            onChange={(e) => onChange('custom', [e.target.value, span[1]])}
          />
          <Field
            label={t('settings.hours.close')}
            type="time"
            value={span[1]}
            onChange={(e) => onChange('custom', [span[0], e.target.value])}
          />
        </div>
      )}
    </div>
  )
}

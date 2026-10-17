import { useState, type FormEvent } from 'react'
import { Copy, KeyRound, Mail, RefreshCw, UserPlus, UserX, UserCheck, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime, type StaffUser } from '@mmc/shared'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  DB_ROLES,
  EMAIL_RE,
  PIN_RE,
  USERNAME_RE,
  generatePin,
  suggestUsername,
  useEmployees,
  useStaffActions,
  type DashboardRight,
  type DbLang,
  type DbRole,
  type Employee,
} from '@/lib/api/staff'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'

interface Credentials {
  title: string
  name: string
  staffId: string
  email: string
  username: string
  pin: string
}

/** Manager-only: employee accounts, first PINs, resets, deactivation (doc §5.11, §5.12). */
export function StaffPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const { data: employees = [], isLoading, error } = useEmployees()
  const actions = useStaffActions()
  const [showNew, setShowNew] = useState(false)
  const [resetFor, setResetFor] = useState<Employee | null>(null)
  const [emailFor, setEmailFor] = useState<Employee | null>(null)
  const [credentials, setCredentials] = useState<Credentials | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const describeError = (e: unknown): string => {
    const m = e instanceof Error ? e.message : String(e)
    if (/e-mail already/i.test(m)) return t('staff.errors.emailTaken')
    if (/taken|already exists/i.test(m)) return t('staff.errors.usernameTaken')
    if (m === 'username') return t('staff.errors.username')
    if (m === 'pin') return t('staff.errors.pin')
    if (m === 'email' || /valid e-mail/i.test(m)) return t('staff.errors.email')
    return t('staff.errors.generic', { message: m })
  }

  const toggleActive = async (e: Employee) => {
    setActionError(null)
    try {
      await actions.setActive.mutateAsync({ id: e.id, active: !e.active })
    } catch (err) {
      setActionError(describeError(err))
    }
  }

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="staff">
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[260px] flex-1">
            <h1 className="m-0 text-2xl font-bold">{t('staff.title')}</h1>
            <p className="text-ink-2 m-0 mt-1 max-w-[640px]">{t('staff.lead')}</p>
          </div>
          <span className="text-ink-2 tabular-nums">
            {t('staff.count', { count: employees.length })}
          </span>
          <Button variant="primary" onClick={() => setShowNew(true)}>
            <UserPlus size={18} aria-hidden="true" />
            {t('staff.newEmployee')}
          </Button>
        </div>

        {(error || actionError) && (
          <p
            role="alert"
            className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
          >
            {actionError ?? describeError(error)}
          </p>
        )}

        {credentials && (
          <CredentialsCard credentials={credentials} onDone={() => setCredentials(null)} />
        )}

        {showNew && (
          <NewEmployeeForm
            onCancel={() => setShowNew(false)}
            onCreated={(c) => {
              setShowNew(false)
              setCredentials(c)
            }}
            describeError={describeError}
          />
        )}

        {resetFor && (
          <ResetPinCard
            employee={resetFor}
            onClose={() => setResetFor(null)}
            onDone={(pin) => {
              setCredentials({
                title: t('staff.reset.doneTitle', { name: resetFor.fullName }),
                name: resetFor.fullName,
                staffId: resetFor.staffId ?? '',
                email: resetFor.email ?? '',
                username: resetFor.username,
                pin,
              })
              setResetFor(null)
            }}
            describeError={describeError}
          />
        )}

        {emailFor && (
          <EmailCard
            employee={emailFor}
            onClose={() => setEmailFor(null)}
            describeError={describeError}
          />
        )}

        <Card>
          <CardHeader>
            <span>{t('staff.cols.employee')}</span>
            <span className="text-ink-3 text-xs">{isLoading ? '…' : ''}</span>
          </CardHeader>
          {employees.map((e) => {
            const self = e.id === user.id
            return (
              <Row key={e.id} className="flex-wrap gap-x-4 gap-y-2 py-3">
                <Avatar name={e.fullName} size="md" />
                <span className="min-w-[180px] flex-1">
                  <span className="block font-semibold">
                    {e.fullName}
                    {self && <span className="text-ink-3 ml-2 text-xs font-medium">(you)</span>}
                  </span>
                  <span className="text-ink-3 text-xs tabular-nums">
                    {e.staffId ? `${e.staffId} · ` : ''}
                    {e.username}
                    {e.email ? ` · ${e.email}` : ''}
                    {e.station ? ` · ${e.station}` : ''}
                    {e.lastSignInAt
                      ? ` · ${t('staff.lastSignIn', { when: `${formatDate(new Date(e.lastSignInAt))} ${formatTime(new Date(e.lastSignInAt))}` })}`
                      : ` · ${t('staff.neverSignedIn')}`}
                  </span>
                </span>
                <Chip>{t(`staff.roles.${e.role}`)}</Chip>
                {e.dashboard && (
                  <Chip>
                    {t(
                      e.dashboard === 'manager'
                        ? 'staff.form.dashboardManager'
                        : 'staff.form.dashboardHead',
                    )}
                  </Chip>
                )}
                {!e.active ? (
                  <Badge tone="red">{t('staff.deactivated')}</Badge>
                ) : !e.email ? (
                  <Badge tone="yellow">{t('staff.noEmail')}</Badge>
                ) : e.mustChangePin ? (
                  <Badge tone="yellow">{t('staff.pinPending')}</Badge>
                ) : (
                  <Badge tone="green">{t('staff.active')}</Badge>
                )}
                <span className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setEmailFor(e)} disabled={!e.active}>
                    <Mail size={16} aria-hidden="true" />
                    {t('staff.setEmail')}
                  </Button>
                  <Button size="sm" onClick={() => setResetFor(e)} disabled={!e.active}>
                    <KeyRound size={16} aria-hidden="true" />
                    {t('staff.resetPin')}
                  </Button>
                  <Button
                    size="sm"
                    variant={e.active ? 'danger' : 'default'}
                    disabled={self || actions.setActive.isPending}
                    onClick={() => void toggleActive(e)}
                  >
                    {e.active ? (
                      <UserX size={16} aria-hidden="true" />
                    ) : (
                      <UserCheck size={16} aria-hidden="true" />
                    )}
                    {t(e.active ? 'staff.deactivate' : 'staff.reactivate')}
                  </Button>
                </span>
              </Row>
            )
          })}
        </Card>
      </main>
    </StaffShell>
  )
}

/* ---------------------------------------------------------------- new employee */

function NewEmployeeForm({
  onCancel,
  onCreated,
  describeError,
}: {
  onCancel: () => void
  onCreated: (c: Credentials) => void
  describeError: (e: unknown) => string
}) {
  const { t } = useTranslation()
  const actions = useStaffActions()
  const [fullName, setFullName] = useState('')
  const [username, setUsername] = useState('')
  const [usernameTouched, setUsernameTouched] = useState(false)
  const [role, setRole] = useState<DbRole>('receptionist')
  const [station, setStation] = useState('')
  const [dashboard, setDashboard] = useState<DashboardRight>(null)
  const [headOf, setHeadOf] = useState('')
  const [language, setLanguage] = useState<DbLang>('kin')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [pin, setPin] = useState(generatePin)
  const [error, setError] = useState<string | null>(null)

  const onName = (v: string) => {
    setFullName(v)
    if (!usernameTouched) setUsername(suggestUsername(v))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!USERNAME_RE.test(username)) return setError(t('staff.errors.username'))
    if (!EMAIL_RE.test(email.trim())) return setError(t('staff.errors.email'))
    if (!PIN_RE.test(pin)) return setError(t('staff.errors.pin'))
    try {
      const effectiveDashboard: DashboardRight = role === 'manager' ? 'manager' : dashboard
      const created = await actions.create.mutateAsync({
        username,
        fullName: fullName.trim(),
        role,
        pin,
        email: email.trim().toLowerCase(),
        station: station.trim() || undefined,
        dashboard: effectiveDashboard,
        headOf: effectiveDashboard === 'head' ? headOf.trim() || station.trim() : undefined,
        language,
        phone: phone.trim() || undefined,
      })
      onCreated({
        title: t('staff.created.title', { name: fullName.trim() }),
        name: fullName.trim(),
        staffId: created.staff_id ?? '',
        email: email.trim().toLowerCase(),
        username,
        pin,
      })
    } catch (err) {
      setError(describeError(err))
    }
  }

  return (
    <Card>
      <CardHeader>
        <span>{t('staff.newEmployee')}</span>
      </CardHeader>
      <form onSubmit={submit}>
        <CardBody className="gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label={t('staff.form.fullName')}
              placeholder={t('staff.form.fullNamePh')}
              value={fullName}
              onChange={(e) => onName(e.target.value)}
              required
            />
            <Field
              label={t('staff.form.username')}
              value={username}
              onChange={(e) => {
                setUsernameTouched(true)
                setUsername(e.target.value.toLowerCase())
              }}
              autoCapitalize="none"
              required
            />
          </div>
          <span className="text-ink-3 -mt-1 text-xs">{t('staff.form.usernameHint')}</span>
          <Field
            label={t('staff.form.email')}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            placeholder="name@example.com"
            required
          />
          <span className="text-ink-3 -mt-1 text-xs">{t('staff.form.emailHint')}</span>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Select
              label={t('staff.form.role')}
              value={role}
              onChange={(e) => setRole(e.target.value as DbRole)}
            >
              {DB_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`staff.roles.${r}`)}
                </option>
              ))}
            </Select>
            <Field
              label={t('staff.form.station')}
              placeholder={t('staff.form.stationPh')}
              value={station}
              onChange={(e) => setStation(e.target.value)}
            />
            <Select
              label={t('staff.form.dashboard')}
              value={role === 'manager' ? 'manager' : (dashboard ?? '')}
              disabled={role === 'manager'}
              onChange={(e) => setDashboard((e.target.value || null) as DashboardRight)}
            >
              <option value="">{t('staff.form.dashboardNone')}</option>
              <option value="head">{t('staff.form.dashboardHead')}</option>
              <option value="manager">{t('staff.form.dashboardManager')}</option>
            </Select>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {dashboard === 'head' && role !== 'manager' && (
              <Field
                label={t('staff.form.headOf')}
                value={headOf}
                onChange={(e) => setHeadOf(e.target.value)}
                placeholder={station}
              />
            )}
            <Select
              label={t('staff.form.language')}
              value={language}
              onChange={(e) => setLanguage(e.target.value as DbLang)}
            >
              <option value="kin">Kinyarwanda</option>
              <option value="en">English</option>
              <option value="fr">Français</option>
            </Select>
            <Field
              label={t('staff.form.phone')}
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="07xx xxx xxx"
            />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field
              label={t('staff.form.pin')}
              value={pin}
              inputMode="numeric"
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="w-40 text-xl font-bold tracking-[.3em] tabular-nums"
              required
            />
            <Button type="button" onClick={() => setPin(generatePin())}>
              <RefreshCw size={16} aria-hidden="true" />
              {t('staff.form.generate')}
            </Button>
            <span className="text-ink-3 text-xs">{t('staff.form.pinHint')}</span>
          </div>
          {error && (
            <p
              role="alert"
              className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
            >
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={actions.create.isPending}>
              {actions.create.isPending ? t('staff.form.creating') : t('staff.form.create')}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t('staff.form.cancel')}
            </Button>
          </div>
        </CardBody>
      </form>
    </Card>
  )
}

/* ---------------------------------------------------------------- reset PIN */

function ResetPinCard({
  employee,
  onClose,
  onDone,
  describeError,
}: {
  employee: Employee
  onClose: () => void
  onDone: (pin: string) => void
  describeError: (e: unknown) => string
}) {
  const { t } = useTranslation()
  const actions = useStaffActions()
  const [pin, setPin] = useState(generatePin)
  const [error, setError] = useState<string | null>(null)
  const confirm = async () => {
    setError(null)
    try {
      await actions.resetPin.mutateAsync({ id: employee.id, pin })
      onDone(pin)
    } catch (err) {
      setError(describeError(err))
    }
  }
  return (
    <Card className="border-primary">
      <CardHeader>
        <span>{t('staff.reset.title', { name: employee.fullName })}</span>
      </CardHeader>
      <CardBody className="gap-3">
        <p className="text-ink-2 m-0">{t('staff.reset.body')}</p>
        <div className="flex flex-wrap items-center gap-3">
          <span className="border-border bg-surface rounded-lg border px-4 py-2 text-2xl font-bold tracking-[.3em] tabular-nums">
            {pin}
          </span>
          <Button onClick={() => setPin(generatePin())}>
            <RefreshCw size={16} aria-hidden="true" />
            {t('staff.form.generate')}
          </Button>
        </div>
        {error && (
          <p
            role="alert"
            className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
          >
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={() => void confirm()}
            disabled={actions.resetPin.isPending}
          >
            {t('staff.reset.confirm')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('staff.form.cancel')}
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

/* ---------------------------------------------------------------- e-mail */

function EmailCard({
  employee,
  onClose,
  describeError,
}: {
  employee: Employee
  onClose: () => void
  describeError: (e: unknown) => string
}) {
  const { t } = useTranslation()
  const actions = useStaffActions()
  const [email, setEmail] = useState(employee.email ?? '')
  const [error, setError] = useState<string | null>(null)
  const save = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!EMAIL_RE.test(email.trim())) return setError(t('staff.errors.email'))
    try {
      await actions.setEmail.mutateAsync({ id: employee.id, email: email.trim().toLowerCase() })
      onClose()
    } catch (err) {
      setError(describeError(err))
    }
  }
  return (
    <Card className="border-primary">
      <CardHeader>
        <span>{t('staff.emailCard.title', { name: employee.fullName })}</span>
      </CardHeader>
      <form onSubmit={save}>
        <CardBody className="gap-3">
          <p className="text-ink-2 m-0">{t('staff.emailCard.body')}</p>
          <Field
            label={t('staff.form.email')}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
            wrapperClassName="max-w-md"
          />
          {error && (
            <p
              role="alert"
              className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
            >
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={actions.setEmail.isPending}>
              {t('staff.emailCard.save')}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('staff.form.cancel')}
            </Button>
          </div>
        </CardBody>
      </form>
    </Card>
  )
}

/* ---------------------------------------------------------------- credentials (shown once) */

function CredentialsCard({
  credentials,
  onDone,
}: {
  credentials: Credentials
  onDone: () => void
}) {
  const { t } = useTranslation()
  return (
    <Card className="border-green">
      <CardHeader>
        <span>{credentials.title}</span>
        <Badge tone="green" icon={<Check size={12} strokeWidth={3} aria-hidden="true" />}>
          {t('staff.active')}
        </Badge>
      </CardHeader>
      <CardBody className="gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {credentials.staffId && (
            <CopyField label={t('staff.created.staffId')} value={credentials.staffId} />
          )}
          <CopyField label={t('staff.created.username')} value={credentials.username} />
          <CopyField label={t('staff.created.pin')} value={credentials.pin} mono />
          {credentials.email && (
            <CopyField label={t('staff.created.email')} value={credentials.email} />
          )}
        </div>
        <p className="text-ink-2 m-0 text-[13px]">{t('staff.created.note')}</p>
        <Button variant="primary" className="self-start" onClick={onDone}>
          {t('staff.created.done')}
        </Button>
      </CardBody>
    </Card>
  )
}

function CopyField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable: the value is visible to copy by hand */
    }
  }
  return (
    <div className="flex items-end gap-2">
      <span className="text-ink-2 flex min-w-0 flex-1 flex-col gap-1.5 text-[13px] font-semibold">
        {label}
        <span
          className={cn(
            'border-border bg-surface text-ink truncate rounded-lg border px-3 py-2 text-xl font-bold',
            mono && 'tracking-[.3em] tabular-nums',
          )}
        >
          {value}
        </span>
      </span>
      <Button type="button" onClick={() => void copy()} aria-label={t('staff.created.copy')}>
        {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
        {copied ? t('staff.created.copied') : t('staff.created.copy')}
      </Button>
    </div>
  )
}

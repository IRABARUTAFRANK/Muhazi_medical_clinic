import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  Building2,
  Check,
  Copy,
  Eye,
  EyeOff,
  IdCard,
  KeyRound,
  Mail,
  MailCheck,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserPlus,
  UserX,
  Wand2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime, type StaffUser } from '@mmc/shared'
import { PageBanner } from '@/components/dash/page-banner'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
import { ListBar, ShownList } from '@/components/ui/list-tools'
import { Select } from '@/components/ui/select'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  DB_ROLES,
  EMAIL_RE,
  PIN_RE,
  POSITIONS,
  USERNAME_RE,
  generatePin,
  sendConfirmCode,
  suggestUsername,
  useDepartmentActions,
  useDepartments,
  useEmployees,
  useStaffActions,
  type DbLang,
  type DbRole,
  type Department,
  type Employee,
  type EmployeeInput,
  type Position,
} from '@/lib/api/staff'
import { navForUser } from '@/lib/nav'
import { matches } from '@/lib/paging'
import { cn } from '@/lib/utils'

interface Credentials {
  title: string
  staffId: string
  email: string
  username: string
  pin: string
}

/** What waits for the manager's e-mailed code before it is sent. */
interface Pending {
  title: string
  run: (confirmCode: string) => Promise<void>
}

const errorBox = 'bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold'

/**
 * Manager-only: employees (create, edit everything, reset PIN, deactivate) and departments
 * (which roles belong; each employee is head, assistant head or member). Every change is
 * confirmed with a one-time code e-mailed to the manager, checked on the server (doc §5.11, §5.12).
 */
export function StaffPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'people' | 'departments'>('people')
  const { data: employees = [], isLoading, error } = useEmployees()
  const { data: departments = [] } = useDepartments()
  const actions = useStaffActions()
  const [editing, setEditing] = useState<Employee | 'new' | null>(null)
  const [resetFor, setResetFor] = useState<Employee | null>(null)
  const [credentials, setCredentials] = useState<Credentials | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [staffQuery, setStaffQuery] = useState('')
  const formRef = useRef<HTMLDivElement>(null)
  // Bring the form the manager just opened into view, wherever the button was on the page.
  useEffect(() => {
    if (editing || resetFor || credentials)
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [editing, resetFor, credentials])

  const describeError = (e: unknown): string => {
    const m = e instanceof Error ? e.message : String(e)
    if (m === 'confirm_code_wrong') return t('staff.confirm.wrong')
    if (m === 'confirm_code_required') return t('staff.confirm.required')
    if (m === 'code_wait') return t('staff.confirm.wait')
    if (/e-mail already/i.test(m)) return t('staff.errors.emailTaken')
    if (/taken|already exists/i.test(m)) return t('staff.errors.usernameTaken')
    if (/does not belong/i.test(m)) return t('staff.errors.roleDept')
    if (/choose a department/i.test(m)) return t('staff.errors.needDept')
    if (m === 'username') return t('staff.errors.username')
    if (m === 'pin') return t('staff.errors.pin')
    if (m === 'email' || /valid e-mail/i.test(m)) return t('staff.errors.email')
    return t('staff.errors.generic', { message: m })
  }

  const visible = employees.filter(
    (e) =>
      (showInactive || e.active) && matches(staffQuery, e.fullName, e.username, e.staffId, e.email),
  )
  const groups: { key: string; name: string; people: Employee[] }[] = [
    ...departments.map((d) => ({
      key: d.id,
      name: d.name,
      people: visible.filter((e) => e.departmentId === d.id),
    })),
    {
      key: 'none',
      name: t('staff.dept.none'),
      people: visible.filter(
        (e) => !e.departmentId || !departments.some((d) => d.id === e.departmentId),
      ),
    },
  ].filter((g) => g.people.length > 0)
  const rank: Record<Position, number> = { head: 0, assistant: 1, member: 2 }

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="staff">
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <PageBanner icon={IdCard} tint="violet" title={t('staff.title')} lead={t('staff.lead2')}>
          {tab === 'people' && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <UserPlus size={18} aria-hidden="true" />
              {t('staff.newEmployee')}
            </Button>
          )}
        </PageBanner>

        <div className="flex flex-wrap gap-1 self-start rounded-xl bg-white/70 p-1" role="tablist">
          {(['people', 'departments'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cn(
                'min-h-10 rounded-lg px-4 text-[13px] font-semibold transition-colors',
                tab === k ? 'bg-navy shadow-card text-white' : 'text-ink-2 hover:bg-hover',
              )}
            >
              {k === 'people'
                ? t('staff.tabs.people', { count: employees.filter((e) => e.active).length })
                : t('staff.tabs.departments', { count: departments.length })}
            </button>
          ))}
        </div>

        {error && (
          <p role="alert" className={errorBox}>
            {describeError(error)}
          </p>
        )}
        {notice && (
          <p
            role="status"
            className="bg-green-bg text-green m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
          >
            {notice}
          </p>
        )}
        {/* Forms open here; the page scrolls to them (Reset PIN, Edit, New employee). */}
        <div ref={formRef} className="flex scroll-mt-4 flex-col gap-4">
          {formError && (
            <p role="alert" className={errorBox}>
              {formError}
            </p>
          )}
          {credentials && (
            <CredentialsCard credentials={credentials} onDone={() => setCredentials(null)} />
          )}
        </div>

        {tab === 'departments' ? (
          <DepartmentsPanel departments={departments} employees={employees} />
        ) : (
          <>
            {editing && (
              <EmployeeForm
                key={editing === 'new' ? 'new' : editing.id}
                employee={editing === 'new' ? null : editing}
                departments={departments}
                takenUsernames={new Set(employees.map((e) => e.username))}
                self={editing !== 'new' && editing.id === user.id}
                onCancel={() => setEditing(null)}
                onSubmit={(input, firstPin) =>
                  setPending({
                    title:
                      editing === 'new'
                        ? t('staff.confirm.create', { name: input.fullName })
                        : t('staff.confirm.update', { name: input.fullName }),
                    run: async (confirmCode) => {
                      if (editing === 'new') {
                        const r = await actions.create.mutateAsync({
                          input,
                          pin: firstPin!,
                          confirmCode,
                        })
                        setCredentials({
                          title: t('staff.created.title', { name: input.fullName }),
                          staffId: r.staff_id ?? '',
                          email: input.email,
                          username: r.username,
                          pin: firstPin!,
                        })
                      } else {
                        await actions.update.mutateAsync({ id: editing.id, input, confirmCode })
                        setNotice(t('staff.saved', { name: input.fullName }))
                      }
                      setEditing(null)
                    },
                  })
                }
              />
            )}

            {resetFor && (
              <ResetPinCard
                employee={resetFor}
                onClose={() => setResetFor(null)}
                onSubmit={async (pin) => {
                  // No e-mailed code: the new PIN is temporary and is recorded in the history.
                  setFormError(null)
                  try {
                    await actions.resetPin.mutateAsync({ id: resetFor.id, pin })
                    setCredentials({
                      title: t('staff.reset.doneTitle', { name: resetFor.fullName }),
                      staffId: resetFor.staffId ?? '',
                      email: resetFor.email ?? '',
                      username: resetFor.username,
                      pin,
                    })
                    setResetFor(null)
                  } catch (err) {
                    setFormError(describeError(err))
                  }
                }}
              />
            )}

            <ListBar query={staffQuery} onQuery={setStaffQuery} placeholderKey="list.searchStaff" />
            <label className="flex items-center gap-2 self-start text-[13px] font-semibold">
              <input
                type="checkbox"
                className="accent-primary size-[18px]"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
              {t('staff.showInactive', { count: employees.filter((e) => !e.active).length })}
            </label>

            {isLoading && <p className="text-ink-3 m-0">…</p>}
            {groups.map((g) => (
              <Card key={g.key}>
                <CardHeader>
                  <span className="inline-flex items-center gap-2">
                    <Building2 size={16} aria-hidden="true" />
                    {g.name}
                  </span>
                  <span className="text-ink-3 text-xs">{g.people.length}</span>
                </CardHeader>
                <ShownList
                  step={8}
                  footerClassName="px-4 py-2"
                  items={[...g.people].sort(
                    (a, b) =>
                      rank[a.position] - rank[b.position] || a.fullName.localeCompare(b.fullName),
                  )}
                >
                  {(shownPeople) => (
                    <>
                      {shownPeople.map((e) => {
                        const self = e.id === user.id
                        return (
                          <Row
                            key={e.id}
                            className={cn(
                              'flex-wrap gap-x-4 gap-y-2 py-3',
                              !e.active && 'opacity-60',
                            )}
                          >
                            <Avatar name={e.fullName} size="md" />
                            <span className="min-w-[200px] flex-1">
                              <span className="block font-semibold">
                                {e.fullName}
                                {e.specialty && (
                                  <span className="text-violet ml-2 text-xs font-semibold">
                                    {e.specialty}
                                  </span>
                                )}
                                {self && (
                                  <span className="text-ink-3 ml-2 text-xs font-medium">
                                    ({t('staff.you')})
                                  </span>
                                )}
                              </span>
                              <span className="text-ink-3 text-xs tabular-nums">
                                {[
                                  e.staffId,
                                  e.username,
                                  e.email,
                                  e.lastSignInAt
                                    ? t('staff.lastSignIn', {
                                        when: `${formatDate(new Date(e.lastSignInAt))} ${formatTime(new Date(e.lastSignInAt))}`,
                                      })
                                    : t('staff.neverSignedIn'),
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </span>
                            </span>
                            <Chip>{t(`staff.roles.${e.role}`)}</Chip>
                            {e.position !== 'member' && (
                              <Badge tone={e.position === 'head' ? 'blue' : 'grey'} dot={false}>
                                {t(`staff.positions.${e.position}`)}
                              </Badge>
                            )}
                            {e.active && e.tempPin && <TempPin pin={e.tempPin} />}
                            {!e.active ? (
                              <Badge tone="red">{t('staff.deactivated')}</Badge>
                            ) : e.mustChangePin ? (
                              <Badge tone="yellow">{t('staff.pinPending')}</Badge>
                            ) : (
                              <Badge tone="green">{t('staff.active')}</Badge>
                            )}
                            <span className="flex flex-wrap gap-2">
                              <Button size="sm" onClick={() => setEditing(e)} disabled={!e.active}>
                                <Pencil size={15} aria-hidden="true" />
                                {t('staff.edit')}
                              </Button>
                              <Button size="sm" onClick={() => setResetFor(e)} disabled={!e.active}>
                                <KeyRound size={15} aria-hidden="true" />
                                {t('staff.resetPin')}
                              </Button>
                              <Button
                                size="sm"
                                variant={e.active ? 'danger' : 'default'}
                                disabled={self}
                                onClick={() =>
                                  setPending({
                                    title: t(
                                      e.active
                                        ? 'staff.confirm.deactivate'
                                        : 'staff.confirm.reactivate',
                                      {
                                        name: e.fullName,
                                      },
                                    ),
                                    run: async (confirmCode) => {
                                      await actions.setActive.mutateAsync({
                                        id: e.id,
                                        active: !e.active,
                                        confirmCode,
                                      })
                                      setNotice(
                                        t(
                                          e.active
                                            ? 'staff.deactivatedNotice'
                                            : 'staff.reactivatedNotice',
                                          { name: e.fullName },
                                        ),
                                      )
                                    },
                                  })
                                }
                              >
                                {e.active ? (
                                  <UserX size={15} aria-hidden="true" />
                                ) : (
                                  <UserCheck size={15} aria-hidden="true" />
                                )}
                                {t(e.active ? 'staff.deactivate' : 'staff.reactivate')}
                              </Button>
                            </span>
                          </Row>
                        )
                      })}
                    </>
                  )}
                </ShownList>
              </Card>
            ))}
          </>
        )}

        {pending && (
          <ConfirmCodeDialog
            title={pending.title}
            describeError={describeError}
            onCancel={() => setPending(null)}
            onConfirm={async (code) => {
              await pending.run(code)
              setPending(null)
            }}
          />
        )}
      </main>
    </StaffShell>
  )
}

/* ---------------------------------------------------------------- confirm with an e-mailed code */

function ConfirmCodeDialog({
  title,
  onConfirm,
  onCancel,
  describeError,
}: {
  title: string
  onConfirm: (code: string) => Promise<void>
  onCancel: () => void
  describeError: (e: unknown) => string
}) {
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(true)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [wait, setWait] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    setSending(true)
    setError(null)
    try {
      const r = await sendConfirmCode()
      setSentTo(r.to)
      setWait(60)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setSending(false)
    }
  }
  // One code per dialog: sent when it opens, again only on request after the cool-down.
  const sentOnce = useRef(false)
  useEffect(() => {
    if (sentOnce.current) return
    sentOnce.current = true
    void send()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (wait <= 0) return
    const id = setTimeout(() => setWait((w) => w - 1), 1000)
    return () => clearTimeout(id)
  }, [wait])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!/^[0-9]{6,10}$/.test(code)) return setError(t('staff.confirm.required'))
    setBusy(true)
    setError(null)
    try {
      await onConfirm(code)
    } catch (err) {
      setError(describeError(err))
      setCode('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('staff.confirm.title')}
      className="anim-enter fixed inset-0 z-[90] flex items-center justify-center bg-[#0b2252]/45 p-4 backdrop-blur-[2px]"
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      <form
        onSubmit={submit}
        className="bg-card shadow-sheet flex w-full max-w-[440px] flex-col gap-4 rounded-2xl p-6"
      >
        <div className="flex items-center gap-3">
          <span className="icon-gradient inline-flex size-11 flex-none items-center justify-center rounded-xl text-white">
            <MailCheck size={22} aria-hidden="true" />
          </span>
          <span>
            <span className="block text-lg font-bold">{t('staff.confirm.title')}</span>
            <span className="text-ink-2 text-[14px]">{title}</span>
          </span>
        </div>
        <p className="bg-surface text-ink-2 m-0 flex items-center gap-2 rounded-lg px-3 py-2 text-[14px]">
          <Mail size={16} aria-hidden="true" className="text-primary flex-none" />
          {sending
            ? t('staff.confirm.sending')
            : sentTo
              ? t('staff.confirm.sentTo', { to: sentTo })
              : t('staff.confirm.notSent')}
        </p>
        <Field
          label={t('staff.confirm.code')}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 10))}
          required
        />
        <p className="text-ink-3 m-0 text-[13px]">{t('staff.confirm.hint')}</p>
        {error && (
          <p role="alert" className={errorBox}>
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={busy} disabled={sending && !sentTo}>
            <Check size={16} aria-hidden="true" />
            {t('staff.confirm.ok')}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('staff.form.cancel')}
          </Button>
          <span className="flex-1" />
          <Button
            type="button"
            variant="ghost"
            disabled={sending || wait > 0}
            onClick={() => void send()}
          >
            <RefreshCw size={15} aria-hidden="true" />
            {wait > 0 ? t('staff.confirm.resendIn', { s: wait }) : t('staff.confirm.resend')}
          </Button>
        </div>
      </form>
    </div>
  )
}

/* ---------------------------------------------------------------- employee form (new / edit) */

function EmployeeForm({
  employee,
  departments,
  takenUsernames,
  self,
  onSubmit,
  onCancel,
}: {
  employee: Employee | null
  departments: Department[]
  takenUsernames: ReadonlySet<string>
  self: boolean
  onSubmit: (input: EmployeeInput, firstPin?: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const isNew = !employee
  const [fullName, setFullName] = useState(employee?.fullName ?? '')
  const [username, setUsername] = useState(employee?.username ?? '')
  const [usernameTouched, setUsernameTouched] = useState(!isNew)
  const [email, setEmail] = useState(employee?.email ?? '')
  const [phone, setPhone] = useState(employee?.phone ?? '')
  const [role, setRole] = useState<DbRole>(employee?.role ?? 'receptionist')
  const [departmentId, setDepartmentId] = useState<string>(employee?.departmentId ?? '')
  const [position, setPosition] = useState<Position>(employee?.position ?? 'member')
  const [station, setStation] = useState(employee?.station ?? '')
  const [specialty, setSpecialty] = useState(employee?.specialty ?? '')
  const [language, setLanguage] = useState<DbLang>(employee?.language ?? 'kin')
  const [pin, setPin] = useState(generatePin)
  const [error, setError] = useState<string | null>(null)

  // Only departments this role belongs to (a department with no roles listed accepts all).
  const fitting = departments.filter((d) => d.roles.length === 0 || d.roles.includes(role))
  const others = new Set([...takenUsernames].filter((u) => u !== employee?.username))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!fullName.trim()) return setError(t('staff.errors.name'))
    if (!USERNAME_RE.test(username)) return setError(t('staff.errors.username'))
    if (others.has(username)) return setError(t('staff.errors.usernameTaken'))
    if (!EMAIL_RE.test(email.trim())) return setError(t('staff.errors.email'))
    if (position !== 'member' && !departmentId) return setError(t('staff.errors.needDept'))
    if (isNew && !PIN_RE.test(pin)) return setError(t('staff.errors.pin'))
    onSubmit(
      {
        fullName,
        username,
        email,
        role,
        departmentId: departmentId || null,
        position: departmentId ? position : 'member',
        station,
        language,
        phone,
        specialty,
      },
      isNew ? pin : undefined,
    )
  }

  return (
    <Card className="border-primary anim-enter">
      <CardHeader>
        <span>
          {isNew ? t('staff.newEmployee') : t('staff.editTitle', { name: employee.fullName })}
        </span>
        {employee?.staffId && (
          <span className="text-ink-3 text-xs tabular-nums">{employee.staffId}</span>
        )}
      </CardHeader>
      <form onSubmit={submit}>
        <CardBody className="gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label={t('staff.form.fullName')}
              value={fullName}
              onChange={(e) => {
                setFullName(e.target.value)
                if (!usernameTouched) setUsername(suggestUsername(e.target.value, others))
              }}
              required
              autoFocus
            />
            <div className="flex items-end gap-2">
              <Field
                label={t('staff.form.username')}
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))
                  setUsernameTouched(true)
                }}
                wrapperClassName="flex-1"
                required
              />
              <Button
                type="button"
                onClick={() => {
                  setUsername(suggestUsername(fullName, others))
                  setUsernameTouched(true)
                }}
                disabled={!fullName.trim()}
                title={t('staff.form.suggest')}
              >
                <Wand2 size={16} aria-hidden="true" />
                {t('staff.form.suggest')}
              </Button>
            </div>
            <Field
              label={t('staff.form.email')}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Field
              label={t('staff.form.phone')}
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <p className="text-ink-3 m-0 -mt-2 text-xs">{t('staff.form.usernameHint2')}</p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Select
              label={t('staff.form.role')}
              value={role}
              onChange={(e) => {
                const r = e.target.value as DbRole
                setRole(r)
                const d = departments.find((x) => x.id === departmentId)
                if (d && d.roles.length && !d.roles.includes(r)) setDepartmentId('')
              }}
              disabled={self}
            >
              {DB_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`staff.roles.${r}`)}
                </option>
              ))}
            </Select>
            <Select
              label={t('staff.form.department')}
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
            >
              <option value="">{t('staff.dept.none')}</option>
              {fitting.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
            <Select
              label={t('staff.form.position')}
              value={departmentId ? position : 'member'}
              onChange={(e) => setPosition(e.target.value as Position)}
              disabled={!departmentId}
            >
              {POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {t(`staff.positions.${p}`)}
                </option>
              ))}
            </Select>
          </div>
          {departments.length === 0 && (
            <p className="text-ink-3 m-0 -mt-2 text-xs">{t('staff.form.noDepartments')}</p>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field
              label={t('staff.form.specialty')}
              value={specialty}
              placeholder={t('staff.form.specialtyPh')}
              onChange={(e) => setSpecialty(e.target.value)}
              wrapperClassName="sm:col-span-3"
            />
            <Field
              label={t('staff.form.station')}
              value={station}
              onChange={(e) => setStation(e.target.value)}
            />
            <Select
              label={t('staff.form.language')}
              value={language}
              onChange={(e) => setLanguage(e.target.value as DbLang)}
            >
              <option value="kin">Kinyarwanda</option>
              <option value="en">English</option>
              <option value="fr">Français</option>
            </Select>
            {isNew && (
              <div className="flex items-end gap-2">
                <Field
                  label={t('staff.form.pin')}
                  inputMode="numeric"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="tracking-[.3em] tabular-nums"
                  wrapperClassName="flex-1"
                  required
                />
                <Button
                  type="button"
                  onClick={() => setPin(generatePin())}
                  aria-label={t('staff.form.generate')}
                >
                  <RefreshCw size={16} aria-hidden="true" />
                </Button>
              </div>
            )}
          </div>
          {isNew && <p className="text-ink-3 m-0 -mt-2 text-xs">{t('staff.form.pinHint')}</p>}

          {error && (
            <p role="alert" className={errorBox}>
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="primary">
              <ShieldCheck size={16} aria-hidden="true" />
              {isNew ? t('staff.form.create') : t('staff.form.saveChanges')}
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

/** The temporary PIN still to be replaced: hidden until the manager shows it, with a copy button. */
function TempPin({ pin }: { pin: string }) {
  const { t } = useTranslation()
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState(false)
  return (
    <span className="border-amber/40 bg-amber-bg text-ink inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-3 text-[13px]">
      <KeyRound size={13} aria-hidden="true" className="text-amber" />
      <span className="text-ink-2 font-semibold">{t('staff.tempPin')}</span>
      <b className="tracking-[.2em] tabular-nums">{shown ? pin : '••••••'}</b>
      <button
        type="button"
        className="hover:bg-card inline-flex size-7 items-center justify-center rounded-full"
        aria-label={t(shown ? 'staff.hidePin' : 'staff.showPin')}
        title={t(shown ? 'staff.hidePin' : 'staff.showPin')}
        onClick={() => setShown((v) => !v)}
      >
        {shown ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
      </button>
      <button
        type="button"
        className="hover:bg-card inline-flex size-7 items-center justify-center rounded-full"
        aria-label={t('staff.copyPin')}
        title={copied ? t('staff.copied') : t('staff.copyPin')}
        onClick={() => {
          void navigator.clipboard?.writeText(pin)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
    </span>
  )
}

function ResetPinCard({
  employee,
  onSubmit,
  onClose,
}: {
  employee: Employee
  onSubmit: (pin: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [pin, setPin] = useState(generatePin)
  return (
    <Card className="border-primary anim-enter">
      <CardHeader>
        <span>{t('staff.reset.title', { name: employee.fullName })}</span>
      </CardHeader>
      <CardBody className="gap-3">
        <p className="text-ink-2 m-0 text-[13px]">{t('staff.reset.body')}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field
            label={t('staff.form.pin')}
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="tracking-[.3em] tabular-nums"
            wrapperClassName="w-48"
          />
          <Button
            type="button"
            onClick={() => setPin(generatePin())}
            aria-label={t('staff.form.generate')}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </Button>
          <Button variant="primary" disabled={!PIN_RE.test(pin)} onClick={() => onSubmit(pin)}>
            <ShieldCheck size={16} aria-hidden="true" />
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

/* ---------------------------------------------------------------- departments */

function DepartmentsPanel({
  departments,
  employees,
}: {
  departments: Department[]
  employees: Employee[]
}) {
  const { t } = useTranslation()
  const actions = useDepartmentActions()
  const [editing, setEditing] = useState<Department | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <p className="text-ink-2 m-0 max-w-[680px] flex-1 text-[13px]">{t('staff.dept.lead')}</p>
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus size={18} aria-hidden="true" />
          {t('staff.dept.new')}
        </Button>
      </div>
      {error && (
        <p role="alert" className={errorBox}>
          {error}
        </p>
      )}
      {editing && (
        <DepartmentForm
          key={editing === 'new' ? 'new' : editing.id}
          department={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSave={async (d) => {
            setError(null)
            try {
              await actions.save.mutateAsync(d)
              setEditing(null)
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            }
          }}
          saving={actions.save.isPending}
        />
      )}
      {departments.length === 0 && !editing && (
        <Card>
          <CardBody>
            <p className="text-ink-3 m-0 text-[13px]">{t('staff.dept.empty')}</p>
          </CardBody>
        </Card>
      )}
      <div className="pc:grid-cols-2 grid grid-cols-1 gap-4">
        {departments.map((d, i) => {
          const people = employees.filter((e) => e.departmentId === d.id && e.active)
          const head = people.find((e) => e.position === 'head')
          const assistants = people.filter((e) => e.position === 'assistant')
          return (
            <Card key={d.id} className="anim-enter" style={{ '--i': i } as React.CSSProperties}>
              <CardHeader>
                <span className="inline-flex items-center gap-2">
                  <Building2 size={16} aria-hidden="true" />
                  {d.name}
                </span>
                <span className="flex gap-1">
                  <Button size="sm" onClick={() => setEditing(d)}>
                    <Pencil size={14} aria-hidden="true" />
                    {t('staff.edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="hover:text-red"
                    aria-label={t('staff.dept.delete')}
                    title={t('staff.dept.delete')}
                    onClick={async () => {
                      if (
                        !window.confirm(
                          t('staff.dept.confirmDelete', { name: d.name, count: people.length }),
                        )
                      )
                        return
                      setError(null)
                      try {
                        await actions.remove.mutateAsync(d.id)
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e))
                      }
                    }}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </Button>
                </span>
              </CardHeader>
              <CardBody className="gap-2.5">
                {d.description && <p className="text-ink-2 m-0 text-[13px]">{d.description}</p>}
                <div className="flex flex-wrap gap-1.5">
                  {d.roles.length === 0 ? (
                    <Chip>{t('staff.dept.allRoles')}</Chip>
                  ) : (
                    d.roles.map((r) => <Chip key={r}>{t(`staff.roles.${r}`)}</Chip>)
                  )}
                </div>
                <p className="m-0 text-[13px]">
                  <b>{t('staff.positions.head')}:</b>{' '}
                  {head?.fullName ?? <span className="text-ink-3">{t('staff.dept.noHead')}</span>}
                  {assistants.length > 0 && (
                    <>
                      {' · '}
                      <b>{t('staff.positions.assistant')}:</b>{' '}
                      {assistants.map((a) => a.fullName).join(', ')}
                    </>
                  )}
                </p>
                <p className="text-ink-3 m-0 text-xs">
                  {t('staff.dept.members', { count: people.length })}
                </p>
              </CardBody>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

function DepartmentForm({
  department,
  onSave,
  onCancel,
  saving,
}: {
  department: Department | null
  onSave: (d: { id?: string; name: string; description: string; roles: DbRole[] }) => void
  onCancel: () => void
  saving: boolean
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(department?.name ?? '')
  const [description, setDescription] = useState(department?.description ?? '')
  const [roles, setRoles] = useState<DbRole[]>(department?.roles ?? [])
  const toggle = (r: DbRole) =>
    setRoles((rs) => (rs.includes(r) ? rs.filter((x) => x !== r) : [...rs, r]))
  return (
    <Card className="border-primary anim-enter">
      <CardHeader>
        <span>
          {department ? t('staff.dept.editTitle', { name: department.name }) : t('staff.dept.new')}
        </span>
      </CardHeader>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim().length < 2) return
          onSave({ id: department?.id, name, description, roles })
        }}
      >
        <CardBody className="gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label={t('staff.dept.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
            <Field
              label={t('staff.dept.description')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <fieldset className="m-0 border-0 p-0">
            <legend className="text-ink-2 mb-2 text-[13px] font-semibold">
              {t('staff.dept.roles')}
            </legend>
            <div className="flex flex-wrap gap-2">
              {DB_ROLES.filter((r) => r !== 'manager').map((r) => (
                <label
                  key={r}
                  className={cn(
                    'border-border flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-[13px] font-semibold transition-colors',
                    roles.includes(r) && 'border-primary bg-primary-tint text-primary',
                  )}
                >
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={roles.includes(r)}
                    onChange={() => toggle(r)}
                  />
                  {t(`staff.roles.${r}`)}
                </label>
              ))}
            </div>
            <p className="text-ink-3 m-0 mt-2 text-xs">{t('staff.dept.rolesHint')}</p>
          </fieldset>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={saving}>
              <Check size={16} aria-hidden="true" />
              {t('staff.dept.save')}
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

/* ---------------------------------------------------------------- credentials to hand over */

function CredentialsCard({
  credentials,
  onDone,
}: {
  credentials: Credentials
  onDone: () => void
}) {
  const { t } = useTranslation()
  return (
    <Card className="border-green anim-enter">
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

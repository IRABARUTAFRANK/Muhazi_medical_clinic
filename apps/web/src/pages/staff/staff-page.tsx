import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  Check,
  Copy,
  Eye,
  EyeOff,
  IdCard,
  KeyRound,
  Lightbulb,
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
import { Reveal } from '@/components/ui/reveal'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
import { ListBar, ShownList } from '@/components/ui/list-tools'
import { Select } from '@/components/ui/select'
import { Flash } from '@/components/ui/flash'
import { StaffShell } from '@/components/staff/staff-shell'
import { useTreatments } from '@/lib/api/catalogue'
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
  useDeactivationReminders,
  useDepartments,
  useEmployees,
  useRetirePreview,
  useStaffActions,
  type DbLang,
  type DbRole,
  type Department,
  type Employee,
  type EmployeeInput,
  type Position,
  positionIn,
  registrationText,
} from '@/lib/api/staff'
import { SECTIONS, sectionName, type SectionId } from '@/lib/api/services'
import { useConfirm } from '@/lib/confirm'
import { navForUser } from '@/lib/nav'
import { matches } from '@/lib/paging'
import { cn } from '@/lib/utils'
import { RegistrationField } from './registration-field'
import {
  registrationError,
  registrationForRole,
  registrationInput,
  registrationStart,
  showsRegistration,
} from './registration'

type Translate = (key: string, opts?: Record<string, unknown>) => string

/** "Doctor · Dentist": the role with what the person is expert in, when set. */
const employeeRole = (e: Pick<Employee, 'role' | 'specialty'>, t: Translate): string => {
  const role = t(`staff.roles.${e.role}`)
  const specialty = e.specialty?.trim()
  // "Sonographer · Sonographer" says it once
  return specialty && specialty.toLowerCase() !== role.toLowerCase()
    ? t('roles.withStation', { role, station: specialty })
    : role
}

// The start of a word, and its end (SQL \m and \M), letters of any language counted.
const WORD = '(?<![\\p{L}\\p{N}])'
const END = '(?![\\p{L}\\p{N}])'
/** The section a specialty names, in the order the database reads it (0080). */
const SPECIALTY_SECTIONS: readonly [RegExp, SectionId][] = [
  [new RegExp(`(${WORD}dent|amenyo|orthodon|stomato)`, 'u'), 'dental'],
  [new RegExp(`(ultra|${WORD}[ée]cho|sonog|radiol|imaging|imagerie|mucyuma)`, 'u'), 'ultrasound'],
  [
    new RegExp(
      `(surg|chirurg|kubaga|theat|th[ée][aâ]tre|${WORD}circ|gusiramura|anaesth|anesth)`,
      'u',
    ),
    'surgery',
  ],
  [
    new RegExp(
      `(g[ée]n[ée]ral|${WORD}gp${END}|family|famille|physician|m[ée]decin|internal|interne|` +
        `paediat|p[ée]diat|gyn|obst|ophtal|ophthal|${WORD}ent${END}|${WORD}orl${END}|cardio|derma|` +
        `neuro|psychiat|urolog|gastro|pneumo|endocrin|rheumat|rhumat|muganga)`,
      'u',
    ),
    'consultation',
  ],
]

/**
 * Where a person with no department service works: the usual desk of the role. The database's
 * role_serves (0080) decides; this mirrors it for the form. A doctor: the desk name (Consultation
 * when it names no section), plus the section the specialty names.
 */
function usualSections(role: DbRole, station: string, specialty: string): SectionId[] {
  if (role === 'sonographer') return ['ultrasound']
  if (role === 'nurse') return ['triage', 'nursing', 'fp', 'hiv']
  if (role === 'lab_tech') return ['laboratory']
  if (role === 'pharmacist') return ['pharmacy']
  if (role !== 'doctor') return []
  const desk = station.toLowerCase()
  const s = specialty.trim().toLowerCase()
  const named = s ? SPECIALTY_SECTIONS.find(([re]) => re.test(s))?.[1] : undefined
  const mine = new Set<SectionId>()
  if (/dent/.test(desk)) mine.add('dental')
  if (/(theat|surg|circ)/.test(desk)) mine.add('surgery').add('circ')
  if (/(ultra|echo)/.test(desk)) mine.add('ultrasound')
  if (!/(dent|theat|surg|ultra|echo)/.test(desk)) mine.add('consultation')
  if (named) mine.add(named)
  if (named === 'surgery') mine.add('circ')
  return SECTIONS.filter((x) => mine.has(x))
}

/** Usual specialties or titles offered per role; anything else may be typed. */
const SPECIALTY_SUGGESTIONS: Partial<Record<DbRole, readonly string[]>> = {
  doctor: [
    'General practitioner',
    'Dentist',
    'Surgeon',
    'Gynaecologist',
    'Paediatrician',
    'Internal medicine',
    'Ophthalmologist',
    'ENT specialist',
  ],
  nurse: ['Registered nurse', 'Midwife', 'Anaesthetic nurse', 'Nurse assistant'],
  lab_tech: ['Laboratory technician', 'Biomedical scientist'],
  sonographer: ['Sonographer', 'Radiographer'],
  pharmacist: ['Pharmacist', 'Pharmacy technician'],
}

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
  const confirm = useConfirm()
  const [editing, setEditing] = useState<Employee | 'new' | null>(null)
  const [resetFor, setResetFor] = useState<Employee | null>(null)
  const [credentials, setCredentials] = useState<Credentials | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [staffQuery, setStaffQuery] = useState('')
  // The account the manager is about to delete: the effects are shown first (one at a time).
  // Only the id is kept: the panel always shows the person as the list has them now
  // (a Deactivate from the row updates it; once deleted they leave the list and it closes).
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const deleting = employees.find((e) => e.id === deletingId) ?? null
  // Accounts deactivated for a month or more become a notice for the managers.
  useDeactivationReminders(true)
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
    if (/registration number/i.test(m)) return t('staff.errors.registrationNo')
    if (/registration body/i.test(m)) return t('staff.errors.registrationBody')
    if (m === 'pin') return t('staff.errors.pin')
    if (m === 'email' || /valid e-mail/i.test(m)) return t('staff.errors.email')
    if (/delete your own account/i.test(m)) return t('staff.errors.deleteSelf')
    if (/at least one manager/i.test(m)) return t('staff.errors.lastManager')
    if (/already deleted/i.test(m)) return t('staff.errors.alreadyDeleted')
    if (/employee not found/i.test(m)) return t('staff.errors.notFound')
    return t('staff.errors.generic', { message: m })
  }

  // Deactivate or reactivate, after the e-mailed code; `after` runs once it is done.
  const askSetActive = (e: Employee, after?: () => void) =>
    setPending({
      title: t(e.active ? 'staff.confirm.deactivate' : 'staff.confirm.reactivate', {
        name: e.fullName,
      }),
      run: async (confirmCode) => {
        await actions.setActive.mutateAsync({ id: e.id, active: !e.active, confirmCode })
        setNotice(
          t(e.active ? 'staff.deactivatedNotice' : 'staff.reactivatedNotice', {
            name: e.fullName,
          }),
        )
        after?.()
      },
    })
  const askDelete = (e: Employee) =>
    setPending({
      title: t('staff.confirm.delete', { name: e.fullName }),
      run: async (confirmCode) => {
        await actions.remove.mutateAsync({ id: e.id, confirmCode })
        setNotice(t('staff.delete.done', { name: e.fullName }))
        setDeletingId(null)
      },
    })
  // From the row: asked first (the e-mailed code follows the yes). From the delete panel, the
  // panel itself was the question.
  const confirmSetActive = async (e: Employee) => {
    const k = e.active ? 'confirm.staff.deactivate' : 'confirm.staff.reactivate'
    if (
      !(await confirm({
        title: t(`${k}.title`, { name: e.fullName }),
        body: t(`${k}.body`, { name: e.fullName }),
        confirmLabel: t(`${k}.yes`),
        tone: e.active ? 'danger' : 'primary',
      }))
    )
      return
    askSetActive(e)
  }
  // One panel at a time: opening any form closes the others.
  const openDelete = (e: Employee) => {
    setEditing(null)
    setResetFor(null)
    setDeletingId(e.id)
  }
  const openEdit = (e: Employee | 'new') => {
    setDeletingId(null)
    setResetFor(null)
    setEditing(e)
  }
  const openReset = (e: Employee) => {
    setDeletingId(null)
    setEditing(null)
    setResetFor(e)
  }
  // Deactivated for a month or more: the manager is invited to delete these accounts.
  const longDeactivated = employees
    .filter((e) => !e.active && e.deactivatedAt && daysSince(e.deactivatedAt) >= 30)
    .sort((a, b) => a.deactivatedAt!.localeCompare(b.deactivatedAt!))

  const visible = employees.filter(
    (e) =>
      (showInactive || e.active) && matches(staffQuery, e.fullName, e.username, e.staffId, e.email),
  )
  const groups: { key: string; name: string; people: Employee[] }[] = [
    ...departments.map((d) => ({
      key: d.id,
      name: d.name,
      people: visible.filter((e) => e.departments.some((m) => m.departmentId === d.id)),
    })),
    {
      key: 'none',
      name: t('staff.dept.none'),
      people: visible.filter(
        (e) => !e.departments.some((m) => departments.some((d) => d.id === m.departmentId)),
      ),
    },
  ].filter((g) => g.people.length > 0)
  const rank: Record<Position, number> = { head: 0, assistant: 1, member: 2 }

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="staff">
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <PageBanner icon={IdCard} tint="violet" title={t('staff.title')} lead={t('staff.lead2')}>
          {tab === 'people' && (
            <Button variant="primary" onClick={() => openEdit('new')}>
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
          <Flash key={notice} onClose={() => setNotice(null)}>
            {notice}
          </Flash>
        )}
        {/* Forms open here; the page scrolls to them (Reset PIN, Edit, New employee). */}
        <div ref={formRef} className="flex scroll-mt-4 flex-col gap-4">
          {formError && (
            <Flash key={formError} tone="error" onClose={() => setFormError(null)}>
              {formError}
            </Flash>
          )}
          {credentials && (
            <CredentialsCard credentials={credentials} onDone={() => setCredentials(null)} />
          )}
        </div>

        {tab === 'departments' ? (
          <DepartmentsPanel departments={departments} employees={employees} />
        ) : (
          <>
            {longDeactivated.length > 0 && (
              <LongDeactivatedCard people={longDeactivated} onDelete={openDelete} />
            )}

            {deleting && (
              <Reveal key={deleting.id}>
                <DeleteAccountCard
                  employee={deleting}
                  lastManager={
                    deleting.role === 'manager' &&
                    !employees.some((x) => x.id !== deleting.id && x.role === 'manager' && x.active)
                  }
                  // Escape belongs to the code dialog while it is open
                  paused={pending !== null}
                  onDeactivate={() =>
                    askSetActive(deleting, () =>
                      setDeletingId((id) => (id === deleting.id ? null : id)),
                    )
                  }
                  onDelete={() => askDelete(deleting)}
                  onCancel={() => setDeletingId(null)}
                />
              </Reveal>
            )}

            {editing && (
              <Reveal focus>
                <EmployeeForm
                  key={editing === 'new' ? 'new' : editing.id}
                  employee={editing === 'new' ? null : editing}
                  departments={departments}
                  takenUsernames={new Set(employees.map((e) => e.username))}
                  heads={Object.fromEntries(
                    employees.flatMap((e) =>
                      e.active
                        ? e.departments
                            .filter((m) => m.position === 'head')
                            .map((m) => [m.departmentId, { id: e.id, name: e.fullName }])
                        : [],
                    ),
                  )}
                  self={editing !== 'new' && editing.id === user.id}
                  onCancel={() => setEditing(null)}
                  onSubmit={async (input, firstPin) => {
                    const k = editing === 'new' ? 'confirm.staff.create' : 'confirm.staff.update'
                    if (
                      !(await confirm({
                        title: t(`${k}.title`, { name: input.fullName }),
                        body: t(`${k}.body`, { name: input.fullName }),
                        confirmLabel: t(`${k}.yes`),
                      }))
                    )
                      return
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
                  }}
                />
              </Reveal>
            )}

            {resetFor && (
              <ResetPinCard
                employee={resetFor}
                onClose={() => setResetFor(null)}
                onSubmit={async (pin) => {
                  // No e-mailed code: the new PIN is temporary and is recorded in the history.
                  if (
                    !(await confirm({
                      title: t('confirm.staff.resetPin.title', { name: resetFor.fullName }),
                      body: t('confirm.staff.resetPin.body', { name: resetFor.fullName }),
                      confirmLabel: t('confirm.staff.resetPin.yes'),
                    }))
                  )
                    return
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
                      rank[positionIn(a, g.key)] - rank[positionIn(b, g.key)] ||
                      a.fullName.localeCompare(b.fullName),
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
                                {self && (
                                  <span className="text-ink-3 ml-2 text-xs font-medium">
                                    ({t('staff.you')})
                                  </span>
                                )}
                              </span>
                              <span className="text-ink-3 text-xs tabular-nums">
                                {[
                                  e.staffId,
                                  registrationText(e) &&
                                    t('staff.registrationShort', { reg: registrationText(e) }),
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
                            <Chip>{employeeRole(e, t)}</Chip>
                            {positionIn(e, g.key) !== 'member' && (
                              <Badge
                                tone={positionIn(e, g.key) === 'head' ? 'blue' : 'grey'}
                                dot={false}
                              >
                                {t(`staff.positions.${positionIn(e, g.key)}`)}
                              </Badge>
                            )}
                            {e.departments.length > 1 && (
                              <span className="text-violet text-xs font-semibold">
                                {t('staff.alsoIn', {
                                  names: e.departments
                                    .filter((m) => m.departmentId !== g.key)
                                    .map((m) => m.departmentName)
                                    .join(', '),
                                })}
                              </span>
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
                              <Button size="sm" onClick={() => openEdit(e)} disabled={!e.active}>
                                <Pencil size={15} aria-hidden="true" />
                                {t('staff.edit')}
                              </Button>
                              <Button size="sm" onClick={() => openReset(e)} disabled={!e.active}>
                                <KeyRound size={15} aria-hidden="true" />
                                {t('staff.resetPin')}
                              </Button>
                              {/* deactivating can be undone: not shown as dangerous as deleting */}
                              <Button
                                size="sm"
                                disabled={self}
                                onClick={() => void confirmSetActive(e)}
                              >
                                {e.active ? (
                                  <UserX size={15} aria-hidden="true" />
                                ) : (
                                  <UserCheck size={15} aria-hidden="true" />
                                )}
                                {t(e.active ? 'staff.deactivate' : 'staff.reactivate')}
                              </Button>
                              {/* the effects and the better option are shown before anything */}
                              <Button
                                size="sm"
                                variant="danger"
                                disabled={self}
                                title={self ? t('staff.errors.deleteSelf') : undefined}
                                aria-expanded={deleting?.id === e.id}
                                onClick={() => openDelete(e)}
                              >
                                <Trash2 size={15} aria-hidden="true" />
                                {t('staff.delete.button')}
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

/* ---------------------------------------------------------------- delete an account */

/** Whole days since an ISO date (0 on the same day). */
function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000))
}

/**
 * Before a delete: what goes, what stays (the clinic's records keep the name), and the better
 * option, deactivating, which keeps everything and can be undone. The counts (notices, waiting
 * patients, booked appointments) come from the server when it has them (migration 0078).
 */
function DeleteAccountCard({
  employee,
  lastManager,
  paused,
  onDeactivate,
  onDelete,
  onCancel,
}: {
  employee: Employee
  /** The clinic's only active manager: the server refuses, so say it now. */
  lastManager: boolean
  paused: boolean
  onDeactivate: () => void
  onDelete: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const name = employee.fullName
  useEffect(() => {
    if (paused) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paused, onCancel])
  // null: an older database without the counts, so the lines say it without numbers
  const { data: preview = null, isPending: previewLoading } = useRetirePreview(employee.id)
  const waitingNow = preview
    ? [
        preview.waitingPatients > 0 &&
          t('staff.delete.now.patients', { count: preview.waitingPatients }),
        preview.openTasks > 0 && t('staff.delete.now.tasks', { count: preview.openTasks }),
      ].filter(Boolean)
    : []
  const happens = [
    t('staff.delete.happens.signIn', { name }),
    t('staff.delete.happens.departments'),
    t('staff.delete.happens.devices'),
    waitingNow.length > 0
      ? `${t('staff.delete.happens.waiting')} (${waitingNow.join(' · ')})`
      : t('staff.delete.happens.waiting'),
    preview && preview.notices > 0
      ? t('staff.delete.happens.noticesCount', { count: preview.notices })
      : t('staff.delete.happens.notices'),
  ]
  const stays = [t('staff.delete.stays.recordsName'), t('staff.delete.stays.staffId')]
  // booked appointments are not moved for the manager: say it before, with the number if known
  const appointments = preview?.upcomingAppointments ?? null

  return (
    <Card className="border-red anim-enter">
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <Trash2 size={16} aria-hidden="true" className="text-red" />
          {t('staff.delete.title', { name })}
        </span>
        {employee.staffId && (
          <span className="text-ink-3 text-xs tabular-nums">{employee.staffId}</span>
        )}
      </CardHeader>
      <CardBody className="gap-4">
        {!employee.active && employee.deactivatedAt && (
          <p className="bg-surface text-ink-2 m-0 rounded-lg px-3 py-2 text-[13px]">
            {t('staff.delete.deactivatedSince', {
              name,
              date: formatDate(new Date(employee.deactivatedAt)),
              count: daysSince(employee.deactivatedAt),
            })}
          </p>
        )}

        {/* the better option comes first */}
        {employee.active && (
          <div className="border-primary bg-primary-tint flex flex-col gap-2 rounded-xl border p-3">
            <span className="text-primary inline-flex items-center gap-2 text-[14px] font-bold">
              <Lightbulb size={16} aria-hidden="true" />
              {t('staff.delete.recommendTitle')}
            </span>
            <p className="text-ink m-0 text-[13px]">{t('staff.delete.recommendBody')}</p>
            <Button variant="primary" className="self-start" onClick={onDeactivate}>
              <UserX size={16} aria-hidden="true" />
              {t('staff.delete.deactivateInstead')}
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <section className="flex flex-col gap-1.5">
            <h3 className="text-red m-0 text-[13px] font-bold">{t('staff.delete.happensTitle')}</h3>
            <ul className="text-ink-2 m-0 flex list-disc flex-col gap-1 pl-5 text-[13px]">
              {happens.map((line) => (
                <li key={line}>{line}</li>
              ))}
              <li className="text-red font-semibold">{t('staff.delete.happens.final')}</li>
            </ul>
          </section>
          <section className="flex flex-col gap-1.5">
            <h3 className="text-green m-0 text-[13px] font-bold">{t('staff.delete.staysTitle')}</h3>
            <ul className="text-ink-2 m-0 flex list-disc flex-col gap-1 pl-5 text-[13px]">
              {stays.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        </div>

        {!previewLoading && appointments !== 0 && (
          <p className="bg-amber-bg text-amber m-0 flex items-start gap-2 rounded-lg px-3 py-2 text-[13px] font-semibold">
            <CalendarClock size={16} aria-hidden="true" className="mt-px shrink-0" />
            {appointments == null
              ? t('staff.delete.appointments', { name })
              : t('staff.delete.appointmentsCount', { name, count: appointments })}
          </p>
        )}

        {lastManager && (
          <p role="alert" className={errorBox}>
            {t('staff.errors.lastManager')}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" disabled={lastManager} onClick={onDelete}>
            <Trash2 size={16} aria-hidden="true" />
            {t('staff.delete.confirmButton')}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            {t('staff.form.cancel')}
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

/** Deactivated for a month or more: if they are not coming back, the account can go. */
function LongDeactivatedCard({
  people,
  onDelete,
}: {
  people: Employee[]
  onDelete: (e: Employee) => void
}) {
  const { t } = useTranslation()
  return (
    <Card className="border-amber/50">
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <AlertTriangle size={16} aria-hidden="true" className="text-amber" />
          {t('staff.longDeactivated.title')}
        </span>
        <span className="text-ink-3 text-xs">{people.length}</span>
      </CardHeader>
      <CardBody className="gap-2">
        <p className="text-ink-2 m-0 text-[13px]">{t('staff.longDeactivated.lead')}</p>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {people.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
              <span className="min-w-[180px] flex-1">
                <b>{e.fullName}</b>
                {e.staffId && <span className="text-ink-3 ml-2 tabular-nums">{e.staffId}</span>}
                <span className="text-ink-3 ml-2">
                  {t('staff.longDeactivated.since', {
                    date: formatDate(new Date(e.deactivatedAt!)),
                    count: daysSince(e.deactivatedAt!),
                  })}
                </span>
              </span>
              <Button size="sm" variant="danger" onClick={() => onDelete(e)}>
                <Trash2 size={15} aria-hidden="true" />
                {t('staff.longDeactivated.delete')}
              </Button>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
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
  heads,
  self,
  onSubmit,
  onCancel,
}: {
  employee: Employee | null
  departments: Department[]
  takenUsernames: ReadonlySet<string>
  /** The head of each department now: one head per department (migration 0073). */
  heads: Record<string, { id: string; name: string }>
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
  // Every department of the employee with the position held there; the first is the main one.
  const [memberships, setMemberships] = useState<{ departmentId: string; position: Position }[]>(
    () =>
      (employee?.departments ?? []).map((m) => ({
        departmentId: m.departmentId,
        position: m.position,
      })),
  )
  const setMembership = (i: number, patch: Partial<{ departmentId: string; position: Position }>) =>
    setMemberships((list) => list.map((m, j) => (j === i ? { ...m, ...patch } : m)))
  const [station, setStation] = useState(employee?.station ?? '')
  const [specialty, setSpecialty] = useState(employee?.specialty ?? '')
  // the professional council number printed on what the person signs (0084)
  const [registration, setRegistration] = useState(() =>
    registrationStart(employee, employee?.role ?? 'receptionist'),
  )
  const [language, setLanguage] = useState<DbLang>(employee?.language ?? 'kin')
  const [pin, setPin] = useState(generatePin)
  const [error, setError] = useState<string | null>(null)

  // Only departments this role belongs to (a department with no roles listed accepts all).
  const fitting = departments.filter((d) => d.roles.length === 0 || d.roles.includes(role))
  const others = new Set([...takenUsernames].filter((u) => u !== employee?.username))
  const specialtyListId = useId()
  const suggestions = SPECIALTY_SUGGESTIONS[role] ?? []
  // The chosen departments decide the services (and so the patients) that reach this person.
  const chosenDepts = memberships
    .map((m) => departments.find((d) => d.id === m.departmentId))
    .filter((d): d is Department => !!d)
  const services = SECTIONS.filter((s) => chosenDepts.some((d) => d.services.includes(s)))
  const silent = chosenDepts.filter((d) => d.services.length === 0).map((d) => d.name)
  // with none, the usual desk of the role (a doctor's also follows the specialty and desk name)
  const shown = services.length ? services : usualSections(role, station, specialty)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!fullName.trim()) return setError(t('staff.errors.name'))
    if (!USERNAME_RE.test(username)) return setError(t('staff.errors.username'))
    if (others.has(username)) return setError(t('staff.errors.usernameTaken'))
    if (!EMAIL_RE.test(email.trim())) return setError(t('staff.errors.email'))
    const chosen = memberships.filter((m) => m.departmentId)
    if (new Set(chosen.map((m) => m.departmentId)).size !== chosen.length)
      return setError(t('staff.errors.deptTwice'))
    if (isNew && !PIN_RE.test(pin)) return setError(t('staff.errors.pin'))
    const regError = registrationError(registration)
    if (regError) return setError(t(regError))
    onSubmit(
      {
        fullName,
        username,
        email,
        role,
        departments: chosen,
        station,
        language,
        phone,
        specialty,
        ...registrationInput(registration, employee),
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

          {/* Three separate ideas: what they may do, what they are expert in, where they work. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Select
                label={t('staff.form.role')}
                value={role}
                onChange={(e) => {
                  const r = e.target.value as DbRole
                  setRole(r)
                  setRegistration((v) => registrationForRole(v, r))
                  // departments that do not take this role are dropped
                  setMemberships((list) =>
                    list.filter((m) => {
                      const d = departments.find((x) => x.id === m.departmentId)
                      return !d || d.roles.length === 0 || d.roles.includes(r)
                    }),
                  )
                }}
                disabled={self}
              >
                {DB_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(`staff.roles.${r}`)}
                  </option>
                ))}
              </Select>
              <p className="text-ink-3 m-0 text-xs">{t(`staff.form.roleDoes.${role}`)}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Field
                label={t('staff.form.specialty')}
                value={specialty}
                placeholder={t('staff.form.specialtyPh')}
                list={suggestions.length ? specialtyListId : undefined}
                autoComplete="off"
                onChange={(e) => setSpecialty(e.target.value)}
              />
              {suggestions.length > 0 && (
                <datalist id={specialtyListId}>
                  {suggestions.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              )}
              <p
                className={cn(
                  'm-0 text-xs',
                  role === 'doctor' && !specialty.trim()
                    ? 'text-amber font-semibold'
                    : 'text-ink-3',
                )}
              >
                {t(
                  role === 'doctor' && !specialty.trim()
                    ? 'staff.form.specialtyDoctorHint'
                    : 'staff.form.specialtyHint',
                )}
              </p>
            </div>
          </div>
          {showsRegistration(role, registration) && (
            <RegistrationField role={role} value={registration} onChange={setRegistration} />
          )}
          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="text-ink-2 mb-1 text-[13px] font-semibold">
              {t('staff.form.departments')}
            </legend>
            <p className="text-ink-3 m-0 -mt-1 text-xs">{t('staff.form.departmentsHint')}</p>
            {memberships.length === 0 && (
              <p className="text-ink-3 m-0 text-xs">{t('staff.form.noDepartmentYet')}</p>
            )}
            {memberships.map((m, i) => (
              <div
                key={i}
                className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]"
              >
                <Select
                  label={i === 0 ? t('staff.form.mainDepartment') : t('staff.form.department')}
                  value={m.departmentId}
                  onChange={(e) => setMembership(i, { departmentId: e.target.value })}
                >
                  <option value="">{t('staff.form.pickDepartment')}</option>
                  {fitting
                    .filter(
                      (d) =>
                        d.id === m.departmentId ||
                        !memberships.some((x) => x.departmentId === d.id),
                    )
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                </Select>
                <Select
                  label={t('staff.form.position')}
                  value={m.position}
                  onChange={(e) => setMembership(i, { position: e.target.value as Position })}
                  disabled={!m.departmentId}
                >
                  {POSITIONS.map((p) => (
                    <option key={p} value={p}>
                      {t(`staff.positions.${p}`)}
                    </option>
                  ))}
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setMemberships((list) => list.filter((_, j) => j !== i))}
                  aria-label={t('staff.form.removeDepartment')}
                  title={t('staff.form.removeDepartment')}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </Button>
                {/* one head per department: the head now becomes assistant head */}
                {m.position === 'head' &&
                  heads[m.departmentId] &&
                  heads[m.departmentId]!.id !== employee?.id && (
                    <p className="bg-amber-bg text-amber m-0 rounded-lg px-3 py-2 text-[13px] font-semibold sm:col-span-3">
                      {t('staff.form.replacesHead', {
                        name: heads[m.departmentId]!.name,
                        dept: departments.find((d) => d.id === m.departmentId)?.name ?? '',
                      })}
                    </p>
                  )}
              </div>
            ))}
            {fitting.some((d) => !memberships.some((x) => x.departmentId === d.id)) && (
              <Button
                type="button"
                className="self-start"
                onClick={() =>
                  setMemberships((list) => [...list, { departmentId: '', position: 'member' }])
                }
              >
                <Plus size={16} aria-hidden="true" />
                {t(
                  memberships.length
                    ? 'staff.form.addAnotherDepartment'
                    : 'staff.form.addDepartment',
                )}
              </Button>
            )}
            {/* What the chosen departments send to this person, live. */}
            <div className="bg-surface flex flex-col gap-1 rounded-lg px-3 py-2 text-[13px]">
              {shown.length > 0 ? (
                <span>
                  <b>{t('staff.form.worksIn')}</b> {shown.map((s) => sectionName(s, t)).join(', ')}
                </span>
              ) : (
                <span className="text-ink-2">{t('staff.form.worksAtRoleDesk')}</span>
              )}
              {/* no department service yet: the role (and a doctor's specialty and desk) decide */}
              {services.length === 0 && shown.length > 0 && (
                <span className="text-ink-3 text-xs">
                  {t(role === 'doctor' ? 'staff.form.byRoleDoctor' : 'staff.form.byRole')}
                </span>
              )}
              {silent.length > 0 && (
                <span className="text-amber font-semibold">
                  {t('staff.form.deptNoService', { names: silent.join(', ') })}
                </span>
              )}
            </div>
            {memberships.length > 1 && (
              <p className="text-ink-3 m-0 text-xs">{t('staff.form.manyHint')}</p>
            )}
            {memberships.length > 0 && (
              <p className="text-ink-3 m-0 text-xs">{t('staff.form.positionsHint')}</p>
            )}
          </fieldset>
          {departments.length === 0 && (
            <p className="text-ink-3 m-0 -mt-2 text-xs">{t('staff.form.noDepartments')}</p>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field
              label={t('staff.form.station')}
              value={station}
              placeholder={t('staff.form.stationPh')}
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
          <p className="text-ink-3 m-0 -mt-2 text-xs">{t('staff.form.stationHint')}</p>
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
  const confirm = useConfirm()
  // A department holds its employees and the treatments they give (Treatments and prices).
  const { data: treatments = [] } = useTreatments()
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
        <Reveal focus>
          <DepartmentForm
            key={editing === 'new' ? 'new' : editing.id}
            department={editing === 'new' ? null : editing}
            onCancel={() => setEditing(null)}
            onSave={async (d) => {
              const k = d.id ? 'confirm.departments.save' : 'confirm.departments.create'
              if (
                !(await confirm({
                  title: t(`${k}.title`, { name: d.name.trim() }),
                  body: t(`${k}.body`),
                  confirmLabel: t(`${k}.yes`),
                }))
              )
                return
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
        </Reveal>
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
          const people = employees.filter(
            (e) => e.active && e.departments.some((m) => m.departmentId === d.id),
          )
          const head = people.find((e) => positionIn(e, d.id) === 'head')
          const assistants = people.filter((e) => positionIn(e, d.id) === 'assistant')
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
                        !(await confirm({
                          title: t('confirm.departments.delete.title', { name: d.name }),
                          body: t('confirm.departments.delete.body', { count: people.length }),
                          confirmLabel: t('confirm.departments.delete.yes'),
                          tone: 'danger',
                        }))
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
                  <b>{t('staff.dept.servicesShort')}:</b>{' '}
                  {d.services.length > 0 ? (
                    d.services.map((s) => sectionName(s, t)).join(', ')
                  ) : (
                    <span className="text-ink-3">{t('staff.dept.noServices')}</span>
                  )}
                </p>
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
                  {t('staff.dept.members', { count: people.length })} ·{' '}
                  {t('staff.dept.treatments', {
                    count: treatments.filter((x) => x.departmentIds.includes(d.id)).length,
                  })}
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
  onSave: (d: {
    id?: string
    name: string
    description: string
    roles: DbRole[]
    services: string[]
  }) => void
  onCancel: () => void
  saving: boolean
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(department?.name ?? '')
  const [description, setDescription] = useState(department?.description ?? '')
  const [roles, setRoles] = useState<DbRole[]>(department?.roles ?? [])
  const [services, setServices] = useState<string[]>(department?.services ?? [])
  const toggle = (r: DbRole) =>
    setRoles((rs) => (rs.includes(r) ? rs.filter((x) => x !== r) : [...rs, r]))
  const toggleService = (s: string) =>
    setServices((ss) => (ss.includes(s) ? ss.filter((x) => x !== s) : [...ss, s]))
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
          onSave({ id: department?.id, name, description, roles, services })
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
          {/* the sections this department works in: its people take the patients sent there */}
          <fieldset className="m-0 border-0 p-0">
            <legend className="text-ink-2 mb-2 text-[13px] font-semibold">
              {t('staff.dept.services')}
            </legend>
            <div className="flex flex-wrap gap-2">
              {SECTIONS.map((s) => (
                <label
                  key={s}
                  className={cn(
                    'border-border flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-[13px] font-semibold transition-colors',
                    services.includes(s) && 'border-primary bg-primary-tint text-primary',
                  )}
                >
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={services.includes(s)}
                    onChange={() => toggleService(s)}
                  />
                  {sectionName(s, t)}
                </label>
              ))}
            </div>
            <p className="text-ink-3 m-0 mt-2 text-xs">{t('staff.dept.servicesHint')}</p>
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

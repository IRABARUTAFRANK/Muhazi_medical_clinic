import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  Check,
  Copy,
  Eye,
  EyeOff,
  FolderLock,
  IdCard,
  KeyRound,
  Lightbulb,
  Mail,
  MailCheck,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Stethoscope,
  Trash2,
  UserCheck,
  UserPlus,
  UserX,
  Wand2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSearch } from '@tanstack/react-router'
import { formatDate, formatTime, type StaffUser } from '@mmc/shared'
import { PageBanner } from '@/components/dash/page-banner'
import { Avatar } from '@/components/ui/avatar'
import { Reveal } from '@/components/ui/reveal'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
import { ListBar, ShownList } from '@/components/ui/list-tools'
import { Select } from '@/components/ui/select'
import { SidePanel } from '@/components/ui/side-panel'
import { Flash } from '@/components/ui/flash'
import { StaffShell } from '@/components/staff/staff-shell'
import { StaffLink } from '@/components/staff/staff-link'
import { useTreatments } from '@/lib/api/catalogue'
import {
  EMAIL_RE,
  PIN_RE,
  POSITIONS,
  PROFESSIONS,
  USERNAME_RE,
  doesIn,
  generatePin,
  sendConfirmCode,
  suggestUsername,
  takesProfession,
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
  type Profession,
  positionIn,
  registrationText,
} from '@/lib/api/staff'
import { SPECIALTIES, professionLabel, specialtyLabel } from '@/lib/roles'
import { NON_TREATING_ROLES } from '@/lib/api/permissions'
import {
  DEFAULT_CEILINGS,
  DESKS,
  ROLE_DESKS,
  departmentGivesNothing,
  deskName,
  desksFor,
  desksOutsideCeiling,
  desksText,
  isDesk,
  useKeptDeskActions,
  useRoleDeskMatrix,
  TREATING_DESKS,
  type DeskId,
} from '@/lib/api/desks'
import { SECTIONS, sectionName, type SectionId } from '@/lib/api/services'
import { useConfirm } from '@/lib/confirm'
import { navForUser } from '@/lib/nav'
import { matches } from '@/lib/paging'
import { heroBand } from '@/components/dash/kit-style'
import { cn } from '@/lib/utils'
import { RegistrationField } from './registration-field'
import { StaffDocumentsPanel } from './staff-documents'
import {
  registrationError,
  registrationForRole,
  registrationInput,
  registrationStart,
  showsRegistration,
} from './registration'

type Translate = (key: string, opts?: Record<string, unknown>) => string

/** The employee form's id: the panel's footer buttons submit it from outside the form. */
const EMPLOYEE_FORM = 'employee-form'

/** "Doctor · Dentist · Clinic manager": the profession, what the person is expert in, and the
 *  manager flag (0128). */
const employeeRole = (
  e: Pick<Employee, 'role' | 'specialty' | 'isManager'>,
  t: Translate,
): string => professionLabel(e, t)

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
  if (role === 'nurse' || role === 'midwife') return ['triage', 'nursing', 'fp', 'hiv']
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

/** Titles suggested (free text) for the professions without a list of specialties (0128). */
const SPECIALTY_SUGGESTIONS: Partial<Record<DbRole, readonly string[]>> = {
  lab_tech: ['Laboratory technician', 'Biomedical scientist'],
  sonographer: ['Sonographer', 'Radiographer'],
  pharmacist: ['Pharmacist', 'Pharmacy technician'],
}

/** The specialty choice of the form (0128): one of the profession's list, 'other' (typed), or ''. */
const OTHER_SPECIALTY = 'other'
const specialtyChoice = (role: DbRole, specialty: string): { choice: string; other: string } => {
  const list = SPECIALTIES[role]
  const s = specialty.trim()
  if (!list) return { choice: '', other: s }
  const known = list.find((x) => x.toLowerCase() === s.toLowerCase())
  if (known) return { choice: known, other: '' }
  return s ? { choice: OTHER_SPECIALTY, other: s } : { choice: '', other: '' }
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

const errorBox =
  'border-red/30 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium'
const warnBox =
  'border-amber/30 bg-amber-bg text-amber m-0 rounded-md border px-3 py-2 text-[14px] font-medium'

/** A department service's name: the sections (0071), and Reception, a desk only (0085). */
const serviceLabel = (s: string, t: Translate): string =>
  s === 'reception' ? deskName(s, t) : sectionName(s, t)

/** The desks some department of the clinic gives (the others follow the role alone). */
const offeredBy = (departments: readonly Department[]): DeskId[] =>
  DESKS.filter((d) => departments.some((x) => x.services.includes(d)))

interface Lead {
  id: string
  name: string
}
/** The head (or the assistant head) of each department now, by department id. */
const leadsOf = (employees: readonly Employee[], position: 'head' | 'assistant') =>
  Object.fromEntries(
    employees.flatMap((e) =>
      e.active
        ? e.departments
            .filter((m) => m.position === position)
            .map((m): [string, Lead] => [m.departmentId, { id: e.id, name: e.fullName }])
        : [],
    ),
  ) as Record<string, Lead>

/**
 * What saving one place does to the department's head and assistant head: one of each per
 * department (0073, 0085). A new head makes the head the assistant and the assistant a member;
 * a new assistant makes the assistant a member. Shown in the form and in the "Are you sure?".
 */
function leadChanges(
  m: { departmentId: string; position: Position },
  selfId: string | undefined,
  heads: Record<string, Lead>,
  assistants: Record<string, Lead>,
  dept: string,
  t: Translate,
): string[] {
  if (!m.departmentId || m.position === 'member') return []
  const head = heads[m.departmentId]
  const assistant = assistants[m.departmentId]
  const otherHead = head && head.id !== selfId ? head : undefined
  const otherAssistant = assistant && assistant.id !== selfId ? assistant : undefined
  const out: string[] = []
  if (m.position === 'head' && otherHead) {
    out.push(t('staff.form.replacesHead', { name: otherHead.name, dept }))
    if (otherAssistant)
      out.push(t('staff.form.assistantToMember', { name: otherAssistant.name, dept }))
  }
  if (m.position === 'assistant' && otherAssistant)
    out.push(t('staff.form.replacesAssistant', { name: otherAssistant.name, dept }))
  return out
}

interface DeskLoss {
  desk: DeskId
  names: string[]
  /** A desk no department gave until now (true), or one this department stops giving. */
  newly: boolean
}
/**
 * Who loses a desk when a department's services change (0085). A desk no department gave until
 * now is, once saved, used only by the members of departments giving it: the people using it now
 * who are not members are listed (those who work there as usual are placed in it by the database
 * when nothing else changes for them; the manager is told about the others). A desk this
 * department stops giving (every desk, when it is deleted: next = null) leaves its members unless
 * another of their departments gives it, or no department gives it any more and their role does.
 * A desk kept from before (keptDesks) stays either way.
 */
function deskLosses(
  dept: Department | null,
  next: readonly string[] | null,
  departments: readonly Department[],
  employees: readonly Employee[],
  desksOf: (e: Employee) => DeskId[] | null,
): DeskLoss[] {
  const others = departments.filter((d) => d.id !== dept?.id)
  const before = dept?.services ?? []
  const after = next ?? []
  const people = employees.filter((e) => e.active && e.role !== 'manager')
  const inDept = (e: Employee, id: string | undefined) =>
    !!id && e.departments.some((m) => m.departmentId === id)
  const uses = (e: Employee, desk: DeskId) =>
    (desksOf(e) ?? []).includes(desk) && !(e.keptDesks ?? []).includes(desk)
  const out: DeskLoss[] = []
  for (const desk of DESKS) {
    const elsewhere = others.some((d) => d.services.includes(desk))
    if (after.includes(desk) && !before.includes(desk) && !elsewhere) {
      const names = people
        .filter((e) => uses(e, desk) && !inDept(e, dept?.id))
        .map((e) => e.fullName)
      if (names.length) out.push({ desk, names, newly: true })
    } else if (before.includes(desk) && !after.includes(desk)) {
      const names = people
        .filter(
          (e) =>
            inDept(e, dept?.id) &&
            uses(e, desk) &&
            !others.some((d) => d.services.includes(desk) && inDept(e, d.id)) &&
            (elsewhere || !ROLE_DESKS[e.role].includes(desk)),
        )
        .map((e) => e.fullName)
      if (names.length) out.push({ desk, names, newly: false })
    }
  }
  return out
}
const lossText = (l: DeskLoss, t: Translate): string =>
  t(l.newly ? 'staff.dept.willLoseNew' : 'staff.dept.willLoseDropped', {
    desk: deskName(l.desk, t),
    names: l.names.join(', '),
  })

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
  // 0141: "Works as the doctor here" is saved after the employee, department by department (the
  // manager's own call; the employee's save itself goes through the confirmed function)
  const applyDoctorHere = async (id: string, input: EmployeeInput, before: Employee | null) => {
    for (const m of input.departments) {
      const was =
        before?.departments.find((x) => x.departmentId === m.departmentId)?.doctorHere === true
      const now = m.doctorHere === true
      if (was !== now)
        await actions.setDoctorHere.mutateAsync({
          profileId: id,
          departmentId: m.departmentId,
          on: now,
        })
    }
  }
  const confirm = useConfirm()
  const [editing, setEditing] = useState<Employee | 'new' | null>(null)
  const [resetFor, setResetFor] = useState<Employee | null>(null)
  // The employee whose documents (licence, contract…) are open in the drawer (0116); the
  // dashboard's "Documents expiring" opens it with ?documents=<id>.
  const search = useSearch({ strict: false }) as { documents?: string }
  const wanted = search.documents ?? null
  const [docsId, setDocsId] = useState<string | null>(wanted)
  // a new ?documents= while the page is open (a second row of the dashboard's panel)
  const [seenWanted, setSeenWanted] = useState(wanted)
  if (wanted !== seenWanted) {
    setSeenWanted(wanted)
    if (wanted) setDocsId(wanted)
  }
  const docsFor = docsId ? (employees.find((e) => e.id === docsId) ?? null) : null
  const setDocsFor = (e: Employee | null) => setDocsId(e?.id ?? null)
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
  // Bring the credentials the manager just made into view, wherever the button was on the page
  // (the forms themselves open in the side panel).
  useEffect(() => {
    if (credentials) formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [credentials])

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
    if (/at least one (active )?manager|own manager role/i.test(m))
      return t('staff.errors.lastClinicManager')
    if (/does not give|tick at least one service/i.test(m)) return t('staff.errors.servicesWrong')
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
  // One head and one assistant head per department: the form says who a save moves down.
  const heads = leadsOf(employees, 'head')
  const assistants = leadsOf(employees, 'assistant')
  // The desks each employee may use (0085: staff_directory.desks). In sample mode they are
  // computed the database's way; before 0085 nothing is shown (the role decides, as before).
  const { data: deskMatrix } = useRoleDeskMatrix()
  const desksOfEmployee = (e: Employee): DeskId[] | null => {
    // (the role 'manager' of a database before 0128: every desk)
    if (!e.active || e.role === 'manager') return null
    if (e.desks) return e.desks.filter(isDesk)
    if (!deskMatrix || deskMatrix.fallback) return null
    return desksFor({
      role: e.role,
      // 0128: what the person does in each department
      services: e.departments.map((m) => {
        const d = departments.find((x) => x.id === m.departmentId)
        return d ? doesIn(m, d) : []
      }),
      ceiling: deskMatrix.roles[e.role],
      offered: offeredBy(departments),
    }).desks
  }

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

        <div
          className="border-border bg-surface flex flex-wrap gap-0.5 self-start rounded-md border p-0.5"
          role="tablist"
        >
          {(['people', 'departments'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cn(
                'inline-flex min-h-8 items-center rounded px-3 text-[14px] font-medium transition-colors duration-120',
                tab === k
                  ? 'bg-card text-primary border-border border'
                  : 'text-ink-2 hover:bg-hover hover:text-ink border border-transparent',
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
        {/* The credentials of a new account or a reset PIN show here; the page scrolls to them. */}
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
          <DepartmentsPanel
            departments={departments}
            employees={employees}
            desksOf={desksOfEmployee}
          />
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
                    deleting.isManager &&
                    !employees.some((x) => x.id !== deleting.id && x.isManager && x.active)
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

            <SidePanel
              open={editing !== null}
              onClose={() => setEditing(null)}
              hue="blue"
              icon={editing === 'new' ? UserPlus : Pencil}
              title={
                editing === 'new'
                  ? t('staff.newEmployee')
                  : editing
                    ? t('staff.editTitle', { name: editing.fullName })
                    : ''
              }
              subtitle={
                editing && editing !== 'new'
                  ? [editing.staffId, employeeRole(editing, t)].filter(Boolean).join(' · ')
                  : undefined
              }
              footer={
                <>
                  <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                    {t('staff.form.cancel')}
                  </Button>
                  <Button type="submit" form={EMPLOYEE_FORM} variant="primary">
                    <ShieldCheck size={16} aria-hidden="true" />
                    {editing === 'new' ? t('staff.form.create') : t('staff.form.saveChanges')}
                  </Button>
                </>
              }
            >
              {editing && (
                <EmployeeForm
                  inPanel
                  key={editing === 'new' ? 'new' : editing.id}
                  employee={editing === 'new' ? null : editing}
                  departments={departments}
                  takenUsernames={new Set(employees.map((e) => e.username))}
                  heads={heads}
                  assistants={assistants}
                  self={editing !== 'new' && editing.id === user.id}
                  onCancel={() => setEditing(null)}
                  onSubmit={async (input, firstPin) => {
                    const k = editing === 'new' ? 'confirm.staff.create' : 'confirm.staff.update'
                    const body = t(`${k}.body`, { name: input.fullName })
                    // the head or assistant head this save moves down, said again before saving
                    const changes = input.departments.flatMap((m) =>
                      leadChanges(
                        m,
                        editing === 'new' ? undefined : editing.id,
                        heads,
                        assistants,
                        departments.find((d) => d.id === m.departmentId)?.name ?? '',
                        t,
                      ),
                    )
                    if (
                      !(await confirm({
                        title: t(`${k}.title`, { name: input.fullName }),
                        body: changes.length ? (
                          <span className="flex flex-col gap-2">
                            <span>{body}</span>
                            {changes.map((c) => (
                              <span key={c} className="text-amber font-semibold">
                                {c}
                              </span>
                            ))}
                          </span>
                        ) : (
                          body
                        ),
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
                          await applyDoctorHere(r.id, input, null)
                          setCredentials({
                            title: t('staff.created.title', { name: input.fullName }),
                            staffId: r.staff_id ?? '',
                            email: input.email,
                            username: r.username,
                            pin: firstPin!,
                          })
                        } else {
                          await actions.update.mutateAsync({ id: editing.id, input, confirmCode })
                          await applyDoctorHere(editing.id, input, editing)
                          setNotice(t('staff.saved', { name: input.fullName }))
                        }
                        setEditing(null)
                      },
                    })
                  }}
                />
              )}
            </SidePanel>

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
            <label className="flex items-center gap-2 self-start text-[14px] font-semibold">
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
                <CardHeader hue="navy">
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
                        const desks = desksOfEmployee(e)
                        return (
                          <Row
                            key={e.id}
                            className={cn(
                              'flex-wrap gap-x-4 gap-y-2 py-3',
                              !e.active && 'opacity-60',
                              ((editing !== 'new' && editing?.id === e.id) ||
                                resetFor?.id === e.id) &&
                                'bg-primary-tint/50',
                            )}
                          >
                            <Avatar name={e.fullName} size="md" />
                            <span className="min-w-[min(200px,100%)] flex-1">
                              <span className="block font-semibold">
                                {/* the name opens the employee's file: details and documents */}
                                <button
                                  type="button"
                                  className="text-ink hover:text-primary cursor-pointer rounded border-0 bg-transparent p-0 text-left font-semibold underline-offset-2 hover:underline"
                                  title={t('staffDocs.button')}
                                  aria-expanded={docsFor?.id === e.id}
                                  onClick={() => setDocsFor(e)}
                                >
                                  {e.fullName}
                                </button>
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
                              {desks && (
                                <span className="text-ink-2 block text-xs">
                                  {desksText(desks, t)}
                                </span>
                              )}
                            </span>
                            <Chip>{employeeRole(e, t)}</Chip>
                            {/* 0126: sees patient records (the role, or marked by the manager) */}
                            {(e.role === 'doctor' || e.isDoctor) && (
                              <Badge
                                tone="green"
                                dot={false}
                                icon={<Stethoscope size={12} aria-hidden="true" />}
                              >
                                {t('doctorMark.badge')}
                              </Badge>
                            )}
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
                              {/* the employee's documents: licence, contract… (0116) */}
                              <Button
                                size="sm"
                                variant="tint-blue"
                                aria-expanded={docsFor?.id === e.id}
                                onClick={() => setDocsFor(e)}
                              >
                                <FolderLock size={15} aria-hidden="true" />
                                {t('staffDocs.button')}
                              </Button>
                              {/* one's own PIN is changed from the menu, not reset here */}
                              {!self && (
                                <Button
                                  size="sm"
                                  variant="tint-amber"
                                  onClick={() => openReset(e)}
                                  disabled={!e.active}
                                >
                                  <KeyRound size={15} aria-hidden="true" />
                                  {t('staff.resetPin')}
                                </Button>
                              )}
                              {/* deactivating can be undone: not shown as dangerous as deleting */}
                              <Button
                                size="sm"
                                variant={e.active ? 'tint-amber' : 'tint-mint'}
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

        {/* the employee's document file (0116): licence, contract, ID, certificates… */}
        <SidePanel
          open={docsFor !== null}
          onClose={() => setDocsFor(null)}
          hue="blue"
          icon={FolderLock}
          title={docsFor ? t('staffDocs.of', { name: docsFor.fullName }) : ''}
          subtitle={
            docsFor
              ? [docsFor.staffId, employeeRole(docsFor, t)].filter(Boolean).join(' · ')
              : undefined
          }
        >
          {docsFor && (
            <>
              {/* the employee's file at a glance, above the documents */}
              <div className="border-border bg-surface mb-3 flex items-start gap-3 rounded-md border p-3">
                <Avatar name={docsFor.fullName} size="md" />
                <span className="min-w-0 flex-1 text-[13px]">
                  <span className="text-ink block text-[15px] font-semibold">
                    {docsFor.fullName}
                  </span>
                  <span className="text-ink-3 block tabular-nums">
                    {[
                      docsFor.staffId,
                      employeeRole(docsFor, t),
                      registrationText(docsFor) &&
                        t('staff.registrationShort', { reg: registrationText(docsFor) }),
                      docsFor.username,
                      docsFor.email,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {desksOfEmployee(docsFor) && (
                    <span className="text-ink-2 block">
                      {desksText(desksOfEmployee(docsFor)!, t)}
                    </span>
                  )}
                  <span className="text-ink-3 block">
                    {docsFor.lastSignInAt
                      ? t('staff.lastSignIn', {
                          when: `${formatDate(new Date(docsFor.lastSignInAt))} ${formatTime(new Date(docsFor.lastSignInAt))}`,
                        })
                      : t('staff.neverSignedIn')}
                  </span>
                </span>
                <span className="flex flex-col gap-2">
                  {/* 0125: the whole profile (details, documents, work, access, notes) */}
                  <StaffLink
                    to="/app/staff/profile"
                    search={{ id: docsFor.id }}
                    className={buttonVariants({ size: 'sm', variant: 'primary' })}
                  >
                    <IdCard size={15} aria-hidden="true" />
                    {t('staffProfile.open')}
                  </StaffLink>
                  <Button size="sm" onClick={() => openEdit(docsFor)} disabled={!docsFor.active}>
                    <Pencil size={15} aria-hidden="true" />
                    {t('staff.edit')}
                  </Button>
                </span>
              </div>
              <StaffDocumentsPanel
                key={docsFor.id}
                profileId={docsFor.id}
                name={docsFor.fullName}
              />
            </>
          )}
        </SidePanel>

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
      <CardHeader hue="coral">
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
          <p className="bg-surface text-ink-2 m-0 rounded-md px-3 py-2 text-[14px]">
            {t('staff.delete.deactivatedSince', {
              name,
              date: formatDate(new Date(employee.deactivatedAt)),
              count: daysSince(employee.deactivatedAt),
            })}
          </p>
        )}

        {/* the better option comes first */}
        {employee.active && (
          <div className="border-primary bg-primary-tint flex flex-col gap-2 rounded-md border p-3">
            <span className="text-primary inline-flex items-center gap-2 text-[14px] font-semibold">
              <Lightbulb size={16} aria-hidden="true" />
              {t('staff.delete.recommendTitle')}
            </span>
            <p className="text-ink m-0 text-[14px]">{t('staff.delete.recommendBody')}</p>
            <Button variant="primary" className="self-start" onClick={onDeactivate}>
              <UserX size={16} aria-hidden="true" />
              {t('staff.delete.deactivateInstead')}
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <section className="flex flex-col gap-1.5">
            <h3 className="text-red m-0 text-[14px] font-semibold">
              {t('staff.delete.happensTitle')}
            </h3>
            <ul className="text-ink-2 m-0 flex list-disc flex-col gap-1 pl-5 text-[14px]">
              {happens.map((line) => (
                <li key={line}>{line}</li>
              ))}
              <li className="text-red font-semibold">{t('staff.delete.happens.final')}</li>
            </ul>
          </section>
          <section className="flex flex-col gap-1.5">
            <h3 className="text-green m-0 text-[14px] font-semibold">
              {t('staff.delete.staysTitle')}
            </h3>
            <ul className="text-ink-2 m-0 flex list-disc flex-col gap-1 pl-5 text-[14px]">
              {stays.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        </div>

        {!previewLoading && appointments !== 0 && (
          <p className="border-amber/30 bg-amber-bg text-amber m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-[14px] font-medium">
            <CalendarClock size={16} aria-hidden="true" className="mt-px shrink-0" />
            {appointments == null
              ? t('staff.delete.appointments', { name })
              : t('staff.delete.appointmentsCount', { name, count: appointments })}
          </p>
        )}

        {lastManager && (
          <p role="alert" className={errorBox}>
            {t('staff.errors.lastClinicManager')}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="danger-solid" disabled={lastManager} onClick={onDelete}>
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
      <CardHeader hue="amber">
        <span className="inline-flex items-center gap-2">
          <AlertTriangle size={16} aria-hidden="true" className="text-amber" />
          {t('staff.longDeactivated.title')}
        </span>
        <span className="text-ink-3 text-xs">{people.length}</span>
      </CardHeader>
      <CardBody className="gap-2">
        <p className="text-ink-2 m-0 text-[14px]">{t('staff.longDeactivated.lead')}</p>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {people.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px]">
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
              <Button size="sm" variant="tint-coral" onClick={() => onDelete(e)}>
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
      className="anim-enter fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      <form
        onSubmit={submit}
        className="bg-card border-border anim-dialog flex w-full max-w-[440px] flex-col gap-4 overflow-hidden rounded-xl border p-4 shadow-[0_20px_60px_rgba(11,34,82,.22)]"
      >
        {/* the dialog's header on the staff hue's gradient (clinical blue), white icon chip */}
        <div
          className={cn(
            heroBand('navy'),
            '-mx-4 -mt-4 flex items-center gap-3 px-4 py-3 text-white',
          )}
        >
          <span className="inline-flex size-8 flex-none items-center justify-center rounded bg-white/20 text-white">
            <MailCheck size={18} aria-hidden="true" />
          </span>
          <span>
            <span className="block text-[16px] font-semibold">{t('staff.confirm.title')}</span>
            <span className="text-[14px] text-white/80">{title}</span>
          </span>
        </div>
        <p className="bg-surface text-ink-2 m-0 flex items-center gap-2 rounded-md px-3 py-2 text-[14px]">
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
  assistants,
  self,
  inPanel = false,
  onSubmit,
  onCancel,
}: {
  employee: Employee | null
  departments: Department[]
  takenUsernames: ReadonlySet<string>
  /** Inside the side panel: no card around the fields, Save / Cancel in the panel's footer. */
  inPanel?: boolean
  /** The head of each department now: one head per department (migration 0073). */
  heads: Record<string, Lead>
  /** The assistant head of each department now: one per department (migration 0085). */
  assistants: Record<string, Lead>
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
  // 0128: the PROFESSION (an account still saying 'manager' is a doctor: the database moves it so)
  const [role, setRole] = useState<Profession>(
    employee ? (employee.role === 'manager' ? 'doctor' : employee.role) : 'receptionist',
  )
  // "also the clinic manager"
  const [isManager, setIsManager] = useState(employee?.isManager ?? false)
  // Every department of the employee with the position held there and what they do there (0128,
  // "Does here"); the first is the main one.
  type Line = { departmentId: string; position: Position; services: string[]; doctorHere: boolean }
  const [memberships, setMemberships] = useState<Line[]>(() =>
    (employee?.departments ?? []).map((m) => {
      const d = departments.find((x) => x.id === m.departmentId)
      return {
        departmentId: m.departmentId,
        position: m.position,
        services: d ? doesIn(m, d) : (m.services ?? []),
        doctorHere: m.doctorHere === true,
      }
    }),
  )
  // 0141: "Works as the doctor here": in a department that treats patients, not for the office
  const mayBeDoctorHere = !NON_TREATING_ROLES.includes(role)
  const treatsHere = (d: Department | undefined) =>
    !!d && d.services.some((s) => (TREATING_DESKS as readonly string[]).includes(s))
  const setMembership = (i: number, patch: Partial<Line>) =>
    setMemberships((list) => list.map((m, j) => (j === i ? { ...m, ...patch } : m)))
  const toggleService = (i: number, s: string) =>
    setMemberships((list) =>
      list.map((m, j) =>
        j !== i
          ? m
          : {
              ...m,
              services: m.services.includes(s)
                ? m.services.filter((x) => x !== s)
                : [...m.services, s],
            },
      ),
    )
  const [station, setStation] = useState(employee?.station ?? '')
  // 0128: the specialty from the profession's list, or "Other" typed
  const [spec, setSpec] = useState(() => specialtyChoice(role, employee?.specialty ?? ''))
  const specList = SPECIALTIES[role]
  const specialty = specList
    ? spec.choice === OTHER_SPECIALTY
      ? spec.other.trim()
      : spec.choice
    : spec.other.trim()
  // the professional council number printed on what the person signs (0084; optional, 0128)
  const [registration, setRegistration] = useState(() => registrationStart(employee, role))
  const [language, setLanguage] = useState<DbLang>(employee?.language ?? 'kin')
  const [pin, setPin] = useState(generatePin)
  const [error, setError] = useState<string | null>(null)

  // Only departments that take this profession (a department with none ticked takes all).
  const fitting = departments.filter((d) => takesProfession(d, role, isManager))
  const others = new Set([...takenUsernames].filter((u) => u !== employee?.username))
  const specialtyListId = useId()
  const suggestions = SPECIALTY_SUGGESTIONS[role] ?? []
  // The chosen departments, and what the person does in each, decide the services (and so the
  // patients) that reach this person.
  const chosenLines = memberships
    .map((m) => ({ m, d: departments.find((d) => d.id === m.departmentId) }))
    .filter((x): x is { m: Line; d: Department } => !!x.d)
  const chosenDepts = chosenLines.map((x) => x.d)
  const ticked = chosenLines.map(({ m, d }) => d.services.filter((s) => m.services.includes(s)))
  const services = SECTIONS.filter((s) => ticked.some((list) => list.includes(s)))
  const silent = chosenDepts.filter((d) => d.services.length === 0).map((d) => d.name)
  // with none, the usual desk of the role (a doctor's also follows the specialty and desk name)
  const shown = services.length ? services : usualSections(role, station, specialty)

  // The desks the person will use, live (0085): the profession is the ceiling, what the person does
  // in the chosen departments decides among it; a desk no department gives follows the profession
  // alone, as before. Before 0085 the role decides everything. The clinic manager too (0128).
  const { data: deskMatrix } = useRoleDeskMatrix()
  const ceiling: readonly DeskId[] = deskMatrix?.roles[role] ?? DEFAULT_CEILINGS[role]
  const offered = offeredBy(departments)
  const deskRule = deskMatrix?.fallback
    ? null
    : desksFor({
        role,
        services: ticked,
        ceiling,
        offered,
        // kept on day one while the role stays the same (0085)
        kept: employee && employee.role === role ? employee.keptDesks : null,
      })
  const canUse: DeskId[] = deskRule ? deskRule.desks : ROLE_DESKS[role]
  // desks with no department yet: the role decides them
  const byRoleDesks = deskRule ? canUse.filter((d) => deskRule.via[d] === 'role') : []
  // the role's usual desks that another department gives (not one chosen here)
  // (0128: one a chosen department gives but left unticked is not "elsewhere")
  const elsewhere = deskRule
    ? ROLE_DESKS[role].filter(
        (d) =>
          ceiling.includes(d) &&
          offered.includes(d) &&
          !canUse.includes(d) &&
          !chosenDepts.some((x) => x.services.includes(d)),
      )
    : []
  // a chosen department that gives nothing this role may use; and what the role may not use
  const givesNothing = chosenDepts.filter((d) => departmentGivesNothing(role, d.services, ceiling))
  const notForRole = DESKS.filter((x) =>
    chosenLines.some(
      ({ m, d }) =>
        !givesNothing.includes(d) &&
        desksOutsideCeiling(
          role,
          d.services.filter((s) => m.services.includes(s)),
          ceiling,
        ).includes(x),
    ),
  )
  const roleName = t(`staff.roles.${role}`)
  const deskList = (list: readonly string[]) => list.map((d) => deskName(d, t)).join(', ')

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
    // 0128: at least one thing done in each department that gives services
    const none = chosenLines.find(
      ({ m, d }) => d.services.length > 0 && !d.services.some((s) => m.services.includes(s)),
    )
    if (none) return setError(t('staff.errors.noServiceTicked', { dept: none.d.name }))
    if (spec.choice === OTHER_SPECIALTY && !spec.other.trim())
      return setError(t('staff.errors.specialtyOther'))
    if (isNew && !PIN_RE.test(pin)) return setError(t('staff.errors.pin'))
    const regError = registrationError(registration)
    if (regError) return setError(t(regError))
    onSubmit(
      {
        fullName,
        username,
        email,
        role,
        isManager,
        departments: chosen.map((m) => {
          const d = departments.find((x) => x.id === m.departmentId)
          return {
            departmentId: m.departmentId,
            position: m.position,
            // only what the department gives, in its order
            services: d ? d.services.filter((s) => m.services.includes(s)) : m.services,
            doctorHere: m.doctorHere && treatsHere(d),
          }
        }),
        station,
        language,
        phone,
        specialty,
        ...registrationInput(registration, employee),
      },
      isNew ? pin : undefined,
    )
  }

  const body = (
    <CardBody className={cn('gap-4', inPanel && 'p-0')}>
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
        <div className="flex min-w-0 items-end gap-2">
          <Field
            label={t('staff.form.username')}
            value={username}
            onChange={(e) => {
              setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))
              setUsernameTouched(true)
            }}
            wrapperClassName="min-w-0 flex-1"
            required
          />
          <Button
            type="button"
            className="flex-none"
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
          {/* 0128: the profession; the clinic manager is a tick below */}
          <Select
            label={t('staff.form.profession')}
            value={role}
            onChange={(e) => {
              const r = e.target.value as Profession
              setRole(r)
              setRegistration((v) => registrationForRole(v, r))
              // the specialty follows the new profession's list (what was typed stays as Other)
              setSpec(specialtyChoice(r, specialty))
              // departments that do not take this profession are dropped
              setMemberships((list) =>
                list.filter((m) => {
                  const d = departments.find((x) => x.id === m.departmentId)
                  return !d || takesProfession(d, r, isManager)
                }),
              )
            }}
          >
            {PROFESSIONS.map((r) => (
              <option key={r} value={r}>
                {t(`staff.roles.${r}`)}
              </option>
            ))}
          </Select>
          <p className="text-ink-3 m-0 text-xs">{t(`staff.form.roleDoes.${role}`)}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          {specList ? (
            <>
              <Select
                label={t('staff.form.specialty')}
                value={spec.choice}
                onChange={(e) => setSpec((v) => ({ ...v, choice: e.target.value }))}
              >
                <option value="">{t('staff.form.specialtyNone')}</option>
                {specList.map((s) => (
                  <option key={s} value={s}>
                    {specialtyLabel(s, t)}
                  </option>
                ))}
                <option value={OTHER_SPECIALTY}>{t('staff.form.specialtyOther')}</option>
              </Select>
              {spec.choice === OTHER_SPECIALTY && (
                <Field
                  label={t('staff.form.specialtyOtherLabel')}
                  value={spec.other}
                  placeholder={t('staff.form.specialtyPh')}
                  autoComplete="off"
                  maxLength={80}
                  onChange={(e) => setSpec((v) => ({ ...v, other: e.target.value }))}
                />
              )}
            </>
          ) : (
            <>
              <Field
                label={t('staff.form.specialtyOptional')}
                value={spec.other}
                placeholder={t('staff.form.specialtyPh')}
                list={suggestions.length ? specialtyListId : undefined}
                autoComplete="off"
                maxLength={80}
                onChange={(e) => setSpec({ choice: '', other: e.target.value })}
              />
              {suggestions.length > 0 && (
                <datalist id={specialtyListId}>
                  {suggestions.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              )}
            </>
          )}
          <p
            className={cn(
              'm-0 text-xs',
              role === 'doctor' && !specialty ? 'text-amber font-semibold' : 'text-ink-3',
            )}
          >
            {t(
              role === 'doctor' && !specialty
                ? 'staff.form.specialtyDoctorHint'
                : 'staff.form.specialtyHint',
            )}
          </p>
        </div>
      </div>
      {/* 0128: "also the clinic manager": oversight of the whole clinic, on top of the profession */}
      <label
        className={cn(
          'border-border flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5',
          isManager && 'border-primary bg-primary-tint',
          self && 'cursor-not-allowed opacity-80',
        )}
      >
        <input
          type="checkbox"
          className="accent-primary mt-0.5 size-4.5 flex-none"
          checked={isManager}
          disabled={self}
          onChange={(e) => {
            const on = e.target.checked
            setIsManager(on)
            // a department that takes the clinic managers only (before 0128) is dropped
            if (!on)
              setMemberships((list) =>
                list.filter((m) => {
                  const d = departments.find((x) => x.id === m.departmentId)
                  return !d || takesProfession(d, role, false)
                }),
              )
          }}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[14px] font-semibold">{t('staff.form.isManager')}</span>
          <span className="text-ink-3 text-xs">
            {t(self ? 'staff.form.isManagerSelf' : 'staff.form.isManagerHint')}
          </span>
        </span>
      </label>
      {showsRegistration(role, registration) && (
        <RegistrationField role={role} value={registration} onChange={setRegistration} />
      )}
      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="text-ink-2 mb-1 text-[14px] font-semibold">
          {t('staff.form.departments')}
        </legend>
        <p className="text-ink-3 m-0 -mt-1 text-xs">{t('staff.form.departmentsHint')}</p>
        {memberships.length === 0 && (
          <p className="text-ink-3 m-0 text-xs">{t('staff.form.noDepartmentYet')}</p>
        )}
        {memberships.map((m, i) => {
          const dept = departments.find((d) => d.id === m.departmentId)
          return (
            <div
              key={i}
              className="border-border grid grid-cols-1 items-end gap-3 rounded-md border p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]"
            >
              <Select
                label={i === 0 ? t('staff.form.mainDepartment') : t('staff.form.department')}
                value={m.departmentId}
                onChange={(e) => {
                  // 0128: a department chosen: everything it gives is ticked (untick what they do not do)
                  const d = departments.find((x) => x.id === e.target.value)
                  setMembership(i, {
                    departmentId: e.target.value,
                    services: d ? [...d.services] : [],
                  })
                }}
              >
                <option value="">{t('staff.form.pickDepartment')}</option>
                {fitting
                  .filter(
                    (d) =>
                      d.id === m.departmentId || !memberships.some((x) => x.departmentId === d.id),
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
              {/* 0128: what the person does in this department, among what it gives */}
              {dept && dept.services.length > 0 && (
                <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0 sm:col-span-3">
                  <legend className="text-ink-2 mb-1 text-[13px] font-semibold">
                    {t('staff.form.doesHere')}
                  </legend>
                  <div className="flex flex-wrap gap-2">
                    {dept.services.map((s) => (
                      <label
                        key={s}
                        className={cn(
                          'border-border flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-2.5 text-[13px] font-semibold transition-colors',
                          m.services.includes(s) && 'border-primary bg-primary-tint text-primary',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="accent-primary"
                          checked={m.services.includes(s)}
                          onChange={() => toggleService(i, s)}
                        />
                        {serviceLabel(s, t)}
                      </label>
                    ))}
                  </div>
                  {!dept.services.some((s) => m.services.includes(s)) && (
                    <span role="alert" className="text-red text-xs font-semibold">
                      {t('staff.errors.noServiceTicked', { dept: dept.name })}
                    </span>
                  )}
                </fieldset>
              )}
              {/* 0141: appointed the doctor of this department (every doctor power at its desks) */}
              {mayBeDoctorHere && treatsHere(dept) && (
                <label className="border-border flex items-start gap-3 rounded-md border p-3 sm:col-span-3">
                  <input
                    type="checkbox"
                    className="accent-primary mt-0.5 size-[18px] flex-none"
                    checked={m.doctorHere}
                    onChange={(e) => setMembership(i, { doctorHere: e.target.checked })}
                  />
                  <span>
                    <span className="block text-[14px] font-semibold">
                      {t('staff.form.doctorHere')}
                    </span>
                    <span className="text-ink-3 block text-xs">
                      {t(
                        role === 'doctor'
                          ? 'staff.form.doctorHereIsDoctor'
                          : 'staff.form.doctorHereHint',
                      )}
                    </span>
                  </span>
                </label>
              )}
              {/* one head and one assistant head per department: who this save moves down */}
              {leadChanges(m, employee?.id, heads, assistants, dept?.name ?? '', t).map((line) => (
                <p key={line} className={cn(warnBox, 'sm:col-span-3')}>
                  {line}
                </p>
              ))}
            </div>
          )
        })}
        {fitting.some((d) => !memberships.some((x) => x.departmentId === d.id)) && (
          <Button
            type="button"
            className="self-start"
            onClick={() =>
              setMemberships((list) => [
                ...list,
                { departmentId: '', position: 'member', services: [], doctorHere: false },
              ])
            }
          >
            <Plus size={16} aria-hidden="true" />
            {t(memberships.length ? 'staff.form.addAnotherDepartment' : 'staff.form.addDepartment')}
          </Button>
        )}
        {/* What the chosen departments give this person, live: the desks, then the patients. */}
        <div
          className="bg-surface flex flex-col gap-1 rounded-md px-3 py-2 text-[14px]"
          aria-live="polite"
        >
          <span className="font-semibold">{desksText(canUse, t)}</span>
          {/* 0128: the manager oversees every desk but works only at these */}
          {isManager && (
            <span className="text-primary text-xs font-semibold">
              {t('staff.form.managerDesks')}
            </span>
          )}
          {byRoleDesks.length > 0 && (
            <span className="text-ink-3 text-xs">
              {t('staff.form.desksByRole', { list: deskList(byRoleDesks) })}
            </span>
          )}
          {employee && deskRule && (
            <KeptDesks
              employee={employee}
              desks={canUse.filter((d) => deskRule.via[d] === 'kept')}
            />
          )}
          {elsewhere.length > 0 && (
            <span className="text-amber text-xs font-semibold">
              {t('staff.form.desksElsewhere', { list: deskList(elsewhere) })}
            </span>
          )}
          {notForRole.length > 0 && (
            <span className="text-ink-3 text-xs">
              {t('staff.form.desksNotForRole', { list: deskList(notForRole), role: roleName })}
            </span>
          )}
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
        {givesNothing.length > 0 && (
          <p role="alert" className={warnBox}>
            {t('staff.form.deptGivesNothing', {
              names: givesNothing.map((d) => d.name).join(', '),
              role: roleName,
              list: deskList(givesNothing.flatMap((d) => d.services.filter(isDesk))),
            })}
          </p>
        )}
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
      {!inPanel && (
        <div className="flex gap-2">
          <Button type="submit" variant="primary">
            <ShieldCheck size={16} aria-hidden="true" />
            {isNew ? t('staff.form.create') : t('staff.form.saveChanges')}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('staff.form.cancel')}
          </Button>
        </div>
      )}
    </CardBody>
  )
  if (inPanel)
    return (
      <form id={EMPLOYEE_FORM} onSubmit={submit}>
        {body}
      </form>
    )
  return (
    <Card className="border-primary anim-enter">
      <CardHeader hue="navy">
        <span>
          {isNew ? t('staff.newEmployee') : t('staff.editTitle', { name: employee.fullName })}
        </span>
        {employee?.staffId && (
          <span className="text-ink-3 text-xs tabular-nums">{employee.staffId}</span>
        )}
      </CardHeader>
      <form onSubmit={submit}>{body}</form>
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
    <span className="border-amber/40 bg-amber-bg text-ink inline-flex items-center gap-1.5 rounded-md border py-0.5 pr-1 pl-3 text-[14px]">
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
    <SidePanel
      open
      onClose={onClose}
      hue="blue"
      icon={KeyRound}
      title={t('staff.reset.title', { name: employee.fullName })}
      subtitle={[employee.staffId, employeeRole(employee, t)].filter(Boolean).join(' · ')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('staff.form.cancel')}
          </Button>
          <Button variant="primary" disabled={!PIN_RE.test(pin)} onClick={() => onSubmit(pin)}>
            <ShieldCheck size={16} aria-hidden="true" />
            {t('staff.reset.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-ink-2 m-0 text-[14px]">{t('staff.reset.body')}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field
            label={t('staff.form.pin')}
            inputMode="numeric"
            value={pin}
            autoFocus
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="tracking-[.3em] tabular-nums"
            wrapperClassName="w-48"
          />
          <Button
            type="button"
            variant="tint-grey"
            onClick={() => setPin(generatePin())}
            aria-label={t('staff.form.generate')}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </SidePanel>
  )
}

/* ---------------------------------------------------------------- departments */

function DepartmentsPanel({
  departments,
  employees,
  desksOf,
}: {
  departments: Department[]
  employees: Employee[]
  /** The desks each employee may use now (null: not known). */
  desksOf: (e: Employee) => DeskId[] | null
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
        <p className="text-ink-2 m-0 max-w-[680px] flex-1 text-[14px]">{t('staff.dept.lead')}</p>
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
            losses={(services) =>
              deskLosses(
                editing === 'new' ? null : editing,
                services,
                departments,
                employees,
                desksOf,
              )
            }
            onCancel={() => setEditing(null)}
            onSave={async (d) => {
              const k = d.id ? 'confirm.departments.save' : 'confirm.departments.create'
              // who loses a desk with this save (0085), repeated in the "Are you sure?"
              const lost = deskLosses(
                editing === 'new' ? null : editing,
                d.services,
                departments,
                employees,
                desksOf,
              )
              if (
                !(await confirm({
                  title: t(`${k}.title`, { name: d.name.trim() }),
                  body: <LossBody text={t(`${k}.body`)} lines={lost.map((l) => lossText(l, t))} />,
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
          // one head and one assistant head (0073, 0085); the members may be many
          const head = people.find((e) => positionIn(e, d.id) === 'head')
          const assistant = people.find((e) => positionIn(e, d.id) === 'assistant')
          const members = people
            .filter((e) => e !== head && e !== assistant)
            .sort((a, b) => a.fullName.localeCompare(b.fullName))
          return (
            <Card key={d.id} className="anim-enter" style={{ '--i': i } as React.CSSProperties}>
              <CardHeader hue="navy">
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
                          body: (
                            <LossBody
                              text={t('confirm.departments.delete.body', { count: people.length })}
                              lines={deskLosses(d, null, departments, employees, desksOf).map((l) =>
                                lossText(l, t),
                              )}
                            />
                          ),
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
                {d.description && <p className="text-ink-2 m-0 text-[14px]">{d.description}</p>}
                {/* 0128: the professions that may be placed here */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <b className="text-[14px]">{t('staff.dept.professionsShort')}:</b>
                  {d.roles.length === 0 ? (
                    <Chip>{t('staff.dept.allProfessions')}</Chip>
                  ) : (
                    d.roles.map((r) => (
                      <Chip key={r}>
                        {r === 'manager' ? t('staff.dept.managersRole') : t(`staff.roles.${r}`)}
                      </Chip>
                    ))
                  )}
                </div>
                <p className="m-0 text-[14px]">
                  <b>{t('staff.dept.servicesGivesShort')}:</b>{' '}
                  {d.services.length > 0 ? (
                    d.services.map((s) => serviceLabel(s, t)).join(', ')
                  ) : (
                    <span className="text-ink-3">{t('staff.dept.noServices')}</span>
                  )}
                </p>
                {/* 0128: who does what here: the person, the position, what they do */}
                <div className="flex flex-col gap-1">
                  <b className="text-[14px]">{t('staff.dept.whoDoesWhat')}</b>
                  {!head && (
                    <span className="text-ink-3 text-xs">
                      {t('staff.positions.head')}: {t('staff.dept.noHead')}
                    </span>
                  )}
                  {people.length === 0 ? (
                    <span className="text-ink-3 text-[13px]">{t('staff.dept.noMembers')}</span>
                  ) : (
                    <div className="border-border overflow-x-auto rounded-md border">
                      <table className="w-full border-collapse text-left text-[13px]">
                        <thead className="bg-surface text-ink-2">
                          <tr>
                            <th className="px-2.5 py-1.5 font-semibold">
                              {t('staff.dept.cols.person')}
                            </th>
                            <th className="px-2.5 py-1.5 font-semibold">
                              {t('staff.dept.cols.position')}
                            </th>
                            <th className="px-2.5 py-1.5 font-semibold">
                              {t('staff.dept.cols.does')}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {[head, assistant, ...members]
                            .filter((e): e is Employee => !!e)
                            .map((e) => {
                              const m = e.departments.find((x) => x.departmentId === d.id)
                              const does = m ? doesIn(m, d) : []
                              return (
                                <tr key={e.id} className="border-border border-t align-top">
                                  <td className="px-2.5 py-1.5">
                                    <span className="block font-semibold">{e.fullName}</span>
                                    <span className="text-ink-3 block text-xs">
                                      {employeeRole(e, t)}
                                    </span>
                                  </td>
                                  <td className="px-2.5 py-1.5">
                                    {t(`staff.positions.${positionIn(e, d.id)}`)}
                                  </td>
                                  <td className="px-2.5 py-1.5">
                                    {d.services.length === 0 ? (
                                      <span className="text-ink-3">—</span>
                                    ) : does.length > 0 ? (
                                      does.map((s) => serviceLabel(s, t)).join(', ')
                                    ) : (
                                      <span className="text-red font-semibold">
                                        {t('staff.dept.doesNothing')}
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              )
                            })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
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

/** Desks kept from before departments decided (0085, day one): the manager places the employee in
 *  a department that gives them, or stops one here (asked first; saved at once). */
function KeptDesks({ employee, desks }: { employee: Employee; desks: DeskId[] }) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { forget } = useKeptDeskActions()
  const [error, setError] = useState<string | null>(null)
  if (desks.length === 0) return null
  return (
    <span className="text-amber flex flex-wrap items-center gap-1.5 text-xs font-semibold">
      {t('staff.form.desksKept', { list: desks.map((d) => deskName(d, t)).join(', ') })}
      {desks.map((d) => (
        <Button
          key={d}
          type="button"
          size="sm"
          variant="ghost"
          loading={forget.isPending && forget.variables?.desk === d}
          onClick={async () => {
            const desk = deskName(d, t)
            if (
              !(await confirm({
                title: t('confirm.staff.forgetKept.title', { desk, name: employee.fullName }),
                body: t('confirm.staff.forgetKept.body', { desk, name: employee.fullName }),
                confirmLabel: t('confirm.staff.forgetKept.yes'),
                tone: 'danger',
              }))
            )
              return
            setError(null)
            try {
              await forget.mutateAsync({ profileId: employee.id, desk: d })
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            }
          }}
        >
          {t('staff.form.keptStop', { desk: deskName(d, t) })}
        </Button>
      ))}
      {error && (
        <span role="alert" className="text-red">
          {error}
        </span>
      )}
    </span>
  )
}

/** The "Are you sure?" text, then (in amber) who loses a desk with it (0085). */
function LossBody({ text, lines }: { text: string; lines: string[] }) {
  if (!lines.length) return <>{text}</>
  return (
    <span className="flex flex-col gap-2">
      <span>{text}</span>
      {lines.map((l) => (
        <span key={l} className="text-amber font-semibold">
          {l}
        </span>
      ))}
    </span>
  )
}

function DepartmentForm({
  department,
  losses,
  onSave,
  onCancel,
  saving,
}: {
  department: Department | null
  /** Who loses a desk if the department is saved with these services (0085). */
  losses: (services: readonly string[]) => DeskLoss[]
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
  // The services are also the desks its members use, each as far as their role allows (0085).
  // Reception is a desk only, known once the database has 0085.
  const { data: deskMatrix } = useRoleDeskMatrix()
  const options = DESKS.filter(
    (d) => d !== 'reception' || (deskMatrix && !deskMatrix.fallback) || services.includes(d),
  )
  // the ticked professions that would get no desk at all from these services
  const getNothing = roles.filter(
    (r) =>
      r !== 'manager' &&
      departmentGivesNothing(r, services, deskMatrix?.roles[r] ?? DEFAULT_CEILINGS[r]),
  )
  // 0128: the professions; 'manager' (the clinic managers, before 0128) only while still ticked
  const professionOptions: DbRole[] = [
    ...PROFESSIONS,
    ...(roles.includes('manager') ? (['manager'] as const) : []),
  ]
  return (
    <Card className="border-primary anim-enter">
      <CardHeader hue="navy">
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
            <legend className="text-ink-2 mb-2 text-[14px] font-semibold">
              {t('staff.dept.professions')}
            </legend>
            <div className="flex flex-wrap gap-2">
              {professionOptions.map((r) => (
                <label
                  key={r}
                  className={cn(
                    'border-border flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-[14px] font-semibold transition-colors',
                    roles.includes(r) && 'border-primary bg-primary-tint text-primary',
                  )}
                >
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={roles.includes(r)}
                    onChange={() => toggle(r)}
                  />
                  {r === 'manager' ? t('staff.dept.managersRole') : t(`staff.roles.${r}`)}
                </label>
              ))}
            </div>
            <p className="text-ink-3 m-0 mt-2 text-xs">{t('staff.dept.professionsHint')}</p>
          </fieldset>
          {/* the sections this department works in: its people take the patients sent there */}
          <fieldset className="m-0 border-0 p-0">
            <legend className="text-ink-2 mb-2 text-[14px] font-semibold">
              {t('staff.dept.servicesGives')}
            </legend>
            <div className="flex flex-wrap gap-2">
              {options.map((s) => (
                <label
                  key={s}
                  className={cn(
                    'border-border flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-[14px] font-semibold transition-colors',
                    services.includes(s) && 'border-primary bg-primary-tint text-primary',
                  )}
                >
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={services.includes(s)}
                    onChange={() => toggleService(s)}
                  />
                  {serviceLabel(s, t)}
                </label>
              ))}
            </div>
            <p className="text-ink-3 m-0 mt-2 text-xs">{t('staff.dept.servicesHint')}</p>
            <p className="text-ink-3 m-0 mt-1 text-xs">{t('staff.dept.desksHint')}</p>
            {getNothing.length > 0 && (
              <p className={cn(warnBox, 'mt-2')}>
                {t('staff.dept.rolesGetNothing', {
                  roles: getNothing.map((r) => t(`staff.roles.${r}`)).join(', '),
                })}
              </p>
            )}
            {losses(services).map((l) => (
              <p key={l.desk} className={cn(warnBox, 'mt-2')} role="status">
                {lossText(l, t)}
              </p>
            ))}
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
      <CardHeader hue="navy">
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
        <p className="text-ink-2 m-0 text-[14px]">{t('staff.created.note')}</p>
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
      <span className="text-ink-2 flex min-w-0 flex-1 flex-col gap-1.5 text-[14px] font-semibold">
        {label}
        <span
          className={cn(
            'border-border bg-surface text-ink truncate rounded-md border px-3 py-2 text-[20px] font-semibold',
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

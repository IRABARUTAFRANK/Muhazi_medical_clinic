import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import {
  ArrowLeft,
  BadgeCheck,
  Briefcase,
  CircleAlert,
  ClipboardList,
  FolderLock,
  IdCard,
  KeyRound,
  Lock,
  MonitorSmartphone,
  NotebookPen,
  Pencil,
  Phone,
  ShieldCheck,
  Stethoscope,
  Trash2,
  UserCog,
  UserRound,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatNumber, formatTime, type StaffUser } from '@mmc/shared'
import { GlassAvatar, GlassPill, HeroHead } from '@/components/clinical/hero-head'
import { Hint } from '@/components/dash/kit'
import { PeriodFilter } from '@/components/dash/period-filter'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Flash } from '@/components/ui/flash'
import { Reveal } from '@/components/ui/reveal'
import { Seg } from '@/components/ui/seg'
import { Select } from '@/components/ui/select'
import { useStaffActivityDetail, type ActivityRecord } from '@/lib/api/analytics'
import { deskName } from '@/lib/api/desks'
import {
  CONTRACT_TYPES,
  NOTE_KINDS,
  useStaffProfile,
  useStaffProfileActions,
  type NoteKind,
  type StaffHrInput,
  type StaffProfile,
} from '@/lib/api/staff-profile'
import { useConfirm } from '@/lib/confirm'
import { navForUser } from '@/lib/nav'
import { usePeriod } from '@/lib/period'
import { cn } from '@/lib/utils'
import { DataTable, Quiet, Stat, statGrid } from '@/pages/analytics/kit'
import { kindName } from '@/pages/analytics/format'
import { StaffDocumentsPanel } from './staff-documents'

/*
 * The employee's profile (0125), like the patient's file: a band with the person, then tabs.
 * Overview (identity, role, departments, desks, registration, contact, personal and contract
 * details), Documents (licence, contract, ID, certificates, with their expiry), Work (what they
 * did in a period, from "Who did what"), Access (their rights and exceptions, trusted browsers,
 * sign-ins) and Notes (the manager's private dated notes). The manager opens anyone's (each look
 * is logged) and edits the personnel details here; the role, e-mail, PIN and deactivation stay
 * in the Employees form (they need the e-mailed code). An employee opens their own ("My
 * profile" in the user menu), read only, without the Notes.
 */

type Tab = 'overview' | 'documents' | 'work' | 'access' | 'notes'
const TABS: Tab[] = ['overview', 'documents', 'work', 'access', 'notes']
const TAB_ICON: Record<Tab, typeof UserRound> = {
  overview: UserRound,
  documents: FolderLock,
  work: ClipboardList,
  access: ShieldCheck,
  notes: NotebookPen,
}
const NOTE_TONE: Record<NoteKind, 'blue' | 'green' | 'yellow' | 'red' | 'grey'> = {
  note: 'grey',
  warning: 'red',
  training: 'blue',
  leave: 'yellow',
  praise: 'green',
}
const errorBox =
  'bg-red-bg text-red m-0 border border-red/30 rounded-md px-3 py-2 text-[13px] font-semibold'
const day = (iso: string | null | undefined) => (iso ? formatDate(new Date(iso)) : null)
const when = (iso: string | null | undefined) =>
  iso ? `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}` : null
const initials = (name: string) =>
  name
    .replace(/^Dr\.?\s+/i, '')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()
/** Whole years since a yyyy-mm-dd date. */
const ageOf = (iso: string) => {
  const b = new Date(iso)
  const n = new Date()
  let y = n.getFullYear() - b.getFullYear()
  if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) y -= 1
  return Math.max(0, y)
}
/** Days from today to a yyyy-mm-dd date (negative: past). */
const daysTo = (iso: string) =>
  Math.round((new Date(`${iso}T00:00:00`).getTime() - new Date().setHours(0, 0, 0, 0)) / 86_400_000)

export function StaffProfilePage({
  user,
  profileId,
  initialTab,
}: {
  user: StaffUser
  profileId: string
  initialTab?: string
}) {
  const { t } = useTranslation()
  const { data: p, isLoading, error } = useStaffProfile(profileId)
  const [tab, setTab] = useState<Tab>(
    TABS.includes(initialTab as Tab) ? (initialTab as Tab) : 'overview',
  )
  const tabs = TABS.filter((k) => k !== 'notes' || p?.notes != null)
  const manager = user.role === 'manager'

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId={manager ? 'staff' : undefined}>
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        {manager && (
          <StaffLink
            to="/app/staff"
            className="text-ink-2 inline-flex items-center gap-1 text-[13px] no-underline"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            {t('staffProfile.back')}
          </StaffLink>
        )}
        {isLoading && <div className="skeleton h-[160px] rounded-md" aria-busy="true" />}
        {error && (
          <p role="alert" className={errorBox}>
            {error.message}
          </p>
        )}
        {p && (
          <>
            <Card className="anim-enter">
              <HeroHead icon={IdCard}>
                <GlassAvatar>{initials(p.fullName)}</GlassAvatar>
                <span className="min-w-[min(220px,100%)] flex-1">
                  <span className="block text-[24px] leading-8 font-semibold">{p.fullName}</span>
                  <span className="block text-[13px] text-white/80 tabular-nums">
                    {[p.staffId, roleWords(p, t), p.username].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <GlassPill>{t(p.active ? 'staff.active' : 'staff.deactivated')}</GlassPill>
                {/* 0126: sees patient records */}
                {p.isDoctor && (
                  <GlassPill>
                    <Stethoscope size={13} aria-hidden="true" />
                    {t('doctorMark.badge')}
                  </GlassPill>
                )}
                {p.self && <GlassPill>{t('staffProfile.you')}</GlassPill>}
              </HeroHead>
              <CardBody className="flex-row flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
                <span className="text-ink-2">
                  {p.lastSignInAt
                    ? t('staff.lastSignIn', { when: when(p.lastSignInAt) })
                    : t('staff.neverSignedIn')}
                </span>
                {p.departments.length > 0 && (
                  <span className="text-ink-2">
                    {p.departments
                      .map((d) =>
                        d.position === 'member'
                          ? d.name
                          : `${d.name} (${t(`staff.positions.${d.position}`)})`,
                      )
                      .join(', ')}
                  </span>
                )}
                <span className="flex-1" />
                {p.canEdit && (
                  <StaffLink
                    to="/app/staff"
                    className={buttonVariants({ size: 'sm', variant: 'tint-grey' })}
                    title={t('staffProfile.changeInEmployeesHint')}
                  >
                    <UserCog size={14} aria-hidden="true" />
                    {t('staffProfile.changeInEmployees')}
                  </StaffLink>
                )}
              </CardBody>
              {!p.canEdit && (
                <CardBody className="border-border text-ink-3 flex-row items-center gap-2 border-t py-2 text-[13px]">
                  <Lock size={14} aria-hidden="true" />
                  {t('staffProfile.readOnly')}
                </CardBody>
              )}
            </Card>

            <div
              className="anim-enter border-border bg-surface flex flex-wrap gap-0.5 self-start rounded-md border p-0.5"
              style={{ '--i': 1 } as CSSProperties}
              role="tablist"
            >
              {tabs.map((k) => {
                const Icon = TAB_ICON[k]
                return (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={tab === k}
                    onClick={() => setTab(k)}
                    className={cn(
                      'inline-flex h-8 items-center gap-1.5 rounded border px-3 text-[14px] font-medium transition-colors duration-120',
                      tab === k
                        ? 'border-border bg-card text-primary'
                        : 'text-ink-2 hover:bg-hover border-transparent',
                    )}
                  >
                    <Icon size={14} aria-hidden="true" />
                    {t(`staffProfile.tabs.${k}`)}
                    {k === 'documents' && p.documents.count > 0 && ` · ${p.documents.count}`}
                    {k === 'documents' && p.documents.expired + p.documents.expiring > 0 && ' · ⚠'}
                    {k === 'notes' && p.notes && p.notes.length > 0 && ` · ${p.notes.length}`}
                  </button>
                )
              })}
            </div>

            <div key={tab} className="flex flex-col gap-4">
              {tab === 'overview' && <Overview p={p} />}
              {tab === 'documents' && (
                <Card className="anim-enter">
                  <CardBody>
                    <StaffDocumentsPanel profileId={p.id} name={p.fullName} readOnly={!p.canEdit} />
                  </CardBody>
                </Card>
              )}
              {tab === 'work' && <Work p={p} />}
              {tab === 'access' && <Access p={p} />}
              {tab === 'notes' && p.notes && <Notes p={p} />}
            </div>
          </>
        )}
      </main>
    </StaffShell>
  )
}

type T = (key: string, opts?: Record<string, unknown>) => string
const roleWords = (p: StaffProfile, t: T) => {
  const role = t(`staff.roles.${p.role}`, { defaultValue: p.role })
  return p.specialty && p.specialty.toLowerCase() !== role.toLowerCase()
    ? t('roles.withStation', { role, station: p.specialty })
    : role
}

function Info({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-ink-3 text-[12px] font-medium">{label}</span>
      <span className="text-[14px] font-medium [overflow-wrap:anywhere]">
        {value == null || value === '' ? '—' : value}
      </span>
    </div>
  )
}
const grid = 'grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3'

/** A date that runs out (registration, contract): red when past, amber within 60 days. */
function Expiry({ date }: { date: string | null }) {
  const { t } = useTranslation()
  if (!date) return <>—</>
  const n = daysTo(date)
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {day(date)}
      {n < 0 ? (
        <Badge tone="red">{t('staffProfile.expired')}</Badge>
      ) : n <= 60 ? (
        <Badge tone="yellow">{t('staffProfile.expiresIn', { count: n })}</Badge>
      ) : null}
    </span>
  )
}

function Overview({ p }: { p: StaffProfile }) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const h = p.hr
  const age = h.birthDate ? ageOf(h.birthDate) : null
  return (
    <>
      {notice && (
        <Flash key={notice} onClose={() => setNotice(null)}>
          {notice}
        </Flash>
      )}
      {editing && p.canEdit && (
        <Reveal focus>
          <HrForm
            p={p}
            onDone={() => {
              setEditing(false)
              setNotice(t('staffProfile.saved'))
            }}
            onCancel={() => setEditing(false)}
          />
        </Reveal>
      )}
      <Card className="anim-enter">
        <CardHeader icon={Briefcase} hue="navy">
          <span>{t('staffProfile.sections.work')}</span>
        </CardHeader>
        <CardBody className={grid}>
          <Info label={t('staffProfile.f.role')} value={roleWords(p, t)} />
          <Info label={t('staffProfile.f.staffId')} value={p.staffId} />
          <Info label={t('staffProfile.f.username')} value={p.username} />
          <Info
            label={t('staffProfile.f.departments')}
            value={
              p.departments.length
                ? p.departments
                    .map((d) => `${d.name} · ${t(`staff.positions.${d.position}`)}`)
                    .join(', ')
                : t('staffProfile.noDepartment')
            }
          />
          <Info
            label={t('staffProfile.f.desks')}
            value={p.desks.length ? p.desks.map((d) => deskName(d, t)).join(', ') : null}
          />
          <Info
            label={t('staffProfile.f.registration')}
            value={
              p.registrationNo
                ? [p.registrationBody, p.registrationNo].filter(Boolean).join(' · ')
                : null
            }
          />
          <Info
            label={t('staffProfile.f.registrationExpires')}
            value={<Expiry date={h.registrationExpiresOn} />}
          />
        </CardBody>
      </Card>

      <DoctorCard p={p} />

      <Card className="anim-enter" style={{ '--i': 1 } as CSSProperties}>
        <CardHeader icon={Phone} hue="teal">
          <span>{t('staffProfile.sections.contact')}</span>
          {p.canEdit && !editing && (
            <Button size="sm" onClick={() => setEditing(true)}>
              <Pencil size={14} aria-hidden="true" />
              {t('staffProfile.edit')}
            </Button>
          )}
        </CardHeader>
        <CardBody className={grid}>
          <Info label={t('staffProfile.f.email')} value={p.email} />
          <Info label={t('staffProfile.f.phone')} value={p.phone} />
          <Info
            label={t('staffProfile.f.emergency')}
            value={[h.emergencyName, h.emergencyPhone].filter(Boolean).join(' · ') || null}
          />
          <Info label={t('staffProfile.f.address')} value={h.address} />
          <Info
            label={t('staffProfile.f.birthDate')}
            value={
              h.birthDate
                ? `${day(h.birthDate)}${age != null ? ` · ${t('staffProfile.age', { count: age })}` : ''}`
                : null
            }
          />
          <Info
            label={t('staffProfile.f.sex')}
            value={h.sex ? t(`register.sexes.${h.sex}`) : null}
          />
          <Info label={t('staffProfile.f.nationalId')} value={h.nationalId} />
        </CardBody>
        <CardBody className="border-border border-t py-2">
          <Hint>{t('staffProfile.privateHint')}</Hint>
        </CardBody>
      </Card>

      <Card className="anim-enter" style={{ '--i': 2 } as CSSProperties}>
        <CardHeader icon={BadgeCheck} hue="violet">
          <span>{t('staffProfile.sections.employment')}</span>
        </CardHeader>
        <CardBody className={grid}>
          <Info label={t('staffProfile.f.hiredOn')} value={day(h.hiredOn)} />
          <Info
            label={t('staffProfile.f.contractType')}
            value={h.contractType ? t(`staffProfile.contracts.${h.contractType}`) : null}
          />
          <Info label={t('staffProfile.f.contractEnd')} value={<Expiry date={h.contractEnd} />} />
          <Info
            label={t('staffProfile.f.status')}
            value={
              p.active
                ? t('staff.active')
                : `${t('staff.deactivated')}${p.deactivatedAt ? ` · ${day(p.deactivatedAt)}` : ''}`
            }
          />
          <Info
            label={t('staffProfile.f.created')}
            value={[day(p.createdAt), p.createdBy].filter(Boolean).join(' · ')}
          />
          <Info
            label={t('staffProfile.f.updated')}
            value={
              h.updatedAt ? [when(h.updatedAt), h.updatedBy].filter(Boolean).join(' · ') : null
            }
          />
        </CardBody>
      </Card>
    </>
  )
}

/** The manager writes the personnel details (save_staff_profile; audited). */
/**
 * 0126: patient records are for doctors. The manager marks an employee (or himself) a doctor, with
 * the registration number of the medical council; a doctor by role is one anyway. Audited (History)
 * and told to the other managers.
 */
function DoctorCard({ p }: { p: StaffProfile }) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { setDoctor } = useStaffProfileActions(p.id)
  const byRole = p.role === 'doctor'
  const on = !!p.isDoctor
  const [form, setForm] = useState(false)
  // a nurse's or a pharmacist's council number is not a doctor's: start empty unless it is RMDC
  const medical = !p.registrationBody || /rmdc|medical/i.test(p.registrationBody)
  const [no, setNo] = useState(medical ? (p.registrationNo ?? '') : '')
  const [body, setBody] = useState(medical ? (p.registrationBody ?? 'RMDC') : 'RMDC')
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  // a database before 0126 says nothing about it
  if (p.isDoctor === undefined) return null
  const turnOn = async (e: FormEvent) => {
    e.preventDefault()
    if (no.trim().length < 3) {
      setErr(t('doctorMark.numberNeeded'))
      return
    }
    if (
      !(await confirm({
        title: t('doctorMark.confirmOn', { name: p.fullName }),
        body: t('doctorMark.confirmOnBody'),
        confirmLabel: t('doctorMark.confirmOnYes'),
      }))
    )
      return
    setErr(null)
    try {
      await setDoctor.mutateAsync({ on: true, registrationNo: no, registrationBody: body })
      setForm(false)
      setDone(t('doctorMark.doneOn', { name: p.fullName }))
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x))
    }
  }
  const turnOff = async () => {
    if (
      !(await confirm({
        title: t('doctorMark.confirmOff', { name: p.fullName }),
        body: t('doctorMark.confirmOffBody'),
        confirmLabel: t('doctorMark.confirmOffYes'),
        tone: 'danger',
      }))
    )
      return
    setErr(null)
    try {
      await setDoctor.mutateAsync({ on: false, registrationNo: '', registrationBody: '' })
      setDone(t('doctorMark.doneOff', { name: p.fullName }))
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x))
    }
  }
  const editable = p.canEdit && !byRole
  return (
    <Card className="anim-enter">
      <CardHeader icon={Stethoscope} hue="violet">
        <span>{t('doctorMark.title')}</span>
        {on && (
          <Badge tone="green" icon={<Stethoscope size={12} aria-hidden="true" />}>
            {t('doctorMark.badge')}
          </Badge>
        )}
      </CardHeader>
      <CardBody className="gap-3">
        {done && (
          <Flash key={done} onClose={() => setDone(null)}>
            {done}
          </Flash>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={on}
          disabled={!editable || setDoctor.isPending}
          onClick={() => (on ? void turnOff() : setForm((f) => !f))}
          className="flex min-w-0 items-start gap-3 text-left disabled:cursor-default"
        >
          <span
            className={cn(
              'relative mt-0.5 inline-flex h-6 w-11 flex-none items-center rounded-full border transition-colors',
              on ? 'border-primary bg-primary' : 'border-border bg-hover',
              !editable && 'opacity-60',
            )}
          >
            <span
              className={cn(
                'bg-card absolute top-0.5 size-[18px] rounded-full shadow transition-transform',
                on ? 'translate-x-[22px]' : 'translate-x-0.5',
              )}
            />
          </span>
          <span className="min-w-0">
            <span className="text-ink block text-[16px] font-semibold">
              {t('doctorMark.switch')}
            </span>
            <span className="text-ink-2 block text-[14px]">
              {byRole
                ? t('doctorMark.byRole')
                : on
                  ? t('doctorMark.onHint', {
                      number:
                        [p.registrationBody, p.registrationNo].filter(Boolean).join(' · ') || '—',
                    })
                  : t('doctorMark.offHint')}
            </span>
          </span>
        </button>
        {form && editable && !on && (
          <Reveal focus>
            <form
              onSubmit={(e) => void turnOn(e)}
              className="border-violet/40 bg-violet-bg/40 flex flex-col gap-3 rounded-md border p-3"
            >
              <p className="text-ink-2 m-0 text-[14px]">{t('doctorMark.formLead')}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field
                  label={t('doctorMark.number')}
                  value={no}
                  required
                  minLength={3}
                  maxLength={60}
                  placeholder="RMDC/A/2019/0457"
                  onChange={(e) => setNo(e.target.value)}
                />
                <Field
                  label={t('doctorMark.body')}
                  value={body}
                  maxLength={60}
                  placeholder="RMDC"
                  onChange={(e) => setBody(e.target.value)}
                />
              </div>
              <span className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" loading={setDoctor.isPending}>
                  <Stethoscope size={16} aria-hidden="true" />
                  {t('doctorMark.save')}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setForm(false)}>
                  {t('staff.form.cancel')}
                </Button>
              </span>
            </form>
          </Reveal>
        )}
        {err && (
          <p role="alert" className={errorBox}>
            {err}
          </p>
        )}
        <p className="text-ink-3 m-0 text-[13px]">{t('doctorMark.what')}</p>
      </CardBody>
    </Card>
  )
}

function HrForm({
  p,
  onDone,
  onCancel,
}: {
  p: StaffProfile
  onDone: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const { save } = useStaffProfileActions(p.id)
  const confirm = useConfirm()
  const h = p.hr
  const [f, setF] = useState<StaffHrInput>({
    phone: p.phone ?? '',
    emergencyName: h.emergencyName ?? '',
    emergencyPhone: h.emergencyPhone ?? '',
    address: h.address ?? '',
    birthDate: h.birthDate ?? '',
    sex: h.sex ?? '',
    nationalId: h.nationalId ?? '',
    hiredOn: h.hiredOn ?? '',
    contractType: h.contractType ?? '',
    contractEnd: h.contractEnd ?? '',
    registrationExpiresOn: h.registrationExpiresOn ?? '',
  })
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof StaffHrInput) => (v: string) => setF((x) => ({ ...x, [k]: v }))
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (
      !(await confirm({
        title: t('staffProfile.confirmSave', { name: p.fullName }),
        body: t('staffProfile.confirmSaveBody'),
        confirmLabel: t('staffProfile.save'),
      }))
    )
      return
    try {
      await save.mutateAsync(f)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const field = (k: keyof StaffHrInput, label: string, type = 'text', extra = {}) => (
    <Field
      label={label}
      type={type}
      value={f[k]}
      onChange={(e) => set(k)(e.target.value)}
      {...extra}
    />
  )
  return (
    <Card>
      <CardHeader icon={Pencil} hue="amber">
        <span>{t('staffProfile.editTitle', { name: p.fullName })}</span>
      </CardHeader>
      <CardBody>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {field('phone', t('staffProfile.f.phone'), 'tel', { maxLength: 20 })}
            {field('emergencyName', t('staffProfile.f.emergencyName'), 'text', { maxLength: 120 })}
            {field('emergencyPhone', t('staffProfile.f.emergencyPhone'), 'tel', { maxLength: 20 })}
            {field('address', t('staffProfile.f.address'), 'text', { maxLength: 300 })}
            {field('birthDate', t('staffProfile.f.birthDate'), 'date')}
            <Select
              label={t('staffProfile.f.sex')}
              value={f.sex}
              onChange={(e) => set('sex')(e.target.value)}
            >
              <option value="">—</option>
              <option value="female">{t('register.sexes.female')}</option>
              <option value="male">{t('register.sexes.male')}</option>
            </Select>
            {field('nationalId', t('staffProfile.f.nationalId'), 'text', { maxLength: 40 })}
            {field('hiredOn', t('staffProfile.f.hiredOn'), 'date')}
            <Select
              label={t('staffProfile.f.contractType')}
              value={f.contractType}
              onChange={(e) => set('contractType')(e.target.value)}
            >
              <option value="">—</option>
              {CONTRACT_TYPES.map((c) => (
                <option key={c} value={c}>
                  {t(`staffProfile.contracts.${c}`)}
                </option>
              ))}
            </Select>
            {field('contractEnd', t('staffProfile.f.contractEnd'), 'date')}
            {field('registrationExpiresOn', t('staffProfile.f.registrationExpires'), 'date')}
          </div>
          <Hint>{t('staffProfile.codeFieldsHint')}</Hint>
          {error && (
            <p role="alert" className={errorBox}>
              {error}
            </p>
          )}
          <span className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={save.isPending}>
              {t('staffProfile.save')}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t('staff.form.cancel')}
            </Button>
          </span>
        </form>
      </CardBody>
    </Card>
  )
}

/** What the person did in a period (staff_activity_detail; the person's own, or the manager). */
function Work({ p }: { p: StaffProfile }) {
  const { t } = useTranslation()
  const period = usePeriod('month')
  const q = useStaffActivityDetail(p.id, { from: period.from, to: period.to })
  const d = q.data
  const counts = Object.entries(d?.counts ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
  return (
    <Card className="anim-enter">
      <CardHeader icon={ClipboardList} hue="teal">
        <span>{t('staffProfile.workTitle', { period: period.label })}</span>
      </CardHeader>
      <CardBody className="gap-4">
        <PeriodFilter period={period} />
        {q.error && <p className={errorBox}>{(q.error as Error).message}</p>}
        {!d && !q.error && <div className="skeleton h-[160px] rounded-md" aria-busy="true" />}
        {d && (
          <>
            <div className={statGrid}>
              {counts.length === 0 && <Quiet>{t('analytics.staff.nothing')}</Quiet>}
              {counts.slice(0, 8).map(([k, n]) => (
                <Stat key={k} icon={ClipboardList} label={kindName(k, t)} value={formatNumber(n)} />
              ))}
            </div>
            <DataTable<ActivityRecord>
              rows={d.records}
              rowKey={(r) => `${r.at}-${r.kind}-${r.encounterId ?? ''}-${r.what ?? ''}`}
              pageSize={15}
              cols={[
                {
                  key: 'at',
                  label: t('report.cols.when'),
                  cell: (r) => (
                    <span className="flex flex-col whitespace-nowrap">
                      {when(r.at)}
                      <span className="text-ink-3 text-[12px]">{kindName(r.kind, t)}</span>
                    </span>
                  ),
                  sort: (r) => r.at,
                },
                {
                  key: 'patient',
                  label: t('analytics.patient'),
                  cell: (r) => (
                    <span className="flex min-w-0 flex-col">
                      <span className="[overflow-wrap:anywhere]">
                        {r.patientName ?? (r.patientId ? t('analytics.staff.hidden') : '—')}
                      </span>
                      <span className="text-ink-3 text-[12px] [overflow-wrap:anywhere]">
                        {[r.fileNumber, r.what].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  ),
                },
              ]}
              empty={<Quiet>{t('analytics.staff.nothing')}</Quiet>}
              caption={t('analytics.staff.recordsTitle')}
            />
          </>
        )}
      </CardBody>
    </Card>
  )
}

function Access({ p }: { p: StaffProfile }) {
  const { t } = useTranslation()
  const a = p.access
  return (
    <>
      <div className={statGrid}>
        <Stat
          icon={KeyRound}
          label={t('staffProfile.access.role')}
          value={t(`staff.roles.${p.role}`, { defaultValue: p.role })}
          tint="navy"
        />
        <Stat
          icon={MonitorSmartphone}
          label={t('staffProfile.access.devices')}
          value={formatNumber(a.trustedDevices)}
          note={t('staffProfile.access.devicesNote')}
        />
        <Stat
          icon={CircleAlert}
          label={t('staffProfile.access.failed')}
          value={formatNumber(a.failedSignIns30)}
          tone={a.failedSignIns30 > 0 ? 'red' : undefined}
        />
        <Stat
          icon={KeyRound}
          label={t('staffProfile.access.pin')}
          value={t(p.mustChangePin ? 'staff.pinPending' : 'staffProfile.access.pinSet')}
          note={p.pinChangedAt ? day(p.pinChangedAt) : undefined}
        />
      </div>
      <Card className="anim-enter">
        <CardHeader icon={ShieldCheck} hue="navy">
          <span>{t('staffProfile.access.rights')}</span>
          {p.canEdit && (
            <StaffLink
              to="/app/settings"
              className={buttonVariants({ size: 'sm', variant: 'tint-grey' })}
            >
              {t('staffProfile.access.changeRights')}
            </StaffLink>
          )}
        </CardHeader>
        {a.permissions.map((x) => (
          <Row key={x.key} className="flex-wrap gap-x-3 gap-y-1 py-2">
            <span className="min-w-[200px] flex-1">
              <span className="block font-semibold">{t(`perms.f.${x.key}.name`)}</span>
              <span className="text-ink-3 block text-[12px]">{t(`perms.f.${x.key}.hint`)}</span>
            </span>
            {x.exception && (
              <Badge tone="blue" dot={false}>
                {t('staffProfile.access.exception', {
                  by: x.setBy ?? '',
                  when: day(x.setAt) ?? '',
                })}
              </Badge>
            )}
            <Badge tone={x.allowed ? 'green' : 'grey'}>
              {t(x.allowed ? 'perms.allowed' : 'perms.notAllowed')}
            </Badge>
          </Row>
        ))}
      </Card>
      <Card className="anim-enter">
        <CardHeader icon={KeyRound} hue="teal">
          <span>{t('staffProfile.access.signIns')}</span>
        </CardHeader>
        {a.signIns.length === 0 && (
          <CardBody>
            <Quiet>{t('analytics.staff.noSignIns')}</Quiet>
          </CardBody>
        )}
        {a.signIns.map((s, i) => (
          <Row key={`${s.at}-${i}`} className="gap-3 py-2">
            <span className="flex-1 tabular-nums">{when(s.at)}</span>
            {s.ok ? (
              <Badge tone="green">{t('analytics.staff.signInOk')}</Badge>
            ) : (
              <Badge tone="red">{s.reason ?? t('dashboard.failedLogin')}</Badge>
            )}
          </Row>
        ))}
      </Card>
    </>
  )
}

/** The manager's private dated notes on the employee (warnings, training, leave…). */
function Notes({ p }: { p: StaffProfile }) {
  const { t } = useTranslation()
  const { addNote, removeNote } = useStaffProfileActions(p.id)
  const confirm = useConfirm()
  const [kind, setKind] = useState<NoteKind>('note')
  const [body, setBody] = useState('')
  const [notedOn, setNotedOn] = useState(new Date().toISOString().slice(0, 10))
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (body.trim().length < 3) return setError(t('staffProfile.notes.needBody'))
    try {
      await addNote.mutateAsync({ kind, body, notedOn })
      setBody('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const remove = async (id: string) => {
    const r = await confirm({
      title: t('staffProfile.notes.removeTitle'),
      body: t('staffProfile.notes.removeBody'),
      input: { label: t('staffProfile.notes.removeWhy'), required: true },
      confirmLabel: t('staffProfile.notes.removeYes'),
      tone: 'danger',
    })
    if (!r.ok) return
    try {
      await removeNote.mutateAsync({ id, reason: r.value })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <>
      <Card className="anim-enter">
        <CardHeader icon={NotebookPen} hue="amber">
          <span>{t('staffProfile.notes.add')}</span>
        </CardHeader>
        <CardBody>
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
            <Seg
              label={t('staffProfile.notes.kind')}
              value={kind}
              onChange={setKind}
              options={NOTE_KINDS.map((k) => ({
                value: k,
                label: t(`staffProfile.notes.kinds.${k}`),
              }))}
              className="self-start"
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[170px_minmax(0,1fr)]">
              <Field
                label={t('staffProfile.notes.date')}
                type="date"
                value={notedOn}
                onChange={(e) => setNotedOn(e.target.value)}
              />
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
                {t('staffProfile.notes.body')}
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={body}
                  placeholder={t('staffProfile.notes.bodyPh')}
                  onChange={(e) => setBody(e.target.value)}
                  className="border-border bg-card focus:border-primary rounded-md border px-2.5 py-2 text-[14px] font-normal outline-none"
                />
              </label>
            </div>
            <Hint>{t('staffProfile.notes.privateHint')}</Hint>
            {error && (
              <p role="alert" className={errorBox}>
                {error}
              </p>
            )}
            <Button
              type="submit"
              variant="primary"
              className="self-start"
              loading={addNote.isPending}
            >
              {t('staffProfile.notes.save')}
            </Button>
          </form>
        </CardBody>
      </Card>
      <Card className="anim-enter">
        <CardHeader icon={NotebookPen} hue="navy">
          <span>{t('staffProfile.notes.title')}</span>
          <span className="text-ink-3 text-[13px]">{p.notes?.length ?? 0}</span>
        </CardHeader>
        {(p.notes ?? []).length === 0 && (
          <CardBody>
            <Quiet>{t('staffProfile.notes.none')}</Quiet>
          </CardBody>
        )}
        {(p.notes ?? []).map((n) => (
          <Row key={n.id} className="items-start gap-3 py-2.5">
            <Badge tone={NOTE_TONE[n.kind]}>{t(`staffProfile.notes.kinds.${n.kind}`)}</Badge>
            <span className="min-w-0 flex-1">
              <span className="block whitespace-pre-wrap">{n.body}</span>
              <span className="text-ink-3 block text-[12px]">
                {[day(n.notedOn), n.by && t('staffProfile.notes.by', { name: n.by })]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('staffProfile.notes.removeTitle')}
              onClick={() => void remove(n.id)}
            >
              <Trash2 size={15} aria-hidden="true" />
            </Button>
          </Row>
        ))}
        {(p.removedNotes ?? 0) > 0 && (
          <CardBody className="text-ink-3 text-[12px]">
            {t('staffProfile.notes.removed', { count: p.removedNotes ?? 0 })}
          </CardBody>
        )}
      </Card>
    </>
  )
}

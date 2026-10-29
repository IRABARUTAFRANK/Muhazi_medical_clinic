import { useState, type CSSProperties, type FormEvent } from 'react'
import {
  Activity,
  ArrowLeft,
  Check,
  FileText,
  FlaskConical,
  FolderOpen,
  Footprints,
  HeartPulse,
  IdCard,
  Lock,
  Pencil,
  Plus,
  Receipt,
  Stethoscope,
  Ticket,
  UserRound,
  X,
} from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf, formatTime, type StaffUser } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { EmptyNote } from '@/components/clinical/empty-note'
import { Reveal } from '@/components/ui/reveal'
import { Button, buttonVariants } from '@/components/ui/button'
import { GlassAvatar, GlassPill, HeroHead } from '@/components/clinical/hero-head'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
import { Seg } from '@/components/ui/seg'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  ageSexOf,
  usePatientActions,
  usePatientFile,
  type PatientFile,
  type PatientRecord,
  usePatientFields,
  type PatientFieldDef,
  setNoNationalId,
  type NoIdReason,
  usePatientResults,
  allergiesForDoc,
} from '@/lib/api/patients'
import { registrationText, useMyCredentials } from '@/lib/api/staff'
import { type VisitResult } from '@/lib/api/visits'
import { useDeskOps } from '@/lib/api/desk-ops'
import { useStaffSettings } from '@/lib/api/settings'
import { VisitJourney } from '@/components/clinical/visit-journey'
import { VisitTrack } from '@/components/clinical/visit-track'
import { navForUser } from '@/lib/nav'
import { ShownList } from '@/components/ui/list-tools'
import { Flash } from '@/components/ui/flash'
import { canRegisterEmergency } from '@/lib/roles'
import { cn } from '@/lib/utils'
import { SendPatientCard } from '@/components/clinical/send-patient-card'
import { useCan } from '@/lib/api/permissions'
import { openMedicalReport } from '@/lib/medical-report'
import { useLetterhead, useMedicalReportLabels } from '@/lib/report-parts'
import { roleLabel } from '@/lib/roles'
import { useConfirm } from '@/lib/confirm'
import {
  PrivacyNotice,
  SafetyHiddenNote,
  SafetySummaryCard,
  WhoLookedCard,
} from '@/components/clinical/record-privacy'
import { privacyNoticeShown, privacyOn } from '@/components/clinical/record-privacy-rules'
import { PatientFilesSection } from '@/components/clinical/supporting-files'
import { MergeCard } from './merge-card'
import { vitalName } from '@/lib/api/vitals'
import {
  CoreFields,
  DetailFields,
  type SetDraft,
} from '@/components/clinical/patient-details-fields'
import { useFieldSettings, useMissingLabel } from '@/components/clinical/use-field-settings'
import {
  NO_ID_KINDS,
  asFile,
  draftOf,
  draftPayload,
  draftProblem,
  fileMissing,
  groupNationalId,
  idKindOf,
  requiredMissing,
  type PatientDraft,
} from '@/lib/patient-rules'

type Tab = 'overview' | 'visits' | 'clinical' | 'files' | 'bills'
const TABS: Tab[] = ['overview', 'visits', 'clinical', 'files', 'bills']
const errorBox =
  'bg-red-bg text-red m-0 border border-red/30 rounded-md px-3 py-2 text-[13px] font-semibold'

/**
 * The patient file. Header with identity, allergies and the current visit; tabs for the
 * editable overview, visit history, clinical record (vitals and diagnoses) and bills.
 * Starting a visit from here follows the same rule as registration: triage first, unless
 * it is an emergency.
 */
/** Whole years since a YYYY-MM-DD date. */
const ageOf = (iso: string) => {
  const b = new Date(iso)
  const n = new Date()
  let y = n.getFullYear() - b.getFullYear()
  if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) y -= 1
  return Math.max(0, y)
}

export function PatientFilePage({
  user,
  patientId,
  initialTab,
  embedded = false,
}: {
  user: StaffUser
  patientId: string
  initialTab?: string
  /**
   * Inside the side panel (file-panel.tsx): no shell, no back link, no name block (the panel's
   * header shows name, file number, age and sex), tabs as a segmented control, 16 px gaps.
   */
  embedded?: boolean
}) {
  const { t } = useTranslation()
  const { data, isLoading, error } = usePatientFile(patientId)
  const [tab, setTab] = useState<Tab>(
    TABS.includes(initialTab as Tab) ? (initialTab as Tab) : 'overview',
  )
  // "complete" comes from reception's "Files to complete" list: open the form straight away.
  const [editing, setEditing] = useState(initialTab === 'complete')
  const deskOps = useDeskOps()
  const confirm = useConfirm()
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [emergency, setEmergency] = useState(false)
  const navigate = useNavigate()

  const openVisit = data?.visits.find((v) => v.status === 'open')
  const [confirming, setConfirming] = useState(false)
  const mayStart = useCan(user)('visit.start')
  const mayVitals = useCan(user)('vitals.write')
  // The medical report holds diagnoses: clinicians and the manager only.
  const mayReport = user.role === 'doctor' || user.role === 'nurse' || user.role === 'manager'
  const letterhead = useLetterhead()
  const reportLabels = useMedicalReportLabels()
  const { data: allResults = [] } = usePatientResults(patientId)
  // the signer's specialty and council registration (nulls on a database before 0084)
  const { data: creds } = useMyCredentials(user.id)
  const printHistory = () => {
    if (!data) return
    const p = data.patient
    // insurer, member number and last weight (absent on a database before 0084)
    const doc = data.document
    // only the visits this person may see (0088); the others are said, not printed
    const visits = [...data.visits]
      .filter((v) => !v.private)
      .sort((a, b) => b.arrivedAt.localeCompare(a.arrivedAt))
    const hidden = data.visits.length - visits.length
    const ok = openMedicalReport(
      {
        kind: 'history',
        clinic: letterhead,
        patient: {
          name: `${p.surname} ${p.given_names}`,
          fileNumber: p.file_number,
          // only read when the birth date and sex are missing
          ageSex: [p.birth_date ? `${ageOf(p.birth_date)}` : null, t(`register.sexes.${p.sex}`)]
            .filter(Boolean)
            .join(' · '),
          birthDate: p.birth_date,
          sex: t(`register.sexes.${p.sex}`),
          phone: p.phone_1,
          insurer: doc?.insurer ?? null,
          memberNo: doc?.memberNo ?? null,
          weightKg: doc?.weightKg ?? null,
          allergies: allergiesForDoc({
            allergies: p.allergies,
            allergiesNone: p.allergies_none ?? doc?.allergiesNone,
          }),
          bloodGroup: p.blood_group,
        },
        visits: visits.map((v) => {
          // the latest value of each vital sign of that visit
          const seen = new Set<string>()
          const latest = data.vitals
            .filter((x) => x.encounterId === v.id)
            .sort((a, b) => b.at.localeCompare(a.at))
            .filter((x) => !seen.has(x.code) && seen.add(x.code))
          const vitals = latest.map((x) => ({
            label: t(`triage.vitals.${x.code}`, { defaultValue: x.code }),
            value: `${x.value ?? x.text ?? ''}${x.unit ? ` ${x.unit}` : ''}`,
            code: x.code,
            unit: x.unit,
          }))
          // who measured, and when: the most recent measurement of the visit
          const measured = latest[0]
          return {
            date: formatDate(new Date(v.arrivedAt)),
            at: v.arrivedAt,
            reference: v.reference ?? null,
            doctor: v.practitioner,
            desks: v.stations.map((s) => t(`register.stations.${s}`, { defaultValue: s })),
            vitals,
            vitalsBy: measured?.by ?? null,
            vitalsAt: measured?.at ?? null,
            notes: [],
            diagnoses: data.conditions
              .filter((c) => c.encounterId === v.id)
              .map((c) => ({
                text: c.text,
                icd10: c.icd10,
                primary: c.type === 'primary',
                provisional: c.provisional,
              })),
            tests: allResults
              .filter((r) => r.encounterId === v.id)
              .map((r) => ({
                name: r.test,
                findings: r.findings,
                impression: r.impression,
                verified: r.verified,
              })),
            treatments: [],
            medicines: [],
          }
        }),
        comment: hidden > 0 ? t('recordPrivacy.printHidden', { count: hidden }) : null,
        author: {
          name: user.name,
          title: creds?.specialty || roleLabel(user, t),
          registrationNo: registrationText(creds),
        },
        printedBy: user.name,
      },
      reportLabels,
    )
    if (!ok) setActionError(t('report.popupBlocked'))
  }
  const { data: staffSettings } = useStaffSettings()
  const lastVisit = [...(data?.visits ?? [])].sort((a, b) =>
    b.arrivedAt.localeCompare(a.arrivedAt),
  )[0]
  const p = data?.patient
  // what the file still needs: the clinic's settings (0108), as patient_missing() says it
  const { states: fieldStates, defs: fieldDefs } = useFieldSettings()
  const missingLabel = useMissingLabel()
  const missing = p ? fileMissing(p, fieldStates, fieldDefs) : []
  const atReception = openVisit?.currentStation === 'reception'

  const sendToDoctor = async () => {
    if (!openVisit || !p) return
    if (
      !(await confirm({
        title: t('confirm.desks.patient.sendToDoctor', { name: `${p.surname} ${p.given_names}` }),
        body: t('confirm.desks.patient.sendToDoctorBody'),
        confirmLabel: t('confirm.desks.patient.sendToDoctorYes'),
      }))
    )
      return
    setActionError(null)
    try {
      await deskOps.sendOn.mutateAsync({
        encounterId: openVisit.id,
        from: 'reception',
        to: 'consultation',
      })
      setNotice(t('files.sentToDoctor'))
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
  }

  // Register first, then send: the visit starts where the patient's need is (or with me).
  const started = (r: VisitResult) => {
    setConfirming(false)
    if (r.myself)
      void navigate({
        to: r.station === 'triage' && mayVitals ? '/app/vitals' : '/app/visit',
        search: { encounter: r.encounterId },
      })
    else
      setNotice(
        t('file.visitStarted', {
          ticket: r.ticketNo,
          station: t(`register.stations.${r.station}`),
        }),
      )
  }

  const body = (
    <>
      {!embedded && (
        <StaffLink
          to="/app/patients"
          className="text-ink-2 inline-flex items-center gap-1 text-[13px] no-underline"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          {t('file.back')}
        </StaffLink>
      )}
      {isLoading && <p className="text-ink-3 m-0">…</p>}
      {error && (
        <p role="alert" className={errorBox}>
          {error.message}
        </p>
      )}
      {actionError && (
        <Flash key={actionError} tone="error" onClose={() => setActionError(null)}>
          {actionError}
        </Flash>
      )}
      {!actionError && notice && (
        <Flash key={notice} onClose={() => setNotice(null)}>
          {notice}
        </Flash>
      )}

      {data && p && (
        <>
          {/* Header */}
          <Card className="anim-enter">
            {/* The person's band (the side panel's header already names them when embedded):
                initials, name and details on the clinic's gradient, the tags as glass pills. */}
            {!embedded && (
              <HeroHead icon={UserRound}>
                <GlassAvatar>{initials(p)}</GlassAvatar>
                <span className="min-w-[min(220px,100%)] flex-1">
                  <span className="block text-[24px] leading-8 font-semibold">
                    {p.surname} {p.given_names}
                  </span>
                  <span className="block text-[13px] text-white/80 tabular-nums">
                    {p.file_number} · {ageSexOf(p.birth_date, p.sex)}
                    {p.birth_date
                      ? ` · ${formatDate(new Date(p.birth_date))}${p.age_estimated ? ` (${t('file.estimated')})` : ''}`
                      : ''}
                    {p.phone_1 ? ` · ${p.phone_1}` : ''}
                    {p.sector ? ` · ${p.sector}` : ''}
                  </span>
                </span>
                {p.blood_group && <GlassPill>{p.blood_group}</GlassPill>}
                {!!p.flags.vip && <GlassPill>VIP</GlassPill>}
              </HeroHead>
            )}
            <CardBody className="flex-row flex-wrap items-center gap-2">
              {embedded && p.blood_group && <Chip>{p.blood_group}</Chip>}
              {embedded && !!p.flags.vip && <Chip>VIP</Chip>}
              {openVisit ? (
                <StaffLink
                  to="/app/visit"
                  search={{ encounter: openVisit.id }}
                  className={buttonVariants({ variant: 'primary' })}
                >
                  <Stethoscope size={16} aria-hidden="true" />
                  {t('file.openVisit', {
                    station: openVisit.currentStation
                      ? t(`register.stations.${openVisit.currentStation}`)
                      : '',
                  })}
                </StaffLink>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => setConfirming(true)}
                  disabled={confirming || !mayStart}
                  title={mayStart ? undefined : t('perms.blocked.visit')}
                >
                  <Ticket size={16} aria-hidden="true" />
                  {t(emergency ? 'register.submitEmergency' : 'file.startVisit')}
                </Button>
              )}
              {/* the history needs the safety details and at least one visit this person may see */}
              {mayReport && !data.safetyHidden && data.visits.some((v) => !v.private) && (
                <Button onClick={printHistory} title={t('medReport.historyHint')}>
                  <FileText size={16} aria-hidden="true" />
                  {t('medReport.history')}
                </Button>
              )}
              <Button onClick={() => setEditing((e) => !e)}>
                <Pencil size={16} aria-hidden="true" />
                {t(editing ? 'staff.form.cancel' : 'file.edit')}
              </Button>
            </CardBody>
            {/* A new visit (ticket, queue, a new bill) only after the person confirms it. */}
            {confirming && !openVisit && (
              <CardBody className="border-border border-t">
                <SendPatientCard
                  user={user}
                  patient={{
                    id: p.id,
                    name: `${p.surname} ${p.given_names}`,
                    fileNumber: p.file_number,
                  }}
                  mode="visit"
                  emergency={emergency}
                  triageFirst={staffSettings?.triageFirst ?? false}
                  lastVisit={
                    lastVisit ? { at: lastVisit.arrivedAt, count: data?.visits.length ?? 0 } : null
                  }
                  onStarted={started}
                  onLater={() => {
                    // Escape on the "Start the visit?" question only answers it: keep the card open
                    if (document.querySelector('[role="alertdialog"]')) return
                    setConfirming(false)
                  }}
                />
              </CardBody>
            )}
            {p.allergies && (
              <CardBody className="bg-red-bg text-red border-border border-t py-2 text-[13px] font-semibold">
                ⚠ {t('file.allergiesLabel')}: {p.allergies}
              </CardBody>
            )}
            {openVisit && (
              <CardBody className="bg-primary-tint/50 border-border border-t py-2 text-[13px]">
                {t('file.inClinicNow', {
                  station: openVisit.currentStation
                    ? t(`register.stations.${openVisit.currentStation}`)
                    : '—',
                })}
              </CardBody>
            )}
            {/* Nurse first, reception completes: what is still missing, and the hand-over. */}
            {(missing.length > 0 || atReception) && (
              <CardBody className="bg-amber-bg/60 border-border flex-row flex-wrap items-center gap-3 border-t py-2.5 text-[13px]">
                <span className="min-w-[min(220px,100%)] flex-1 font-semibold">
                  {missing.length > 0
                    ? t('files.lacks', { missing: missing.map(missingLabel).join(', ') })
                    : t('files.completeNow')}
                </span>
                {missing.length > 0 && !editing && (
                  <Button size="sm" onClick={() => setEditing(true)}>
                    {t('files.complete')}
                  </Button>
                )}
                {atReception && (
                  <Button
                    size="sm"
                    variant="success"
                    loading={deskOps.sendOn.isPending}
                    onClick={() => void sendToDoctor()}
                  >
                    {t('files.sendToDoctor')}
                  </Button>
                )}
              </CardBody>
            )}
            {!openVisit && (
              <CardBody className="border-border flex-row flex-wrap items-end gap-3 border-t">
                {canRegisterEmergency(user) && (
                  <label className="flex min-h-9 items-center gap-2 text-[13px] font-semibold">
                    <input
                      type="checkbox"
                      className="accent-red size-[18px]"
                      checked={emergency}
                      onChange={(e) => setEmergency(e.target.checked)}
                    />
                    {t('register.emergency')}
                  </label>
                )}
                <span className="text-ink-3 text-xs">
                  {t(
                    emergency
                      ? 'register.emergencyHint'
                      : staffSettings?.triageFirst
                        ? 'register.flowTriageFirst'
                        : 'register.flow',
                  )}
                </span>
              </CardBody>
            )}
          </Card>

          {/* past records private: request / emergency access, or the access in force */}
          {privacyNoticeShown(data.access) && (
            <PrivacyNotice
              patientId={p.id}
              patientName={`${p.surname} ${p.given_names}`}
              access={data.access}
              onMessage={(m) => {
                setActionError(null)
                setNotice(m)
              }}
            />
          )}

          {editing && (
            <Reveal focus>
              <EditForm
                safetyHidden={!!data.safetyHidden}
                extraFilled={data.extra_filled ?? []}
                patient={p}
                onDone={() => {
                  setEditing(false)
                  setNotice(t('file.saved'))
                }}
                onError={setActionError}
              />
            </Reveal>
          )}

          {/* Tabs */}
          {embedded ? (
            <Seg
              label={t('file.tabs.overview')}
              value={tab}
              onChange={setTab}
              options={TABS.map((k) => ({
                value: k,
                label:
                  t(`file.tabs.${k}`) +
                  (k === 'visits' ? ` · ${data.visits.length}` : '') +
                  (k === 'bills' && data.bills.some((b) => b.balance > 0) ? ' · ⚠' : ''),
              }))}
              className="anim-enter self-start"
            />
          ) : (
            <div
              className="anim-enter border-border bg-surface flex flex-wrap gap-0.5 self-start rounded-md border p-0.5"
              style={{ '--i': 1 } as CSSProperties}
              role="tablist"
            >
              {TABS.map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={tab === k}
                  onClick={() => setTab(k)}
                  className={cn(
                    'h-8 rounded border px-3 text-[14px] font-medium transition-colors duration-120',
                    tab === k
                      ? 'border-border bg-card text-primary'
                      : 'text-ink-2 hover:bg-hover border-transparent',
                  )}
                >
                  {t(`file.tabs.${k}`)}
                  {k === 'visits' && ` · ${data.visits.length}`}
                  {k === 'bills' && data.bills.some((b) => b.balance > 0) && ' · ⚠'}
                </button>
              ))}
            </div>
          )}

          <div key={tab} className="flex flex-col gap-4">
            {tab === 'overview' && data.summary && privacyOn(data.access) && (
              <SafetySummaryCard
                summary={data.summary}
                patientName={`${p.surname} ${p.given_names}`}
              />
            )}
            {tab === 'overview' && <Overview file={data} embedded={embedded} />}
            {tab === 'overview' && data.access?.canSeeLog && !data.access.legacy && (
              <WhoLookedCard patientId={patientId} />
            )}
            {tab === 'overview' && user.role === 'manager' && (
              <MergeCard
                keepId={patientId}
                keepLabel={`${data.patient.file_number} · ${data.patient.surname} ${data.patient.given_names}`}
              />
            )}
            {tab === 'visits' && (
              <Visits file={data} openId={openVisit?.id ?? null} canReport={mayReport} />
            )}
            {tab === 'clinical' && recordLocked(data.access) && (
              <LockedRecord
                name={`${p.surname} ${p.given_names}`}
                canRequest={!!data.access?.canRequest}
              />
            )}
            {tab === 'clinical' && !recordLocked(data.access) && (
              <>
                {(data.access?.hiddenVisits ?? 0) > 0 && (
                  <p className="text-ink-3 m-0 flex items-center gap-1.5 text-[13px]">
                    <Lock size={14} aria-hidden="true" />
                    {t('recordPrivacy.onlyVisible')}
                  </p>
                )}
                <Clinical
                  file={data}
                  embedded={embedded}
                  partial={(data.access?.hiddenVisits ?? 0) > 0}
                />
              </>
            )}
            {tab === 'files' && recordLocked(data.access) && (
              <LockedRecord
                name={`${p.surname} ${p.given_names}`}
                canRequest={!!data.access?.canRequest}
              />
            )}
            {tab === 'files' && !recordLocked(data.access) && (
              <PatientFilesSection
                patientId={patientId}
                patientName={`${p.surname} ${p.given_names}`}
                canRequest={privacyNoticeShown(data.access) && !!data.access?.canRequest}
              />
            )}
            {tab === 'bills' && <Bills file={data} />}
          </div>
        </>
      )}
    </>
  )
  if (embedded) return <div className="flex min-w-0 flex-col gap-4">{body}</div>
  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="patients">
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        {body}
      </main>
    </StaffShell>
  )
}

const initials = (p: PatientRecord) =>
  `${p.surname[0] ?? ''}${p.given_names[0] ?? ''}`.toUpperCase()
const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`

function Info({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-ink-3 text-[12px] font-medium">{label}</span>
      <span className="text-[14px] font-medium">{value == null || value === '' ? '—' : value}</span>
    </div>
  )
}

function Overview({ file, embedded }: { file: PatientFile; embedded?: boolean }) {
  const { t } = useTranslation()
  const p = file.patient
  const f = (k: string) => t(`file.fields.${k}`)
  const { states } = useFieldSettings()
  // a field the clinic hid is left out, unless the file already holds a value for it
  const shown = (k: keyof typeof states, value: unknown) =>
    states[k] !== 'hidden' || (value != null && value !== '')
  const idKind = idKindOf(p)
  return (
    // one column in the 600 px side panel, two on the whole page
    <div className={cn('grid grid-cols-1 gap-4', !embedded && 'pc:grid-cols-2')}>
      <Card className="anim-enter">
        <CardHeader icon={IdCard}>
          <span>{t('file.identity')}</span>
        </CardHeader>
        <CardBody className={cn('grid grid-cols-2 gap-x-4 gap-y-3', !embedded && 'sm:grid-cols-3')}>
          <Info label={f('file_number')} value={p.file_number} />
          {shown('national_id', p.national_id ?? p.id_number ?? p.no_national_id) && (
            <Info
              label={
                idKind === 'passport' || idKind === 'other'
                  ? t(`patientFields.id.kinds.${idKind}`)
                  : f('national_id')
              }
              value={
                idKind === 'passport' || idKind === 'other'
                  ? p.id_number
                  : p.national_id
                    ? groupNationalId(p.national_id)
                    : p.no_national_id
                      ? t(`register.noId.${p.no_national_id}`)
                      : null
              }
            />
          )}
          <Info label={f('sex')} value={t(`register.sexes.${p.sex}`)} />
          <Info
            label={f('birth_date')}
            value={
              p.birth_date
                ? `${formatDate(new Date(p.birth_date))} · ${ageSexOf(p.birth_date, 'unknown')}`
                : null
            }
          />
          {shown('phone_1', p.phone_1) && <Info label={f('phone_1')} value={p.phone_1} />}
          {shown('phone_2', p.phone_2) && <Info label={f('phone_2')} value={p.phone_2} />}
          {shown('email', p.email) && (
            <Info label={t('patientFields.labels.email')} value={p.email} />
          )}
          {shown('province', p.province) && (
            <Info
              label={t('patientFields.labels.province')}
              value={
                p.province
                  ? t(`patientFields.provinces.${p.province}`, { defaultValue: p.province })
                  : null
              }
            />
          )}
          {shown('district', p.district) && <Info label={f('district')} value={p.district} />}
          {shown('sector', p.sector) && <Info label={f('sector')} value={p.sector} />}
          {(shown('cell', p.cell) || shown('village', p.village)) && (
            <Info label={f('cell')} value={[p.cell, p.village].filter(Boolean).join(' · ')} />
          )}
          {shown('occupation', p.occupation) && (
            <Info label={f('occupation')} value={p.occupation} />
          )}
          {shown('marital_status', p.marital_status) && (
            <Info
              label={t('patientFields.labels.marital_status')}
              value={
                p.marital_status
                  ? t(`patientFields.marital.${p.marital_status}`, {
                      defaultValue: p.marital_status,
                    })
                  : null
              }
            />
          )}
          {shown('ubudehe_category', p.ubudehe_category) && (
            <Info label={f('ubudehe_category')} value={p.ubudehe_category} />
          )}
          <Info label={f('language')} value={p.language} />
          <Info label={f('registered')} value={when(p.created_at)} />
        </CardBody>
      </Card>
      <Card className="anim-enter" style={{ '--i': 1 } as CSSProperties}>
        <CardHeader icon={HeartPulse} hue="mint">
          <span>{t('file.medical')}</span>
        </CardHeader>
        <CardBody className="gap-3">
          {/* level 1 (0088): the safety fields come empty, which is not "none" */}
          {/* the safety summary above already shows blood group and allergies */}
          {file.safetyHidden ? (
            <SafetyHiddenNote />
          ) : file.summary ? null : (
            <>
              <Info label={f('blood_group')} value={p.blood_group} />
              <div
                className={cn(
                  'rounded-md px-3 py-2',
                  p.allergies ? 'bg-red-bg text-red' : 'bg-hover text-ink-2',
                )}
              >
                <span className="block text-[12px] font-medium">{f('allergies')}</span>
                <span className="font-medium">
                  {p.allergies ??
                    (p.allergies_none
                      ? t('safetySummary.noKnown')
                      : t('safetySummary.notRecorded'))}
                </span>
                <span className="text-ink-3 mt-1 block text-xs">{t('file.allergiesHint')}</span>
              </div>
            </>
          )}
          <Info
            label={f('emergency')}
            value={[p.emergency_name, p.emergency_phone].filter(Boolean).join(' · ')}
          />
          {!file.safetyHidden && <Info label={f('notes')} value={p.notes} />}
        </CardBody>
      </Card>
      <MoreInfo
        patient={p}
        safetyHidden={!!file.safetyHidden}
        extraFilled={file.extra_filled ?? []}
      />
    </div>
  )
}

/**
 * The customizable part of the file. Fields the manager defined in Settings appear for
 * every patient; anyone with patient.write can also add a one-off field for this patient.
 */
function MoreInfo({
  patient: p,
  safetyHidden = false,
  extraFilled = [],
}: {
  patient: PatientRecord
  /** Identity level: the "medical" fields are not sent; say so instead of showing them empty. */
  safetyHidden?: boolean
  /** The private fields that hold a value (keys only): the others really are empty. */
  extraFilled?: string[]
}) {
  const { t } = useTranslation()
  const { data: defs = [] } = usePatientFields()
  const actions = usePatientActions(p.id)
  const confirm = useConfirm()
  const name = `${p.surname} ${p.given_names}`
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [value, setValue] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const extra = p.extra ?? {}
  const defKeys = new Set(defs.flatMap((d) => [d.key, d.label]))
  const adHoc = Object.entries(extra).filter(([k]) => !defKeys.has(k))
  const valueOf = (d: PatientFieldDef) => extra[d.key] ?? extra[d.label]

  const save = async (next: Record<string, string>) => {
    setErr(null)
    try {
      await actions.update.mutateAsync({ extra: next })
      setAdding(false)
      setLabel('')
      setValue('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }
  const add = async (e: FormEvent) => {
    e.preventDefault()
    const k = label.trim()
    if (!k || !value.trim()) return
    if (
      !(await confirm({
        title: t('confirm.desks.patient.addField', { field: k, name }),
        body: t('confirm.desks.patient.addFieldBody', { value: value.trim() }),
        confirmLabel: t('confirm.desks.patient.addFieldYes'),
      }))
    )
      return
    void save({ ...extra, [k]: value.trim() })
  }
  const remove = async (k: string) => {
    if (
      !(await confirm({
        title: t('confirm.desks.patient.removeField', { field: k, name }),
        body: t('confirm.desks.patient.removeFieldBody'),
        confirmLabel: t('confirm.desks.patient.removeFieldYes'),
        tone: 'danger',
      }))
    )
      return
    const next = { ...extra }
    delete next[k]
    void save(next)
  }

  return (
    <Card className="pc:col-span-2 anim-enter" style={{ '--i': 2 } as CSSProperties}>
      <CardHeader hue="grey">
        <span>{t('file.more')}</span>
        <Button size="sm" onClick={() => setAdding((a) => !a)}>
          <Plus size={14} aria-hidden="true" />
          {t('file.addField')}
        </Button>
      </CardHeader>
      <CardBody className="gap-3">
        <p className="text-ink-3 m-0 text-xs">{t('file.moreLead')}</p>
        {adding && (
          <form
            onSubmit={(e) => void add(e)}
            className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_2fr_auto]"
          >
            <Field
              label={t('file.fieldName')}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('file.fieldNamePh')}
              required
              autoFocus
            />
            <Field
              label={t('file.fieldValue')}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
            <Button
              type="submit"
              variant="primary"
              className="self-end"
              loading={actions.update.isPending}
            >
              {t('file.saveField')}
            </Button>
          </form>
        )}
        {err && (
          <p role="alert" className={errorBox}>
            {err}
          </p>
        )}
        {defs.length + adHoc.length === 0 && <EmptyNote>{t('file.noExtra')}</EmptyNote>}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
          {defs.map((d) => (
            <Info
              key={d.key}
              label={d.label}
              value={
                safetyHidden && d.private
                  ? extraFilled.includes(d.key)
                    ? t('file.privateField')
                    : null
                  : valueOf(d)
              }
            />
          ))}
          {adHoc.map(([k, v]) => (
            <div key={k} className="flex items-start gap-1">
              <Info label={k} value={v} />
              <button
                type="button"
                onClick={() => void remove(k)}
                className="text-ink-3 hover:text-red rounded p-0.5"
                aria-label={t('file.removeField', { name: k })}
                title={t('file.removeField', { name: k })}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  )
}

/**
 * Edit details. The fields follow Settings › Patient fields (0108): hidden ones are left out (and
 * left as they are), required ones are starred and block saving with what is missing; the ID by
 * its type (national ID: exactly 16 digits). The medical part (blood group, allergies, notes)
 * stays with the people who may see it.
 */
function EditForm({
  patient: p,
  safetyHidden = false,
  extraFilled = [],
  onDone,
  onError,
}: {
  patient: PatientRecord
  /** Level 1 (0088): allergies, blood group and notes are not shown, nor sent. */
  safetyHidden?: boolean
  /** The private fields that hold a value (keys only): locked at level 1; the others fillable. */
  extraFilled?: string[]
  onDone: () => void
  onError: (m: string | null) => void
}) {
  const { t } = useTranslation()
  const actions = usePatientActions(p.id)
  const confirm = useConfirm()
  const { states, defs } = useFieldSettings()
  const missingLabel = useMissingLabel()
  const f = (k: string) => t(`file.fields.${k}`)
  const [draft, setDraft] = useState<PatientDraft>(() => draftOf(p, defs))
  const set: SetDraft = (k, v) => setDraft((d) => ({ ...d, [k]: v }))
  const setExtra = (k: string, v: string) =>
    setDraft((d) => ({ ...d, extra: { ...d.extra, [k]: v } }))
  const [med, setMed] = useState({
    blood_group: p.blood_group ?? '',
    allergies: p.allergies ?? '',
    notes: p.notes ?? '',
  })
  // "No known allergies" (0084): ticked, the allergy text is cleared and cannot be typed
  const [allergiesNone, setAllergiesNone] = useState(!!p.allergies_none)
  const defKeys = new Set(defs.flatMap((d) => [d.key, d.label]))
  const adHocKeys = Object.keys(draft.extra).filter((k) => !defKeys.has(k))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    onError(null)
    // the same checks as the register form, before the database refuses in its own words
    const problem = draftProblem(draft, states)
    if (problem) return onError(t(problem.key, problem.values))
    const missing = requiredMissing(asFile(draft), states, defs, draft.age_years)
    if (missing.length > 0)
      return onError(
        t('patientFields.errors.required', { fields: missing.map(missingLabel).join(', ') }),
      )
    if (
      !(await confirm({
        title: t('confirm.desks.patient.save', {
          name: `${draft.surname} ${draft.given_names}`.trim(),
        }),
        body: t('confirm.desks.patient.saveBody'),
        confirmLabel: t('confirm.desks.patient.saveYes'),
      }))
    )
      return
    try {
      // a field saved under its label before keys existed now lives under its key
      const extra = { ...draft.extra }
      for (const d of defs) {
        if (extra[d.key] === undefined && extra[d.label] !== undefined)
          extra[d.key] = extra[d.label]!
        if (d.key !== d.label) delete extra[d.label]
      }
      const fields = {
        ...draftPayload({ ...draft, extra }, states),
        ...med,
        allergies_none: allergiesNone,
      } as Record<string, string | number | boolean | null | Record<string, string>>
      if (allergiesNone) fields.allergies = ''
      // what this person cannot see is left as it is (never cleared by an empty field)
      if (safetyHidden) {
        delete fields.blood_group
        delete fields.allergies
        delete fields.allergies_none
        delete fields.notes
      }
      await actions.update.mutateAsync(fields)
      // the "no ID" reason (also said by update_patient from 0108; a database before needs this)
      const why = (NO_ID_KINDS as string[]).includes(draft.id_kind) ? draft.id_kind : null
      if (states.national_id !== 'hidden' && why !== (p.no_national_id ?? null))
        await setNoNationalId(p.id, why as NoIdReason | null)
      onDone()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <Card className="border-primary anim-enter">
      <CardHeader icon={Pencil}>
        <span>{t('file.editTitle')}</span>
      </CardHeader>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <CardBody className="gap-3">
          <CoreFields draft={draft} set={set} />
          <DetailFields
            draft={draft}
            set={set}
            setExtra={setExtra}
            states={states}
            defs={defs}
            mode="edit"
            // the "medical" fields are not sent at the identity level: one that already holds a
            // value is locked (update_patient keeps it anyway); an empty one may be filled in
            extraLocked={(d) =>
              safetyHidden && d.private && extraFilled.includes(d.key) ? (
                <Field key={d.key} label={d.label} value={t('file.privateField')} disabled />
              ) : null
            }
          />
          {safetyHidden && defs.some((d) => d.private) && (
            <p className="text-ink-3 m-0 text-xs">{t('file.privateFill')}</p>
          )}
          {adHocKeys.length > 0 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {adHocKeys.map((k) => (
                <Field
                  key={k}
                  label={k}
                  value={draft.extra[k] ?? ''}
                  onChange={(e) => setExtra(k, e.target.value)}
                />
              ))}
            </div>
          )}
          {safetyHidden ? (
            <SafetyHiddenNote />
          ) : (
            <>
              <h3 className="text-ink-2 m-0 mt-2 text-[12px] font-medium">{t('file.medical')}</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field
                  label={f('blood_group')}
                  value={med.blood_group}
                  onChange={(e) => setMed((m) => ({ ...m, blood_group: e.target.value }))}
                  placeholder="O+"
                />
              </div>
              <Field
                label={f('allergies')}
                value={med.allergies}
                onChange={(e) => setMed((m) => ({ ...m, allergies: e.target.value }))}
                placeholder={t('file.allergiesPh')}
                className="border-red/60"
                disabled={allergiesNone}
              />
              <p className="text-ink-3 m-0 -mt-2 text-xs">{t('file.allergiesHint')}</p>
              <label className="flex min-h-9 cursor-pointer items-center gap-3 text-[14px] font-semibold">
                <input
                  type="checkbox"
                  className="accent-primary size-5"
                  checked={allergiesNone}
                  onChange={(e) => {
                    setAllergiesNone(e.target.checked)
                    if (e.target.checked) setMed((m) => ({ ...m, allergies: '' }))
                  }}
                />
                {t('file.allergiesNone')}
              </label>
              <p className="text-ink-3 m-0 -mt-2 text-xs">{t('file.allergiesNoneHint')}</p>
              <Field
                label={f('notes')}
                value={med.notes}
                onChange={(e) => setMed((m) => ({ ...m, notes: e.target.value }))}
              />
            </>
          )}
          <p className="text-ink-3 m-0 text-[12px]">
            <span aria-hidden="true" className="text-red font-semibold">
              *
            </span>{' '}
            {t('patientFields.requiredHint')}
          </p>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={actions.update.isPending}>
              <Check size={16} aria-hidden="true" />
              {t('file.save')}
            </Button>
          </div>
        </CardBody>
      </form>
    </Card>
  )
}

function Visits({
  file,
  openId,
  canReport = false,
}: {
  file: PatientFile
  openId: string | null
  canReport?: boolean
}) {
  const { t } = useTranslation()
  const [shown, setShown] = useState<string | null>(openId)
  if (file.visits.length === 0)
    return (
      <Card className="anim-enter">
        <CardBody>
          <EmptyNote>{t('file.noVisits')}</EmptyNote>
        </CardBody>
      </Card>
    )
  return (
    <Card className="anim-enter">
      <ShownList items={file.visits} step={8} footerClassName="px-4 py-2">
        {(visits) =>
          visits.map((v, i) => (
            <div key={v.id} className="border-grid border-b last:border-b-0">
              <Row
                className="flex-wrap gap-x-4 gap-y-1 border-b-0 py-3"
                style={{ '--i': i } as CSSProperties}
              >
                <span className="min-w-[min(200px,100%)] flex-1">
                  <span className="block font-semibold tabular-nums">{when(v.arrivedAt)}</span>
                  <span className="text-ink-3 block text-xs">
                    {[
                      v.practitioner,
                      v.stations.map((s) => t(`register.stations.${s}`)).join(' → '),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                {v.triage && <Badge tone={v.triage}>{t(`home.triage.${v.triage}`)}</Badge>}
                <span className="min-w-[160px] text-[13px]">
                  {v.private ? (
                    <span className="text-violet inline-flex items-center gap-1.5 font-semibold">
                      <Lock size={13} aria-hidden="true" />
                      {t('recordPrivacy.privateVisit')}
                    </span>
                  ) : (
                    (v.diagnosis ?? <span className="text-ink-3">{t('file.noDiagnosis')}</span>)
                  )}
                </span>
                <span className="font-semibold tabular-nums">
                  {v.total != null ? formatRwf(v.total) : '—'}
                </span>
                {v.status === 'open' ? (
                  <Badge tone="blue">
                    {t('file.visitOpen', {
                      station: v.currentStation ? t(`register.stations.${v.currentStation}`) : '',
                    })}
                  </Badge>
                ) : (
                  <Badge tone="green">{t('file.visitClosed')}</Badge>
                )}
                <StaffLink
                  to="/app/visit"
                  search={{ encounter: v.id }}
                  className={buttonVariants({ size: 'sm' })}
                >
                  <FolderOpen size={14} aria-hidden="true" />
                  {t('common.open')}
                </StaffLink>
                {canReport && !v.private && (
                  <StaffLink
                    to="/app/visit"
                    search={{ encounter: v.id, report: true }}
                    className={buttonVariants({ size: 'sm', variant: 'ghost' })}
                    title={t('medReport.hint')}
                  >
                    <FileText size={14} aria-hidden="true" />
                    {t('medReport.visitButton')}
                  </StaffLink>
                )}
              </Row>
              <div className="px-4 pb-3">
                {/* the visit's track: always for the visit in progress, else with the details */}
                {(v.status === 'open' || shown === v.id) && (
                  <VisitTrack encounterId={v.id} className="mb-2.5" />
                )}
                <Button
                  size="sm"
                  variant={shown === v.id ? 'default' : 'ghost'}
                  onClick={() => setShown(shown === v.id ? null : v.id)}
                >
                  <Footprints size={14} aria-hidden="true" />
                  {t(shown === v.id ? 'journey.hide' : 'journey.show')}
                </Button>
                {shown === v.id && (
                  <div className="mt-3">
                    <VisitJourney encounterId={v.id} />
                  </div>
                )}
              </div>
            </div>
          ))
        }
      </ShownList>
    </Card>
  )
}

/**
 * Nothing of the medical record is open to this person: only the identity (a receptionist, a
 * cashier), or past visits all hidden and no visit of theirs. The tab says so plainly, so an
 * empty page is never taken for a fault of the system.
 */
function recordLocked(access: PatientFile['access']): boolean {
  if (!privacyOn(access)) return false
  if (access.level === 'identity') return true
  return (
    access.hiddenVisits > 0 &&
    access.ownVisits === 0 &&
    access.via == null &&
    !access.treatingEncounterId
  )
}

function LockedRecord({ name, canRequest }: { name: string; canRequest: boolean }) {
  const { t } = useTranslation()
  return (
    <Card className="border-violet/40 anim-enter">
      <CardBody className="gap-2.5">
        <p className="text-violet m-0 flex items-start gap-2 text-[17px] font-semibold">
          <Lock size={20} aria-hidden="true" className="mt-0.5 shrink-0" />
          {t('recordPrivacy.lockedTitle', { name })}
        </p>
        <p className="text-ink m-0 text-[15px]">{t('recordPrivacy.lockedNotError')}</p>
        <p className="text-ink-2 m-0 text-[14px]">{t('recordPrivacy.lockedWhy')}</p>
        <p className="bg-violet-bg/60 text-ink m-0 rounded-md px-3 py-2 text-[14px] font-medium">
          {t(canRequest ? 'recordPrivacy.lockedAsk' : 'recordPrivacy.lockedManager')}
        </p>
        <p className="text-ink-3 m-0 text-[13px]">{t('recordPrivacy.lockedStill')}</p>
      </CardBody>
    </Card>
  )
}

function Clinical({
  file,
  embedded,
  partial = false,
}: {
  file: PatientFile
  embedded?: boolean
  /** Some visits are hidden: an empty list means "none in what you may see", not "none". */
  partial?: boolean
}) {
  const { t } = useTranslation()
  const latest = new Map<string, (typeof file.vitals)[number]>()
  for (const v of file.vitals) if (!latest.has(v.code)) latest.set(v.code, v)
  return (
    <div className={cn('grid grid-cols-1 gap-4', !embedded && 'pc:grid-cols-2')}>
      <ResultsCard patientId={file.patient.id} partial={partial} />
      <Card className="anim-enter">
        <CardHeader icon={Activity} hue="mint">
          <span>{t('file.latestVitals')}</span>
          <span className="text-ink-3 text-xs">
            {latest.size ? when([...latest.values()][0]!.at) : ''}
          </span>
        </CardHeader>
        <CardBody className="flex-row flex-wrap gap-2">
          {latest.size === 0 && (
            <EmptyNote>{t(partial ? 'recordPrivacy.noneVisible' : 'file.noVitals')}</EmptyNote>
          )}
          {[...latest.values()].map((v) => (
            <Chip key={v.code}>
              {vitalName(v, t)}: <b className="ml-1 tabular-nums">{v.value ?? v.text}</b>
              {v.unit ? ` ${v.unit}` : ''}
            </Chip>
          ))}
        </CardBody>
      </Card>
      <Card className="anim-enter" style={{ '--i': 1 } as CSSProperties}>
        <CardHeader icon={Stethoscope} hue="navy">
          <span>{t('file.diagnoses')}</span>
          <span className="text-ink-3 text-xs">{file.conditions.length}</span>
        </CardHeader>
        {file.conditions.length === 0 && (
          <CardBody>
            <EmptyNote>{t(partial ? 'recordPrivacy.noneVisible' : 'file.noDiagnosis')}</EmptyNote>
          </CardBody>
        )}
        {file.conditions.map((c) => (
          <Row key={c.id} className="flex-wrap gap-x-3 gap-y-1 py-2">
            <span className="min-w-[160px] flex-1">
              <span className="block font-semibold">
                {c.text}
                {c.icd10 ? <span className="text-ink-3 ml-2 text-xs">{c.icd10}</span> : null}
              </span>
              <span className="text-ink-3 block text-xs">
                {[when(c.at), c.by].filter(Boolean).join(' · ')}
              </span>
            </span>
            <Badge tone={c.type === 'primary' ? 'blue' : 'grey'} dot={false}>
              {t(`clinical.type.${c.type}`)}
              {c.provisional ? ` · ${t('clinical.provisional')}` : ''}
            </Badge>
          </Row>
        ))}
      </Card>
    </div>
  )
}

function Bills({ file }: { file: PatientFile }) {
  const { t } = useTranslation()
  const due = file.bills.reduce((s, b) => s + b.balance, 0)
  return (
    <Card className="anim-enter">
      <CardHeader icon={Receipt} hue="mint">
        <span>{t('file.tabs.bills')}</span>
        <span
          className={cn('text-xs font-semibold tabular-nums', due > 0 ? 'text-red' : 'text-ink-3')}
        >
          {t('patients.owes', { amount: formatRwf(due) })}
        </span>
      </CardHeader>
      {file.bills.length === 0 && (
        <CardBody>
          <EmptyNote>{t('file.noBills')}</EmptyNote>
        </CardBody>
      )}
      {file.bills.map((b) => (
        <Row key={b.invoiceId} className="flex-wrap gap-x-4 gap-y-1 py-2">
          <span className="min-w-[180px] flex-1">
            <span className="block font-semibold tabular-nums">
              {b.number ?? t('file.draftBill')}
            </span>
            <span className="text-ink-3 block text-xs">
              {[when(b.at), b.payer ?? t('visit.payer.cash')].join(' · ')}
            </span>
          </span>
          <span className="tabular-nums">{formatRwf(b.total)}</span>
          {b.insurerShare > 0 && (
            <Chip>
              {t('visit.charges.insurerPays', { name: b.payer ?? '' })} {formatRwf(b.insurerShare)}
            </Chip>
          )}
          <Badge tone={b.balance > 0 ? 'orange' : 'green'}>
            {b.balance > 0
              ? t('patients.owes', { amount: formatRwf(b.balance) })
              : t('visit.payment.paidBadge')}
          </Badge>
          <StaffLink
            to="/app/visit"
            search={{ encounter: b.encounterId }}
            className={buttonVariants({ size: 'sm' })}
          >
            {t('common.open')}
          </StaffLink>
        </Row>
      ))}
    </Card>
  )
}

/** Every lab and imaging result of the patient, newest first, so any doctor can read them. */
function ResultsCard({ patientId, partial = false }: { patientId: string; partial?: boolean }) {
  const { t } = useTranslation()
  const { data: results = [] } = usePatientResults(patientId)
  return (
    <Card className="anim-enter pc:col-span-2">
      <CardHeader hue="violet">
        <span className="inline-flex items-center gap-2">
          <FlaskConical size={16} aria-hidden="true" />
          {t('file.results')}
        </span>
        <span className="text-ink-3 text-xs">{results.length}</span>
      </CardHeader>
      {results.length === 0 ? (
        <CardBody>
          <EmptyNote>{t(partial ? 'recordPrivacy.noneVisible' : 'file.noResults')}</EmptyNote>
        </CardBody>
      ) : (
        <ShownList items={results} step={5} footerClassName="px-4 py-2">
          {(shown) =>
            shown.map((r) => (
              <Row key={r.id} className="items-start gap-3 py-2.5">
                <Badge
                  tone={r.verified ? 'green' : r.findings || r.impression ? 'yellow' : 'blue'}
                  dot={false}
                  className="mt-0.5"
                >
                  {r.verified
                    ? t('clinical.verified')
                    : r.findings || r.impression
                      ? t('clinical.notVerified')
                      : t('file.awaitingResult')}
                </Badge>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{r.test}</span>
                  {r.findings && <span className="block text-[14px]">{r.findings}</span>}
                  {r.impression && (
                    <span className="block text-[14px] font-semibold">{r.impression}</span>
                  )}
                  <span className="text-ink-3 block text-xs">
                    {[
                      t('file.orderedBy', { name: r.orderedBy ?? '—', when: when(r.orderedAt) }),
                      r.resultBy && r.resultAt
                        ? t('file.resultBy', { name: r.resultBy, when: when(r.resultAt) })
                        : null,
                      r.reason,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <StaffLink
                  to="/app/visit"
                  search={{ encounter: r.encounterId }}
                  className={buttonVariants({ size: 'sm' })}
                >
                  {t('file.seeVisit')}
                </StaffLink>
              </Row>
            ))
          }
        </ShownList>
      )}
    </Card>
  )
}

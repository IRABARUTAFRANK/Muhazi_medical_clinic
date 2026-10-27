import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  FolderOpen,
  History,
  Info,
  LockKeyhole,
  Search,
  ShieldCheck,
  Siren,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime, type StaffUser } from '@mmc/shared'
import { Empty, Hint, Panel, Pill } from '@/components/dash/kit'
import { card, type Tint } from '@/components/dash/kit-style'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { PeriodCustom, PeriodSeg } from '@/components/dash/period-filter'
import { AccessRequestCard } from '@/components/privacy/approvals'
import { isManagerUser } from '@/components/privacy/approvers'
import { buttonVariants, tableLink } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Flash } from '@/components/ui/flash'
import { Pager, ShownList } from '@/components/ui/list-tools'
import { Select } from '@/components/ui/select'
import { SidePanel, useSidePanelState } from '@/components/ui/side-panel'
import { StaffShell } from '@/components/staff/staff-shell'
import { StaffLink } from '@/components/staff/staff-link'
import { usePatientsList } from '@/lib/api/patients'
import {
  useRecordAccessLog,
  useRecordAccessRequests,
  type AccessLogRow,
  type AccessLogVia,
  type AccessRequestRow,
} from '@/lib/api/privacy'
import { useEmployees } from '@/lib/api/staff'
import { navForUser } from '@/lib/nav'
import { useAgo } from '@/lib/notice-wording'
import { usePeriod } from '@/lib/period'
import { cn } from '@/lib/utils'

const VIAS: readonly AccessLogVia[] = ['own', 'head', 'request', 'emergency', 'manager']
const VIA_TINT: Record<AccessLogVia, Tint> = {
  own: 'teal',
  head: 'violet',
  request: 'mint',
  emergency: 'coral',
  manager: 'navy',
}
const PAGE_SIZE = 25

/** The state of a request or an emergency access: its tint, icon and wording key. */
function requestLook(r: AccessRequestRow): { tint: Tint; icon: LucideIcon; key: string } {
  if (r.kind === 'emergency')
    return r.reviewedAt
      ? { tint: 'navy', icon: ShieldCheck, key: 'reviewed' }
      : { tint: 'coral', icon: Siren, key: 'toReview' }
  if (r.status === 'pending') return { tint: 'amber', icon: Clock, key: 'pending' }
  if (r.status === 'approved')
    return r.active
      ? { tint: 'mint', icon: CircleCheck, key: 'active' }
      : { tint: 'teal', icon: CircleCheck, key: 'approved' }
  if (r.status === 'refused') return { tint: 'coral', icon: CircleX, key: 'refused' }
  return { tint: 'navy', icon: CircleX, key: 'cancelled' }
}

/** A refusal from the database, as a bordered red line with its symbol. */
const ErrorLine = ({ children }: { children: string }) => (
  <p
    role="alert"
    className="border-red/30 bg-red-bg text-red m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-[14px] font-medium"
  >
    <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
    <span>{children}</span>
  </p>
)

/**
 * Record access (0088): the approvers' page.
 *   Everyone who answers (the manager, the head of a department in charge): the requests waiting
 *   for their answer (approve, or refuse with a reason; the first answer wins) and the requests
 *   answered in the last 90 days.
 *   The manager also: the emergency accesses to review (mark reviewed, with a comment) and the log
 *   of every opening of past records, filtered by period, person, patient and how.
 * A request or an emergency access opens in a side panel (coral: record access) with its
 * actions; a notice opens this page on its request (?request=<id>), straight into the panel.
 */
export function RecordAccessPage({ user, focus }: { user: StaffUser; focus?: string }) {
  const { t } = useTranslation()
  const manager = isManagerUser(user)
  const pending = useRecordAccessRequests('pending')
  const all = useRecordAccessRequests('all')
  // every approver: a head is told of an emergency too (read only: the manager reviews it)
  const emergencies = useRecordAccessRequests('emergency')
  const waiting = pending.data ?? []
  const toReview = (emergencies.data ?? []).filter((r) => r.canReview)
  const answered = (all.data ?? []).filter((r) => r.kind === 'request' && r.status !== 'pending')
  const error = pending.error ?? all.error ?? emergencies.error
  // an answered card moves to another list: its message is shown here
  const [done, setDone] = useState<string | null>(null)
  // the request opened in the side panel; the row keeps its tint while it is open
  const panel = useSidePanelState<AccessRequestRow>((r) => r.id)
  const everyRow = [...waiting, ...(emergencies.data ?? []), ...answered]
  const inPanel = panel.item ? (everyRow.find((r) => r.id === panel.item!.id) ?? panel.item) : null
  // from a notice: the request named in the address opens once its list has loaded
  const focusOpened = useRef<string | null>(null)
  const focusRow = focus ? everyRow.find((r) => r.id === focus) : undefined
  useEffect(() => {
    if (!focus || !focusRow || focusOpened.current === focus) return
    focusOpened.current = focus
    panel.show(focusRow)
  }, [focus, focusRow, panel])
  const requestList = (rows: AccessRequestRow[]) => (
    <ul className="m-0 flex list-none flex-col p-0">
      {rows.map((r, n) => (
        <RequestRow
          key={r.id}
          row={r}
          i={n}
          selected={panel.isOpen(r)}
          onOpen={() => panel.show(r)}
        />
      ))}
    </ul>
  )

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="record-access">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <PageBanner
          icon={LockKeyhole}
          tint="violet"
          title={t('recordAccess.title')}
          lead={t(manager ? 'recordAccess.lead' : 'recordAccess.leadHead')}
          meta={
            <>
              <BannerChip icon={Clock}>
                {t('recordAccess.waitingChip', { count: waiting.length })}
              </BannerChip>
              {manager && (
                <BannerChip icon={Siren}>
                  {t('recordAccess.toReviewChip', { count: toReview.length })}
                </BannerChip>
              )}
            </>
          }
        />

        {done && (
          <Flash key={done} onClose={() => setDone(null)}>
            {done}
          </Flash>
        )}
        {error && <ErrorLine>{error.message}</ErrorLine>}

        <div className="pc:grid-cols-2 grid grid-cols-1 gap-4">
          {/* waiting for my answer */}
          <Panel
            i={0}
            icon={Clock}
            tint="amber"
            title={t('recordAccess.pendingTitle')}
            right={String(waiting.length)}
          >
            {pending.isLoading ? (
              <p className="text-ink-3 m-0 text-[14px]">{t('recordAccess.loading')}</p>
            ) : waiting.length === 0 ? (
              <Empty>{t('recordAccess.pendingEmpty')}</Empty>
            ) : (
              requestList(waiting)
            )}
            <Hint>{t('recordAccess.pendingHint')}</Hint>
          </Panel>

          {/* emergency accesses (the manager reviews each one; the heads see them) */}
          <Panel
            i={1}
            icon={Siren}
            tint="coral"
            title={t('recordAccess.emergencyTitle')}
            right={
              manager
                ? t('recordAccess.toReviewChip', { count: toReview.length })
                : String((emergencies.data ?? []).length)
            }
          >
            {(emergencies.data ?? []).length === 0 ? (
              <Empty>{t('recordAccess.emergencyEmpty')}</Empty>
            ) : (
              <ShownList items={emergencies.data ?? []} step={6}>
                {(shown) => requestList(shown)}
              </ShownList>
            )}
            <Hint>
              {t(manager ? 'recordAccess.emergencyHint' : 'recordAccess.emergencyHeadNote')}
            </Hint>
          </Panel>
        </div>

        {manager && <AccessLogPanel />}

        {/* answered in the last 90 days */}
        <Panel
          i={3}
          icon={History}
          tint="teal"
          title={t('recordAccess.answeredTitle')}
          right={String(answered.length)}
        >
          {answered.length === 0 ? (
            <Empty>{t('recordAccess.answeredEmpty')}</Empty>
          ) : (
            <ShownList items={answered} step={10}>
              {(shown) => requestList(shown)}
            </ShownList>
          )}
        </Panel>

        {/* the request opened: the approvals card with its actions, in the coral side panel */}
        {inPanel && (
          <RequestPanel
            row={inPanel}
            open={panel.open}
            onClose={panel.close}
            onDone={(message) => {
              setDone(message)
              panel.close()
            }}
          />
        )}
      </main>
    </StaffShell>
  )
}

/** One request in a list: its state, the patient, who asks, when, and "Details" to open it. */
function RequestRow({
  row,
  i,
  selected,
  onOpen,
}: {
  row: AccessRequestRow
  i: number
  selected: boolean
  onOpen: () => void
}) {
  const { t } = useTranslation()
  const ago = useAgo()
  const look = requestLook(row)
  const role = t(`staff.roles.${row.requestedByRole}`, { defaultValue: row.requestedByRole })
  return (
    <li
      className={cn(
        'border-grid anim-enter flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 text-[14px] transition-colors duration-120 last:border-b-0',
        row.kind === 'emergency' && !row.reviewedAt && 'border-l-red-dot -ml-2.5 border-l-2 pl-2',
        selected && 'bg-primary-tint/50 -mx-2 rounded-md px-2',
      )}
      style={{ '--i': i } as CSSProperties}
    >
      <Pill tint={look.tint} icon={look.icon}>
        {row.kind === 'emergency'
          ? t('recordAccess.status.emergency')
          : t(`recordAccess.status.${look.key}`)}
      </Pill>
      <span className="min-w-0 flex-[1_1_200px]">
        <span className="text-ink block font-semibold">
          {row.patient}
          {row.fileNumber && (
            <span className="text-ink-3 font-normal tabular-nums"> · {row.fileNumber}</span>
          )}
        </span>
        <span className="text-ink-3 block text-[13px]">
          {t(
            row.kind === 'emergency' ? 'recordAccess.card.openedBy' : 'recordAccess.card.askedBy',
            {
              name: row.requestedBy,
              role,
            },
          )}
        </span>
      </span>
      <span className="text-ink-3 text-[13px] whitespace-nowrap">{ago(row.at)}</span>
      <button type="button" onClick={onOpen} aria-expanded={selected} className={tableLink}>
        <Info size={14} aria-hidden="true" />
        {t('recordAccess.panel.details')}
      </button>
    </li>
  )
}

/** The side panel of a request: the approvals card (approve, refuse, review, withdraw) as is. */
function RequestPanel({
  row,
  open,
  onClose,
  onDone,
}: {
  row: AccessRequestRow
  open: boolean
  onClose: () => void
  onDone: (message: string) => void
}) {
  const { t } = useTranslation()
  const look = requestLook(row)
  const role = t(`staff.roles.${row.requestedByRole}`, { defaultValue: row.requestedByRole })
  return (
    <SidePanel
      open={open}
      onClose={onClose}
      hue="coral"
      icon={row.kind === 'emergency' ? Siren : LockKeyhole}
      title={row.patient}
      subtitle={`${t(row.kind === 'emergency' ? 'recordAccess.panel.emergency' : 'recordAccess.panel.request')}${row.fileNumber ? ` · ${row.fileNumber}` : ''} · ${role}`}
      tags={
        <Pill tint={look.tint} icon={look.icon}>
          {t(`recordAccess.status.${look.key}`)}
        </Pill>
      }
    >
      <AccessRequestCard row={row} onDone={onDone} />
    </SidePanel>
  )
}

/* ---------------------------------------------------------------- the access log (manager) */

/** Midnight at the start of an ISO day (local time), as an ISO instant. */
const dayStartIso = (day: string) => new Date(`${day}T00:00:00`).toISOString()
/** Midnight after an ISO day (local time). */
const dayAfterIso = (day: string) => {
  const d = new Date(`${day}T00:00:00`)
  d.setDate(d.getDate() + 1)
  return d.toISOString()
}

function AccessLogPanel() {
  const { t } = useTranslation()
  const period = usePeriod('month')
  const { data: employees = [] } = useEmployees()
  const [actor, setActor] = useState('')
  const [via, setVia] = useState<AccessLogVia | ''>('')
  const [patient, setPatient] = useState<{ id: string; label: string } | null>(null)
  const [query, setQuery] = useState('')
  const filterKey = `${period.from}|${period.to}|${actor}|${via}|${patient?.id ?? ''}`
  const [paging, setPaging] = useState({ page: 1, key: filterKey })
  // a new filter starts again at page 1 (derived during render)
  const page = paging.key === filterKey ? paging.page : 1
  if (paging.key !== filterKey) setPaging({ page: 1, key: filterKey })

  const filter = useMemo(
    () => ({
      from: dayStartIso(period.from),
      to: dayAfterIso(period.to),
      actorId: actor || null,
      via: via || null,
      patientId: patient?.id ?? null,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    [period.from, period.to, actor, via, patient?.id, page],
  )
  const log = useRecordAccessLog(filter)
  const rows = log.data?.rows ?? []
  const panel = useSidePanelState<AccessLogRow>((r) => r.id)
  const total = log.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pick = (id: string, label: string) => {
    setPatient({ id, label })
    setQuery('')
  }

  return (
    <Panel
      i={2}
      icon={ShieldCheck}
      tint="violet"
      title={t('recordAccess.logTitle')}
      right={t('recordAccess.logCount', { count: total })}
    >
      <Hint>{t('recordAccess.logLead')}</Hint>
      {/* filters: period, person, patient, how */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <PeriodSeg period={period} />
        </div>
        <PeriodCustom period={period} />
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label={t('recordAccess.person')}
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            wrapperClassName="w-full sm:w-64"
          >
            <option value="">{t('recordAccess.everyone')}</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.fullName} · {t(`staff.roles.${e.role}`, { defaultValue: e.role })}
              </option>
            ))}
          </Select>
          <Select
            label={t('recordAccess.how')}
            value={via}
            onChange={(e) => setVia(e.target.value as AccessLogVia | '')}
            wrapperClassName="w-full sm:w-56"
          >
            <option value="">{t('recordAccess.anyWay')}</option>
            {VIAS.map((v) => (
              <option key={v} value={v}>
                {t(`recordAccess.via.${v}`)}
              </option>
            ))}
          </Select>
          {patient ? (
            <div className="flex w-full flex-col gap-1.5 sm:w-64">
              <span className="text-ink-2 text-[13px] font-medium">
                {t('recordAccess.patient')}
              </span>
              <span className="border-primary bg-primary-tint text-ink flex h-[38px] items-center gap-2 rounded-md border px-3 text-[14px]">
                <UserRound size={16} aria-hidden="true" className="text-primary flex-none" />
                <span className="min-w-0 flex-1 truncate">{patient.label}</span>
                <button
                  type="button"
                  onClick={() => setPatient(null)}
                  aria-label={t('recordAccess.allPatients')}
                  title={t('recordAccess.allPatients')}
                  className="text-ink-3 hover:text-ink hover:bg-hover inline-flex size-7 items-center justify-center rounded"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </span>
            </div>
          ) : (
            <div className="relative w-full sm:w-64">
              <Field
                label={t('recordAccess.patient')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('recordAccess.patientPh')}
                type="search"
              />
              {query.trim().length >= 2 && <PatientMatches query={query} onPick={pick} />}
            </div>
          )}
        </div>
      </div>

      {log.error && <ErrorLine>{log.error.message}</ErrorLine>}
      {!log.isLoading && rows.length === 0 ? (
        <Empty>{t('recordAccess.logEmpty')}</Empty>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {rows.map((r, n) => (
            <LogRow
              key={r.id}
              row={r}
              i={n}
              selected={panel.isOpen(r)}
              onOpen={() => panel.show(r)}
              onPatient={() =>
                pick(r.patientId, `${r.patient}${r.fileNumber ? ` · ${r.fileNumber}` : ''}`)
              }
            />
          ))}
        </ul>
      )}
      <Pager
        page={page}
        pages={pages}
        from={total ? (page - 1) * PAGE_SIZE + 1 : 0}
        to={Math.min(page * PAGE_SIZE, total)}
        total={total}
        onPage={(p) => setPaging({ page: p, key: filterKey })}
      />
      {panel.item && <LogPanel row={panel.item} open={panel.open} onClose={panel.close} />}
    </Panel>
  )
}

/** Up to six patients matching the words typed (name, file number, phone). */
function PatientMatches({
  query,
  onPick,
}: {
  query: string
  onPick: (id: string, label: string) => void
}) {
  const { t } = useTranslation()
  const { data, isLoading } = usePatientsList(query, 0)
  const hits = (data?.rows ?? []).slice(0, 6)
  return (
    <div className="border-border bg-card shadow-sheet absolute top-full right-0 left-0 z-10 mt-1 flex flex-col rounded-md border p-1">
      {isLoading ? (
        <span className="text-ink-3 px-2 py-2 text-[13px]">{t('recordAccess.loading')}</span>
      ) : hits.length === 0 ? (
        <span className="text-ink-3 flex items-center gap-1.5 px-2 py-2 text-[13px]">
          <Search size={14} aria-hidden="true" />
          {t('recordAccess.noPatient')}
        </span>
      ) : (
        hits.map((p) => {
          const label = `${p.surname} ${p.givenNames} · ${p.fileNumber}`
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(p.id, label)}
              className="hover:bg-hover text-ink min-h-9 rounded px-2 text-left text-[14px] transition-colors duration-120"
            >
              {label}
            </button>
          )
        })
      )}
    </div>
  )
}

/** One opening of past records; an emergency in red. */
/** "Visit MMC-…", "Patient file", … : what a log entry opened. */
function whatOpened(row: AccessLogRow, t: (k: string, o?: Record<string, unknown>) => string) {
  return row.what === 'visit'
    ? row.visitReference
      ? t('recordAccess.what.visit', { ref: row.visitReference })
      : t('recordAccess.what.visitNoRef')
    : t(`recordAccess.what.${row.what}`)
}

function LogRow({
  row,
  i,
  selected,
  onOpen,
  onPatient,
}: {
  row: AccessLogRow
  i: number
  selected: boolean
  onOpen: () => void
  onPatient: () => void
}) {
  const { t } = useTranslation()
  const at = new Date(row.at)
  const what = whatOpened(row, t)
  return (
    <li
      className={cn(
        'border-grid anim-enter flex flex-wrap items-start gap-x-3 gap-y-1 border-b py-2.5 text-[14px] transition-colors duration-120 last:border-b-0',
        row.emergency && 'border-l-red-dot -ml-2.5 border-l-2 pl-2',
        selected && 'bg-primary-tint/50 -mx-2 rounded-md px-2',
      )}
      style={{ '--i': i } as CSSProperties}
    >
      <span className="text-ink-3 w-[92px] flex-none text-[13px] tabular-nums">
        {formatDate(at)}
        <br />
        {formatTime(at)}
      </span>
      <span className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
        <span className="text-ink font-semibold">
          {row.actor ?? t('recordAccess.unknownPerson')}
          {row.actorRole && (
            <span className="text-ink-3 font-normal">
              {' · '}
              {t(`staff.roles.${row.actorRole}`, { defaultValue: row.actorRole })}
            </span>
          )}
        </span>
        <span className="text-ink-2">
          <button
            type="button"
            onClick={onPatient}
            title={t('recordAccess.onlyThisPatient')}
            className="text-primary focus-visible:ring-primary/20 rounded font-semibold outline-none hover:underline focus-visible:ring-2"
          >
            {row.patient}
          </button>
          {row.fileNumber && <span className="text-ink-3"> · {row.fileNumber}</span>}
          <span className="text-ink-3"> · {what}</span>
        </span>
        {row.reason && <span className="text-ink-2 text-[13px] italic">“{row.reason}”</span>}
        {row.emergency && row.reviewed && (
          <span className="text-ink-3 text-[13px]">
            {t('recordAccess.logReviewed', { name: row.reviewedBy ?? '' })}
            {row.reviewNote && ` · ${row.reviewNote}`}
          </span>
        )}
      </span>
      <span className="flex flex-none flex-wrap items-center gap-1.5">
        <Pill tint={VIA_TINT[row.via]} icon={row.emergency ? Siren : undefined}>
          {t(`recordAccess.via.${row.via}`)}
        </Pill>
        {row.emergency && !row.reviewed && (
          <Pill tint="coral">{t('recordAccess.status.toReview')}</Pill>
        )}
        <button type="button" onClick={onOpen} aria-expanded={selected} className={tableLink}>
          <Info size={14} aria-hidden="true" />
          {t('recordAccess.panel.details')}
        </button>
        <StaffLink to="/app/patient" search={{ id: row.patientId }} className={tableLink}>
          <FolderOpen size={14} aria-hidden="true" />
          {t('recordAccess.card.openFile')}
        </StaffLink>
      </span>
    </li>
  )
}

/** One log entry in the coral side panel: when, who, which patient, what, how, the reason. */
function LogPanel({
  row,
  open,
  onClose,
}: {
  row: AccessLogRow
  open: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const at = new Date(row.at)
  const lines: [string, string | null][] = [
    [t('recordAccess.panel.when'), `${formatDate(at)} ${formatTime(at)}`],
    [
      t('recordAccess.panel.who'),
      `${row.actor ?? t('recordAccess.unknownPerson')}${row.actorRole ? ` · ${t(`staff.roles.${row.actorRole}`, { defaultValue: row.actorRole })}` : ''}`,
    ],
    [t('recordAccess.patient'), `${row.patient}${row.fileNumber ? ` · ${row.fileNumber}` : ''}`],
    [t('recordAccess.panel.what'), whatOpened(row, t)],
    [t('recordAccess.panel.reason'), row.reason ?? null],
    [
      t('recordAccess.panel.review'),
      row.emergency
        ? row.reviewed
          ? `${t('recordAccess.logReviewed', { name: row.reviewedBy ?? '' })}${row.reviewNote ? ` · ${row.reviewNote}` : ''}`
          : t('recordAccess.status.toReview')
        : null,
    ],
  ]
  return (
    <SidePanel
      open={open}
      onClose={onClose}
      hue="coral"
      icon={row.emergency ? Siren : ShieldCheck}
      title={row.patient}
      subtitle={`${t('recordAccess.panel.log')} · ${formatDate(at)} ${formatTime(at)}`}
      tags={
        <Pill tint={VIA_TINT[row.via]} icon={row.emergency ? Siren : undefined}>
          {t(`recordAccess.via.${row.via}`)}
        </Pill>
      }
    >
      <div className="flex flex-col gap-4">
        <dl
          className={cn(
            card,
            'm-0 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[150px_minmax(0,1fr)]',
          )}
        >
          {lines
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-3 text-[13px]">{k}</dt>
                <dd className="text-ink m-0 text-[14px] font-medium">{v}</dd>
              </div>
            ))}
        </dl>
        <div className="flex flex-wrap gap-2">
          <StaffLink
            to="/app/patient"
            search={{ id: row.patientId }}
            className={buttonVariants({ size: 'sm' })}
          >
            <FolderOpen size={14} aria-hidden="true" />
            {t('recordAccess.card.openFile')}
          </StaffLink>
        </div>
      </div>
    </SidePanel>
  )
}

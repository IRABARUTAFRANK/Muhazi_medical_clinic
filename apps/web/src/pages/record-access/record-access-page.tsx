import { useMemo, useState, type CSSProperties } from 'react'
import { Clock, History, LockKeyhole, Search, ShieldCheck, Siren, UserRound, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime, type StaffUser } from '@mmc/shared'
import { Empty, Hint, Panel, Pill } from '@/components/dash/kit'
import type { Tint } from '@/components/dash/kit-style'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { PeriodCustom, PeriodSeg } from '@/components/dash/period-filter'
import { AccessRequestCard } from '@/components/privacy/approvals'
import { isManagerUser } from '@/components/privacy/approvers'
import { Field } from '@/components/ui/field'
import { Flash } from '@/components/ui/flash'
import { Pager, ShownList } from '@/components/ui/list-tools'
import { Select } from '@/components/ui/select'
import { StaffShell } from '@/components/staff/staff-shell'
import { StaffLink } from '@/components/staff/staff-link'
import { usePatientsList } from '@/lib/api/patients'
import {
  useRecordAccessLog,
  useRecordAccessRequests,
  type AccessLogRow,
  type AccessLogVia,
} from '@/lib/api/privacy'
import { useEmployees } from '@/lib/api/staff'
import { navForUser } from '@/lib/nav'
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

/**
 * Record access (0088): the approvers' page.
 *   Everyone who answers (the manager, the head of a department in charge): the requests waiting
 *   for their answer (approve, or refuse with a reason; the first answer wins) and the requests
 *   answered in the last 90 days.
 *   The manager also: the emergency accesses to review (mark reviewed, with a comment) and the log
 *   of every opening of past records, filtered by period, person, patient and how.
 * A notice opens this page on its request (?request=<id>), outlined.
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
        {error && (
          <p className="bg-red-bg text-red m-0 rounded-xl px-3 py-2 text-[14px] font-semibold">
            {error.message}
          </p>
        )}

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
              <div className="flex flex-col gap-2.5">
                {waiting.map((r, n) => (
                  <AccessRequestCard
                    key={r.id}
                    row={r}
                    i={n}
                    highlight={r.id === focus}
                    onDone={setDone}
                  />
                ))}
              </div>
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
              <ShownList items={emergencies.data ?? []} step={4}>
                {(shown) => (
                  <div className="flex flex-col gap-2.5">
                    {shown.map((r, n) => (
                      <AccessRequestCard
                        key={r.id}
                        row={r}
                        i={n}
                        highlight={r.id === focus}
                        onDone={setDone}
                      />
                    ))}
                  </div>
                )}
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
            <ShownList items={answered} step={6}>
              {(shown) => (
                <div className="pc:grid-cols-2 grid grid-cols-1 gap-2.5">
                  {shown.map((r, n) => (
                    <AccessRequestCard
                      key={r.id}
                      row={r}
                      i={n}
                      highlight={r.id === focus}
                      onDone={setDone}
                    />
                  ))}
                </div>
              )}
            </ShownList>
          )}
        </Panel>
      </main>
    </StaffShell>
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
              <span className="text-ink-2 text-[13px] font-semibold">
                {t('recordAccess.patient')}
              </span>
              <span className="border-primary bg-primary-tint text-ink flex h-11 items-center gap-2 rounded-lg border px-3 text-[14px]">
                <UserRound size={16} aria-hidden="true" className="text-primary flex-none" />
                <span className="min-w-0 flex-1 truncate">{patient.label}</span>
                <button
                  type="button"
                  onClick={() => setPatient(null)}
                  aria-label={t('recordAccess.allPatients')}
                  title={t('recordAccess.allPatients')}
                  className="text-ink-3 hover:text-ink hover:bg-hover inline-flex size-8 items-center justify-center rounded-md"
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

      {log.error && (
        <p className="bg-red-bg text-red m-0 rounded-xl px-3 py-2 text-[14px] font-semibold">
          {log.error.message}
        </p>
      )}
      {!log.isLoading && rows.length === 0 ? (
        <Empty>{t('recordAccess.logEmpty')}</Empty>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {rows.map((r, n) => (
            <LogRow
              key={r.id}
              row={r}
              i={n}
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
    <div className="border-border bg-card shadow-card absolute top-full right-0 left-0 z-10 mt-1 flex flex-col rounded-lg border p-1">
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
              className="hover:bg-hover text-ink min-h-10 rounded-md px-2 text-left text-[14px]"
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
function LogRow({ row, i, onPatient }: { row: AccessLogRow; i: number; onPatient: () => void }) {
  const { t } = useTranslation()
  const at = new Date(row.at)
  const what =
    row.what === 'visit'
      ? row.visitReference
        ? t('recordAccess.what.visit', { ref: row.visitReference })
        : t('recordAccess.what.visitNoRef')
      : t(`recordAccess.what.${row.what}`)
  return (
    <li
      className={cn(
        'border-grid anim-enter flex flex-wrap items-start gap-x-3 gap-y-1 border-b py-2.5 text-[14px] last:border-b-0',
        row.emergency && 'bg-red-bg/60 -mx-2 rounded-lg border-b-0 px-2',
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
            className="text-primary font-semibold hover:underline"
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
        <StaffLink
          to="/app/patient"
          search={{ id: row.patientId }}
          className="text-primary text-[13px] font-semibold no-underline hover:underline"
        >
          {t('recordAccess.card.openFile')}
        </StaffLink>
      </span>
    </li>
  )
}

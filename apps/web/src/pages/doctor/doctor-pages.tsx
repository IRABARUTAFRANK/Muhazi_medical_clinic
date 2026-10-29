import { useState, type CSSProperties } from 'react'
import {
  Ban,
  CircleCheck,
  Clock,
  FlaskConical,
  FolderOpen,
  Hourglass,
  ListOrdered,
  Pill as PillIcon,
  Store,
  TestTube,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { addDays, formatDate, formatTime, isoDate, type StaffUser } from '@mmc/shared'
import { Empty, Panel, Pill } from '@/components/dash/kit'
import type { Tint } from '@/components/dash/kit-style'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { PeriodFilter } from '@/components/dash/period-filter'
import { buttonVariants } from '@/components/ui/button'
import { OpenFileLink } from '@/components/clinical/file-panel'
import { ListBar, Pager } from '@/components/ui/list-tools'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  useMyOrders,
  useMyPrescriptions,
  type MyOrder,
  type MyPrescription,
  type RxState,
} from '@/lib/api/doctor'
import type { TestStatus } from '@/lib/api/lab'
import {
  mineElsewhere,
  onePerPool,
  openItems,
  queueCounts,
  sortQueue,
  stationFor,
  useQueueBoard,
} from '@/lib/api/visits'
import { navForUser } from '@/lib/nav'
import { matches, usePaged, type SortKey } from '@/lib/paging'
import { useSearchPeriod, type Period } from '@/lib/period'
import { cn } from '@/lib/utils'
import { OpenNextButton } from '../home/open-next'
import { MyQueuePanel } from '../home/role-panels'

const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`

/** Tabs as 32 px bordered chips with a count; the open one on the teal tint. */
function Tabs<K extends string>({
  value,
  onChange,
  tabs,
}: {
  value: K
  onChange: (k: K) => void
  tabs: { id: K; label: string; count: number }[]
}) {
  return (
    <div className="flex flex-wrap gap-2" role="tablist">
      {tabs.map((x) => (
        <button
          key={x.id}
          type="button"
          role="tab"
          aria-selected={value === x.id}
          onClick={() => onChange(x.id)}
          className={cn(
            'focus-visible:ring-primary/20 inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[13px] font-medium transition-colors duration-120 outline-none focus-visible:ring-2',
            value === x.id
              ? 'border-primary/30 bg-primary-tint text-primary'
              : 'border-border bg-card text-ink-2 hover:bg-hover',
          )}
        >
          {x.label}
          <span
            className={cn(
              'rounded px-1.5 text-[12px] tabular-nums',
              value === x.id ? 'bg-card' : 'bg-hover',
            )}
          >
            {x.count}
          </span>
        </button>
      ))}
    </div>
  )
}

/** Open the visit while it is open, the patient file afterwards. */
function VisitLink({
  open,
  encounterId,
  patientId,
}: {
  open: boolean
  encounterId: string
  patientId: string
}) {
  const { t } = useTranslation()
  return open ? (
    <StaffLink
      to="/app/visit"
      search={{ encounter: encounterId }}
      className={buttonVariants({ size: 'sm', variant: 'tint-blue' })}
    >
      <FolderOpen size={14} aria-hidden="true" />
      {t('visits.openVisit')}
    </StaffLink>
  ) : (
    // the file opens in the side panel; the link underneath keeps middle-click and ctrl-click
    // on the whole page
    <OpenFileLink
      patientId={patientId}
      className={buttonVariants({ size: 'sm', variant: 'tint-blue' })}
    >
      <FolderOpen size={14} aria-hidden="true" />
      {t('visit.patientFile')}
    </OpenFileLink>
  )
}

/* ---------------------------------------------------------------- my queue */

/** The doctor's desk queue on its own page: who waits, who is with whom, take the next one. */
export function QueuePage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const station = stationFor(user)
  const { data: board = [] } = useQueueBoard('all', user.role)
  // the desk's queue, and the patients of the other sections this person works in
  // a patient sent to several of my desks at once is one row
  const live = onePerPool([
    ...board.filter((r) => r.station === station),
    ...mineElsewhere(board, station),
  ])
  const [sort, setSort] = useState<SortKey>('urgent')
  const [query, setQuery] = useState('')
  const rows = sortQueue(
    openItems(live).filter((r) => matches(query, r.name, r.ticket, r.fileNumber)),
    sort === 'name'
      ? 'name'
      : sort === 'latest'
        ? 'latest'
        : sort === 'oldest'
          ? 'oldest'
          : 'urgent',
  )
  const desk = t(`register.stations.${station}`)
  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="queue">
      <main className="pc:p-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <PageBanner
          icon={ListOrdered}
          tint="amber"
          title={t('queuePage.title', { desk })}
          lead={t('queuePage.lead')}
          meta={
            <BannerChip icon={Hourglass}>
              {t('home.waiting', { count: queueCounts(live).waiting })}
            </BannerChip>
          }
        >
          <OpenNextButton user={user} />
        </PageBanner>
        <ListBar
          query={query}
          onQuery={setQuery}
          sort={sort}
          onSort={setSort}
          sorts={['urgent', 'oldest', 'latest', 'name']}
          placeholderKey="lab.search"
        />
        <MyQueuePanel
          title={t('home.myQueue', { station: desk })}
          rows={rows}
          counts={queueCounts(live)}
          rowAction="call"
        />
      </main>
    </StaffShell>
  )
}

/* ---------------------------------------------------------------- tests & results */

/**
 * The period bar of the two lists, kept in the address, opening on the last 7 days (as Custom),
 * so on a Monday the results of last Friday's tests are still there.
 */
function useLastWeekPeriod(): Period {
  const today = new Date()
  return useSearchPeriod('custom', { from: isoDate(addDays(today, -6)), to: isoDate(today) })
}

/** An older database could only give the last 90 days. */
function PeriodCutNote() {
  const { t } = useTranslation()
  return (
    <p className="border-amber/30 bg-amber-bg text-amber m-0 flex items-start gap-2 rounded-md border px-3 py-2.5 text-[14px] font-medium">
      <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
      {t('doctorLists.periodNeedsUpdate')}
    </p>
  )
}

const STATUS_LOOK: Record<TestStatus, { tint: Tint; icon: LucideIcon }> = {
  ordered: { tint: 'amber', icon: Hourglass },
  collected: { tint: 'teal', icon: TestTube },
  in_process: { tint: 'violet', icon: FlaskConical },
  resulted: { tint: 'navy', icon: Clock },
  verified: { tint: 'mint', icon: CircleCheck },
  cancelled: { tint: 'coral', icon: Ban },
}

type OrderTab = 'ready' | 'waiting' | 'cancelled' | 'all'
const orderTab = (o: MyOrder): OrderTab =>
  o.status === 'resulted' || o.status === 'verified'
    ? 'ready'
    : o.status === 'cancelled'
      ? 'cancelled'
      : 'waiting'

/** Every test I ordered: waiting at the lab, results ready (to read), not done (and why). */
export function ResultsPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  // the same period filter as the dashboards (the last 7 days by default)
  const period = useLastWeekPeriod()
  const [tab, setTab] = useState<OrderTab>('ready')
  const [query, setQuery] = useState('')
  const { data: got, isLoading } = useMyOrders({ from: period.from, to: period.to })
  const data = got?.rows ?? []
  const count = (k: OrderTab) =>
    k === 'all' ? data.length : data.filter((o) => orderTab(o) === k).length
  const shown = data.filter(
    (o) =>
      (tab === 'all' || orderTab(o) === tab) && matches(query, o.patient, o.test, o.fileNumber),
  )
  const paged = usePaged(shown, 15, `${tab}|${query}|${period.from}|${period.to}`)
  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="results">
      <main className="pc:p-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <PageBanner
          icon={FlaskConical}
          tint="coral"
          title={t('doctorLists.resultsTitle')}
          lead={t('doctorLists.resultsLead')}
          meta={
            <BannerChip icon={CircleCheck}>
              {t('doctorLists.readyCount', { count: count('ready') })}
            </BannerChip>
          }
        />
        <Panel i={1} icon={FlaskConical} tint="coral" title={t('doctorLists.resultsPanel')}>
          <PeriodFilter period={period} />
          {got?.cut && <PeriodCutNote />}
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={(['ready', 'waiting', 'cancelled', 'all'] as const).map((k) => ({
              id: k,
              label: t(`doctorLists.orderTabs.${k}`),
              count: count(k),
            }))}
          />
          <ListBar query={query} onQuery={setQuery} placeholderKey="lab.search" />
          {paged.total === 0 ? (
            <Empty icon={FlaskConical}>
              {isLoading ? t('doctorLists.loading') : t('doctorLists.noOrders')}
            </Empty>
          ) : (
            <div className="flex flex-col">
              {paged.slice.map((o, i) => {
                const look = STATUS_LOOK[o.status]
                return (
                  <div
                    key={o.id}
                    className="border-grid anim-enter flex flex-col gap-2 border-b py-3 last:border-b-0"
                    style={{ '--i': Math.min(i, 12) } as CSSProperties}
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <Pill tint={look.tint} icon={look.icon}>
                        {t(`lab.status.${o.status}`)}
                      </Pill>
                      <span className="min-w-[min(200px,100%)] flex-1">
                        <span className="block font-semibold">
                          {o.test}
                          <span className="text-ink-2 font-normal"> · {o.patient}</span>
                        </span>
                        <span className="text-ink-3 block text-[13px]">
                          {[
                            o.fileNumber,
                            t(`register.stations.${o.station}`, { defaultValue: o.station }),
                            t('doctorLists.orderedAt', { when: when(o.orderedAt) }),
                            o.reason,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      <VisitLink
                        open={o.visitOpen}
                        encounterId={o.encounterId}
                        patientId={o.patientId}
                      />
                    </div>
                    {(o.findings || o.impression) && (
                      <span className="border-border bg-card border-l-green-dot block rounded-md border border-l-2 px-3 py-2 text-[13px]">
                        {o.findings && <span className="block">{o.findings}</span>}
                        {o.impression && (
                          <span className="block font-semibold">{o.impression}</span>
                        )}
                        <span className="text-ink-3 block text-xs">
                          {[
                            o.verified ? t('clinical.verified') : t('clinical.notVerified'),
                            o.resultBy,
                            o.resultAt && when(o.resultAt),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          <Pager {...paged} onPage={paged.setPage} />
        </Panel>
      </main>
    </StaffShell>
  )
}

/* ---------------------------------------------------------------- prescriptions */

const RX_LOOK: Record<RxState, { tint: Tint; icon: LucideIcon }> = {
  waiting: { tint: 'amber', icon: Hourglass },
  given: { tint: 'mint', icon: CircleCheck },
  not_given: { tint: 'coral', icon: Ban },
  room: { tint: 'teal', icon: PillIcon },
  outside: { tint: 'violet', icon: Store },
}

/** Every prescription I wrote and what became of it at the pharmacy. */
export function PrescriptionsPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  // the same period filter as the dashboards (the last 7 days by default)
  const period = useLastWeekPeriod()
  const [tab, setTab] = useState<RxState | 'all'>('all')
  const [query, setQuery] = useState('')
  const { data: got, isLoading } = useMyPrescriptions({ from: period.from, to: period.to })
  const data = got?.rows ?? []
  const count = (k: RxState | 'all') =>
    k === 'all' ? data.length : data.filter((r) => r.state === k).length
  const shown = data.filter(
    (r: MyPrescription) =>
      (tab === 'all' || r.state === tab) && matches(query, r.patient, r.item, r.fileNumber),
  )
  const paged = usePaged(shown, 15, `${tab}|${query}|${period.from}|${period.to}`)
  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="prescriptions">
      <main className="pc:p-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <PageBanner
          icon={PillIcon}
          tint="violet"
          title={t('doctorLists.rxTitle')}
          lead={t('doctorLists.rxLead')}
          meta={
            <BannerChip icon={Ban}>
              {t('doctorLists.notGivenCount', { count: count('not_given') })}
            </BannerChip>
          }
        />
        <Panel i={1} icon={PillIcon} tint="violet" title={t('doctorLists.rxPanel')}>
          <PeriodFilter period={period} />
          {got?.cut && <PeriodCutNote />}
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={(['all', 'waiting', 'given', 'not_given', 'room', 'outside'] as const).map(
              (k) => ({
                id: k,
                label: t(`doctorLists.rxTabs.${k}`),
                count: count(k),
              }),
            )}
          />
          <ListBar query={query} onQuery={setQuery} placeholderKey="doctorLists.rxSearch" />
          {paged.total === 0 ? (
            <Empty icon={PillIcon}>
              {isLoading ? t('doctorLists.loading') : t('doctorLists.noRx')}
            </Empty>
          ) : (
            <div className="flex flex-col">
              {paged.slice.map((r, i) => {
                const look = RX_LOOK[r.state]
                return (
                  <div
                    key={r.id}
                    className="border-grid anim-enter flex flex-wrap items-center gap-3 border-b py-3 last:border-b-0"
                    style={{ '--i': Math.min(i, 12) } as CSSProperties}
                  >
                    <Pill tint={look.tint} icon={look.icon}>
                      {t(`doctorLists.rxTabs.${r.state}`)}
                    </Pill>
                    <span className="min-w-[min(200px,100%)] flex-1">
                      <span className="block font-semibold">
                        {r.item} × {r.quantity}
                        <span className="text-ink-2 font-normal"> · {r.patient}</span>
                      </span>
                      <span className="text-ink-3 block text-[13px]">
                        {[
                          r.fileNumber,
                          r.dose,
                          r.frequency,
                          r.days ? t('clinical.forDays', { count: r.days }) : null,
                          when(r.at),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {r.notGivenReason && (
                        <span className="text-red block text-[13px] font-semibold">
                          {t('clinical.notGivenWhy', { reason: r.notGivenReason })}
                        </span>
                      )}
                    </span>
                    <VisitLink
                      open={r.visitOpen}
                      encounterId={r.encounterId}
                      patientId={r.patientId}
                    />
                  </div>
                )
              })}
            </div>
          )}
          <Pager {...paged} onPage={paged.setPage} />
        </Panel>
      </main>
    </StaffShell>
  )
}

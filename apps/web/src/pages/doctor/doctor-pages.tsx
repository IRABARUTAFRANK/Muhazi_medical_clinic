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
  TestTube,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime, type StaffUser } from '@mmc/shared'
import { Empty, Panel, Pill } from '@/components/dash/kit'
import type { Tint } from '@/components/dash/kit-style'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { buttonVariants } from '@/components/ui/button'
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
import { openItems, queueCounts, sortQueue, stationFor, useQueueBoard } from '@/lib/api/visits'
import { navForUser } from '@/lib/nav'
import { matches, usePaged, type SortKey } from '@/lib/paging'
import { cn } from '@/lib/utils'
import { OpenNextButton } from '../home/open-next'
import { MyQueuePanel } from '../home/role-panels'

const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`

/** Tabs as pills with a count. */
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
            'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold',
            value === x.id
              ? 'border-primary bg-primary text-white'
              : 'border-border bg-card text-ink-2 hover:bg-hover',
          )}
        >
          {x.label}
          <span
            className={cn(
              'rounded-full px-1.5 text-[12px]',
              value === x.id ? 'bg-white/20' : 'bg-hover',
            )}
          >
            {x.count}
          </span>
        </button>
      ))}
    </div>
  )
}

/** How many days back the lists go. */
function DaysPicker({ days, onDays }: { days: number; onDays: (d: number) => void }) {
  const { t } = useTranslation()
  return (
    <label className="text-ink-2 inline-flex items-center gap-2 text-[13px] font-semibold">
      {t('doctorLists.period')}
      <select
        className="border-border bg-card h-9 rounded-lg border px-2 text-[13px]"
        value={days}
        onChange={(e) => onDays(Number(e.target.value))}
      >
        {[1, 7, 30, 90].map((d) => (
          <option key={d} value={d}>
            {t('doctorLists.lastDays', { count: d })}
          </option>
        ))}
      </select>
    </label>
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
      className={buttonVariants({ size: 'sm' })}
    >
      {t('visits.openVisit')}
    </StaffLink>
  ) : (
    <StaffLink
      to="/app/patient"
      search={{ id: patientId }}
      className={buttonVariants({ size: 'sm', variant: 'ghost' })}
    >
      <FolderOpen size={14} aria-hidden="true" />
      {t('visit.patientFile')}
    </StaffLink>
  )
}

/* ---------------------------------------------------------------- my queue */

/** The doctor's desk queue on its own page: who waits, who is with whom, take the next one. */
export function QueuePage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const station = stationFor(user)
  const { data: live = [] } = useQueueBoard(station, user.role)
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
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
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
  const [days, setDays] = useState(7)
  const [tab, setTab] = useState<OrderTab>('ready')
  const [query, setQuery] = useState('')
  const { data = [], isLoading } = useMyOrders(days)
  const count = (k: OrderTab) =>
    k === 'all' ? data.length : data.filter((o) => orderTab(o) === k).length
  const shown = data.filter(
    (o) =>
      (tab === 'all' || orderTab(o) === tab) && matches(query, o.patient, o.test, o.fileNumber),
  )
  const paged = usePaged(shown, 15, `${tab}|${query}|${days}`)
  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="results">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
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
        <Panel
          i={1}
          icon={FlaskConical}
          tint="coral"
          title={t('doctorLists.resultsPanel')}
          right={<DaysPicker days={days} onDays={setDays} />}
        >
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
                      <span className="min-w-[200px] flex-1">
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
                      <span className="bg-green-bg/60 block rounded-lg px-3 py-2 text-[13px]">
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
}

/** Every prescription I wrote and what became of it at the pharmacy. */
export function PrescriptionsPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const [days, setDays] = useState(7)
  const [tab, setTab] = useState<RxState | 'all'>('all')
  const [query, setQuery] = useState('')
  const { data = [], isLoading } = useMyPrescriptions(days)
  const count = (k: RxState | 'all') =>
    k === 'all' ? data.length : data.filter((r) => r.state === k).length
  const shown = data.filter(
    (r: MyPrescription) =>
      (tab === 'all' || r.state === tab) && matches(query, r.patient, r.item, r.fileNumber),
  )
  const paged = usePaged(shown, 15, `${tab}|${query}|${days}`)
  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="prescriptions">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
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
        <Panel
          i={1}
          icon={PillIcon}
          tint="violet"
          title={t('doctorLists.rxPanel')}
          right={<DaysPicker days={days} onDays={setDays} />}
        >
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={(['all', 'waiting', 'given', 'not_given', 'room'] as const).map((k) => ({
              id: k,
              label: t(`doctorLists.rxTabs.${k}`),
              count: count(k),
            }))}
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
                    <span className="min-w-[200px] flex-1">
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

import { useState } from 'react'
import {
  Ban,
  CircleCheck,
  ClipboardList,
  Clock,
  FlaskConical,
  Hourglass,
  ListOrdered,
  RefreshCw,
  Siren,
  TestTube,
  Timer,
  Warehouse,
  Workflow,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { usePeriod } from '@/lib/period'
import { PeriodCustom, PeriodSeg } from '@/components/dash/period-filter'
import { formatDuration } from '@/lib/duration'
import { formatDate, formatNumber, formatTime, type StaffUser } from '@mmc/shared'
import { DoctorCalendarsSection } from '@/components/calendar/doctor-calendars-section'
import { IdentityBanner } from '@/components/dash/identity-banner'
import { Empty, Kpi, ListRows, Panel, Pill, SectionTitle } from '@/components/dash/kit'
import { greetingFor } from '@/components/dash/kit-style'
import { NoticesPanel } from '@/components/dash/notices-panel'
import { Button, buttonVariants } from '@/components/ui/button'
import { ListBar, ShownList } from '@/components/ui/list-tools'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { useLabSummary, useLabWorklist } from '@/lib/api/lab'
import { isLowStock, useStockOverview } from '@/lib/api/stock'
import { openItems, stationFor, useQueueBoard } from '@/lib/api/visits'
import { useNow } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { matches } from '@/lib/paging'
import { isLive } from '@/lib/supabase'
import { LabOrderRow } from '../lab/lab-parts'
import { ErrorBox, MyQueuePanel, ToAcceptPanel } from './role-panels'
import { useHomeSummary } from '@/lib/api/home'
import { CallsPanel } from './calls-panel'

/**
 * Laboratory dashboard (lab technicians; sonographers for imaging): the bench in the manager
 * design. Figures of the day, the worklist (urgent first: sample taken → result → verify), the
 * patients queued at the lab, what is most ordered today and the results already given.
 */
export function LabDashboard({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const now = useNow()
  // the figures of the chosen period (today by default; lists of what waits now stay "now")
  const period = usePeriod('today')
  const days = period.range === 'today' ? null : { from: period.from, to: period.to }
  const periodWord = t(`dashboard.period.${period.range}`)
  const { data: s, refetch, isFetching, dataUpdatedAt } = useLabSummary(days)
  const { data: open = [] } = useLabWorklist('open')
  const { data: done = [] } = useLabWorklist('done')
  // the lab's queue, or the ultrasound queue for sonographers
  const desk = stationFor(user)
  const { data: queue = [] } = useQueueBoard(desk, user.role)
  const rows = openItems(queue)
  const [query, setQuery] = useState('')
  // a sonographer keeps a calendar: the bookings made with them wait for their answer
  const { data: home } = useHomeSummary()
  const [bookingError, setBookingError] = useState<string | null>(null)
  const bench = open.filter((o) => matches(query, o.patient, o.test, o.fileNumber, o.ticket))
  // the laboratory's own shelves (reagents, supplies): low or expiring soon
  const { data: stock } = useStockOverview()
  const labStores = (stock?.locations ?? []).filter((l) => l.type === 'lab').map((l) => l.id)
  const watch = (stock?.items ?? [])
    .filter((i) => i.active && labStores.some((id) => (i.byLocation[id] ?? 0) > 0))
    .filter(
      (i) =>
        isLowStock(i) ||
        (i.earliestExpiry && new Date(i.earliestExpiry).getTime() < now + 60 * 86_400_000),
    )

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="home">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <IdentityBanner user={user} greeting={greetingFor(user.name, t)} />

        <div className="anim-enter flex flex-wrap items-center gap-3">
          <div className="text-ink-2 flex min-w-[240px] flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <FlaskConical size={16} aria-hidden="true" className="text-primary" />
              {t('lab.bench')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock size={15} aria-hidden="true" className="text-ink-3" />
              {t('dashboard.subtitleUpdated', {
                time: formatTime(dataUpdatedAt ? new Date(dataUpdatedAt) : new Date(now)),
              })}
            </span>
            {!isLive && <span className="text-ink-3">{t('dashboard.sampleData')}</span>}
          </div>
          <PeriodSeg period={period} />
          <Button
            size="icon"
            onClick={() => void refetch()}
            loading={isFetching}
            aria-label={t('dashboard.refresh')}
            title={t('dashboard.refresh')}
          >
            {!isFetching && <RefreshCw size={16} aria-hidden="true" />}
          </Button>
          {user.dbRole !== 'sonographer' && (
            <StaffLink to="/app/stock" className={buttonVariants({ size: 'md' })}>
              <Warehouse size={16} aria-hidden="true" />
              {t('lab.stock')}
            </StaffLink>
          )}
          <StaffLink to="/app/lab" className={buttonVariants({ variant: 'primary', size: 'md' })}>
            <ClipboardList size={16} aria-hidden="true" />
            {t('lab.openWorklist')}
          </StaffLink>
          <PeriodCustom period={period} className="basis-full" />
        </div>

        {s && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(230px,1fr))] sm:gap-4">
            <Kpi
              i={0}
              icon={Hourglass}
              tint="amber"
              label={t('lab.tiles.waiting')}
              value={s.waiting}
              unit={t('lab.units.sample')}
            />
            <Kpi
              i={1}
              icon={TestTube}
              tint="teal"
              label={t('lab.tiles.inProcess')}
              value={s.inProcess}
              unit={t('dashboard.units.now')}
            />
            <Kpi
              i={2}
              icon={Clock}
              tint="navy"
              label={t('lab.tiles.toVerify')}
              value={s.toVerify}
              unit={t('lab.units.results')}
              delta={
                s.toVerify > 0 ? { text: t('lab.verifySoon'), good: false, up: null } : undefined
              }
            />
            <Kpi
              i={3}
              icon={CircleCheck}
              tint="mint"
              label={t('lab.tiles.done')}
              value={s.doneToday}
              unit={periodWord}
            />
            <Kpi
              i={4}
              icon={Siren}
              tint="coral"
              label={t('lab.tiles.urgent')}
              value={s.urgent}
              unit={t('dashboard.units.now')}
              delta={s.urgent > 0 ? { text: t('desk.seeFirst'), good: false, up: null } : undefined}
            />
            <Kpi
              i={5}
              icon={Timer}
              tint="violet"
              label={t('lab.tiles.turnaround')}
              value={s.turnaroundMin}
              text={formatDuration(s.turnaroundMin, t)}
              unit=""
            />
          </div>
        )}

        {/* Calling the next patient, help requests */}
        <CallsPanel user={user} />

        <section className="flex flex-col gap-3">
          <SectionTitle icon={Workflow}>{t('lab.section')}</SectionTitle>
          <div className="pc:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] grid grid-cols-1 gap-4">
            <Panel
              i={1}
              icon={ClipboardList}
              tint="coral"
              title={t('lab.worklist')}
              right={t('lab.openCount', { count: open.length })}
            >
              <ListBar query={query} onQuery={setQuery} placeholderKey="lab.search" />
              {bench.length === 0 ? (
                <Empty icon={FlaskConical}>{t('lab.empty')}</Empty>
              ) : (
                <ShownList items={bench} step={6}>
                  {(shown) => (
                    <div className="flex flex-col">
                      {shown.map((o, i) => (
                        <LabOrderRow key={o.id} order={o} i={i} now={now} />
                      ))}
                    </div>
                  )}
                </ShownList>
              )}
            </Panel>
            <div className="flex min-w-0 flex-col gap-4">
              <MyQueuePanel
                title={desk === 'ultrasound' ? t('lab.queueUltrasound') : t('lab.queue')}
                rows={rows}
                counts={{
                  waiting: rows.filter((r) => !r.startedAt).length,
                  inProgress: rows.filter((r) => r.startedAt).length,
                  done: s?.served ?? 0,
                }}
                rowAction="call"
              />
              {s && (
                <Panel
                  i={3}
                  icon={ListOrdered}
                  tint="violet"
                  title={t('lab.mostOrdered')}
                  right={t('lab.orderedToday', { count: s.orderedToday, period: periodWord })}
                >
                  {s.byTest.length === 0 && (
                    <Empty>{t('lab.nothingToday', { period: periodWord })}</Empty>
                  )}
                  <ListRows
                    rows={s.byTest.map((b, i) => ({
                      key: b.test,
                      pill: <Pill tint={i === 0 ? 'amber' : 'teal'}>{i + 1}</Pill>,
                      label: b.test,
                      value: String(b.count),
                    }))}
                  />
                </Panel>
              )}
              {user.dbRole === 'sonographer' && home && (
                <>
                  {bookingError && <ErrorBox>{bookingError}</ErrorBox>}
                  <ToAcceptPanel items={home.toAccept} onError={setBookingError} />
                </>
              )}
              {user.dbRole !== 'sonographer' && labStores.length > 0 && (
                <Panel
                  i={4}
                  icon={Warehouse}
                  tint="amber"
                  title={t('lab.stockWatch')}
                  right={String(watch.length)}
                >
                  {watch.length === 0 ? (
                    <Empty>{t('lab.stockFine')}</Empty>
                  ) : (
                    <ListRows
                      rows={watch.map((i) => ({
                        key: i.id,
                        pill: (
                          <Pill tint={isLowStock(i) ? 'coral' : 'amber'}>
                            {formatNumber(
                              labStores.reduce((n, id) => n + (i.byLocation[id] ?? 0), 0),
                            )}
                          </Pill>
                        ),
                        label: i.name,
                        value: isLowStock(i)
                          ? t('stock.low')
                          : t('lab.expiresOn', { date: formatDate(new Date(i.earliestExpiry!)) }),
                      }))}
                    />
                  )}
                </Panel>
              )}
              <NoticesPanel limit={4} />
            </div>
          </div>
        </section>

        {(s?.notDone ?? []).length > 0 && (
          <Panel
            i={2}
            icon={Ban}
            tint="coral"
            title={t('lab.notDoneToday', { period: periodWord })}
            right={String(s!.notDone!.length)}
          >
            <ListRows
              rows={s!.notDone!.map((x) => ({
                key: x.id,
                label: `${x.test} · ${x.patient}`,
                value: [formatTime(new Date(x.at)), x.reason].filter(Boolean).join(' · '),
              }))}
            />
          </Panel>
        )}

        <section className="flex flex-col gap-3">
          <SectionTitle icon={CircleCheck}>{t('lab.doneToday')}</SectionTitle>
          <Panel
            i={1}
            icon={CircleCheck}
            tint="mint"
            title={t('lab.resultsGiven')}
            right={String(done.length)}
          >
            {done.length === 0 ? (
              <Empty>{t('lab.noneDone')}</Empty>
            ) : (
              <ShownList items={done} step={5}>
                {(shown) => (
                  <div className="flex flex-col">
                    {shown.map((o, i) => (
                      <LabOrderRow key={o.id} order={o} i={i} now={now} />
                    ))}
                  </div>
                )}
              </ShownList>
            )}
          </Panel>
        </section>
        <DoctorCalendarsSection user={user} />
      </main>
    </StaffShell>
  )
}

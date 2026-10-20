import { useState } from 'react'
import {
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
  Workflow,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDuration } from '@/lib/duration'
import { formatTime, type StaffUser } from '@mmc/shared'
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
import { openItems, useQueueBoard } from '@/lib/api/visits'
import { useNow } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { matches } from '@/lib/paging'
import { isLive } from '@/lib/supabase'
import { LabOrderRow } from '../lab/lab-parts'
import { MyQueuePanel } from './role-panels'

/**
 * Laboratory dashboard (lab technicians; sonographers for imaging): the bench in the manager
 * design. Figures of the day, the worklist (urgent first: sample taken → result → verify), the
 * patients queued at the lab, what is most ordered today and the results already given.
 */
export function LabDashboard({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const now = useNow()
  const { data: s, refetch, isFetching, dataUpdatedAt } = useLabSummary()
  const { data: open = [] } = useLabWorklist('open')
  const { data: done = [] } = useLabWorklist('done')
  const { data: queue = [] } = useQueueBoard('laboratory', user.role)
  const rows = openItems(queue)
  const [query, setQuery] = useState('')
  const bench = open.filter((o) => matches(query, o.patient, o.test, o.fileNumber, o.ticket))

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
          <Button
            size="icon"
            onClick={() => void refetch()}
            loading={isFetching}
            aria-label={t('dashboard.refresh')}
            title={t('dashboard.refresh')}
          >
            {!isFetching && <RefreshCw size={16} aria-hidden="true" />}
          </Button>
          <StaffLink to="/app/lab" className={buttonVariants({ variant: 'primary', size: 'md' })}>
            <ClipboardList size={16} aria-hidden="true" />
            {t('lab.openWorklist')}
          </StaffLink>
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
              unit={t('dashboard.period.today')}
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
                title={t('lab.queue')}
                rows={rows}
                counts={{
                  waiting: rows.filter((r) => !r.startedAt).length,
                  inProgress: rows.filter((r) => r.startedAt).length,
                  done: 0,
                }}
                rowAction="call"
              />
              {s && (
                <Panel
                  i={3}
                  icon={ListOrdered}
                  tint="violet"
                  title={t('lab.mostOrdered')}
                  right={t('lab.orderedToday', { count: s.orderedToday })}
                >
                  {s.byTest.length === 0 && <Empty>{t('lab.nothingToday')}</Empty>}
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
              <NoticesPanel limit={4} />
            </div>
          </div>
        </section>

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

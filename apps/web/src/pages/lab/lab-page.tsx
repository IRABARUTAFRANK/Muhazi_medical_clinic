import { useState } from 'react'
import { CircleCheck, Clock, FlaskConical, Hourglass, TestTubes } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLINIC_PROFILE, type StaffUser } from '@mmc/shared'
import { Empty, Kpi, Panel, SectionTitle } from '@/components/dash/kit'
import { ActionRow, ActionRowEnd, BannerChip, PageBanner } from '@/components/dash/page-banner'
import { Seg } from '@/components/ui/seg'
import { ListBar, Pager } from '@/components/ui/list-tools'
import { StaffShell } from '@/components/staff/staff-shell'
import { useLabSummary, useLabWorklist, type LabOrder } from '@/lib/api/lab'
import { useClinicInfo } from '@/lib/api/public'
import { ReportButtons } from '@/components/dash/report-buttons'
import { labReport } from '@/lib/reports/build'
import { useNow } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { matches, usePaged, type SortKey } from '@/lib/paging'
import { NoDeskPage } from '@/components/clinical/desk-gate'
import { NotAllowedNotice } from '@/components/clinical/perm-gate'
import { useCan } from '@/lib/api/permissions'
import { useCanDesk, type DeskId } from '@/lib/api/desks'
import { LabOrderRow } from './lab-parts'

const LAB_DESKS: readonly DeskId[] = ['laboratory', 'ultrasound']

type Filter = 'all' | 'ordered' | 'process' | 'resulted'

const sortOrders = (rows: LabOrder[], sort: SortKey) =>
  [...rows].sort((a, b) => {
    if (sort === 'name') return a.patient.localeCompare(b.patient)
    if (sort === 'latest') return b.orderedAt.localeCompare(a.orderedAt)
    if (sort === 'oldest' || sort === 'longest') return a.orderedAt.localeCompare(b.orderedAt)
    return a.priority - b.priority || a.orderedAt.localeCompare(b.orderedAt)
  })

/**
 * The full laboratory worklist: every open test (or today's results), searchable, by status and
 * in the order chosen, 15 at a time; each row takes the test to its next step.
 */
export function LabPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  // the laboratory and ultrasound desks: a department of the person gives them (or, where no
  // department does, the role); the list itself only holds the tests of the desks they have
  const canDesk = useCanDesk(user)
  if (!canDesk(LAB_DESKS))
    return (
      <NoDeskPage
        user={user}
        activeId="worklist"
        desks={LAB_DESKS}
        icon={FlaskConical}
        tint="violet"
        title={t('lab.worklistTitle')}
      />
    )
  return <LabWorklist user={user} />
}

function LabWorklist({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  // the list stays readable; taking samples and writing results follow the manager's switch
  const can = useCan(user)
  const now = useNow()
  const [tab, setTab] = useState<'open' | 'done'>('open')
  const { data: orders = [] } = useLabWorklist(tab)
  const { data: openAll = [] } = useLabWorklist('open')
  const { data: doneAll = [] } = useLabWorklist('done')
  const { data: summary } = useLabSummary()
  const { data: info } = useClinicInfo()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('urgent')
  const [filter, setFilter] = useState<Filter>('all')
  const inFilter = (o: LabOrder) =>
    filter === 'all' ||
    (filter === 'ordered' && o.status === 'ordered') ||
    (filter === 'process' && (o.status === 'collected' || o.status === 'in_process')) ||
    (filter === 'resulted' && o.status === 'resulted')
  const shown = sortOrders(
    orders.filter((o) => inFilter(o) && matches(query, o.patient, o.test, o.fileNumber, o.ticket)),
    sort,
  )
  const paged = usePaged(shown, 15, `${tab}|${filter}|${query}|${sort}`)
  const count = (f: Filter) => orders.filter((o) => (f === 'all' ? true : inFilterOf(f, o))).length
  // the bench at a glance, from the lists already on the page
  const openCount = (f: Filter) => openAll.filter((o) => inFilterOf(f, o)).length

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="worklist">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <PageBanner
          icon={FlaskConical}
          tint="violet"
          title={t('lab.worklistTitle')}
          lead={t('lab.worklistLead')}
          meta={
            <BannerChip icon={Hourglass}>
              {t('lab.openCount', { count: openAll.length })}
            </BannerChip>
          }
        />
        <ActionRow>
          <Seg<'open' | 'done'>
            label={t('lab.worklist')}
            value={tab}
            onChange={setTab}
            options={[
              { value: 'open', label: `${t('lab.tabs.open')} (${openAll.length})` },
              { value: 'done', label: `${t('lab.tabs.done')} (${doneAll.length})` },
            ]}
          />
          <ReportButtons
            build={() =>
              labReport(summary, openAll, doneAll, info?.profile ?? CLINIC_PROFILE, user, t)
            }
          />
          <ActionRowEnd />
        </ActionRow>

        {!can('orders.write') && <NotAllowedNotice feature="orders.write" />}

        <section className="flex flex-col gap-3">
          <SectionTitle icon={TestTubes}>{t('lab.section')}</SectionTitle>
          <div className="pc:grid-cols-[repeat(auto-fit,minmax(150px,1fr))] grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Kpi
              i={0}
              icon={Hourglass}
              tint="amber"
              label={t('lab.tiles.waiting')}
              value={openCount('ordered')}
              unit={t('lab.units.sample')}
            />
            <Kpi
              i={1}
              icon={FlaskConical}
              tint="violet"
              label={t('lab.tiles.inProcess')}
              value={openCount('process')}
              unit=""
            />
            <Kpi
              i={2}
              icon={Clock}
              tint="navy"
              label={t('lab.tiles.toVerify')}
              value={openCount('resulted')}
              unit={t('lab.units.results')}
            />
            <Kpi
              i={3}
              icon={CircleCheck}
              tint="mint"
              label={t('lab.tiles.done')}
              value={doneAll.length}
              unit=""
            />
          </div>
        </section>

        <Panel
          i={1}
          icon={tab === 'open' ? FlaskConical : CircleCheck}
          tint={tab === 'open' ? 'violet' : 'mint'}
          title={t(tab === 'open' ? 'lab.worklist' : 'lab.resultsGiven')}
          right={tab === 'open' ? t('lab.openCount', { count: shown.length }) : undefined}
        >
          <ListBar
            query={query}
            onQuery={setQuery}
            sort={sort}
            onSort={setSort}
            sorts={['urgent', 'oldest', 'latest', 'name']}
            placeholderKey="lab.search"
          />
          {tab === 'open' && (
            <Seg<Filter>
              className="self-start"
              label={t('lab.filters.all')}
              value={filter}
              onChange={setFilter}
              options={(['all', 'ordered', 'process', 'resulted'] as const).map((f) => ({
                value: f,
                label: `${t(`lab.filters.${f}`)} (${count(f)})`,
              }))}
            />
          )}
          {paged.total === 0 ? (
            <Empty icon={FlaskConical}>{t(tab === 'open' ? 'lab.empty' : 'lab.noneDone')}</Empty>
          ) : (
            <div className="flex flex-col">
              {paged.slice.map((o, i) => (
                <LabOrderRow key={o.id} order={o} i={i} now={now} />
              ))}
            </div>
          )}
          <Pager {...paged} onPage={paged.setPage} />
        </Panel>
      </main>
    </StaffShell>
  )
}

const inFilterOf = (f: Filter, o: LabOrder) =>
  (f === 'ordered' && o.status === 'ordered') ||
  (f === 'process' && (o.status === 'collected' || o.status === 'in_process')) ||
  (f === 'resulted' && o.status === 'resulted')

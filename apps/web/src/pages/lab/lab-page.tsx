import { useState } from 'react'
import { CircleCheck, FlaskConical, Hourglass } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Empty, Panel } from '@/components/dash/kit'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { ListBar, Pager } from '@/components/ui/list-tools'
import { StaffShell } from '@/components/staff/staff-shell'
import { useLabWorklist, type LabOrder } from '@/lib/api/lab'
import { useNow } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { matches, usePaged, type SortKey } from '@/lib/paging'
import { cn } from '@/lib/utils'
import { LabOrderRow } from './lab-parts'

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
  const now = useNow()
  const [tab, setTab] = useState<'open' | 'done'>('open')
  const { data: orders = [] } = useLabWorklist(tab)
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

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="worklist">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <PageBanner
          icon={FlaskConical}
          tint="coral"
          title={t('lab.worklistTitle')}
          lead={t('lab.worklistLead')}
          user={user}
          meta={
            <BannerChip icon={Hourglass}>{t('lab.openCount', { count: orders.length })}</BannerChip>
          }
        />

        <div className="flex gap-1 self-start rounded-xl bg-white/70 p-1" role="tablist">
          {(['open', 'done'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cn(
                'inline-flex min-h-10 items-center gap-2 rounded-lg px-4 text-[14px] font-semibold',
                tab === k ? 'bg-navy text-white' : 'text-ink-2 hover:bg-hover',
              )}
            >
              {k === 'open' ? (
                <FlaskConical size={16} aria-hidden="true" />
              ) : (
                <CircleCheck size={16} aria-hidden="true" />
              )}
              {t(`lab.tabs.${k}`)}
            </button>
          ))}
        </div>

        <Panel
          i={1}
          icon={FlaskConical}
          tint="coral"
          title={t(tab === 'open' ? 'lab.worklist' : 'lab.resultsGiven')}
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
            <div className="flex flex-wrap gap-2">
              {(['all', 'ordered', 'process', 'resulted'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold',
                    filter === f
                      ? 'border-primary bg-primary text-white'
                      : 'border-border bg-card text-ink-2 hover:bg-hover',
                  )}
                >
                  {t(`lab.filters.${f}`)}
                  <span
                    className={cn(
                      'rounded-full px-1.5 text-[12px]',
                      filter === f ? 'bg-white/20' : 'bg-hover',
                    )}
                  >
                    {count(f)}
                  </span>
                </button>
              ))}
            </div>
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

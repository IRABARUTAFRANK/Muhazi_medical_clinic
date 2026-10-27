import { useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowRightLeft, FolderOpen, Lock, Stethoscope, UserPlus, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { StationGlyph } from '@/components/dash/kit'
import { EmptyNote } from '@/components/clinical/empty-note'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { ListBar, ShowMore } from '@/components/ui/list-tools'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { OpenFileLink } from '@/components/clinical/file-panel'
import { useOpenFileId } from '@/lib/panel-url'
import { LeftButton } from '@/components/clinical/left-button'
import { HandoverBadge } from '@/components/clinical/handover-badge'
import { useChangeFlash } from '@/components/clinical/use-change-flash'
import {
  STATIONS,
  openItems,
  sortQueue,
  useQueueBoard,
  type QueueItem,
  type Station,
} from '@/lib/api/visits'
import { formatDuration } from '@/lib/duration'
import { navForUser } from '@/lib/nav'
import { matches, useShowMore, type SortKey } from '@/lib/paging'
import { cn } from '@/lib/utils'

/**
 * "In the clinic": every patient with an open visit today, grouped by the station where they
 * are now (triage, consultation, laboratory, pharmacy, cashier…). Each row opens the visit
 * screen (to treat or charge) or the patient file (history). Refreshes every 15 seconds.
 */
export function VisitsPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const { data: items = [], isLoading, error } = useQueueBoard('all', user.role)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('urgent')
  // Search and order apply to every desk; each desk card then shows a few at a time.
  const open = sortQueue(
    openItems(items).filter((q) => matches(query, q.name, q.ticket, q.fileNumber)),
    sort,
  )
  // A patient shared by several desks ("first free doctor") is listed at each desk, counted once.
  const people = new Set(open.map((q) => q.encounterId)).size
  // Shared patients are shown once, in their own card, with the desks they wait at.
  const single = open.filter((i) => !i.poolId)
  const pools = [...new Map(open.filter((i) => i.poolId).map((i) => [i.poolId!, i])).values()].map(
    (first) => ({
      item: first,
      desks: open.filter((i) => i.poolId === first.poolId).map((i) => i.station),
    }),
  )
  const stations = STATIONS.filter((s) => single.some((i) => i.station === s))

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="visits">
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <PageBanner
          icon={Stethoscope}
          tint="mint"
          title={t('visits.title')}
          lead={t('visits.lead')}
          meta={<BannerChip icon={Stethoscope}>{t('visits.count', { count: people })}</BannerChip>}
        >
          <StaffLink to="/app/register" className={buttonVariants({ variant: 'primary' })}>
            <UserPlus size={18} aria-hidden="true" />
            {t('register.title')}
          </StaffLink>
        </PageBanner>

        {error && (
          <p
            role="alert"
            className="bg-red-bg text-red border-red/30 m-0 rounded-md border px-3 py-2 text-[13px] font-semibold"
          >
            {error.message}
          </p>
        )}
        {items.length > 0 && (
          <ListBar
            query={query}
            onQuery={setQuery}
            sort={sort}
            onSort={setSort}
            sorts={['urgent', 'longest', 'latest', 'name']}
            placeholderKey="list.searchPatient"
          />
        )}
        {!isLoading && open.length === 0 && (
          <Card>
            <CardBody>
              <EmptyNote>{t('visits.none')}</EmptyNote>
            </CardBody>
          </Card>
        )}

        {pools.length > 0 && (
          <Card className="anim-enter border-violet/30">
            <CardHeader>
              <span className="inline-flex items-center gap-2">
                <Users size={16} aria-hidden="true" className="text-violet" />
                {t('visits.pooled')}
              </span>
              <span className="text-ink-3 text-xs">{t('visits.pooledHint')}</span>
            </CardHeader>
            <ShownRows
              items={pools}
              render={(p) => (
                <VisitRow key={p.item.poolId} item={p.item} desks={p.desks} user={user} />
              )}
            />
          </Card>
        )}

        {/* Stations in the order a patient moves through the clinic */}
        <div className="pc:grid-cols-2 grid grid-cols-1 gap-4">
          {stations.map((s, gi) => {
            const rows = single.filter((i) => i.station === s)
            return (
              <Card key={s} className="anim-enter" style={{ '--i': gi } as CSSProperties}>
                <CardHeader>
                  <span className="inline-flex items-center gap-2">
                    <Stethoscope size={16} aria-hidden="true" />
                    {t(`register.stations.${s}`)}
                  </span>
                  <span className="text-ink-3 text-xs">
                    {t('visits.stationCount', {
                      waiting: rows.filter((r) => !r.startedAt).length,
                      busy: rows.filter((r) => r.startedAt).length,
                    })}
                  </span>
                </CardHeader>
                <ShownRows
                  items={rows}
                  render={(r) => <VisitRow key={r.queueId} item={r} user={user} />}
                />
              </Card>
            )
          })}
        </div>
      </main>
    </StaffShell>
  )
}

/** A desk's rows, six at a time with "Show more". */
function ShownRows<T>({ items, render }: { items: T[]; render: (item: T) => ReactNode }) {
  const m = useShowMore(items, 6)
  return (
    <>
      {m.visible.map(render)}
      {(m.rest > 0 || m.expanded) && (
        <div className="px-4 py-2">
          <ShowMore rest={m.rest} expanded={m.expanded} onMore={m.more} onLess={m.less} step={6} />
        </div>
      )}
    </>
  )
}

function VisitRow({
  item: r,
  desks,
  user,
}: {
  item: QueueItem
  desks?: Station[]
  user: StaffUser
}) {
  const { t } = useTranslation()
  // the row glows for a moment when the patient moves desk, is taken or changes colour
  const changed = useChangeFlash(`${r.station}|${r.startedAt}|${r.takenBy}|${r.triage}`)
  const fileOpen = useOpenFileId() === r.patientId
  return (
    <Row
      className={cn(
        'flex-wrap gap-x-3 gap-y-1 py-2',
        changed && 'anim-row-flash',
        fileOpen && 'bg-primary-tint/50 hover:bg-primary-tint/50',
      )}
    >
      <span className="text-primary w-14 font-semibold tabular-nums">{r.ticket}</span>
      <span className="min-w-[160px] flex-1">
        <span className="block font-semibold">{r.name}</span>
        <span className="text-ink-3 block text-xs tabular-nums">
          {r.fileNumber} · {r.ageSex} ·{' '}
          {r.startedAt
            ? t('visits.inProgress')
            : t('visits.waiting', { time: formatDuration(r.waitMin, t) })}
        </span>
        {r.referredBy && (
          <span
            className="text-violet mt-0.5 flex items-center gap-1 text-[13px] font-semibold"
            title={r.referralNote ?? undefined}
          >
            <ArrowRightLeft size={13} aria-hidden="true" />
            {t('refer.from', { name: r.referredBy })}
            {r.assignedName ? ` → ${r.assignedName}` : ''}
            {r.referralNote ? ` · “${r.referralNote}”` : ''}
          </span>
        )}
        <HandoverBadge handover={r.handover} className="mt-0.5 text-[13px]" />
        {desks && (
          <span className="mt-1 flex flex-wrap gap-1">
            {desks.map((d) => (
              <span
                key={d}
                className="bg-violet-bg text-violet inline-flex items-center gap-1 rounded px-2 py-0.5 text-[12px] font-semibold"
              >
                <StationGlyph station={d} size={12} />
                {t(`register.stations.${d}`)}
              </span>
            ))}
          </span>
        )}
      </span>
      <Badge tone={r.triage}>{t(`home.triage.${r.triage}`)}</Badge>
      {r.canWork === false ? (
        // sent to someone else: in the clinic, read only for me
        <StaffLink
          to="/app/visit"
          search={{ encounter: r.encounterId }}
          className={buttonVariants({ size: 'sm', variant: 'ghost' })}
          title={t('access.notYours', {
            holder: r.takenBy ?? r.assignedName ?? r.departmentName ?? '',
          })}
        >
          <Lock size={14} aria-hidden="true" />
          {t('access.view')}
        </StaffLink>
      ) : (
        <StaffLink
          to="/app/visit"
          search={{ encounter: r.encounterId }}
          className={buttonVariants({ size: 'sm', variant: 'primary' })}
        >
          <Stethoscope size={14} aria-hidden="true" />
          {t('visits.openVisit')}
        </StaffLink>
      )}
      {/* the file opens beside the list (teal tint: an action); middle-click: the whole page */}
      <OpenFileLink
        patientId={r.patientId}
        className={buttonVariants({ size: 'sm', variant: 'tint-teal' })}
        aria-label={t('visit.patientFile')}
        title={t('visit.patientFile')}
      >
        <FolderOpen size={14} aria-hidden="true" />
      </OpenFileLink>
      <LeftButton encounterId={r.encounterId} name={r.name} user={user} compact />
    </Row>
  )
}

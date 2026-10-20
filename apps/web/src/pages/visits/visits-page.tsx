import type { CSSProperties } from 'react'
import { FolderOpen, Stethoscope, UserPlus, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { StationGlyph } from '@/components/dash/kit'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { STATIONS, openItems, useQueueBoard, type QueueItem, type Station } from '@/lib/api/visits'
import { navForUser } from '@/lib/nav'

/**
 * "In the clinic": every patient with an open visit today, grouped by the station where they
 * are now (triage, consultation, laboratory, pharmacy, cashier…). Each row opens the visit
 * screen (to treat or charge) or the patient file (history). Refreshes every 15 seconds.
 */
export function VisitsPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const { data: items = [], isLoading, error } = useQueueBoard('all', user.role)
  const open = openItems(items)
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
          user={user}
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
            className="bg-red-bg text-red m-0 rounded-xl px-3 py-2 text-[13px] font-semibold"
          >
            {error.message}
          </p>
        )}
        {!isLoading && open.length === 0 && (
          <Card>
            <CardBody>
              <p className="text-ink-3 m-0 text-[13px]">{t('visits.none')}</p>
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
            {pools.map((p) => (
              <VisitRow key={p.item.poolId} item={p.item} desks={p.desks} />
            ))}
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
                {rows.map((r) => (
                  <VisitRow key={r.queueId} item={r} />
                ))}
              </Card>
            )
          })}
        </div>
      </main>
    </StaffShell>
  )
}

function VisitRow({ item: r, desks }: { item: QueueItem; desks?: Station[] }) {
  const { t } = useTranslation()
  return (
    <Row className="flex-wrap gap-x-3 gap-y-1 py-2">
      <span className="text-primary w-14 font-bold tabular-nums">{r.ticket}</span>
      <span className="min-w-[160px] flex-1">
        <span className="block font-semibold">{r.name}</span>
        <span className="text-ink-3 block text-xs tabular-nums">
          {r.fileNumber} · {r.ageSex} ·{' '}
          {r.startedAt ? t('visits.inProgress') : t('visits.waiting', { count: r.waitMin })}
        </span>
        {desks && (
          <span className="mt-1 flex flex-wrap gap-1">
            {desks.map((d) => (
              <span
                key={d}
                className="bg-violet-bg text-violet inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold"
              >
                <StationGlyph station={d} size={12} />
                {t(`register.stations.${d}`)}
              </span>
            ))}
          </span>
        )}
      </span>
      <Badge tone={r.triage}>{t(`home.triage.${r.triage}`)}</Badge>
      <StaffLink
        to="/app/visit"
        search={{ encounter: r.encounterId }}
        className={buttonVariants({ size: 'sm', variant: 'primary' })}
      >
        {t('visits.openVisit')}
      </StaffLink>
      <StaffLink
        to="/app/patient"
        search={{ id: r.patientId }}
        className={buttonVariants({ size: 'sm' })}
        aria-label={t('visit.patientFile')}
        title={t('visit.patientFile')}
      >
        <FolderOpen size={14} aria-hidden="true" />
      </StaffLink>
    </Row>
  )
}

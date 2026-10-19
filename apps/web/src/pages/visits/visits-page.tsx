import type { CSSProperties } from 'react'
import { FolderOpen, Stethoscope, UserPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { STATIONS, openItems, useQueueBoard, type QueueItem } from '@/lib/api/visits'
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
  const stations = STATIONS.filter((s) => open.some((i) => i.station === s))

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="visits">
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <div className="anim-enter flex flex-wrap items-end gap-3">
          <div className="min-w-[260px] flex-1">
            <h1 className="m-0 text-2xl font-bold">{t('visits.title')}</h1>
            <p className="text-ink-2 m-0 mt-1 max-w-[720px]">{t('visits.lead')}</p>
          </div>
          <span className="text-ink-2 tabular-nums">
            {t('visits.count', { count: open.length })}
          </span>
          <StaffLink to="/app/register" className={buttonVariants({ variant: 'primary' })}>
            <UserPlus size={18} aria-hidden="true" />
            {t('register.title')}
          </StaffLink>
        </div>

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

        {/* Stations in the order a patient moves through the clinic */}
        <div className="pc:grid-cols-2 grid grid-cols-1 gap-4">
          {stations.map((s, gi) => {
            const rows = open.filter((i) => i.station === s)
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

function VisitRow({ item: r }: { item: QueueItem }) {
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

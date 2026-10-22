import {
  AlertTriangle,
  Ban,
  Clock,
  Coins,
  PackageCheck,
  PackagePlus,
  Pill,
  RefreshCw,
  Users,
  Warehouse,
  Workflow,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf, formatTime, type StaffUser } from '@mmc/shared'
import { IdentityBanner } from '@/components/dash/identity-banner'
import { Empty, Kpi, ListRows, Panel, Pill as Tag, SectionTitle } from '@/components/dash/kit'
import { greetingFor } from '@/components/dash/kit-style'
import { NoticesPanel } from '@/components/dash/notices-panel'
import { Button, buttonVariants } from '@/components/ui/button'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { isLowStock, usePharmacyQueue, usePharmacySummary, useStockOverview } from '@/lib/api/stock'
import { useCan } from '@/lib/api/permissions'
import { openItems, useQueueBoard } from '@/lib/api/visits'
import { useNow } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { isLive } from '@/lib/supabase'
import { PharmacyDesk, SellMedicineCard } from '../stock/pharmacy-desk'
import { CallsPanel } from './calls-panel'
import { MyQueuePanel } from './role-panels'

/**
 * Pharmacy dashboard (pharmacists): the hand-over desk in the manager design. Figures of the day,
 * the prescriptions waiting one card per patient (hand over, or "not given" with the reason the
 * doctor is told), patients sent to the pharmacy without a prescription, stock to reorder or
 * about to expire, what was not given and what goes out most today.
 */
export function PharmacyDashboard({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const now = useNow(60_000)
  const can = useCan(user)
  const { data: s, refetch, isFetching, dataUpdatedAt } = usePharmacySummary()
  const { data: lines = [], refetch: refetchLines } = usePharmacyQueue()
  const { data: stock, refetch: refetchStock } = useStockOverview()
  const { data: board = [] } = useQueueBoard('pharmacy', user.role)
  const { data: everyone = [] } = useQueueBoard('all', user.role)
  // every patient in the clinic now (one per visit), for a sale without a prescription
  const inClinic = [...new Map(openItems(everyone).map((q) => [q.encounterId, q])).values()].map(
    (q) => ({
      encounterId: q.encounterId,
      label: `${q.ticket} · ${q.name} · ${q.fileNumber}`,
    }),
  )
  // At the pharmacy desk without a medicine to hand over (sent to buy something, to ask…).
  const withRx = new Set(lines.map((l) => l.encounterId))
  const others = openItems(board).filter((q) => !withRx.has(q.encounterId))
  const items = (stock?.items ?? []).filter((i) => i.active)
  const low = items.filter(isLowStock)
  const expiring = items.filter(
    (i) => i.earliestExpiry && new Date(i.earliestExpiry).getTime() < now + 90 * 86_400_000,
  )

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="home">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <IdentityBanner user={user} greeting={greetingFor(user.name, t)} />

        <div className="anim-enter flex flex-wrap items-center gap-3">
          <div className="text-ink-2 flex min-w-[240px] flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <Pill size={16} aria-hidden="true" className="text-primary" />
              {t('pharmacy.desk')}
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
            onClick={() => {
              // the figures, the hand-over list and the stock together
              void refetch()
              void refetchLines()
              void refetchStock()
            }}
            loading={isFetching}
            aria-label={t('dashboard.refresh')}
            title={t('dashboard.refresh')}
          >
            {!isFetching && <RefreshCw size={16} aria-hidden="true" />}
          </Button>
          {can('stock.write') && (
            <StaffLink
              to="/app/stock"
              search={{ tab: 'receive' }}
              className={buttonVariants({ size: 'md' })}
            >
              <PackagePlus size={16} aria-hidden="true" />
              {t('pharmacy.receive')}
            </StaffLink>
          )}
          <StaffLink
            to="/app/stock"
            search={{ tab: 'stock' }}
            className={buttonVariants({ variant: 'primary', size: 'md' })}
          >
            <Warehouse size={16} aria-hidden="true" />
            {t('pharmacy.openStock')}
          </StaffLink>
        </div>

        {s && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(230px,1fr))] sm:gap-4">
            <Kpi
              i={0}
              icon={Pill}
              tint="violet"
              label={t('pharmacy.tiles.toHandOver')}
              value={s.lines}
              unit={t('pharmacy.units.forPatients', { count: s.patients })}
              delta={
                s.lines > 0 ? { text: t('pharmacy.serveSoon'), good: false, up: null } : undefined
              }
            />
            <Kpi
              i={1}
              icon={PackageCheck}
              tint="mint"
              label={t('pharmacy.tiles.given')}
              value={s.dispensedToday}
              unit={t('pharmacy.units.patientsServed', { count: s.patientsServedToday })}
            />
            <Kpi
              i={2}
              icon={Coins}
              tint="navy"
              label={t('pharmacy.tiles.sales')}
              value={s.salesToday}
              text={formatRwf(s.salesToday)}
              unit={t('dashboard.period.today')}
            />
            <Kpi
              i={3}
              icon={Ban}
              tint="coral"
              label={t('pharmacy.tiles.notGiven')}
              value={s.notGivenToday}
              unit={t('dashboard.period.today')}
            />
            <Kpi
              i={4}
              icon={AlertTriangle}
              tint="amber"
              label={t('stock.tiles.low')}
              value={low.length}
              unit={t('stock.units.toReorder')}
              delta={
                low.length > 0 ? { text: t('stock.reorderSoon'), good: false, up: null } : undefined
              }
            />
            <Kpi
              i={5}
              icon={AlertTriangle}
              tint="coral"
              label={t('stock.tiles.expiring')}
              value={expiring.length}
              unit={t('stock.units.in90')}
            />
          </div>
        )}

        <CallsPanel user={user} />

        <section className="flex flex-col gap-3">
          <SectionTitle icon={Workflow}>{t('pharmacy.section')}</SectionTitle>
          <div className="pc:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] grid grid-cols-1 gap-4">
            <div className="flex min-w-0 flex-col gap-4">
              <PharmacyDesk canDispense />
              <SellMedicineCard patients={inClinic} />
              {others.length > 0 && (
                <MyQueuePanel
                  title={t('pharmacy.atDesk')}
                  rows={others}
                  counts={{
                    waiting: others.filter((r) => !r.startedAt).length,
                    inProgress: others.filter((r) => r.startedAt).length,
                    done: 0,
                  }}
                  rowAction="open"
                />
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <Panel
                i={2}
                icon={AlertTriangle}
                tint="amber"
                title={t('pharmacy.stockAlerts')}
                right={String(low.length + expiring.length)}
              >
                {low.length + expiring.length === 0 ? (
                  <Empty>{t('pharmacy.stockFine')}</Empty>
                ) : (
                  <ListRows
                    rows={[
                      ...low.slice(0, 6).map((i) => ({
                        key: `low-${i.id}`,
                        pill: <Tag tint="amber">{t('stock.low')}</Tag>,
                        label: `${i.name}${i.strength ? ` ${i.strength}` : ''}`,
                        value: t('pharmacy.leftOf', { count: i.onHand, level: i.reorderLevel }),
                      })),
                      ...expiring.slice(0, 6).map((i) => ({
                        key: `exp-${i.id}`,
                        pill: <Tag tint="coral">{t('pharmacy.expires')}</Tag>,
                        label: `${i.name}${i.strength ? ` ${i.strength}` : ''}`,
                        value: formatDate(new Date(i.earliestExpiry!)),
                      })),
                    ]}
                  />
                )}
                <StaffLink
                  to="/app/stock"
                  search={{ tab: 'stock' }}
                  className={buttonVariants({ size: 'sm' })}
                >
                  {t('pharmacy.openStock')} →
                </StaffLink>
              </Panel>
              {s && s.notGiven.length > 0 && (
                <Panel
                  i={3}
                  icon={Ban}
                  tint="coral"
                  title={t('pharmacy.notGivenToday')}
                  right={String(s.notGiven.length)}
                >
                  <ListRows
                    rows={s.notGiven.slice(0, 6).map((n, i) => ({
                      key: `${n.at}-${i}`,
                      pill: <Tag tint="coral">{formatTime(new Date(n.at))}</Tag>,
                      label: `${n.item} · ${n.patient}`,
                      value: n.reason ?? '',
                    }))}
                  />
                </Panel>
              )}
              {s && (
                <Panel
                  i={4}
                  icon={Users}
                  tint="violet"
                  title={t('pharmacy.mostGiven')}
                  right={t('pharmacy.givenCount', { count: s.dispensedToday })}
                >
                  {s.topToday.length === 0 && <Empty>{t('pharmacy.nothingYet')}</Empty>}
                  <ListRows
                    rows={s.topToday.map((b, i) => ({
                      key: b.item,
                      pill: <Tag tint={i === 0 ? 'amber' : 'teal'}>{i + 1}</Tag>,
                      label: b.item,
                      value: String(b.count),
                    }))}
                  />
                </Panel>
              )}
              <NoticesPanel limit={4} />
            </div>
          </div>
        </section>
      </main>
    </StaffShell>
  )
}

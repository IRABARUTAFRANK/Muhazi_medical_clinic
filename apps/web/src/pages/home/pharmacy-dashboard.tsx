import { useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  CalendarX,
  Clock,
  Coins,
  MessageSquare,
  PackageCheck,
  PackagePlus,
  Pill,
  RefreshCw,
  Users,
  Wallet,
  Warehouse,
  Workflow,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { usePeriod } from '@/lib/period'
import { PeriodCustom, PeriodSeg } from '@/components/dash/period-filter'
import { formatDate, formatRwf, formatTime, type StaffUser } from '@mmc/shared'
import { IdentityBanner } from '@/components/dash/identity-banner'
import { Empty, Kpi, ListRows, Panel, Pill as Tag, SectionTitle } from '@/components/dash/kit'
import { greetingFor } from '@/components/dash/kit-style'
import { periodSearch, useAnalyticsLink } from '@/components/dash/analytics-links'
import { NoticesPanel } from '@/components/dash/notices-panel'
import { Button, actionLink, buttonVariants } from '@/components/ui/button'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { isLowStock, usePharmacyQueue, usePharmacySummary, useStockOverview } from '@/lib/api/stock'
import {
  EXPIRY_WINDOW_DAYS,
  expiresSoon,
  useDailyStockAlertCheck,
  usePharmacyActions,
  useStockTotals,
} from '@/lib/api/pharmacy'
import { useConfirm } from '@/lib/confirm'
import { Flash } from '@/components/ui/flash'
import { cn } from '@/lib/utils'
import { useCan, useSwitchedOff } from '@/lib/api/permissions'
import { NotAllowedNotice } from '@/components/clinical/perm-gate'
import { openItems, useQueueBoard } from '@/lib/api/visits'
import { useNow } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { isLive } from '@/lib/supabase'
import { PharmacyDesk, SellMedicineCard } from '../stock/pharmacy-desk'
import { CallsPanel } from './calls-panel'
import { MyQueuePanel } from './role-panels'
import { DeskBlocks } from './home-desks'

/**
 * Pharmacy dashboard (pharmacists): the hand-over desk in the manager design. Figures of the day
 * (the revenue of prescriptions and walk-in sales) and of the stock (stock_totals: low, expiring
 * within 30 days, expired on the shelf, inventory value), the prescriptions waiting one card per
 * patient (hand over all or a part, or "not given" with the reason the doctor is told), the walk-in
 * sales the pharmacist takes the payment of, patients sent to the pharmacy without a prescription,
 * stock to reorder, expired or about to expire, what was not given and what goes out most today.
 * "Message the manager" sends a notice to every manager; the stock notices are checked once a day.
 */
export function PharmacyDashboard({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const now = useNow(60_000)
  const can = useCan(user)
  // receiving and managing stock follow the manager's switch; handing over stays
  const switchedOff = useSwitchedOff(user)
  // the figures of the chosen period (today by default; lists of what waits now stay "now")
  const period = usePeriod('today')
  const days = period.range === 'today' ? null : { from: period.from, to: period.to }
  const periodWord = t(`dashboard.period.${period.range}`)
  // the pharmacy figures open the Analytics page (the manager, a head whose department has the
  // pharmacy); for anyone else they stay plain, and the stock tiles open the stock page
  const link = useAnalyticsLink(periodSearch(period))
  const stockLink = link('stock') ?? '/app/stock'
  const { data: s, refetch, isFetching, dataUpdatedAt } = usePharmacySummary(days)
  const { data: lines = [], refetch: refetchLines } = usePharmacyQueue()
  const { data: stock, refetch: refetchStock } = useStockOverview()
  const { data: board = [] } = useQueueBoard('pharmacy', user.role)
  const { data: everyone = [] } = useQueueBoard('all', user.role)
  // every patient in the clinic now (one per visit), for a sale without a prescription
  const inClinic = [...new Map(openItems(everyone).map((q) => [q.encounterId, q])).values()].map(
    (q) => ({
      encounterId: q.encounterId,
      name: q.name,
      fileNumber: q.fileNumber,
      ticket: q.ticket,
      where: t(`register.stations.${q.station}`),
    }),
  )
  // At the pharmacy desk without a medicine to hand over (sent to buy something, to ask…).
  const withRx = new Set(lines.map((l) => l.encounterId))
  const others = openItems(board).filter((q) => !withRx.has(q.encounterId))
  const items = (stock?.items ?? []).filter((i) => i.active)
  const low = items.filter(isLowStock)
  // the stock totals (stock_totals); an old database: counted from the overview
  const { data: totalsRaw, refetch: refetchTotals } = useStockTotals(null)
  const expiryDays = totalsRaw?.expiryDays ?? EXPIRY_WINDOW_DAYS
  // the next batch expires within the window (stock.expiry_days, 30), not yet expired
  const expiring = items.filter((i) => expiresSoon(i, expiryDays))
  // expired batches still on the shelf: urgent until written off
  const expired = items.filter((i) => i.expiredUnits > 0)
  const totals = totalsRaw ?? {
    inventoryCost: Math.round(items.reduce((n, i) => n + i.costValue, 0)),
    sellingValue: Math.round(items.reduce((n, i) => n + i.onHand * (i.sellingPrice ?? 0), 0)),
    items: items.length,
    low: low.length,
    expiring30: expiring.length,
    expiredUnits: items.reduce((n, i) => n + i.expiredUnits, 0),
    expiredCost: Math.round(items.reduce((n, i) => n + i.expiredUnits * (i.avgCost ?? 0), 0)),
    expiryDays,
  }
  // the day's revenue: medicines on the visits' bills (prescriptions and sales) + walk-in sales
  const walkIn = s?.counterSalesTotal ?? 0
  const revenue = (s?.salesToday ?? 0) + walkIn
  // the stock notices (low, expiring, expired, the daily summary): once a day per person
  useDailyStockAlertCheck(true)
  const { messageManager } = usePharmacyActions()
  const confirm = useConfirm()
  const [sent, setSent] = useState<{ ok: boolean; text: string } | null>(null)

  const askManager = async () => {
    const r = await confirm({
      title: t('pharmacy.home.messageTitle'),
      body: t('pharmacy.home.messageBody'),
      input: {
        label: t('pharmacy.home.messageLabel'),
        placeholder: t('pharmacy.home.messagePh'),
        required: true,
        multiline: true,
        maxLength: 500,
      },
      confirmLabel: t('pharmacy.home.messageSend'),
    })
    if (!r.ok) return
    if (r.value.length < 3) return setSent({ ok: false, text: t('pharmacy.home.messageShort') })
    try {
      await messageManager.mutateAsync(r.value)
      setSent({ ok: true, text: t('pharmacy.home.messageSent') })
    } catch (e) {
      setSent({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="home">
      <main className="pc:p-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <IdentityBanner user={user} greeting={greetingFor(user.name, t)} />
        {switchedOff('stock.write') && <NotAllowedNotice feature="stock.write" compact />}

        <div className="flex flex-wrap items-center gap-3">
          <div className="text-ink-2 flex min-w-[min(240px,100%)] flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
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
          <PeriodSeg period={period} />
          <Button
            variant="tint-grey"
            size="icon"
            onClick={() => {
              // the figures, the hand-over list and the stock together
              void refetch()
              void refetchLines()
              void refetchStock()
              void refetchTotals()
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
              {t('pharmacy.home.addStock')}
            </StaffLink>
          )}
          <Button
            variant="tint-violet"
            onClick={() => void askManager()}
            loading={messageManager.isPending}
          >
            {!messageManager.isPending && <MessageSquare size={16} aria-hidden="true" />}
            {t('pharmacy.home.messageManager')}
          </Button>
          <StaffLink
            to="/app/stock"
            search={{ tab: 'stock' }}
            className={buttonVariants({ variant: 'primary', size: 'md' })}
          >
            <Warehouse size={16} aria-hidden="true" />
            {t('pharmacy.openStock')}
          </StaffLink>
          <PeriodCustom period={period} className="basis-full" />
        </div>
        {sent && (
          <Flash key={sent.text} tone={sent.ok ? 'success' : 'error'} onClose={() => setSent(null)}>
            {sent.text}
          </Flash>
        )}

        {s && (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3 sm:grid-cols-[repeat(auto-fit,minmax(210px,1fr))]">
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
              unit={t('pharmacy.units.patientsServed', {
                count: s.patientsServedToday,
                period: periodWord,
              })}
              to={link('staff', { kind: 'medicinesGiven' })}
            />
            <Kpi
              i={2}
              icon={Coins}
              tint="navy"
              label={t('pharmacy.home.revenue', { period: periodWord })}
              value={revenue}
              text={formatRwf(revenue)}
              unit={t('pharmacy.home.revenueSplit', {
                rx: formatRwf(s.salesToday),
                walkIn: formatRwf(walkIn),
              })}
              to={link('pharmacy')}
            />
            <Kpi
              i={3}
              icon={Ban}
              tint="coral"
              label={t('pharmacy.tiles.notGiven')}
              value={s.notGivenToday}
              unit={periodWord}
              to={link('pharmacy', { by: 'notGiven' })}
            />
            <Kpi
              i={4}
              icon={AlertTriangle}
              tint="amber"
              label={t('stock.tiles.low')}
              value={totals.low}
              unit={t('stock.units.toReorder')}
              delta={
                totals.low > 0 ? { text: t('stock.reorderSoon'), good: false, up: null } : undefined
              }
              to={stockLink}
            />
            <Kpi
              i={5}
              icon={AlertTriangle}
              tint="coral"
              label={t('stock.tiles.expiring')}
              value={totals.expiring30}
              unit={t('pharmacy.home.withinDays', { count: expiryDays })}
              to={stockLink}
            />
            <Kpi
              i={6}
              icon={CalendarX}
              tint="coral"
              label={t('pharmacy.home.expired')}
              value={totals.expiredUnits}
              unit={t('pharmacy.home.expiredUnit', { amount: formatRwf(totals.expiredCost) })}
              delta={
                totals.expiredUnits > 0
                  ? { text: t('pharmacy.home.writeOff'), good: false, up: null }
                  : undefined
              }
              to={stockLink}
            />
            <Kpi
              i={7}
              icon={Wallet}
              tint="teal"
              label={t('pharmacy.home.inventory')}
              value={totals.inventoryCost}
              text={formatRwf(totals.inventoryCost)}
              unit={t('pharmacy.home.sellsFor', { amount: formatRwf(totals.sellingValue) })}
              to={stockLink}
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
                right={String(expired.length + low.length + expiring.length)}
                to={link('stock')}
              >
                {expired.length + low.length + expiring.length === 0 ? (
                  <Empty>{t('pharmacy.home.stockFine', { count: expiryDays })}</Empty>
                ) : (
                  <ListRows
                    rows={[
                      // expired first: urgent until written off
                      ...expired.slice(0, 6).map((i) => ({
                        key: `expired-${i.id}`,
                        pill: <Tag tint="coral">{t('pharmacy.home.expiredTag')}</Tag>,
                        label: `${i.name}${i.strength ? ` ${i.strength}` : ''}`,
                        value: t('pharmacy.home.expiredLeft', { count: i.expiredUnits }),
                      })),
                      ...low.slice(0, 6).map((i) => ({
                        key: `low-${i.id}`,
                        pill: <Tag tint="amber">{t('stock.low')}</Tag>,
                        label: `${i.name}${i.strength ? ` ${i.strength}` : ''}`,
                        // the usable units at the pharmacy: what the "Low" rule judges
                        value: t('pharmacy.leftOf', {
                          count: i.pharmacyUsable ?? i.onHand,
                          level: i.reorderLevel,
                        }),
                      })),
                      ...expiring.slice(0, 6).map((i) => ({
                        key: `exp-${i.id}`,
                        pill: <Tag tint="coral">{t('pharmacy.expires')}</Tag>,
                        label: `${i.name}${i.strength ? ` ${i.strength}` : ''}`,
                        value: formatDate(new Date((i.nextExpiry ?? i.earliestExpiry)!)),
                      })),
                    ]}
                  />
                )}
                <StaffLink
                  to="/app/stock"
                  search={{ tab: 'stock' }}
                  className={cn(actionLink, 'self-start text-[13px]')}
                >
                  {t('pharmacy.openStock')}
                  <ArrowRight size={14} aria-hidden="true" />
                </StaffLink>
              </Panel>
              {s && s.notGiven.length > 0 && (
                <Panel
                  i={3}
                  icon={Ban}
                  tint="coral"
                  title={t('pharmacy.notGivenToday', { period: periodWord })}
                  right={String(s.notGiven.length)}
                  to={link('pharmacy', { by: 'notGiven' })}
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
                  title={t('pharmacy.mostGivenIn', { period: periodWord })}
                  right={t('pharmacy.givenCount', { count: s.dispensedToday })}
                  to={link('pharmacy')}
                >
                  {s.topToday.length === 0 && (
                    <Empty>{t('pharmacy.nothingYetIn', { period: periodWord })}</Empty>
                  )}
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
        {/* the desks the person's departments give besides this one */}
        <DeskBlocks user={user} kind="pharmacy" />
      </main>
    </StaffShell>
  )
}

import type { CSSProperties } from 'react'
import {
  Banknote,
  Clock,
  HandCoins,
  PieChart,
  Receipt,
  RefreshCw,
  Smartphone,
  UserRound,
  Wallet,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumber, formatRwf, formatTime, type StaffUser } from '@mmc/shared'
import { DoctorCalendarsSection } from '@/components/calendar/doctor-calendars-section'
import { HBarList } from '@/components/charts/hbar'
import { IdentityBanner } from '@/components/dash/identity-banner'
import { Empty, Kpi, Panel, Pill, SectionTitle } from '@/components/dash/kit'
import { delta, greetingFor } from '@/components/dash/kit-style'
import { NoticesPanel } from '@/components/dash/notices-panel'
import { Button, buttonVariants } from '@/components/ui/button'
import { ShownList } from '@/components/ui/list-tools'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { useCashierSummary } from '@/lib/api/finance'
import { useHomeSummary } from '@/lib/api/home'
import { openItems, useQueueBoard } from '@/lib/api/visits'
import { navForUser } from '@/lib/nav'
import { isLive } from '@/lib/supabase'
import { MyQueuePanel } from './role-panels'

const METHOD_ICON: Record<string, LucideIcon> = {
  cash: Banknote,
  momo: Smartphone,
  airtel: Smartphone,
}
const METHOD_COLORS = ['var(--mmc-green-dot)', 'var(--mmc-yellow-dot)', 'var(--mmc-red-dot)']

/**
 * Finance (cashier) dashboard in the manager design: what came in today and how (cash, MTN MoMo,
 * Airtel Money), against yesterday; the bills still to collect with "Take payment"; every payment
 * of the day with its receipt; the patients waiting at the cashier.
 */
export function CashierDashboard({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const { data: s, refetch, isFetching, dataUpdatedAt } = useCashierSummary(null)
  const { data: home } = useHomeSummary()
  const { data: queue = [] } = useQueueBoard('cashier', user.role)
  const rows = openItems(queue)
  const bills = home?.openBills ?? []
  const amountOf = (m: string) => s?.byMethod.find((x) => x.method === m)?.amount ?? 0
  const methodName = (m: string) => t(`visit.payment.methods.${m}`, { defaultValue: m })

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="home">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <IdentityBanner user={user} greeting={greetingFor(user.name, t)} />

        <div className="anim-enter flex flex-wrap items-center gap-3">
          <div className="text-ink-2 flex min-w-[240px] flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <Wallet size={16} aria-hidden="true" className="text-primary" />
              {t('finance.desk')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock size={15} aria-hidden="true" className="text-ink-3" />
              {t('dashboard.subtitleUpdated', {
                time: formatTime(dataUpdatedAt ? new Date(dataUpdatedAt) : new Date()),
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
          <StaffLink to="/app/payments" className={buttonVariants({ size: 'md' })}>
            <Clock size={16} aria-hidden="true" />
            {t('finance.dayClose')}
          </StaffLink>
          <StaffLink to="/app/bills" className={buttonVariants({ variant: 'primary', size: 'md' })}>
            <Receipt size={16} aria-hidden="true" />
            {t('finance.openBillsBtn')}
          </StaffLink>
        </div>

        {s && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(150px,1fr))] sm:gap-4">
            <Kpi
              i={0}
              icon={HandCoins}
              tint="violet"
              label={t('finance.tiles.collected')}
              value={s.total}
              unit="RWF"
              delta={delta(s.total, s.previousTotal, true, t)}
            />
            <Kpi
              i={1}
              icon={Banknote}
              tint="mint"
              label={methodName('cash')}
              value={amountOf('cash')}
              unit="RWF"
            />
            <Kpi
              i={2}
              icon={Smartphone}
              tint="amber"
              label={methodName('momo')}
              value={amountOf('momo')}
              unit="RWF"
            />
            <Kpi
              i={3}
              icon={Smartphone}
              tint="coral"
              label={methodName('airtel')}
              value={amountOf('airtel')}
              unit="RWF"
            />
            <Kpi
              i={4}
              icon={Receipt}
              tint="navy"
              label={t('finance.tiles.openBills')}
              value={s.openBills}
              unit={formatRwf(s.openDue)}
              delta={
                s.openBills > 0
                  ? { text: t('finance.toCollect'), good: false, up: null }
                  : undefined
              }
            />
            <Kpi
              i={5}
              icon={UserRound}
              tint="teal"
              label={t('finance.tiles.mine')}
              value={s.mine}
              unit="RWF"
            />
          </div>
        )}

        <section className="flex flex-col gap-3">
          <SectionTitle icon={Workflow}>{t('finance.section')}</SectionTitle>
          <div className="pc:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] grid grid-cols-1 gap-4">
            <Panel
              i={1}
              icon={Receipt}
              tint="coral"
              title={t('home.openBills')}
              right={t('home.billsDue', {
                count: bills.length,
                amount: formatRwf(bills.reduce((x, b) => x + b.balance, 0)),
              })}
            >
              {bills.length === 0 ? (
                <Empty>{t('home.noOpenBills')}</Empty>
              ) : (
                <ShownList items={bills} step={6}>
                  {(shown) => (
                    <div className="flex flex-col">
                      {shown.map((b, i) => (
                        <div
                          key={b.encounterId}
                          className="border-grid anim-enter flex min-h-12 flex-wrap items-center gap-2.5 border-b py-2 text-[14px] last:border-b-0"
                          style={{ '--i': i } as CSSProperties}
                        >
                          <Pill tint="amber" icon={Receipt}>
                            {b.ticket ?? '—'}
                          </Pill>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold">{b.name}</span>
                            <span className="text-ink-3 block truncate text-[13px]">
                              {b.file}
                              {b.station
                                ? ` · ${t('home.atStation', { station: t(`register.stations.${b.station}`, { defaultValue: b.station }) })}`
                                : ''}
                            </span>
                          </span>
                          <span className="font-bold whitespace-nowrap tabular-nums">
                            {formatRwf(b.balance)}
                          </span>
                          <StaffLink
                            to="/app/visit"
                            search={{ encounter: b.encounterId }}
                            className={buttonVariants({
                              variant: i === 0 ? 'primary' : 'default',
                              size: 'sm',
                            })}
                          >
                            <Wallet size={14} aria-hidden="true" />
                            {t('home.takePayment')}
                          </StaffLink>
                        </div>
                      ))}
                    </div>
                  )}
                </ShownList>
              )}
            </Panel>
            <div className="flex min-w-0 flex-col gap-4">
              {s && (
                <Panel
                  i={2}
                  icon={PieChart}
                  tint="mint"
                  title={t('finance.byMethod')}
                  right={formatRwf(s.total)}
                >
                  {s.byMethod.length === 0 ? (
                    <Empty>{t('finance.nothingYet')}</Empty>
                  ) : (
                    <HBarList
                      subject="money"
                      colors={METHOD_COLORS}
                      labelWidth="minmax(110px,140px)"
                      rows={['cash', 'momo', 'airtel'].map((m) => ({
                        icon: METHOD_ICON[m],
                        label: methodName(m),
                        value: amountOf(m),
                        display: formatNumber(amountOf(m)),
                      }))}
                    />
                  )}
                </Panel>
              )}
              <MyQueuePanel
                title={t('home.myQueue', { station: t('register.stations.cashier') })}
                rows={rows}
                counts={{
                  waiting: rows.filter((r) => !r.startedAt).length,
                  inProgress: rows.filter((r) => r.startedAt).length,
                  done: s?.count ?? 0,
                }}
                rowAction="open"
              />
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <SectionTitle icon={HandCoins}>{t('finance.todaysPayments')}</SectionTitle>
          <div className="pc:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] grid grid-cols-1 gap-4">
            <Panel
              i={1}
              icon={HandCoins}
              tint="violet"
              title={t('finance.payments')}
              right={String(s?.count ?? 0)}
            >
              {!s || s.payments.length === 0 ? (
                <Empty>{t('finance.nothingYet')}</Empty>
              ) : (
                <ShownList items={s.payments} step={6}>
                  {(shown) => (
                    <div className="flex flex-col">
                      {shown.map((p, i) => {
                        const Icon = METHOD_ICON[p.method] ?? Wallet
                        return (
                          <div
                            key={p.id}
                            className="border-grid anim-enter flex min-h-11 flex-wrap items-center gap-2.5 border-b py-2 text-[14px] last:border-b-0"
                            style={{ '--i': i } as CSSProperties}
                          >
                            <span className="text-ink-3 w-12 tabular-nums">
                              {formatTime(new Date(p.at))}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-semibold">{p.patient}</span>
                              <span className="text-ink-3 flex items-center gap-1 truncate text-[13px]">
                                <Icon size={12} aria-hidden="true" />
                                {[methodName(p.method), p.reference, p.invoice]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </span>
                            </span>
                            <span className="font-bold whitespace-nowrap tabular-nums">
                              {formatRwf(p.amount)}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </ShownList>
              )}
            </Panel>
            <NoticesPanel limit={4} />
          </div>
        </section>
        <DoctorCalendarsSection user={user} />
      </main>
    </StaffShell>
  )
}

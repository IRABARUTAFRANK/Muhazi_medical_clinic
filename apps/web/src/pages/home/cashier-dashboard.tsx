import { useState, type CSSProperties } from 'react'
import {
  Banknote,
  Clock,
  HandCoins,
  PieChart,
  Printer,
  Receipt,
  ReceiptText,
  RefreshCw,
  Smartphone,
  UserRound,
  UserRoundCheck,
  Users,
  Wallet,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumber, formatRwf, formatTime, type StaffUser } from '@mmc/shared'
import { DoctorCalendarsSection } from '@/components/calendar/doctor-calendars-section'
import { HBarList } from '@/components/charts/hbar'
import { IdentityBanner } from '@/components/dash/identity-banner'
import { Empty, Kpi, Panel, SectionTitle } from '@/components/dash/kit'
import { PeriodCustom, PeriodSeg } from '@/components/dash/period-filter'
import { delta, greetingFor } from '@/components/dash/kit-style'
import { periodSearch, useAnalyticsLink } from '@/components/dash/analytics-links'
import { DashLink } from '@/components/dash/dash-link'
import { NoticesPanel } from '@/components/dash/notices-panel'
import { Button, buttonVariants } from '@/components/ui/button'
import { ShownList } from '@/components/ui/list-tools'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { useReceiptsInPeriod } from '@/lib/api/analytics-receipts'
import { useCashierSummary, useUnpaidDebts } from '@/lib/api/finance'
import { useLetterhead } from '@/lib/report-parts'
import { openReceiptsBatch } from '@/lib/reports/receipts-print'
import { useHomeSummary } from '@/lib/api/home'
import { useMySummary } from '@/lib/api/my'
import { navForUser } from '@/lib/nav'
import { periodHref, useSearchPeriod } from '@/lib/period'
import { isLive } from '@/lib/supabase'
import { CallsPanel } from './calls-panel'
import { MyWorkPanel, WaitingForMePanel } from './my-panels'
import { WORK_OF } from './my-work'
import { DebtsPanel } from '@/pages/finance/finance-pages'
import { NotAllowedNotice } from '@/components/clinical/perm-gate'
import { useCan } from '@/lib/api/permissions'
import { OpenBillsPanel } from './bills-panel'

const METHOD_ICON: Record<string, LucideIcon> = {
  cash: Banknote,
  momo: Smartphone,
  airtel: Smartphone,
}
const METHOD_COLORS = ['var(--mmc-green-dot)', 'var(--mmc-yellow-dot)', 'var(--mmc-red-dot)']

/**
 * Finance (cashier) dashboard in the manager design, personal since 0120: what I took over the
 * chosen period (today by default) and how (cash, MTN MoMo, Airtel Money), against the period
 * before; the patients waiting at my desk; the bills still to collect with "Take payment" (the
 * desk's tool); my payments of the period with their receipts. The desk's total and the
 * clinic's money are the manager's. The day close stays on the Payments page, one day at a time.
 */
export function CashierDashboard({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  // the money of the chosen period (today = the one-day summary, as before)
  const period = useSearchPeriod('today')
  const {
    data: s,
    error,
    refetch,
    isFetching,
    dataUpdatedAt,
  } = useCashierSummary(
    null,
    period.range === 'today' ? null : { from: period.from, to: period.to },
  )
  // an older database answers with today's figures only: name them so
  const range = s?.todayOnly ? 'today' : period.range
  const periodWord = t(`dashboard.period.${range}`)
  // the manager opens the money on the Analytics page; a cashier keeps the payments page
  const link = useAnalyticsLink(periodSearch(period))
  const { data: home } = useHomeSummary()
  // my own money and my own queue (0120)
  const { data: my, refetch: refetchMine } = useMySummary(
    period.range === 'today' ? null : { from: period.from, to: period.to },
  )
  // an earlier day's visit still open with money due is an unpaid bill, not an open bill of
  // today: listed once, under Unpaid bills
  const { data: debts = [] } = useUnpaidDebts()
  const earlier = new Set(debts.filter((d) => d.status === 'open').map((d) => d.encounterId))
  const bills = (home?.openBills ?? []).filter((b) => !earlier.has(b.encounterId))
  // what I took less the money I gave back, as my cash count expects; the refunds come by
  // method from the desk summary (mine only)
  const refundedOf = (m: string) =>
    (s?.refunds ?? []).filter((r) => r.method === m && r.mine).reduce((sum, r) => sum + r.amount, 0)
  const amountOf = (m: string) =>
    (my?.money?.byMethod.find((x) => x.method === m)?.amount ?? 0) - refundedOf(m)
  const collected = (my?.money?.payments.amount ?? 0) - (my?.money?.refunds.amount ?? 0)
  const collectedBefore = my?.money?.payments.prevAmount ?? 0
  const methodName = (m: string) => t(`visit.payment.methods.${m}`, { defaultValue: m })
  // the manager's switch "Take payments": switched off, the cashier still sees the money
  const canTake = useCan(user)('payment.take')
  // the receipts given in the period (0102): how many, for how much, and all of them printed
  const receiptsGot = useReceiptsInPeriod({ from: period.from, to: period.to })
  // mine only: the receipts I gave
  const receipts = {
    ...receiptsGot,
    data: receiptsGot.data
      ? (() => {
          const rows = receiptsGot.data.receipts.filter(
            (r) => !r.cashierId || r.cashierId === user.id,
          )
          return {
            ...receiptsGot.data,
            receipts: rows,
            count: rows.length,
            total: rows.reduce((n, r) => n + r.amount, 0),
          }
        })()
      : undefined,
  }
  // my payments of the period (the desk's other cashiers are not my business)
  const myPayments = (s?.payments ?? []).filter((p) => p.mine !== false)
  const letterhead = useLetterhead()
  const [printError, setPrintError] = useState<string | null>(null)
  const printReceipts = () => {
    setPrintError(null)
    const rows = receipts.data?.receipts ?? []
    const ok = openReceiptsBatch({
      rows,
      from: period.from,
      to: period.to,
      clinic: letterhead,
      printedBy: user.name,
    })
    if (!ok) setPrintError(rows.length ? t('report.popupBlocked') : t('finance.nothingYet'))
  }
  const receiptsWord = t('analytics.views.receipts', { defaultValue: 'Receipts' })

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="home">
      <main className="pc:p-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <IdentityBanner user={user} greeting={greetingFor(user.name, t)} />

        <div className="flex flex-wrap items-center gap-3">
          <div className="text-ink-2 flex min-w-[min(240px,100%)] flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
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
          <PeriodSeg period={period} />
          <Button
            variant="tint-grey"
            size="icon"
            onClick={() => {
              void refetch()
              void refetchMine()
            }}
            loading={isFetching}
            aria-label={t('dashboard.refresh')}
            title={t('dashboard.refresh')}
          >
            {!isFetching && <RefreshCw size={16} aria-hidden="true" />}
          </Button>
          {/* the Payments page opens on the same period */}
          <DashLink
            href={periodHref('/app/payments', period)}
            className={buttonVariants({ size: 'md' })}
          >
            <Clock size={16} aria-hidden="true" />
            {t('finance.dayClose')}
          </DashLink>
          <Button
            variant="tint-grey"
            size="md"
            onClick={printReceipts}
            disabled={!receipts.data || receipts.data.receipts.length === 0}
            title={t('receipts.printAllHint', {
              defaultValue: 'Every receipt of the period in one document, one per page',
            })}
          >
            <Printer size={16} aria-hidden="true" />
            {t('receipts.printAll', { defaultValue: 'Print all receipts' })}
          </Button>
          {printError && <span className="text-red text-[13px] font-semibold">{printError}</span>}
          <StaffLink
            to="/app/bills"
            className={buttonVariants({ variant: canTake ? 'primary' : 'default', size: 'md' })}
          >
            <Receipt size={16} aria-hidden="true" />
            {t('finance.openBillsBtn')}
          </StaffLink>
          <PeriodCustom period={period} className="basis-full" />
        </div>

        {!canTake && <NotAllowedNotice feature="payment.take" compact />}

        {s?.todayOnly && (
          <p className="border-yellow/25 bg-yellow-bg text-yellow m-0 rounded-md border px-3 py-2 text-[14px] font-medium">
            {t('finance.periodNeedsUpdate')}
          </p>
        )}

        {error && (
          <p
            role="alert"
            className="border-red/25 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium"
          >
            {t('dashboard.loadFailed', { message: error.message })}
          </p>
        )}

        {s && my && (
          <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(230px,1fr))] sm:gap-3">
            <Kpi
              i={0}
              icon={UserRound}
              tint="violet"
              label={t('my.tiles.collectedByMe', { period: periodWord })}
              value={collected}
              unit="RWF"
              // "all time" has no period before it to compare with
              delta={range === 'all' ? undefined : delta(collected, collectedBefore, true, t)}
              to={link('collections') ?? link('revenue') ?? periodHref('/app/payments', period)}
            />
            <Kpi
              i={1}
              icon={HandCoins}
              tint="mint"
              label={t('my.tiles.paymentsByMe')}
              value={my.money?.payments.count ?? 0}
              unit={periodWord}
              to={link('collections') ?? periodHref('/app/payments', period)}
            />
            <Kpi
              i={1}
              icon={ReceiptText}
              tint="teal"
              label={t('my.tiles.receiptsByMe', { period: periodWord })}
              value={receipts.data?.count ?? 0}
              unit={formatRwf(receipts.data?.total ?? 0)}
              to={link('receipts')}
            />
            <Kpi
              i={1}
              icon={Banknote}
              tint="mint"
              label={methodName('cash')}
              value={amountOf('cash')}
              unit="RWF"
              to={link('methods')}
            />
            <Kpi
              i={2}
              icon={Smartphone}
              tint="amber"
              label={methodName('momo')}
              value={amountOf('momo')}
              unit="RWF"
              to={link('methods')}
            />
            <Kpi
              i={3}
              icon={Smartphone}
              tint="coral"
              label={methodName('airtel')}
              value={amountOf('airtel')}
              unit="RWF"
              to={link('methods')}
            />
            <Kpi
              i={4}
              icon={Users}
              tint="amber"
              label={t('my.tiles.waitingForMe')}
              value={my.counts.sentToMe + my.counts.atMyDesks}
              unit={t('dashboard.units.now')}
            />
            <Kpi
              i={5}
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
              to={link('openBills')}
            />
          </div>
        )}

        {/* WAITING FOR ME: the patients at my desk, then what I took (0120) */}
        <section className="flex flex-col gap-3">
          <SectionTitle icon={UserRoundCheck}>{t('my.section')}</SectionTitle>
          <div className="pc:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] grid grid-cols-1 gap-4">
            <WaitingForMePanel
              summary={my}
              rowAction="open"
              title={t('home.myQueue', { station: t('register.stations.cashier') })}
              // the patients I took the payment of (not the number of payments)
              done={s?.scope === 'mine' ? (s.served ?? 0) : (my?.money?.payments.count ?? 0)}
            />
            <div className="flex min-w-0 flex-col gap-4">
              <MyWorkPanel
                summary={my}
                periodWord={periodWord}
                kinds={WORK_OF.cashier}
                link={link}
                user={user}
                i={2}
              />
              {s && my && (
                <Panel
                  i={3}
                  icon={PieChart}
                  tint="mint"
                  title={t('my.byMethod', { period: periodWord })}
                  right={formatRwf(collected)}
                  to={
                    link('methods') ??
                    link('revenue', { by: 'method' }) ??
                    periodHref('/app/payments', period)
                  }
                >
                  {(my.money?.byMethod.length ?? 0) === 0 ? (
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
              {/* calls and help requests addressed to the cash desk */}
              <CallsPanel user={user} />
            </div>
          </div>
        </section>

        {/* THE DESK'S TOOLS: the bills to collect, then my payments of the period */}
        <section className="flex flex-col gap-3">
          <SectionTitle icon={Workflow}>{t('finance.section')}</SectionTitle>
          <OpenBillsPanel bills={bills} canTake={canTake} />
        </section>

        <section className="flex flex-col gap-3">
          <SectionTitle icon={HandCoins}>{t('my.paymentsIn', { period: periodWord })}</SectionTitle>
          <div className="pc:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] grid grid-cols-1 gap-4">
            <Panel
              i={1}
              icon={HandCoins}
              tint="violet"
              title={t('my.payments')}
              right={`${myPayments.length} · ${receiptsWord}: ${receipts.data?.count ?? 0}`}
              to={link('receipts')}
            >
              {myPayments.length === 0 ? (
                <Empty>{t('finance.nothingYet')}</Empty>
              ) : (
                <ShownList items={myPayments} step={6}>
                  {(shown) => (
                    <div className="flex flex-col">
                      {shown.map((p, i) => {
                        const Icon = METHOD_ICON[p.method] ?? Wallet
                        return (
                          <div
                            key={p.id}
                            className="border-grid flex min-h-10 flex-wrap items-center gap-2.5 border-b py-1.5 text-[14px] last:border-b-0"
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
                            <span className="font-semibold whitespace-nowrap tabular-nums">
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
          {/* money still owed on visits already over: collected here when the patient comes back */}
          {((s?.debts ?? 0) > 0 || debts.length > 0) && <DebtsPanel canTake={canTake} />}
          {(my?.money?.refunds.amount ?? 0) > 0 && link('refunds') && (
            <Panel
              i={3}
              icon={HandCoins}
              tint="coral"
              title={t('analytics.revenue.refunded')}
              right={formatRwf(my?.money?.refunds.amount ?? 0)}
              to={link('refunds')}
            >
              <Empty>{t('finance.nothingYet')}</Empty>
            </Panel>
          )}
        </section>
        <DoctorCalendarsSection user={user} />
      </main>
    </StaffShell>
  )
}

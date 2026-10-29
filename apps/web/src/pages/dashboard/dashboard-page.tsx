import { useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import {
  Banknote,
  BedDouble,
  Boxes,
  CalendarCheck,
  CalendarClock,
  ChartLine,
  Clock,
  History,
  Coins,
  FileText,
  FlaskConical,
  HeartPulse,
  Landmark,
  ListOrdered,
  LogIn,
  type LucideIcon,
  MapPin,
  Medal,
  PackageX,
  PieChart,
  Printer,
  Receipt,
  ReceiptText,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldPlus,
  Smartphone,
  Stethoscope,
  Tablets,
  UserPlus,
  Users,
  Wallet,
  Workflow,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  FEATURES,
  addDays,
  formatDate,
  formatDayMonth,
  formatNumber,
  formatRwf,
  formatTime,
  isoDate,
  type DashboardRole,
  type StaffUser,
  CLINIC_PROFILE,
} from '@mmc/shared'
import { DoctorCalendarsSection } from '@/components/calendar/doctor-calendars-section'
import { DepartmentSection } from './department-section'
import { CallsPanel } from '@/pages/home/calls-panel'
import { ToAcceptSection } from '@/pages/home/role-panels'
import { HBarList } from '@/components/charts/hbar'
import { IdentityBanner } from '@/components/dash/identity-banner'
import { StationTile } from '@/components/dash/station-tile'
import { Empty, Kpi, ListRows, Panel, Pill, SectionTitle } from '@/components/dash/kit'
import { DashLink } from '@/components/dash/dash-link'
import {
  periodSearch,
  useAnalyticsLink,
  type AnalyticsSearch,
} from '@/components/dash/analytics-links'
import { NoticesPanel } from '@/components/dash/notices-panel'
import { AccessApprovalsPanel } from '@/components/privacy/approvals'
import {
  avatarTint,
  delta,
  greetingFor,
  groupLabel,
  stationIconFor,
  initials,
} from '@/components/dash/kit-style'
import { LineChart } from '@/components/charts/line-chart'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { ShowMore } from '@/components/ui/list-tools'
import { PeriodCustom, PeriodSeg } from '@/components/dash/period-filter'
import { usePeriod } from '@/lib/period'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { useReceiptsInPeriod } from '@/lib/api/analytics-receipts'
import { useVisitsInPeriod } from '@/lib/api/analytics-documents'
import { methodLabel, useDashboard, type RevenuePoint } from '@/lib/api/dashboard'
import { useLetterhead } from '@/lib/report-parts'
import { openReceiptsBatch } from '@/lib/reports/receipts-print'
import type { ActivityKind } from '@/lib/api/analytics'
import { categoryName } from '@/lib/api/catalogue'
import { useDailyStockAlertCheck } from '@/lib/api/pharmacy'
import { useClinicInfo } from '@/lib/api/public'
import { useDeactivationReminders } from '@/lib/api/staff'
import { ReportButtons } from '@/components/dash/report-buttons'
import { dashboardReport } from '@/lib/reports/build'
import { useDayNames } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { isLive } from '@/lib/supabase'
import { useShowMore } from '@/lib/paging'
import { cn } from '@/lib/utils'

/* Figma: "Muhazi Clinic — Manager Dashboard v2". Tinted KPI chips, 16 px cards with a soft
   shadow, one colour per subject, staggered entrance, count-up numbers, drawn revenue line. */

/** The clinic takes cash, MTN MoMo and Airtel Money only. */
const ACCEPTED_METHODS = ['cash', 'momo', 'airtel']

/** Payment method symbol from its key or name ("cash", "MTN MoMo", "Airtel Money"). */
const methodIcon = (method: string): LucideIcon => {
  const m = method.toLowerCase()
  if (m.includes('cash')) return Banknote
  if (m.includes('momo') || m.includes('mtn') || m.includes('airtel') || m.includes('mobile'))
    return Smartphone
  return Wallet
}

const METHOD_COLORS = [
  'var(--mmc-primary)',
  'var(--mmc-green-dot)',
  'var(--mmc-yellow-dot)',
  'var(--mmc-violet)',
  'var(--mmc-c-time)',
]

interface DashboardPageProps {
  user: StaffUser
  /** Optional override from the URL; otherwise the user's own dashboard role. */
  view?: DashboardRole
}

export function DashboardPage({ user, view }: DashboardPageProps) {
  const { t, i18n } = useTranslation()
  const dayNames = useDayNames()
  const now = new Date()
  const canManage = user.dashboard === 'manager' || user.role === 'manager'
  const [role] = useState<DashboardRole>(view ?? (canManage ? 'manager' : 'head'))
  const period = usePeriod('today')
  const { range, custom } = period
  const isManager = canManage && role === 'manager'
  const { data, isFetching, error, refetch, dataUpdatedAt } = useDashboard(range, isManager, custom)
  // "Who did what": eight people at a time.
  const staffRows = useShowMore(data?.staff ?? [], 8)
  const { data: info } = useClinicInfo()
  // the manager hears about low, expiring and expired stock even on a day nobody opens the pharmacy
  useDailyStockAlertCheck(isManager)
  // Managers: accounts deactivated for a month or more become a notice (once each).
  useDeactivationReminders(canManage)

  const nav = navForUser(user)
  const activeId = 'dashboard'
  const rangeLabel =
    range === 'today' ? `${dayNames.long[now.getDay()]} ${formatDate(now)}` : period.label
  const periodWord = t(`dashboard.period.${range}`)
  const collections = (data?.collections ?? []).filter((c) => ACCEPTED_METHODS.includes(c.method))
  const greeting = greetingFor(user.name, t)
  // Every highlighted figure opens its detailed view on the Analytics page, with this period;
  // undefined when the person may not open that view (the card then stays a plain card).
  const link = useAnalyticsLink(periodSearch(period))
  // Revenue by day: the chosen period (up to 92 days), or the last 30 days for "Today",
  // "All time" and long periods.
  const today = isoDate(now)
  const last30: AnalyticsSearch = {
    range: 'custom',
    from: isoDate(addDays(now, -29)),
    to: today,
  }
  const periodSeries =
    range !== 'today' && (data?.revenuePeriod?.length ?? 0) > 1 ? data!.revenuePeriod! : null
  const revenueSeries = periodSeries ?? data?.revenue30d ?? []
  const revenueSearch = periodSeries ? {} : last30
  const revenueTotal = revenueSeries.reduce((s, r) => s + r.amount, 0)
  const revenueRefunds = revenueSeries.reduce((s, r) => s + r.refunds, 0)
  // "Who did what": a person's detailed view, or one kind of their work. The manager only: a
  // head's list here is clinic-wide while their Analytics shows their own department (people
  // outside it are refused), so a head keeps the panel's "Details" link to their department.
  const personLink = (id: string | null, kind?: ActivityKind) =>
    id && isManager ? link('staff', { person: id, ...(kind ? { kind } : {}) }) : undefined
  // the receipts given in the period and the patients' documents (0102): the manager only
  const receipts = useReceiptsInPeriod({ from: period.from, to: period.to }, {}, isManager)
  const docs = useVisitsInPeriod({ from: period.from, to: period.to }, {}, canManage)
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
  const documentsHref = `/app/documents?${new URLSearchParams(
    Object.entries(periodSearch(period)).filter((e): e is [string, string] => !!e[1]),
  ).toString()}`

  return (
    <StaffShell user={user} nav={nav} activeId={activeId}>
      <main className="pc:p-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 print:overflow-visible">
        {/* WHO IS SIGNED IN */}
        <IdentityBanner user={user} greeting={greeting} />

        {/* TOOLBAR */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-ink-2 flex min-w-[min(240px,100%)] flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            {/* Today's date is in the banner; a week or month shows its span here. */}
            {range !== 'today' && (
              <span className="inline-flex items-center gap-1.5 font-semibold">
                <ChartLine size={16} aria-hidden="true" className="text-primary" />
                {rangeLabel}
              </span>
            )}
            {info?.profile.sector && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin size={15} aria-hidden="true" className="text-ink-3" />
                {info.profile.sector}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <Clock size={15} aria-hidden="true" className="text-ink-3" />
              {t('dashboard.subtitleUpdated', {
                time: formatTime(dataUpdatedAt ? new Date(dataUpdatedAt) : now),
              })}
            </span>
            {!isLive && <span className="text-ink-3">{t('dashboard.sampleData')}</span>}
          </div>
          <StaffLink
            to="/app/patients"
            className="border-border bg-surface text-ink-3 hover:bg-hover wide:flex hidden h-9 w-[260px] items-center gap-2 rounded-full border px-3 text-[14px] no-underline"
          >
            <Search size={16} aria-hidden="true" />
            {t('common.searchPatient')}
          </StaffLink>
          <PeriodSeg period={period} />
          <Button
            variant="tint-grey"
            size="icon"
            onClick={() => void refetch()}
            loading={isFetching}
            aria-label={t('dashboard.refresh')}
            title={t('dashboard.refresh')}
          >
            {!isFetching && <RefreshCw size={16} aria-hidden="true" />}
          </Button>
          <ReportButtons
            build={() =>
              data ? dashboardReport(data, info?.profile ?? CLINIC_PROFILE, user, t) : null
            }
          />
          <Button variant="tint-grey" size="md" onClick={() => window.print()}>
            <Printer size={16} aria-hidden="true" />
            {t('dashboard.print')}
          </Button>
          <StaffLink
            to="/app/register"
            className={buttonVariants({ variant: 'primary', size: 'md' })}
          >
            <UserPlus size={16} aria-hidden="true" />
            {t('dashboard.registerPatient')}
          </StaffLink>
        </div>
        <PeriodCustom
          period={period}
          className="bg-card border-card-border shadow-card rounded-lg2 border px-4 py-3"
        />

        {error && (
          <p
            role="alert"
            className="border-red/25 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium"
          >
            {t('dashboard.loadFailed', { message: error.message })}
          </p>
        )}

        {/* A head of department: their own department first (people, desks, work). */}
        {!isManager && (
          <DepartmentSection user={user} range={range} custom={custom} periodWord={periodWord} />
        )}

        {!data && !error && <Skeleton isManager={isManager} />}

        {data && (
          <div key={range} className="flex flex-col gap-4">
            {/* KPI ROW */}
            <div className="pc:grid-cols-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Kpi
                i={0}
                icon={UserPlus}
                tint="teal"
                label={t('dashboard.tiles.registered')}
                value={data.tiles.registered}
                unit={periodWord}
                delta={delta(data.tiles.registered, data.tiles.registeredPrev, true, t)}
                to={link('visits')}
              />
              <Kpi
                i={1}
                icon={Stethoscope}
                tint="mint"
                label={t('dashboard.tiles.visits')}
                value={data.tiles.visits}
                unit={periodWord}
                delta={delta(data.tiles.visits, data.tiles.visitsPrev, true, t)}
                to={link('visits')}
              />
              {/* No average waiting time on the cards: the waiting times (median and 90th
                  percentile of completed waits) are on the Analytics page. */}
              <Kpi
                i={2}
                icon={Users}
                tint="amber"
                label={t('dashboard.tiles.waiting')}
                value={data.tiles.waitingNow}
                unit={t('dashboard.units.now')}
                delta={
                  data.tiles.forgottenNow > 0
                    ? {
                        text: t('dashboard.forgottenShort', { count: data.tiles.forgottenNow }),
                        good: false,
                        up: null,
                      }
                    : undefined
                }
              />
              {isManager && data.tiles.revenue != null && (
                <Kpi
                  i={3}
                  icon={Wallet}
                  tint="violet"
                  label={t(
                    range === 'today' ? 'dashboard.tiles.revenue' : 'dashboard.tiles.revenuePeriod',
                  )}
                  value={data.tiles.revenue}
                  unit="RWF"
                  delta={delta(data.tiles.revenue, data.tiles.revenuePrev ?? 0, true, t)}
                  spark={data.revenue30d.slice(-10).map((r) => r.amount)}
                  to={link('revenue') ?? '/app/payments'}
                />
              )}
              {isManager && receipts.data && (
                <Kpi
                  i={4}
                  icon={ReceiptText}
                  tint="teal"
                  label={t('receipts.givenIn', {
                    period: periodWord,
                    defaultValue: 'Receipts {{period}}',
                  })}
                  value={receipts.data.count}
                  unit={formatRwf(receipts.data.total)}
                  to={link('receipts')}
                />
              )}
              {isManager && data.tiles.openBills != null && (
                <Kpi
                  i={4}
                  icon={Receipt}
                  tint="navy"
                  label={t('dashboard.tiles.openBills')}
                  value={data.tiles.openBills}
                  unit={formatRwf(data.tiles.openBillsDue ?? 0)}
                  delta={
                    data.tiles.openBills > 0
                      ? { text: t('dashboard.toCollect'), good: false, up: null }
                      : undefined
                  }
                  to="/app/bills"
                />
              )}
              {isManager && (data.tiles.debts ?? 0) > 0 && (
                <Kpi
                  i={5}
                  icon={Wallet}
                  tint="coral"
                  label={t('dashboard.tiles.debts')}
                  value={data.tiles.debts ?? 0}
                  unit={formatRwf(data.tiles.debtsDue ?? 0)}
                  delta={{ text: t('dashboard.debtsHint'), good: false, up: null }}
                  to="/app/bills"
                />
              )}
              <Kpi
                i={6}
                icon={BedDouble}
                tint="teal"
                label={t('dashboard.tiles.beds')}
                value={data.tiles.bedsOccupied}
                unit={`/ ${data.tiles.bedsTotal} ${t('dashboard.units.beds')}`}
              />
            </div>

            {/* the manager keeps a calendar (0094): bookings to accept, under the tiles while there
                is something to answer (a "Booking to accept" notice points here) */}
            {user.role === 'manager' && <ToAcceptSection />}

            {/* NOTIFICATIONS: what is addressed to the manager right now */}
            {/* requests to see past records, emergency accesses to review (0088) */}
            <AccessApprovalsPanel user={user} />
            <NoticesPanel limit={4} />
            {/* calls and help requests addressed to the manager */}
            <CallsPanel user={user} />

            {/* MONEY */}
            {isManager && (
              <section className="flex flex-col gap-3">
                <SectionTitle icon={Coins}>{t('dashboard.sections.money')}</SectionTitle>
                <div
                  className={cn(
                    'grid grid-cols-1 gap-4',
                    FEATURES.insurance
                      ? 'pc:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]'
                      : 'pc:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]',
                  )}
                >
                  <Panel
                    i={1}
                    icon={ChartLine}
                    tint="violet"
                    title={
                      periodSeries
                        ? t('dashboard.revenueByDay', { period: periodWord })
                        : t('dashboard.revenue30')
                    }
                    right={
                      revenueRefunds > 0
                        ? `${t('dashboard.collectedTotal', { amount: formatRwf(revenueTotal) })} · ${t('dashboard.netTotal', { amount: formatRwf(revenueTotal - revenueRefunds) })}`
                        : t('dashboard.collectedTotal', { amount: formatRwf(revenueTotal) })
                    }
                    to={link('revenue', revenueSearch)}
                  >
                    <RevenueChart
                      points={revenueSeries}
                      last30={!periodSeries}
                      dayLink={(day) => link('revenue', { ...revenueSearch, day })}
                    />
                  </Panel>
                  <Panel
                    i={2}
                    icon={PieChart}
                    tint="mint"
                    title={t('dashboard.collections', { period: periodWord })}
                    right={formatRwf(collections.reduce((s, c) => s + c.amount, 0))}
                    to={link('revenue', { by: 'method' })}
                  >
                    <div className="flex flex-wrap items-center justify-center gap-4">
                      <Donut
                        values={collections.map((c) => c.amount)}
                        colors={METHOD_COLORS}
                        label={periodWord}
                        total={collections.reduce((s, c) => s + c.amount, 0)}
                      />
                      <div className="min-w-[190px] flex-1">
                        <HBarList
                          subject="money"
                          colors={METHOD_COLORS}
                          labelWidth="minmax(72px,96px)"
                          rows={collections.map((m) => ({
                            // cash, momo, airtel → the interface language
                            icon: methodIcon(m.method),
                            label: t(`visit.payment.methods.${m.method}`, {
                              defaultValue: methodLabel(m.method),
                            }),
                            value: m.amount,
                            display: formatNumber(m.amount),
                          }))}
                        />
                      </div>
                    </div>
                  </Panel>
                  <Panel
                    i={4}
                    icon={ReceiptText}
                    tint="teal"
                    title={t('receipts.givenIn', {
                      period: periodWord,
                      defaultValue: 'Receipts {{period}}',
                    })}
                    right={
                      receipts.data
                        ? `${formatNumber(receipts.data.count)} · ${formatRwf(receipts.data.total)}`
                        : undefined
                    }
                    to={link('receipts')}
                  >
                    {receipts.data && receipts.data.byMethod.length > 0 ? (
                      <HBarList
                        subject="money"
                        colors={METHOD_COLORS}
                        labelWidth="minmax(72px,96px)"
                        rows={receipts.data.byMethod.map((m) => ({
                          icon: methodIcon(m.method),
                          label: t(`visit.payment.methods.${m.method}`, {
                            defaultValue: methodLabel(m.method),
                          }),
                          value: m.amount,
                          display: `${formatNumber(m.count)} · ${formatNumber(m.amount)}`,
                        }))}
                      />
                    ) : (
                      <Empty>{t('finance.nothingYet')}</Empty>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="tint-grey"
                        size="sm"
                        onClick={printReceipts}
                        disabled={!receipts.data || receipts.data.receipts.length === 0}
                      >
                        <Printer size={14} aria-hidden="true" />
                        {t('receipts.printAll', { defaultValue: 'Print all receipts' })}
                      </Button>
                      {printError && (
                        <span className="text-red text-[13px] font-semibold">{printError}</span>
                      )}
                    </div>
                  </Panel>
                  {/* What insurers owe: only once the clinic works with insurers. */}
                  {FEATURES.insurance && (
                    <Panel
                      i={3}
                      icon={Landmark}
                      tint="navy"
                      title={t('dashboard.receivables')}
                      right={formatRwf(data.receivables.reduce((s, r) => s + r.amount, 0))}
                      to={link('revenue', { by: 'payer' })}
                    >
                      {data.receivables.length === 0 ? (
                        <Empty>{t('dashboard.noReceivables')}</Empty>
                      ) : (
                        <HBarList
                          subject="money"
                          rows={data.receivables.map((m) => ({
                            icon: ShieldPlus,
                            label: m.payer,
                            value: m.amount,
                            display: formatNumber(m.amount),
                          }))}
                        />
                      )}
                      <StaffLink
                        to="/app/prices"
                        className={cn(buttonVariants({ size: 'sm' }), 'self-start')}
                      >
                        {t('dashboard.claims')} →
                      </StaffLink>
                    </Panel>
                  )}
                </div>
              </section>
            )}

            {/* OPERATIONS */}
            <section className="flex flex-col gap-3">
              <SectionTitle icon={Workflow}>{t('dashboard.sections.ops')}</SectionTitle>
              <div className="pc:grid-cols-2 grid grid-cols-1 gap-4">
                <Panel
                  i={1}
                  icon={Users}
                  tint="amber"
                  title={t('dashboard.queueNow')}
                  right={t('dashboard.refreshNote')}
                  to={link('waiting')}
                  toLabel={t('dashboard.links.waitingTimes')}
                >
                  {data.waitByStation.length === 0 ? (
                    <Empty>{t('dashboard.noQueue')}</Empty>
                  ) : (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2.5">
                      {data.waitByStation.map((s, i) => (
                        <StationTile key={s.station} i={i} {...s} />
                      ))}
                    </div>
                  )}
                  {data.tiles.forgottenNow > 0 && (
                    <DashLink
                      href="/app/visits"
                      className="text-yellow inline-flex items-center gap-1.5 self-start text-[13px] font-semibold"
                    >
                      <History size={14} aria-hidden="true" />
                      {t('dashboard.forgottenHint', { count: data.tiles.forgottenNow })} →
                    </DashLink>
                  )}
                </Panel>
                <Panel
                  i={2}
                  icon={Stethoscope}
                  tint="mint"
                  title={t('dashboard.visitsByService', { period: periodWord })}
                  right={t('dashboard.visitsCount', { count: data.tiles.visits })}
                  to={link('visits', { by: 'group' })}
                >
                  {data.visitsByGroup.length === 0 ? (
                    <Empty>{t('dashboard.noVisits')}</Empty>
                  ) : (
                    <HBarList
                      subject="visits"
                      labelWidth="minmax(96px,140px)"
                      rows={data.visitsByGroup.map((v) => ({
                        icon: stationIconFor(v.group),
                        label: v.name
                          ? categoryName(
                              {
                                nameEn: v.name,
                                nameKin: v.nameKin ?? null,
                                nameFr: v.nameFr ?? null,
                              },
                              i18n.language,
                            )
                          : groupLabel(v.group, t),
                        value: v.count,
                      }))}
                    />
                  )}
                  <div className="text-ink-3 flex flex-wrap items-center gap-2 text-[13px]">
                    <CalendarCheck size={14} aria-hidden="true" />
                    {t('dashboard.bookings', { period: periodWord })}: {data.bookings.booked}{' '}
                    {t('dashboard.booked')} ·{' '}
                    {t('dashboard.noShowShort', { missed: data.bookings.missed })}
                    <StaffLink
                      to="/app/appointments"
                      className="coarse:min-h-[var(--tap)] inline-flex items-center no-underline"
                    >
                      <Badge tone={data.bookings.pending > 0 ? 'yellow' : 'green'} dot={false}>
                        {t('dashboard.pendingInquiries', { count: data.bookings.pending })} →
                      </Badge>
                    </StaffLink>
                  </div>
                </Panel>
              </div>
              {/* the documents of every patient treated in the period, printed together (0102) */}
              <Panel
                i={4}
                icon={FileText}
                tint="navy"
                id="documents"
                title={t('documents.title', { defaultValue: 'Patients’ documents' })}
                right={
                  docs.data
                    ? t('documents.found', {
                        count: docs.data.count,
                        defaultValue: '{{count}} found',
                      })
                    : undefined
                }
                to={documentsHref}
                toLabel={t('documents.open', { defaultValue: 'Open' })}
              >
                <p className="text-ink-2 m-0 text-[14px]">
                  {t('documents.cardLead', {
                    defaultValue:
                      'The medical reports of every patient treated in the period, filtered by department, doctor, service or insurer, printed in one document or exported as a list.',
                  })}
                </p>
                {docs.data && (
                  <div className="text-ink-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                    <span>
                      {t('dashboard.tiles.visits')}:{' '}
                      <b className="text-ink">{formatNumber(docs.data.count)}</b>
                    </span>
                    <span>
                      {t('documents.closedVisits', { defaultValue: 'Closed visits' })}:{' '}
                      <b className="text-ink">{formatNumber(docs.data.closed)}</b>
                    </span>
                    <span>
                      {t('documents.patients', { defaultValue: 'Patients' })}:{' '}
                      <b className="text-ink">
                        {formatNumber(new Set(docs.data.visits.map((v) => v.patient.id)).size)}
                      </b>
                    </span>
                  </div>
                )}
                <StaffLink
                  to={documentsHref}
                  className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'self-start')}
                >
                  <Printer size={14} aria-hidden="true" />
                  {t('documents.printAll', { defaultValue: 'Print all medical reports' })}
                </StaffLink>
              </Panel>
              {/* Who did what: its own full-width row, so every count shows */}
              <Panel
                i={3}
                icon={Users}
                tint="teal"
                title={t('dashboard.staffActivity', { period: periodWord })}
                right={t('dashboard.staffActivityNote')}
                to={link('staff')}
                className="overflow-x-auto"
              >
                {data.staff.length === 0 ? (
                  <Empty>{t('dashboard.noStaffActivity')}</Empty>
                ) : (
                  <table className="w-full border-collapse text-[14px]">
                    <thead>
                      <tr className="text-ink-3 text-left text-[12px] font-normal">
                        <th className="border-border border-b py-2 pr-2 font-normal">
                          <span className="inline-flex items-center gap-1">
                            <Users size={13} aria-hidden="true" />
                            {t('dashboard.cols.employee')}
                          </span>
                        </th>
                        <th className="border-border hidden border-b py-2 pr-2 text-right font-normal sm:table-cell">
                          <span className="inline-flex items-center gap-1">
                            <UserPlus size={13} aria-hidden="true" />
                            {t('dashboard.cols.registrations')}
                          </span>
                        </th>
                        <th className="border-border hidden border-b py-2 pr-2 text-right font-normal sm:table-cell">
                          <span className="inline-flex items-center gap-1">
                            <HeartPulse size={13} aria-hidden="true" />
                            {t('dashboard.cols.vitals')}
                          </span>
                        </th>
                        <th className="border-border border-b py-2 pr-2 text-right font-normal">
                          <span className="inline-flex items-center gap-1">
                            <Stethoscope size={13} aria-hidden="true" />
                            {t('dashboard.cols.patients')}
                          </span>
                        </th>
                        <th className="border-border hidden border-b py-2 pr-2 text-right font-normal sm:table-cell">
                          <span className="inline-flex items-center gap-1">
                            <FlaskConical size={13} aria-hidden="true" />
                            {t('dashboard.cols.results')}
                          </span>
                        </th>
                        <th className="border-border hidden border-b py-2 pr-2 text-right font-normal sm:table-cell">
                          <span className="inline-flex items-center gap-1">
                            <Tablets size={13} aria-hidden="true" />
                            {t('dashboard.cols.dispensed')}
                          </span>
                        </th>
                        <th className="border-border hidden border-b py-2 pr-2 text-right font-normal sm:table-cell">
                          <span className="inline-flex items-center gap-1">
                            <Receipt size={13} aria-hidden="true" />
                            {t('dashboard.cols.charges')}
                          </span>
                        </th>
                        {isManager && (
                          <th className="border-border border-b py-1.5 text-right font-semibold">
                            <span className="inline-flex items-center gap-1">
                              <Wallet size={13} aria-hidden="true" />
                              {t('dashboard.cols.collected')}
                            </span>
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {staffRows.visible.map((s, i) => {
                        const cell = (what: string, n: number) =>
                          `${s.name} · ${what}: ${formatNumber(n)}`
                        const person = personLink(s.id)
                        return (
                          <tr
                            key={s.id ?? s.name}
                            className="border-grid border-b last:border-b-0"
                            style={{ '--i': i } as CSSProperties}
                          >
                            <td className="py-2 pr-2">
                              <PersonCell
                                to={person}
                                label={t('dashboard.links.person', { name: s.name })}
                              >
                                <span
                                  className={cn(
                                    'inline-flex size-8 flex-none items-center justify-center rounded-full text-[12px] font-semibold',
                                    avatarTint(i),
                                  )}
                                >
                                  {initials(s.name)}
                                </span>
                                <span className="min-w-0">
                                  <span className="block truncate font-semibold">{s.name}</span>
                                  <span className="text-ink-3 block truncate text-[12px]">
                                    {t(`staff.roles.${s.role}`)}
                                    {s.staffId ? ` · ${s.staffId}` : ''}
                                    {!s.active && ` · ${t('dashboard.staffLeft')}`}
                                  </span>
                                </span>
                              </PersonCell>
                            </td>
                            <CountCell
                              n={s.registrations}
                              to={personLink(s.id, 'registered')}
                              label={cell(t('dashboard.cols.registrations'), s.registrations)}
                              className="hidden sm:table-cell"
                            />
                            <CountCell
                              n={s.vitals}
                              to={personLink(s.id, 'vitals')}
                              label={cell(t('dashboard.cols.vitals'), s.vitals)}
                              className="hidden sm:table-cell"
                            />
                            <CountCell
                              n={s.patients ?? 0}
                              to={personLink(s.id, 'patientsSeen')}
                              label={cell(t('dashboard.cols.patients'), s.patients ?? 0)}
                            />
                            <CountCell
                              n={s.results ?? 0}
                              to={personLink(s.id, 'results')}
                              label={cell(t('dashboard.cols.results'), s.results ?? 0)}
                              className="hidden sm:table-cell"
                            />
                            <CountCell
                              n={s.dispensed ?? 0}
                              to={personLink(s.id, 'medicinesGiven')}
                              label={cell(t('dashboard.cols.dispensed'), s.dispensed ?? 0)}
                              className="hidden sm:table-cell"
                            />
                            <CountCell
                              n={s.charges}
                              to={personLink(s.id, 'charges')}
                              label={cell(t('dashboard.cols.charges'), s.charges)}
                              className="hidden sm:table-cell"
                            />
                            {isManager && (
                              <CountCell
                                n={s.collected ?? 0}
                                to={personLink(s.id, 'payments')}
                                label={cell(t('dashboard.cols.collected'), s.collected ?? 0)}
                                empty="—"
                                className="pr-0"
                              />
                            )}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
                {data.staff.length > 0 && (
                  <ShowMore
                    rest={staffRows.rest}
                    expanded={staffRows.expanded}
                    onMore={staffRows.more}
                    onLess={staffRows.less}
                    step={8}
                  />
                )}
              </Panel>
            </section>

            {/* CLINICAL · STOCK · SECURITY */}
            <section className="flex flex-col gap-3">
              <SectionTitle icon={ShieldCheck}>
                {t('dashboard.sections.clinical')} · {t('dashboard.logins')}
              </SectionTitle>
              <div className="pc:grid-cols-3 grid grid-cols-1 gap-4">
                <Panel
                  i={1}
                  icon={ListOrdered}
                  tint="teal"
                  title={t('dashboard.topTreatments', { period: periodWord })}
                  right={t('dashboard.cases')}
                  to={link('treatments')}
                >
                  {data.topTreatments.length === 0 && <Empty>{t('dashboard.noTreatments')}</Empty>}
                  <ListRows
                    rows={data.topTreatments.map((d, i) => ({
                      key: d.name,
                      pill: (
                        <Pill tint={i === 0 ? 'amber' : 'teal'} icon={i < 3 ? Medal : undefined}>
                          {i + 1}
                        </Pill>
                      ),
                      label: d.name,
                      value:
                        isManager && d.amount != null
                          ? `${d.count} · ${formatNumber(d.amount)}`
                          : String(d.count),
                    }))}
                  />
                </Panel>
                <Panel
                  i={2}
                  icon={Boxes}
                  tint="amber"
                  title={t('dashboard.reorder')}
                  right={`${t('dashboard.expiring')} · ${t('dashboard.days30')}: ${data.expiring.d30}`}
                  to={link('stock') ? '/app/stock?tab=reorder' : undefined}
                >
                  {data.reorder.length === 0 &&
                    data.expiring.d30 + data.expiring.d60 + data.expiring.d90 === 0 && (
                      <Empty>{t('dashboard.stockOk')}</Empty>
                    )}
                  <ListRows
                    rows={[
                      ...data.reorder.map((r) => ({
                        key: r.id,
                        pill: (
                          <Pill tint={r.onHand < r.min / 2 ? 'coral' : 'amber'} icon={PackageX}>
                            {t('dashboard.lowShort')}
                          </Pill>
                        ),
                        label: r.name,
                        value: `${formatNumber(r.onHand)} / ${formatNumber(r.min)}`,
                      })),
                      ...((data.expiring.expired ?? 0) > 0
                        ? [
                            {
                              key: 'expired',
                              pill: (
                                <Pill tint="coral" icon={PackageX}>
                                  {t('dashboard.expiredShort')}
                                </Pill>
                              ),
                              label: t('dashboard.expiredItems', {
                                count: data.expiring.expired ?? 0,
                              }),
                              value: t('dashboard.writeOff'),
                            },
                          ]
                        : []),
                      ...(data.expiring.d30 + data.expiring.d60 + data.expiring.d90 > 0
                        ? [
                            {
                              key: 'exp',
                              pill: (
                                <Pill tint="amber" icon={CalendarClock}>
                                  {t('dashboard.days30')}
                                </Pill>
                              ),
                              label: t('dashboard.expiringItems', { count: data.expiring.d30 }),
                              value: `${data.expiring.d60} ${t('dashboard.days60')} · ${data.expiring.d90} ${t('dashboard.days90')}`,
                            },
                          ]
                        : []),
                    ]}
                  />
                </Panel>
                <Panel
                  i={3}
                  icon={LogIn}
                  tint="navy"
                  title={`${t('dashboard.logins')} · ${t('dashboard.last24h')}`}
                  right={`${data.logins.length}`}
                  to={link('staff', { by: 'signins' })}
                >
                  {data.logins.length === 0 && <Empty>{t('dashboard.noLogins')}</Empty>}
                  <ListRows
                    rows={data.logins.map((l, i) => {
                      const failed = !!l.reason && /wrong|without/i.test(l.reason)
                      return {
                        key: `${l.name}-${i}`,
                        pill: (
                          <Pill
                            tint={failed ? 'coral' : 'mint'}
                            icon={failed ? ShieldAlert : ShieldCheck}
                          >
                            {failed ? t('dashboard.failedLogin') : 'ok'}
                          </Pill>
                        ),
                        label: `${l.name} · ${t(`staff.roles.${l.role}`)}`,
                        value: `${formatDayMonth(new Date(l.at))} ${formatTime(new Date(l.at))}`,
                        to: personLink(l.id),
                      }
                    })}
                  />
                </Panel>
              </div>
            </section>
          </div>
        )}
        <DoctorCalendarsSection user={user} />
      </main>
    </StaffShell>
  )
}

/* ---------------------------------------------------------------- pieces */

function Donut({
  values,
  colors,
  label,
  total,
}: {
  values: number[]
  colors: string[]
  label: string
  total: number
}) {
  const sum = values.reduce((s, v) => s + v, 0)
  const C = 2 * Math.PI * 42
  // Arc lengths and where each one starts, computed once (no mutation during render).
  const segments = values.reduce<{ len: number; start: number }[]>((acc, v) => {
    const len = sum ? (v / sum) * C : 0
    const start = acc.length ? acc[acc.length - 1]!.start + acc[acc.length - 1]!.len : 0
    acc.push({ len, start })
    return acc
  }, [])
  const short =
    total >= 1_000_000
      ? `${(total / 1_000_000).toFixed(1)}M`
      : total >= 1000
        ? `${Math.round(total / 1000)}k`
        : String(total)
  return (
    <svg
      viewBox="0 0 120 120"
      className="size-[112px] flex-none"
      role="img"
      aria-label={`${label}: ${formatRwf(total)}`}
    >
      <circle cx="60" cy="60" r="42" fill="none" stroke="var(--mmc-hover)" strokeWidth="16" />
      {segments.map(({ len, start }, i) => (
        <circle
          key={i}
          cx="60"
          cy="60"
          r="42"
          fill="none"
          stroke={colors[i % colors.length]}
          strokeWidth="16"
          strokeDasharray={`${len} ${C - len}`}
          strokeDashoffset={-start}
          transform="rotate(-90 60 60)"
          className="fade-in-late"
        />
      ))}
      <text x="60" y="58" textAnchor="middle" fontSize="15" fontWeight={700} className="fill-ink">
        {short}
      </text>
      <text x="60" y="74" textAnchor="middle" fontSize="10" fontWeight={600} className="fill-ink-3">
        {label}
      </text>
    </svg>
  )
}

/** The line chart's frame (components/charts/line-chart.tsx): 640 wide, plot from 56 to 600. */
const CHART = { width: 640, left: 56, right: 600 }

/**
 * Revenue by day: the amount collected each day. A click on a day opens that day on the
 * Analytics page (its payments, cancellations, refunds and cash count); the panel's
 * "Details" link opens the whole period for the keyboard.
 */
function RevenueChart({
  points,
  last30,
  dayLink,
}: {
  points: RevenuePoint[]
  /** The fixed "last 30 days" series (otherwise the chosen period). */
  last30: boolean
  /** The detailed view of one day, or undefined when the person may not open it. */
  dayLink: (day: string) => string | undefined
}) {
  const { t } = useTranslation()
  const router = useRouter()
  const values = points.map((r) => r.amount)
  const labels = points.map((r) => formatDayMonth(new Date(r.day)))
  const peak = Math.max(1, ...values)
  const step = niceStep(peak)
  const max = Math.max(step, Math.ceil(peak / step) * step)
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max]
  const n = points.length
  // five dates spread over the period (the first and the last included)
  const xTicks = [...new Set([0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (n - 1))))]
  const rwfShort = (v: number) =>
    v === 0 ? '0' : v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : `${Math.round(v / 1000)}k`
  const latest = formatRwf(values[n - 1] ?? 0)
  const canPick = n > 0 && !!dayLink(points[0]!.day)
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    if (!rect.width) return
    const x = ((e.clientX - rect.left) / rect.width) * CHART.width
    const i = Math.round(((x - CHART.left) / (CHART.right - CHART.left)) * (n - 1))
    const point = points[Math.min(n - 1, Math.max(0, i))]
    const href = point && dayLink(point.day)
    if (href) void router.navigate({ href })
  }
  const chart = (
    <LineChart
      values={values}
      labels={labels}
      max={max}
      ticks={ticks}
      tickLabel={rwfShort}
      format={formatRwf}
      xTicks={xTicks}
      area
      animate
      ariaLabel={
        last30
          ? t('dashboard.revenueAria', { latest })
          : t('dashboard.revenueAriaDays', { count: n, latest })
      }
    />
  )
  if (!canPick) return chart
  return (
    // a pointer shortcut only: the panel's "Details" link is the keyboard way to the same view
    <div className="cursor-pointer" title={t('dashboard.links.openDay')} onClick={onClick}>
      {chart}
    </div>
  )
}

/** The name cell of "Who did what": a link to the person's detailed view when there is one. */
function PersonCell({
  to,
  label,
  children,
}: {
  to: string | undefined
  label: string
  children: ReactNode
}) {
  const row = 'flex items-center gap-2.5'
  return to ? (
    <DashLink
      href={to}
      title={label}
      className={cn(
        row,
        'hover:text-primary focus-visible:ring-primary/45 rounded-md text-inherit no-underline outline-none focus-visible:ring-[3px]',
      )}
    >
      {children}
    </DashLink>
  ) : (
    <span className={row}>{children}</span>
  )
}

/** One count of "Who did what": a link to that kind of work of the person when above 0. */
function CountCell({
  n,
  to,
  label,
  empty,
  className,
}: {
  n: number
  to: string | undefined
  /** "Name · Vitals: 12", for the link's accessible name. */
  label: string
  /** Shown instead of 0 (e.g. "—"). */
  empty?: string
  className?: string
}) {
  return (
    <td className={cn('py-2 pr-2 text-right tabular-nums', className)}>
      {n > 0 && to ? (
        <DashLink
          href={to}
          aria-label={label}
          title={label}
          className="hover:text-primary focus-visible:ring-primary/45 decoration-ink-3/50 coarse:inline-flex coarse:min-h-[var(--tap)] coarse:min-w-[var(--tap)] coarse:items-center coarse:justify-end rounded px-0.5 text-inherit underline decoration-dotted underline-offset-4 outline-none focus-visible:ring-[3px]"
        >
          {formatNumber(n)}
        </DashLink>
      ) : n > 0 ? (
        formatNumber(n)
      ) : (
        (empty ?? '0')
      )}
    </td>
  )
}

const niceStep = (peak: number) => {
  const raw = peak / 4
  const mag = 10 ** Math.floor(Math.log10(Math.max(1, raw)))
  const n = raw / mag
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag
}

function Skeleton({ isManager }: { isManager: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label={t('dashboard.loading')}>
      <div className="pc:grid-cols-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Array.from({ length: isManager ? 7 : 5 }, (_, i) => (
          <div key={i} className="skeleton h-[130px] rounded-md" />
        ))}
      </div>
      <div className="pc:grid-cols-3 grid grid-cols-1 gap-4">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="skeleton h-[260px] rounded-md" />
        ))}
      </div>
    </div>
  )
}

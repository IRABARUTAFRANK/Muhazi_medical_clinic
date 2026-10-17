import { useState, type CSSProperties, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowUp,
  BedDouble,
  Minus,
  Printer,
  Receipt,
  RefreshCw,
  Search,
  Stethoscope,
  Timer,
  UserPlus,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  CLINIC_HOURS,
  formatDate,
  formatDayMonth,
  formatNumber,
  formatRwf,
  formatTime,
  type DashboardRole,
  type StaffUser,
} from '@mmc/shared'
import { HBarList } from '@/components/charts/hbar'
import { LineChart } from '@/components/charts/line-chart'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Seg } from '@/components/ui/seg'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  rangeDates,
  useDashboard,
  type DashboardData,
  type DashboardRange,
} from '@/lib/api/dashboard'
import { useClinicInfo, useClinicStatus } from '@/lib/api/public'
import { useDayNames } from '@/lib/hooks'
import { useCountUp } from '@/lib/motion'
import { navForUser } from '@/lib/nav'
import { isLive } from '@/lib/supabase'
import { cn } from '@/lib/utils'

/* Figma: "Muhazi Clinic — Manager Dashboard v2". Tinted KPI chips, 16 px cards with a soft
   shadow, one colour per subject, staggered entrance, count-up numbers, drawn revenue line. */

const sectionTitle = 'text-[11px] font-extrabold tracking-[.08em] text-ink-3 uppercase'
const card =
  'card-lift bg-card shadow-card flex min-w-0 flex-col gap-3.5 rounded-[16px] px-5 py-[18px]'
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
  const { t } = useTranslation()
  const dayNames = useDayNames()
  const now = new Date()
  const canManage = user.dashboard === 'manager' || user.role === 'manager'
  const [role] = useState<DashboardRole>(view ?? (canManage ? 'manager' : 'head'))
  const [range, setRange] = useState<DashboardRange>('today')
  const isManager = canManage && role === 'manager'
  const { data, isFetching, error, refetch, dataUpdatedAt } = useDashboard(range, isManager)
  const { data: info } = useClinicInfo()
  const { data: status } = useClinicStatus(info?.hours ?? CLINIC_HOURS)

  const nav = navForUser(user)
  const activeId = canManage ? 'dashboard' : 'reports'
  const { from, to } = rangeDates(range, now)
  const rangeLabel =
    range === 'today'
      ? `${dayNames.long[now.getDay()]} ${formatDate(now)}`
      : t('dashboard.rangeLabels.week', { from: formatDayMonth(from), to: formatDate(to) })
  const periodWord = t(`dashboard.period.${range}`)
  const hour = now.getHours()
  const greeting = t(
    `dashboard.greeting.${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}`,
    {
      name: user.name
        .replace(/^Dr\.?\s+/i, '')
        .split(' ')
        .pop(),
    },
  )

  return (
    <StaffShell user={user} nav={nav} activeId={activeId}>
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4 print:overflow-visible">
        {/* HEADER */}
        <div className="anim-enter flex flex-wrap items-center gap-4">
          <div className="min-w-[240px] flex-1">
            <h1 className="m-0 text-[26px] font-bold tracking-[-0.02em]">{greeting}</h1>
            <div className="text-ink-2 mt-1 text-sm">
              {rangeLabel} · {info?.profile.sector ?? ''} ·{' '}
              {t('dashboard.subtitleUpdated', {
                time: formatTime(dataUpdatedAt ? new Date(dataUpdatedAt) : now),
              })}{' '}
              ·{' '}
              <b className={status?.open ? 'text-green' : 'text-red'}>
                ● {t(status?.open ? 'dashboard.clinicOpen' : 'dashboard.clinicClosed')}
              </b>
              {!isLive && <span className="text-ink-3"> · {t('dashboard.sampleData')}</span>}
            </div>
          </div>
          <StaffLink
            to="/app/register"
            className="border-border bg-card text-ink-3 card-lift wide:flex hidden h-11 w-[260px] items-center gap-2.5 rounded-xl border px-3.5 text-sm no-underline"
          >
            <Search size={16} aria-hidden="true" />
            {t('common.searchPatient')}
          </StaffLink>
          <Seg<DashboardRange>
            label={t('dashboard.dateRange')}
            value={range}
            onChange={setRange}
            options={[
              { value: 'today', label: t('dashboard.ranges.today') },
              { value: 'week', label: t('dashboard.ranges.week') },
              { value: 'month', label: t('dashboard.ranges.month') },
            ]}
          />
          <Button
            size="icon"
            onClick={() => void refetch()}
            loading={isFetching}
            aria-label={t('dashboard.refresh')}
            title={t('dashboard.refresh')}
          >
            {!isFetching && <RefreshCw size={16} aria-hidden="true" />}
          </Button>
          <Button size="md" onClick={() => window.print()}>
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

        {error && (
          <p
            role="alert"
            className="bg-red-bg text-red m-0 rounded-xl px-3 py-2 text-[13px] font-semibold"
          >
            {t('dashboard.loadFailed', { message: error.message })}
          </p>
        )}

        {!data && !error && <Skeleton isManager={isManager} />}

        {data && (
          <div key={range} className="flex flex-col gap-5">
            {/* KPI ROW */}
            <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4">
              <Kpi
                i={0}
                icon={UserPlus}
                tint="teal"
                label={t('dashboard.tiles.registered')}
                value={data.tiles.registered}
                unit={periodWord}
                delta={delta(data.tiles.registered, data.tiles.registeredPrev, true, t)}
              />
              <Kpi
                i={1}
                icon={Stethoscope}
                tint="mint"
                label={t('dashboard.tiles.visits')}
                value={data.tiles.visits}
                unit={periodWord}
                delta={delta(data.tiles.visits, data.tiles.visitsPrev, true, t)}
              />
              <Kpi
                i={2}
                icon={Users}
                tint="amber"
                label={t('dashboard.tiles.waiting')}
                value={data.tiles.waitingNow}
                unit={t('dashboard.units.now')}
              />
              <Kpi
                i={3}
                icon={Timer}
                tint="coral"
                label={t('dashboard.tiles.avgWait')}
                value={data.tiles.avgWaitMin}
                unit={t('dashboard.units.min')}
                delta={
                  data.tiles.avgWaitMin > 30
                    ? { text: t('dashboard.queueLong'), good: false, up: true }
                    : undefined
                }
              />
              {isManager && data.tiles.revenue != null && (
                <Kpi
                  i={4}
                  icon={Wallet}
                  tint="violet"
                  label={t('dashboard.tiles.revenue')}
                  value={data.tiles.revenue}
                  unit="RWF"
                  delta={delta(data.tiles.revenue, data.tiles.revenuePrev ?? 0, true, t)}
                  spark={data.revenue30d.slice(-10).map((r) => r.amount)}
                />
              )}
              {isManager && data.tiles.openBills != null && (
                <Kpi
                  i={5}
                  icon={Receipt}
                  tint="navy"
                  label={t('dashboard.tiles.openBills')}
                  value={data.tiles.openBills}
                  unit={formatRwf(data.tiles.openBillsDue ?? 0)}
                  delta={
                    data.tiles.openBills > 0
                      ? { text: t('visit.next.toCashier'), good: false, up: null }
                      : undefined
                  }
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

            {/* MONEY */}
            {isManager && (
              <section className="flex flex-col gap-3">
                <div className={sectionTitle}>{t('dashboard.sections.money')}</div>
                <div className="pc:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] grid grid-cols-1 gap-4">
                  <Panel
                    i={1}
                    title={t('dashboard.revenue30')}
                    right={t('dashboard.collectedTotal', {
                      amount: formatRwf(data.revenue30d.reduce((s, r) => s + r.amount, 0)),
                    })}
                  >
                    <RevenueChart data={data} />
                  </Panel>
                  <Panel
                    i={2}
                    title={t('dashboard.collections', { period: periodWord })}
                    right={formatRwf(data.collections.reduce((s, c) => s + c.amount, 0))}
                  >
                    <div className="flex items-center gap-4">
                      <Donut
                        values={data.collections.map((c) => c.amount)}
                        colors={METHOD_COLORS}
                        label={periodWord}
                        total={data.collections.reduce((s, c) => s + c.amount, 0)}
                      />
                      <div className="min-w-0 flex-1">
                        <HBarList
                          subject="money"
                          colors={METHOD_COLORS}
                          labelWidth="minmax(72px,96px)"
                          rows={data.collections.map((m) => ({
                            label: m.method,
                            value: m.amount,
                            display: formatNumber(m.amount),
                          }))}
                        />
                      </div>
                    </div>
                  </Panel>
                  <Panel
                    i={3}
                    title={t('dashboard.receivables')}
                    right={formatRwf(data.receivables.reduce((s, r) => s + r.amount, 0))}
                  >
                    {data.receivables.length === 0 ? (
                      <Empty>{t('dashboard.noReceivables')}</Empty>
                    ) : (
                      <HBarList
                        subject="money"
                        rows={data.receivables.map((m) => ({
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
                </div>
              </section>
            )}

            {/* OPERATIONS */}
            <section className="flex flex-col gap-3">
              <div className={sectionTitle}>{t('dashboard.sections.ops')}</div>
              <div className="pc:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.5fr)] grid grid-cols-1 gap-4">
                <Panel i={1} title={t('dashboard.queueNow')} right={t('dashboard.refreshNote')}>
                  {data.waitByStation.length === 0 ? (
                    <Empty>{t('dashboard.noQueue')}</Empty>
                  ) : (
                    <div className="grid grid-cols-2 gap-2.5">
                      {data.waitByStation.map((s, i) => {
                        const hot = s.minutes > 20
                        return (
                          <div
                            key={s.station}
                            className={cn(
                              'anim-enter flex flex-col gap-0.5 rounded-xl border px-3 py-2.5',
                              hot ? 'border-red-dot/30 bg-red-bg/40' : 'border-border',
                            )}
                            style={{ '--i': i } as CSSProperties}
                          >
                            <span className="text-xl font-extrabold tabular-nums">{s.waiting}</span>
                            <span className="text-ink-2 text-xs font-semibold">
                              {stationLabel(s.station, t)}
                            </span>
                            <span
                              className={cn(
                                'text-[11px]',
                                hot ? 'text-red font-semibold' : 'text-ink-3',
                              )}
                            >
                              {t('dashboard.avgShort', { min: s.minutes })}
                              {hot ? ` · ⚠ ${t('dashboard.queueLong')}` : ''}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </Panel>
                <Panel
                  i={2}
                  title={t('dashboard.visitsByService', { period: periodWord })}
                  right={t('dashboard.visitsCount', { count: data.tiles.visits })}
                >
                  {data.visitsByGroup.length === 0 ? (
                    <Empty>{t('dashboard.noVisits')}</Empty>
                  ) : (
                    <HBarList
                      subject="visits"
                      labelWidth="minmax(96px,140px)"
                      rows={data.visitsByGroup.map((v) => ({
                        label: groupLabel(v.group, t),
                        value: v.count,
                      }))}
                    />
                  )}
                  <div className="text-ink-3 flex flex-wrap items-center gap-2 text-xs">
                    {t('dashboard.bookings', { period: periodWord })}: {data.bookings.booked}{' '}
                    {t('dashboard.booked')} ·{' '}
                    {t('dashboard.noShowShort', { missed: data.bookings.missed })}
                    <Badge tone={data.bookings.pending > 0 ? 'yellow' : 'green'} dot={false}>
                      {t('dashboard.pendingInquiries', { count: data.bookings.pending })}
                    </Badge>
                  </div>
                </Panel>
                <Panel
                  i={3}
                  title={t('dashboard.staffActivity', { period: periodWord })}
                  right={t('dashboard.staffActivityNote')}
                  className="overflow-x-auto"
                >
                  {data.staff.length === 0 ? (
                    <Empty>{t('dashboard.noStaffActivity')}</Empty>
                  ) : (
                    <table className="w-full border-collapse text-[13px]">
                      <thead>
                        <tr className="text-ink-3 text-left text-[11px] tracking-[.04em] uppercase">
                          <th className="border-border border-b py-1.5 pr-2 font-semibold">
                            {t('dashboard.cols.employee')}
                          </th>
                          <th className="border-border border-b py-1.5 pr-2 text-right font-semibold">
                            {t('dashboard.cols.registrations')}
                          </th>
                          <th className="border-border border-b py-1.5 pr-2 text-right font-semibold">
                            {t('dashboard.cols.vitals')}
                          </th>
                          <th className="border-border border-b py-1.5 pr-2 text-right font-semibold">
                            {t('dashboard.cols.charges')}
                          </th>
                          {isManager && (
                            <th className="border-border border-b py-1.5 text-right font-semibold">
                              {t('dashboard.cols.collected')}
                            </th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {data.staff.map((s, i) => (
                          <tr
                            key={s.name}
                            className="border-grid anim-enter border-b last:border-b-0"
                            style={{ '--i': i } as CSSProperties}
                          >
                            <td className="py-2 pr-2">
                              <span className="flex items-center gap-2.5">
                                <span
                                  className={cn(
                                    'inline-flex size-[30px] flex-none items-center justify-center rounded-full text-[11px] font-extrabold',
                                    avatarTint(i),
                                  )}
                                >
                                  {initials(s.name)}
                                </span>
                                <span className="min-w-0">
                                  <span className="block truncate font-semibold">{s.name}</span>
                                  <span className="text-ink-3 block truncate text-[11px]">
                                    {t(`staff.roles.${s.role}`)}
                                    {s.staffId ? ` · ${s.staffId}` : ''}
                                  </span>
                                </span>
                              </span>
                            </td>
                            <td className="py-2 pr-2 text-right tabular-nums">{s.registrations}</td>
                            <td className="py-2 pr-2 text-right tabular-nums">{s.vitals}</td>
                            <td className="py-2 pr-2 text-right tabular-nums">{s.charges}</td>
                            {isManager && (
                              <td className="py-2 text-right tabular-nums">
                                {s.collected ? formatNumber(s.collected) : '—'}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Panel>
              </div>
            </section>

            {/* CLINICAL · STOCK · SECURITY */}
            <section className="flex flex-col gap-3">
              <div className={sectionTitle}>
                {t('dashboard.sections.clinical')} · {t('dashboard.logins')}
              </div>
              <div className="pc:grid-cols-3 grid grid-cols-1 gap-4">
                <Panel
                  i={1}
                  title={t('dashboard.topTreatments', { period: periodWord })}
                  right={t('dashboard.cases')}
                >
                  {data.topTreatments.length === 0 && <Empty>{t('dashboard.noTreatments')}</Empty>}
                  <ListRows
                    rows={data.topTreatments.map((d, i) => ({
                      key: d.name,
                      pill: <Pill tint="teal">{i + 1}</Pill>,
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
                  title={t('dashboard.reorder')}
                  right={`${t('dashboard.expiring')} · ${t('dashboard.days30')}: ${data.expiring.d30}`}
                >
                  {data.reorder.length === 0 &&
                    data.expiring.d30 + data.expiring.d60 + data.expiring.d90 === 0 && (
                      <Empty>{t('dashboard.stockOk')}</Empty>
                    )}
                  <ListRows
                    rows={[
                      ...data.reorder.map((r) => ({
                        key: r.name,
                        pill: (
                          <Pill tint={r.onHand < r.min / 2 ? 'coral' : 'amber'}>
                            {t('dashboard.lowShort')}
                          </Pill>
                        ),
                        label: r.name,
                        value: `${formatNumber(r.onHand)} / ${formatNumber(r.min)}`,
                      })),
                      ...(data.expiring.d30 + data.expiring.d60 + data.expiring.d90 > 0
                        ? [
                            {
                              key: 'exp',
                              pill: <Pill tint="amber">{t('dashboard.days30')}</Pill>,
                              label: t('dashboard.expiringBatches', { count: data.expiring.d30 }),
                              value: `${data.expiring.d60} ${t('dashboard.days60')} · ${data.expiring.d90} ${t('dashboard.days90')}`,
                            },
                          ]
                        : []),
                    ]}
                  />
                </Panel>
                <Panel
                  i={3}
                  title={`${t('dashboard.logins')} · ${t('dashboard.last24h')}`}
                  right={`${data.logins.length}`}
                >
                  {data.logins.length === 0 && <Empty>{t('dashboard.noLogins')}</Empty>}
                  <ListRows
                    rows={data.logins.map((l, i) => {
                      const failed = !!l.reason && /wrong|without/i.test(l.reason)
                      return {
                        key: `${l.name}-${i}`,
                        pill: (
                          <Pill tint={failed ? 'coral' : 'mint'}>
                            {failed ? t('dashboard.failedLogin') : 'ok'}
                          </Pill>
                        ),
                        label: `${l.name} · ${t(`staff.roles.${l.role}`)}`,
                        value: `${formatDayMonth(new Date(l.at))} ${formatTime(new Date(l.at))}`,
                      }
                    })}
                  />
                </Panel>
              </div>
            </section>
          </div>
        )}
      </main>
    </StaffShell>
  )
}

/* ---------------------------------------------------------------- pieces */

type TFn = (key: string, opts?: Record<string, unknown>) => string
type Tint = 'teal' | 'mint' | 'amber' | 'coral' | 'violet' | 'navy'
const tintClass: Record<Tint, string> = {
  teal: 'bg-primary-tint text-primary',
  mint: 'bg-green-bg text-green',
  amber: 'bg-amber-bg text-amber',
  coral: 'bg-red-bg text-red',
  violet: 'bg-violet-bg text-violet',
  navy: 'bg-blue-bg text-navy',
}
const avatarTint = (i: number) =>
  tintClass[(['teal', 'mint', 'violet', 'amber', 'coral', 'navy'] as Tint[])[i % 6]!]
const initials = (name: string) =>
  name
    .replace(/^Dr\.?\s+/i, '')
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')

function delta(now: number, prev: number, upIsGood: boolean, t: TFn) {
  const diff = now - prev
  if (diff === 0)
    return {
      text: t('dashboard.noChange'),
      good: null as boolean | null,
      up: null as boolean | null,
    }
  const pct = prev === 0 ? null : Math.round((diff / prev) * 100)
  return {
    text: t('dashboard.vsPrevious', {
      change: `${diff > 0 ? '+' : '−'}${formatNumber(Math.abs(diff))}${pct != null ? ` (${pct > 0 ? '+' : ''}${pct} %)` : ''}`,
    }),
    good: upIsGood ? diff > 0 : diff < 0,
    up: diff > 0,
  }
}

function CountUp({ value }: { value: number }) {
  const v = useCountUp(value, 600)
  return <>{formatNumber(v)}</>
}

function Kpi({
  i,
  icon: IconC,
  tint,
  label,
  value,
  unit,
  delta: d,
  spark,
}: {
  i: number
  icon: LucideIcon
  tint: Tint
  label: string
  value: number
  unit: string
  delta?: { text: string; good: boolean | null; up: boolean | null }
  spark?: number[]
}) {
  const Arrow = d ? (d.up === null ? Minus : d.up ? ArrowUp : ArrowDown) : Minus
  const pill = d
    ? d.good === null
      ? 'bg-hover text-ink-2'
      : d.good
        ? 'bg-green-bg text-green'
        : 'bg-red-bg text-red'
    : ''
  return (
    <div
      className={cn(card, 'anim-enter relative gap-2.5 overflow-hidden px-[18px] pt-[18px] pb-3.5')}
      style={{ '--i': i } as CSSProperties}
    >
      <span
        className={cn(
          'inline-flex size-10 items-center justify-center rounded-xl',
          tintClass[tint],
        )}
      >
        <IconC size={18} aria-hidden="true" />
      </span>
      <span className="text-ink-2 text-[12px] font-bold tracking-[.04em] uppercase">{label}</span>
      <span className="flex flex-wrap items-baseline gap-1.5 text-[30px] leading-none font-extrabold tracking-[-0.02em] tabular-nums">
        <CountUp value={value} />
        <small className="text-ink-3 text-[13px] font-semibold">{unit}</small>
      </span>
      {d && (
        <span
          className={cn(
            'fade-in-late inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-bold tabular-nums',
            pill,
          )}
        >
          <Arrow size={12} strokeWidth={3} aria-hidden="true" />
          {d.text}
        </span>
      )}
      {spark && spark.length > 1 && <Sparkline values={spark} />}
    </div>
  )
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values)
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * 84},${34 - (v / max) * 28}`)
    .join(' ')
  return (
    <svg
      viewBox="0 0 84 34"
      className="text-violet pointer-events-none absolute right-3 bottom-3 h-[34px] w-[84px]"
      aria-hidden="true"
    >
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        pathLength={1}
        className="draw-line"
      />
    </svg>
  )
}

function Panel({
  i,
  title,
  right,
  children,
  className,
}: {
  i: number
  title: string
  right?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn(card, 'anim-enter', className)} style={{ '--i': i } as CSSProperties}>
      <h3 className="m-0 flex items-center justify-between gap-2 text-[15px] font-bold">
        <span className="truncate">{title}</span>
        {right && <span className="text-ink-3 truncate text-xs font-semibold">{right}</span>}
      </h3>
      {children}
    </section>
  )
}

function Pill({ tint, children }: { tint: Tint; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex min-w-6 justify-center rounded-full px-2 py-0.5 text-[11px] font-bold',
        tintClass[tint],
      )}
    >
      {children}
    </span>
  )
}

function ListRows({
  rows,
}: {
  rows: { key: string; pill: ReactNode; label: string; value: string }[]
}) {
  return (
    <div className="flex flex-col">
      {rows.map((r, i) => (
        <div
          key={r.key}
          className="border-grid anim-enter flex min-h-9 items-center gap-2.5 border-b py-1.5 text-[13px] last:border-b-0"
          style={{ '--i': i } as CSSProperties}
        >
          {r.pill}
          <span className="min-w-0 flex-1 truncate">{r.label}</span>
          <span className="font-bold whitespace-nowrap tabular-nums">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

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

function RevenueChart({ data }: { data: DashboardData }) {
  const { t } = useTranslation()
  const values = data.revenue30d.map((r) => r.amount)
  const labels = data.revenue30d.map((r) => formatDayMonth(new Date(r.day)))
  const peak = Math.max(1, ...values)
  const step = niceStep(peak)
  const max = Math.max(step, Math.ceil(peak / step) * step)
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max]
  const rwfShort = (v: number) =>
    v === 0 ? '0' : v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : `${Math.round(v / 1000)}k`
  return (
    <LineChart
      values={values}
      labels={labels}
      max={max}
      ticks={ticks}
      tickLabel={rwfShort}
      format={formatRwf}
      xTicks={[0, 7, 14, 21, 29]}
      area
      animate
      ariaLabel={t('dashboard.revenueAria', { latest: formatRwf(values[values.length - 1] ?? 0) })}
    />
  )
}

const niceStep = (peak: number) => {
  const raw = peak / 4
  const mag = 10 ** Math.floor(Math.log10(Math.max(1, raw)))
  const n = raw / mag
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag
}

const stationLabel = (s: string, t: TFn) => {
  const key = `register.stations.${s.toLowerCase()}`
  const v = t(key)
  return v === key ? s : v
}

const groupLabel = (g: string, t: TFn) => {
  const key = `prices.groups.${g}`
  const v = t(key)
  return v === key ? g : v
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-ink-3 m-0 py-2 text-[13px]">{children}</p>
}

function Skeleton({ isManager }: { isManager: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label={t('dashboard.loading')}>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(168px,1fr))] gap-4">
        {Array.from({ length: isManager ? 7 : 5 }, (_, i) => (
          <div key={i} className="skeleton h-[150px] rounded-[16px]" />
        ))}
      </div>
      <div className="pc:grid-cols-3 grid grid-cols-1 gap-4">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="skeleton h-[260px] rounded-[16px]" />
        ))}
      </div>
    </div>
  )
}

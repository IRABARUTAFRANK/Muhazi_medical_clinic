import { useState } from 'react'
import { ArrowDown, ArrowUp, Minus, Printer, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
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
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Seg } from '@/components/ui/seg'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  rangeDates,
  useDashboard,
  type DashboardData,
  type DashboardRange,
} from '@/lib/api/dashboard'
import { useClinicSettings } from '@/lib/api/settings'
import { useDayNames } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { isLive } from '@/lib/supabase'
import { cn } from '@/lib/utils'

const sectionTitle = 'mt-1 -mb-1 text-xs font-bold tracking-[.06em] text-ink-3 uppercase'
const threeCols = 'grid grid-cols-1 gap-3 pc:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]'

interface DashboardPageProps {
  user: StaffUser
  /** Optional override from the URL; otherwise the user's own dashboard role. */
  view?: DashboardRole
}

/**
 * Manager dashboard, every number live from `dashboard_summary()`. Heads of station see the
 * same page without the money rows. Sections: today's numbers · money · operations ·
 * clinical and stock · people and compliance.
 */
export function DashboardPage({ user, view }: DashboardPageProps) {
  const { t } = useTranslation()
  const dayNames = useDayNames()
  const now = new Date()
  const canManage = user.dashboard === 'manager' || user.role === 'manager'
  const [role] = useState<DashboardRole>(view ?? (canManage ? 'manager' : 'head'))
  const [range, setRange] = useState<DashboardRange>('today')
  const isManager = canManage && role === 'manager'
  const { data, isFetching, error, refetch, dataUpdatedAt } = useDashboard(range, isManager)
  const { data: settings } = useClinicSettings()

  const nav = navForUser(user)
  const activeId = canManage ? 'dashboard' : 'reports'
  const { from, to } = rangeDates(range, now)
  const rangeLabel =
    range === 'today'
      ? `${dayNames.long[now.getDay()]} ${formatDate(now)}`
      : t('dashboard.rangeLabels.week', { from: formatDayMonth(from), to: formatDate(to) })
  const periodWord = t(`dashboard.period.${range}`)

  return (
    <StaffShell user={user} nav={nav} activeId={activeId}>
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 print:overflow-visible">
        {/* PAGE HEADER */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[240px] flex-1">
            <h1 className="m-0 text-2xl font-bold">{t('dashboard.title')}</h1>
            <div className="text-ink-2">
              {t('dashboard.subtitle', {
                town: settings?.profile.sector ?? '',
                range: rangeLabel,
                time: formatTime(dataUpdatedAt ? new Date(dataUpdatedAt) : now),
              })}
              {!isLive && <span className="text-ink-3"> · {t('dashboard.sampleData')}</span>}
            </div>
          </div>
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
            size="sm"
            className="min-h-10"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            <RefreshCw size={16} className={cn(isFetching && 'animate-spin')} aria-hidden="true" />
            {t('dashboard.refresh')}
          </Button>
          <Button variant="primary" onClick={() => window.print()}>
            <Printer size={16} aria-hidden="true" />
            {t('dashboard.print')}
          </Button>
        </div>

        {error && (
          <p
            role="alert"
            className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
          >
            {t('dashboard.loadFailed', { message: error.message })}
          </p>
        )}

        {data && (
          <>
            {/* ROW 1: NUMBERS */}
            <div className={sectionTitle}>{t('dashboard.sections.today')}</div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
              <Tile
                label={t('dashboard.tiles.registered')}
                value={formatNumber(data.tiles.registered)}
                unit={periodWord}
                delta={delta(data.tiles.registered, data.tiles.registeredPrev, true, t)}
              />
              <Tile
                label={t('dashboard.tiles.visits')}
                value={formatNumber(data.tiles.visits)}
                unit={periodWord}
                delta={delta(data.tiles.visits, data.tiles.visitsPrev, true, t)}
              />
              <Tile
                label={t('dashboard.tiles.waiting')}
                value={formatNumber(data.tiles.waitingNow)}
                unit={t('dashboard.units.now')}
              />
              <Tile
                label={t('dashboard.tiles.avgWait')}
                value={formatNumber(data.tiles.avgWaitMin)}
                unit={t('dashboard.units.min')}
                tone={
                  data.tiles.avgWaitMin > 30
                    ? 'bad'
                    : data.tiles.avgWaitMin > 0
                      ? 'good'
                      : undefined
                }
              />
              {isManager && data.tiles.revenue != null && (
                <Tile
                  label={t('dashboard.tiles.revenue')}
                  value={formatNumber(data.tiles.revenue)}
                  unit="RWF"
                  delta={delta(data.tiles.revenue, data.tiles.revenuePrev ?? 0, true, t)}
                />
              )}
              {isManager && data.tiles.openBills != null && (
                <Tile
                  label={t('dashboard.tiles.openBills')}
                  value={formatNumber(data.tiles.openBills)}
                  unit={t('dashboard.units.bills')}
                  sub={formatRwf(data.tiles.openBillsDue ?? 0)}
                  tone={data.tiles.openBills > 0 ? 'warn' : 'good'}
                />
              )}
              <Tile
                label={t('dashboard.tiles.beds')}
                value={`${data.tiles.bedsOccupied} / ${data.tiles.bedsTotal}`}
                unit={t('dashboard.units.beds')}
              />
            </div>

            {/* ROW 2: MONEY */}
            {isManager && (
              <>
                <div className={sectionTitle}>{t('dashboard.sections.money')}</div>
                <div className={threeCols}>
                  <Card>
                    <CardHeader>
                      <span>{t('dashboard.revenue30')}</span>
                      <span className="text-ink-3 text-xs tabular-nums">
                        {formatRwf(data.revenue30d.reduce((s, r) => s + r.amount, 0))}
                      </span>
                    </CardHeader>
                    <CardBody className="justify-center">
                      <RevenueChart data={data} />
                    </CardBody>
                  </Card>
                  <Card>
                    <CardHeader>
                      <span>{t('dashboard.collections', { period: periodWord })}</span>
                      <span className="text-ink-3 text-xs tabular-nums">
                        {formatRwf(data.collections.reduce((s, c) => s + c.amount, 0))}
                      </span>
                    </CardHeader>
                    <CardBody className="justify-center">
                      <HBarList
                        subject="money"
                        rows={data.collections.map((m) => ({
                          label: m.method,
                          value: m.amount,
                          display: formatRwf(m.amount),
                        }))}
                      />
                    </CardBody>
                  </Card>
                  <Card>
                    <CardHeader>
                      <span>{t('dashboard.receivables')}</span>
                      <span className="text-ink-3 text-xs tabular-nums">
                        {formatRwf(data.receivables.reduce((s, r) => s + r.amount, 0))}
                      </span>
                    </CardHeader>
                    <CardBody className="justify-center">
                      {data.receivables.length === 0 ? (
                        <Empty>{t('dashboard.noReceivables')}</Empty>
                      ) : (
                        <HBarList
                          subject="money"
                          rows={data.receivables.map((m) => ({
                            label: m.payer,
                            value: m.amount,
                            display: formatRwf(m.amount),
                          }))}
                        />
                      )}
                    </CardBody>
                  </Card>
                </div>
              </>
            )}

            {/* ROW 3: OPERATIONS */}
            <div className={sectionTitle}>{t('dashboard.sections.ops')}</div>
            <div className={threeCols}>
              <Card>
                <CardHeader>
                  <span>{t('dashboard.visitsByService', { period: periodWord })}</span>
                  <span className="text-ink-3 text-xs tabular-nums">
                    {t('dashboard.visitsCount', { count: data.tiles.visits })}
                  </span>
                </CardHeader>
                <CardBody className="justify-center">
                  {data.visitsByGroup.length === 0 ? (
                    <Empty>{t('dashboard.noVisits')}</Empty>
                  ) : (
                    <HBarList
                      subject="visits"
                      labelWidth="minmax(120px,200px)"
                      rows={data.visitsByGroup.map((v) => ({
                        label: groupLabel(v.group, t),
                        value: v.count,
                      }))}
                    />
                  )}
                </CardBody>
              </Card>
              <Card>
                <CardHeader>
                  <span>{t('dashboard.queueNow')}</span>
                  <span className="text-ink-3 text-xs">{t('common.min')}</span>
                </CardHeader>
                <CardBody className="justify-center">
                  {data.waitByStation.length === 0 ? (
                    <Empty>{t('dashboard.noQueue')}</Empty>
                  ) : (
                    <HBarList
                      subject="time"
                      rows={data.waitByStation.map((s) => ({
                        label: t(`register.stations.${s.station}`),
                        value: s.minutes,
                        display: `${s.minutes} ${t('common.min')} · ${t('dashboard.waitingShort', { count: s.waiting })}`,
                      }))}
                    />
                  )}
                </CardBody>
              </Card>
              <Card>
                <CardHeader>
                  <span>{t('dashboard.bookings', { period: periodWord })}</span>
                </CardHeader>
                <CardBody className="items-start justify-center gap-1">
                  <span className="text-3xl font-bold tabular-nums">
                    {data.bookings.booked}
                    <small className="text-ink-2 text-base font-medium">
                      {' '}
                      {t('dashboard.booked')}
                    </small>
                  </span>
                  <span className="text-ink-2 text-[13px]">
                    {t('dashboard.noShowDetail', {
                      missed: data.bookings.missed,
                      booked: data.bookings.booked,
                    })}
                  </span>
                  <Badge
                    tone={data.bookings.pending > 0 ? 'yellow' : 'green'}
                    className="mt-1 tabular-nums"
                  >
                    {t('dashboard.pendingInquiries', { count: data.bookings.pending })}
                  </Badge>
                </CardBody>
              </Card>
            </div>

            {/* ROW 4: CLINICAL AND STOCK */}
            <div className={sectionTitle}>{t('dashboard.sections.clinical')}</div>
            <div className="pc:grid-cols-3 grid grid-cols-1 gap-3">
              <Card>
                <CardHeader>
                  <span>{t('dashboard.topTreatments', { period: periodWord })}</span>
                  <span className="text-ink-3 text-xs">{t('dashboard.cases')}</span>
                </CardHeader>
                <CardBody className="gap-1">
                  {data.topTreatments.length === 0 && <Empty>{t('dashboard.noTreatments')}</Empty>}
                  {data.topTreatments.map((d, i) => (
                    <div
                      key={d.name}
                      className="flex min-h-7 items-center gap-2.5 text-[13px]"
                      title={`${d.name}: ${d.count}`}
                    >
                      <span className="text-ink-3 w-5 font-semibold tabular-nums">{i + 1}</span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate">{d.name}</span>
                        <span
                          className="bg-c-visits h-2 rounded"
                          style={{
                            width: `${Math.round((d.count / (data.topTreatments[0]?.count ?? 1)) * 100)}%`,
                          }}
                        />
                      </span>
                      <span className="w-8 text-right font-semibold tabular-nums">{d.count}</span>
                      {isManager && d.amount != null && (
                        <span className="text-ink-3 w-24 text-right text-xs tabular-nums">
                          {formatRwf(d.amount)}
                        </span>
                      )}
                    </div>
                  ))}
                </CardBody>
              </Card>
              <div className="flex flex-col gap-3">
                <Card>
                  <CardHeader>
                    <span>{t('dashboard.expiring')}</span>
                    <span className="text-ink-3 text-xs">{t('dashboard.fromToday')}</span>
                  </CardHeader>
                  <CardBody className="flex-row gap-2">
                    <Mini
                      value={data.expiring.d30}
                      label={t('dashboard.days30')}
                      className="bg-red-bg text-red border-transparent"
                    />
                    <Mini
                      value={data.expiring.d60}
                      label={t('dashboard.days60')}
                      className="bg-yellow-bg text-yellow border-transparent"
                    />
                    <Mini
                      value={data.expiring.d90}
                      label={t('dashboard.days90')}
                      labelClass="text-ink-2"
                    />
                  </CardBody>
                </Card>
                <Card className="flex-1">
                  <CardHeader>
                    <span>{t('dashboard.catalogue')}</span>
                    <Badge tone="blue" className="tabular-nums">
                      {t('dashboard.activeTreatments', { count: data.services.active })}
                    </Badge>
                  </CardHeader>
                  <CardBody className="gap-1">
                    <span className="text-ink-2 text-[13px]">{t('dashboard.catalogueNote')}</span>
                  </CardBody>
                </Card>
              </div>
              <Card>
                <CardHeader>
                  <span>{t('dashboard.reorder')}</span>
                  <Badge tone={data.reorder.length ? 'orange' : 'green'} className="tabular-nums">
                    {t('dashboard.items', { count: data.reorder.length })}
                  </Badge>
                </CardHeader>
                <CardBody className="gap-0">
                  {data.reorder.length === 0 && <Empty>{t('dashboard.stockOk')}</Empty>}
                  {data.reorder.map((r) => (
                    <LRow key={r.name}>
                      <span className="min-w-0 flex-1 truncate">{r.name}</span>
                      <span className="text-orange font-semibold tabular-nums">
                        {formatNumber(r.onHand)}
                      </span>
                      <span className="text-ink-3 text-xs tabular-nums">
                        / {formatNumber(r.min)}
                      </span>
                    </LRow>
                  ))}
                </CardBody>
              </Card>
            </div>

            {/* ROW 5: PEOPLE AND COMPLIANCE */}
            <div className={sectionTitle}>{t('dashboard.sections.people')}</div>
            <div className="pc:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] grid grid-cols-1 gap-3">
              <Card>
                <CardHeader>
                  <span>{t('dashboard.staffActivity', { period: periodWord })}</span>
                  <span className="text-ink-3 text-xs">{t('dashboard.staffActivityNote')}</span>
                </CardHeader>
                <CardBody className="gap-0 overflow-x-auto">
                  {data.staff.length === 0 && <Empty>{t('dashboard.noStaffActivity')}</Empty>}
                  {data.staff.length > 0 && (
                    <table className="w-full border-collapse text-[13px]">
                      <thead>
                        <tr className="text-ink-3 text-left text-xs uppercase">
                          <th className="py-1.5 pr-2 font-semibold">
                            {t('dashboard.cols.employee')}
                          </th>
                          <th className="py-1.5 pr-2 text-right font-semibold">
                            {t('dashboard.cols.registrations')}
                          </th>
                          <th className="py-1.5 pr-2 text-right font-semibold">
                            {t('dashboard.cols.vitals')}
                          </th>
                          <th className="py-1.5 pr-2 text-right font-semibold">
                            {t('dashboard.cols.charges')}
                          </th>
                          {isManager && (
                            <th className="py-1.5 pr-2 text-right font-semibold">
                              {t('dashboard.cols.collected')}
                            </th>
                          )}
                          <th className="py-1.5 text-right font-semibold">
                            {t('dashboard.cols.lastSignIn')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.staff.map((s) => (
                          <tr key={s.name} className="border-grid border-t">
                            <td className="py-1.5 pr-2">
                              <span className="block font-medium">{s.name}</span>
                              <span className="text-ink-3 text-xs">
                                {t(`staff.roles.${s.role}`)}
                                {s.staffId ? ` · ${s.staffId}` : ''}
                              </span>
                            </td>
                            <td className="py-1.5 pr-2 text-right tabular-nums">
                              {s.registrations}
                            </td>
                            <td className="py-1.5 pr-2 text-right tabular-nums">{s.vitals}</td>
                            <td className="py-1.5 pr-2 text-right tabular-nums">{s.charges}</td>
                            {isManager && (
                              <td className="py-1.5 pr-2 text-right tabular-nums">
                                {formatRwf(s.collected ?? 0)}
                              </td>
                            )}
                            <td className="text-ink-3 py-1.5 text-right text-xs tabular-nums">
                              {s.lastSignIn
                                ? `${formatDayMonth(new Date(s.lastSignIn))} ${formatTime(new Date(s.lastSignIn))}`
                                : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </CardBody>
              </Card>
              <Card>
                <CardHeader>
                  <span>{t('dashboard.logins')}</span>
                  <span className="text-ink-3 text-xs">{t('dashboard.last24h')}</span>
                </CardHeader>
                <CardBody className="gap-0">
                  {data.logins.length === 0 && <Empty>{t('dashboard.noLogins')}</Empty>}
                  {data.logins.map((l, i) => (
                    <LRow key={`${l.name}-${i}`}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{l.name}</span>
                        <span className="text-ink-3 text-xs">{t(`staff.roles.${l.role}`)}</span>
                      </span>
                      <span className="text-ink-2 text-xs tabular-nums">
                        {formatDayMonth(new Date(l.at))} {formatTime(new Date(l.at))}
                      </span>
                      {l.reason && /wrong|without/i.test(l.reason) && (
                        <Badge tone="red">{t('dashboard.failedLogin')}</Badge>
                      )}
                    </LRow>
                  ))}
                </CardBody>
              </Card>
              <div className="flex flex-col gap-3">
                <Card>
                  <CardHeader>
                    <span>{t('dashboard.messages', { period: periodWord })}</span>
                    <span className="text-ink-3 text-xs">{t('dashboard.sentFailed')}</span>
                  </CardHeader>
                  <CardBody className="justify-center">
                    <HBarList
                      subject="time"
                      labelWidth="80px"
                      rows={data.messages.map((c) => ({
                        label: c.channel,
                        value: c.sent,
                        title: `${c.channel}: ${c.sent} · ${t('dashboard.failed', { count: c.failed })}`,
                        display: (
                          <>
                            {c.sent}{' '}
                            <span className={c.failed ? 'text-red' : 'text-ink-3'}>
                              · {t('dashboard.failed', { count: c.failed })}
                            </span>
                          </>
                        ),
                      }))}
                    />
                  </CardBody>
                </Card>
                {isManager && (
                  <Card className="flex-1">
                    <CardHeader>
                      <span>{t('dashboard.claims')}</span>
                      <span className="text-ink-3 text-xs">{t('dashboard.byInsurer')}</span>
                    </CardHeader>
                    <CardBody className="gap-0">
                      {data.claims.length === 0 && <Empty>{t('dashboard.noClaims')}</Empty>}
                      {data.claims.map((c) => (
                        <LRow key={c.payer}>
                          <span className="min-w-0 flex-1 truncate">{c.payer}</span>
                          <span className="font-semibold whitespace-nowrap tabular-nums">
                            {t('dashboard.claimsCount', { count: c.count })}
                          </span>
                          <span className="text-ink-3 text-right text-xs whitespace-nowrap tabular-nums">
                            {formatRwf(c.amount ?? 0)}
                          </span>
                        </LRow>
                      ))}
                    </CardBody>
                  </Card>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </StaffShell>
  )
}

/* ---------------------------------------------------------------- pieces */

type TFn = (key: string, opts?: Record<string, unknown>) => string

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

function Tile({
  label,
  value,
  unit,
  sub,
  delta: d,
  tone,
}: {
  label: string
  value: string
  unit: string
  sub?: string
  delta?: { text: string; good: boolean | null; up: boolean | null }
  tone?: 'good' | 'warn' | 'bad'
}) {
  const color = d ? (d.good === null ? 'text-ink-3' : d.good ? 'text-green' : 'text-red') : ''
  const Arrow = d ? (d.up === null ? Minus : d.up ? ArrowUp : ArrowDown) : Minus
  return (
    <div
      className={cn(
        'border-border bg-card flex min-w-0 flex-col gap-1 rounded-lg border px-4 py-3',
        tone === 'bad' && 'border-red',
        tone === 'warn' && 'border-orange',
      )}
    >
      <span className="text-ink-2 text-xs font-semibold tracking-[.03em] uppercase">{label}</span>
      <span className="flex flex-wrap items-baseline gap-1.5 text-3xl font-bold tabular-nums">
        {value}
        <small className="text-ink-2 text-sm font-medium">{unit}</small>
      </span>
      {sub && <span className="text-ink-2 text-xs tabular-nums">{sub}</span>}
      {d && (
        <span className={cn('flex items-center gap-1 text-xs font-semibold tabular-nums', color)}>
          <Arrow size={12} strokeWidth={3} aria-hidden="true" />
          {d.text}
        </span>
      )}
    </div>
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

const groupLabel = (g: string, t: TFn) => {
  const key = `prices.groups.${g}`
  const v = t(key)
  return v === key ? g : v
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-ink-3 m-0 py-2 text-[13px]">{children}</p>
}

function Mini({
  value,
  label,
  className,
  labelClass,
}: {
  value: number
  label: string
  className?: string
  labelClass?: string
}) {
  return (
    <div
      className={cn(
        'border-border flex flex-1 flex-col items-center gap-1 rounded-lg border p-2',
        className,
      )}
    >
      <b className="text-2xl tabular-nums">{value}</b>
      <span className={cn('text-xs font-semibold', labelClass)}>{label}</span>
    </div>
  )
}

function LRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-grid flex min-h-9 items-center gap-2.5 border-b text-[13px] last:border-b-0">
      {children}
    </div>
  )
}

import { useState } from 'react'
import { ArrowDown, ArrowUp, Download, Filter, ChevronDown, Minus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  BACKUP,
  BREAK_GLASS,
  CHANNELS,
  CLAIMS_DUE,
  CLINIC,
  COLLECTIONS_TODAY,
  COLLECTIONS_TOTAL,
  DASHBOARD_TILES,
  DEVICES,
  DEVICE_TONE,
  EXPIRING_BATCHES,
  NO_SHOW,
  RECEIVABLES,
  RECEIVABLES_TOTAL,
  REORDER,
  REVENUE_30D,
  TOP_DIAGNOSES,
  VISITS_BY_SERVICE,
  VISITS_TOTAL,
  WAIT_BY_STATION,
  addDays,
  demoNow,
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
import { useDayNames } from '@/lib/hooks'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'

type Range = 'today' | 'week' | 'month' | 'custom'

const sectionTitle = 'mt-1 -mb-1 text-xs font-bold tracking-[.06em] text-ink-3 uppercase'
const threeCols = 'grid grid-cols-1 gap-3 pc:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]'

interface DashboardPageProps {
  user: StaffUser
  /** Optional override from the URL; otherwise the user's own dashboard role. */
  view?: DashboardRole
}

/** Manager dashboard (five rows). Heads of station see the same page without money rows. */
export function DashboardPage({ user, view }: DashboardPageProps) {
  const { t } = useTranslation()
  const dayNames = useDayNames()
  const now = demoNow()
  const canManage = user.dashboard === 'manager'
  const [role, setRole] = useState<DashboardRole>(view ?? (canManage ? 'manager' : 'head'))
  const [range, setRange] = useState<Range>('today')
  const isManager = canManage && role === 'manager'

  const nav = navForUser(user)
  const activeId = canManage ? 'dashboard' : 'reports'

  const rangeLabel = (() => {
    const monday = addDays(now, -((now.getDay() + 6) % 7))
    const first = new Date(now.getFullYear(), now.getMonth(), 1)
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    switch (range) {
      case 'today':
        return `${dayNames.long[now.getDay()]} ${formatDate(now)}`
      case 'week':
        return t('dashboard.rangeLabels.week', {
          from: formatDayMonth(monday),
          to: formatDate(addDays(monday, 6)),
        })
      case 'month':
        return t('dashboard.rangeLabels.month', {
          from: formatDayMonth(first),
          to: formatDate(lastDay),
        })
      case 'custom':
        return t('dashboard.rangeLabels.custom')
    }
  })()

  const tiles = DASHBOARD_TILES.filter((tile) => isManager || !tile.money)
  const dayLabels = REVENUE_30D.map((_, i) =>
    formatDayMonth(addDays(now, -(REVENUE_30D.length - 1 - i))),
  )
  const rwfShort = (v: number) => (v === 0 ? '0' : `${v / 1000}k`)

  return (
    <StaffShell user={user} nav={nav} activeId={activeId}>
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        {/* PAGE HEADER */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[240px] flex-1">
            <h1 className="m-0 text-2xl font-bold">{t('dashboard.title')}</h1>
            <div className="text-ink-2">
              {t('dashboard.subtitle', {
                town: CLINIC.town,
                range: rangeLabel,
                time: formatTime(now),
              })}
            </div>
          </div>
          <Seg<Range>
            label={t('dashboard.dateRange')}
            value={range}
            onChange={setRange}
            options={[
              { value: 'today', label: t('dashboard.ranges.today') },
              { value: 'week', label: t('dashboard.ranges.week') },
              { value: 'month', label: t('dashboard.ranges.month') },
              { value: 'custom', label: t('dashboard.ranges.custom') },
            ]}
          />
          <Button
            aria-label={t('dashboard.roleFilter')}
            size="sm"
            className="min-h-10 font-medium"
            disabled={!canManage}
            onClick={() => setRole((r) => (r === 'manager' ? 'head' : 'manager'))}
          >
            <Filter size={16} aria-hidden="true" />
            {t('dashboard.viewAs', {
              role: t(isManager ? 'common.manager' : 'roles.headOfStation'),
            })}
            <ChevronDown size={14} aria-hidden="true" />
          </Button>
          <Button variant="primary">
            <Download size={16} aria-hidden="true" />
            {t('dashboard.export')}
          </Button>
        </div>

        {/* ROW 1: TODAY'S NUMBERS */}
        <div className={sectionTitle}>{t('dashboard.sections.today')}</div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
          {tiles.map((tile) => {
            const color = tile.good === null ? 'text-ink-3' : tile.good ? 'text-green' : 'text-red'
            const Arrow = tile.up === null ? Minus : tile.up ? ArrowUp : ArrowDown
            return (
              <div
                key={tile.id}
                className="border-border bg-card flex min-w-0 flex-col gap-1 rounded-lg border px-4 py-3"
              >
                <span className="text-ink-2 text-xs font-semibold tracking-[.03em] uppercase">
                  {t(`dashboard.tiles.${tile.id}`)}
                </span>
                <span className="flex flex-wrap items-baseline gap-1.5 text-3xl font-bold tabular-nums">
                  {tile.value}
                  <small className="text-ink-2 text-sm font-medium">
                    {t(`dashboard.units.${tile.unitKey}`)}
                  </small>
                </span>
                <span
                  className={cn(
                    'flex items-center gap-1 text-xs font-semibold tabular-nums',
                    color,
                  )}
                >
                  <Arrow size={12} strokeWidth={3} aria-hidden="true" />
                  {tile.change
                    ? t('dashboard.vsYesterday', { change: tile.change })
                    : t('dashboard.noChange')}
                </span>
              </div>
            )
          })}
        </div>

        {/* ROW 2: MONEY */}
        {isManager && (
          <>
            <div className={sectionTitle}>{t('dashboard.sections.money')}</div>
            <div className={threeCols}>
              <Card>
                <CardHeader>
                  <span>{t('dashboard.revenue30')}</span>
                  <span className="text-ink-3 text-xs tabular-nums">RWF</span>
                </CardHeader>
                <CardBody className="justify-center">
                  <LineChart
                    values={REVENUE_30D}
                    labels={dayLabels}
                    max={1250000}
                    ticks={[0, 400000, 800000, 1200000]}
                    tickLabel={rwfShort}
                    format={formatRwf}
                    xTicks={[0, 7, 14, 21, 29]}
                    ariaLabel={t('dashboard.revenueAria', {
                      latest: formatRwf(REVENUE_30D[REVENUE_30D.length - 1] ?? 0),
                    })}
                  />
                </CardBody>
              </Card>
              <Card>
                <CardHeader>
                  <span>{t('dashboard.collections')}</span>
                  <span className="text-ink-3 text-xs tabular-nums">
                    {formatRwf(COLLECTIONS_TOTAL)}
                  </span>
                </CardHeader>
                <CardBody className="justify-center">
                  <HBarList
                    subject="money"
                    max={330000}
                    rows={COLLECTIONS_TODAY.map((m) => ({ ...m, display: formatRwf(m.value) }))}
                  />
                </CardBody>
              </Card>
              <Card>
                <CardHeader>
                  <span>{t('dashboard.receivables')}</span>
                  <span className="text-ink-3 text-xs tabular-nums">
                    {formatRwf(RECEIVABLES_TOTAL)}
                  </span>
                </CardHeader>
                <CardBody className="justify-center">
                  <HBarList
                    subject="money"
                    max={5000000}
                    rows={RECEIVABLES.map((m) => ({ ...m, display: formatRwf(m.value) }))}
                  />
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
              <span>{t('dashboard.visitsByService')}</span>
              <span className="text-ink-3 text-xs tabular-nums">
                {t('dashboard.visitsCount', { count: VISITS_TOTAL })}
              </span>
            </CardHeader>
            <CardBody className="justify-center">
              <HBarList
                subject="visits"
                max={420}
                labelWidth="minmax(120px,200px)"
                rows={VISITS_BY_SERVICE}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader>
              <span>{t('dashboard.waitByStation')}</span>
              <span className="text-ink-3 text-xs">{t('common.min')}</span>
            </CardHeader>
            <CardBody className="justify-center">
              <HBarList
                subject="time"
                max={32}
                rows={WAIT_BY_STATION.map((s) => ({
                  ...s,
                  display: `${s.value} ${t('common.min')}`,
                }))}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader>
              <span>{t('dashboard.noShow')}</span>
            </CardHeader>
            <CardBody className="items-start justify-center gap-1">
              <span className="text-3xl font-bold tabular-nums">
                {NO_SHOW.ratePct}
                <small className="text-ink-2 text-base font-medium"> %</small>
              </span>
              <span className="text-green flex items-center gap-1 text-[13px] font-semibold tabular-nums">
                <ArrowDown size={12} strokeWidth={3} aria-hidden="true" />
                {t('dashboard.noShowDelta', {
                  points: (NO_SHOW.previousPct - NO_SHOW.ratePct).toFixed(1),
                  prev: NO_SHOW.previousPct,
                })}
              </span>
              <span className="text-ink-2 text-[13px]">
                {t('dashboard.noShowDetail', { missed: NO_SHOW.missed, booked: NO_SHOW.booked })}
              </span>
              <div className="mt-2 flex h-12 w-full items-end gap-1" aria-hidden="true">
                {NO_SHOW.series.map((v, i) => (
                  <span
                    key={i}
                    className="bg-c-time flex-1 rounded-t-[3px]"
                    style={{ height: `${Math.round((v / 12) * 100)}%` }}
                    title={`${v} %`}
                  />
                ))}
              </div>
              <div className="text-ink-3 flex w-full justify-between text-xs">
                <span>{t('dashboard.may')}</span>
                <span>{t('dashboard.oct')}</span>
              </div>
            </CardBody>
          </Card>
        </div>

        {/* ROW 4: CLINICAL AND STOCK */}
        <div className={sectionTitle}>{t('dashboard.sections.clinical')}</div>
        <div className="pc:grid-cols-3 grid grid-cols-1 gap-3">
          <Card>
            <CardHeader>
              <span>{t('dashboard.topDiagnoses')}</span>
              <span className="text-ink-3 text-xs">{t('dashboard.cases')}</span>
            </CardHeader>
            <CardBody className="gap-1">
              {TOP_DIAGNOSES.map((d, i) => (
                <div
                  key={d.label}
                  className="flex min-h-7 items-center gap-2.5 text-[13px]"
                  title={`${d.label}: ${d.value}`}
                >
                  <span className="text-ink-3 w-5 font-semibold tabular-nums">{i + 1}</span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate">{d.label}</span>
                    <span
                      className="bg-c-visits h-2 rounded"
                      style={{
                        width: `${Math.round((d.value / (TOP_DIAGNOSES[0]?.value ?? 1)) * 100)}%`,
                      }}
                    />
                  </span>
                  <span className="w-8 text-right font-semibold tabular-nums">{d.value}</span>
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
                  value={EXPIRING_BATCHES.d30}
                  label={t('dashboard.days30')}
                  className="bg-red-bg text-red border-transparent"
                />
                <Mini
                  value={EXPIRING_BATCHES.d60}
                  label={t('dashboard.days60')}
                  className="bg-yellow-bg text-yellow border-transparent"
                />
                <Mini
                  value={EXPIRING_BATCHES.d90}
                  label={t('dashboard.days90')}
                  labelClass="text-ink-2"
                />
              </CardBody>
            </Card>
            <Card className="flex-1">
              <CardHeader>
                <span>{t('dashboard.backup')}</span>
                <Badge tone="green">{t('dashboard.healthy')}</Badge>
              </CardHeader>
              <CardBody className="gap-1">
                <span className="text-xl font-bold tabular-nums">
                  {t('dashboard.backupToday', { time: BACKUP.lastAt })}
                </span>
                <span className="text-ink-2 text-[13px]">
                  {t('dashboard.backupLast', { size: BACKUP.sizeGb, time: BACKUP.offsiteAt })}
                </span>
                <span className="text-ink-3 text-xs tabular-nums">
                  {t('dashboard.backupNext', {
                    when: `${formatDate(addDays(now, 1))} ${BACKUP.nextAt}`,
                  })}
                </span>
              </CardBody>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <span>{t('dashboard.reorder')}</span>
              <Badge tone="orange" className="tabular-nums">
                {t('dashboard.items', { count: REORDER.length })}
              </Badge>
            </CardHeader>
            <CardBody className="gap-0">
              {REORDER.map((r) => (
                <LRow key={r.label}>
                  <span className="min-w-0 flex-1 truncate">{r.label}</span>
                  <span className="text-orange font-semibold tabular-nums">
                    {formatNumber(r.qty)}
                  </span>
                  <span className="text-ink-3 text-xs tabular-nums">/ {formatNumber(r.min)}</span>
                </LRow>
              ))}
            </CardBody>
          </Card>
        </div>

        {/* ROW 5: COMPLIANCE AND SYSTEM */}
        <div className={sectionTitle}>{t('dashboard.sections.compliance')}</div>
        <div className="pc:grid-cols-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <span>{t('dashboard.devices')}</span>
              <Badge tone="red" className="tabular-nums">
                {t('dashboard.failing', {
                  count: DEVICES.filter((d) => d.state === 'failed').length,
                })}
              </Badge>
            </CardHeader>
            <CardBody className="gap-0">
              {DEVICES.map((d) => (
                <LRow key={d.label}>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{d.label}</span>
                    <span className="text-ink-3 text-xs tabular-nums">{d.detail}</span>
                  </span>
                  <Badge tone={DEVICE_TONE[d.state]}>{t(`dashboard.deviceState.${d.state}`)}</Badge>
                </LRow>
              ))}
            </CardBody>
          </Card>
          <Card>
            <CardHeader>
              <span>{t('dashboard.breakGlass')}</span>
              <Badge tone="yellow" className="tabular-nums">
                {t('dashboard.toReview', { count: 1 })}
              </Badge>
            </CardHeader>
            <CardBody className="gap-2">
              <div className="flex flex-col gap-0.5 py-1 text-[13px]">
                <span className="font-semibold">{BREAK_GLASS.who}</span>
                <span className="text-ink-2 tabular-nums">
                  {t('dashboard.breakGlassDetail', {
                    time: BREAK_GLASS.when,
                    file: BREAK_GLASS.file,
                    patient: BREAK_GLASS.patient,
                  })}
                </span>
                <span className="text-ink-3 text-xs">
                  {t('dashboard.reason', { reason: BREAK_GLASS.reason })}
                </span>
              </div>
              <Button size="sm" className="self-start">
                {t('dashboard.reviewLog')}
              </Button>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>
              <span>{t('dashboard.messages')}</span>
              <span className="text-ink-3 text-xs">{t('dashboard.sentFailed')}</span>
            </CardHeader>
            <CardBody className="justify-center">
              <HBarList
                subject="time"
                labelWidth="80px"
                rows={CHANNELS.map((c) => ({
                  label: c.label,
                  value: c.sent,
                  title: `${c.label}: ${c.sent} · ${t('dashboard.failed', { count: c.failed })}`,
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
          <Card>
            <CardHeader>
              <span>{t('dashboard.claims')}</span>
              <span className="text-ink-3 text-xs">{t('dashboard.byInsurer')}</span>
            </CardHeader>
            <CardBody className="gap-0">
              {CLAIMS_DUE.map((c) => (
                <LRow key={c.label}>
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  <span className="font-semibold whitespace-nowrap tabular-nums">
                    {t('dashboard.claimsCount', { count: c.count })}
                  </span>
                  <span className="text-ink-3 text-right text-xs whitespace-nowrap tabular-nums">
                    {formatRwf(c.amount)}
                  </span>
                </LRow>
              ))}
            </CardBody>
          </Card>
        </div>
      </main>
    </StaffShell>
  )
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

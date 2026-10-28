import { ChartColumn, Clock, DoorOpen, Hash, History, Hourglass, Timer } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '@mmc/shared'
import { Hint, Kpi, Panel } from '@/components/dash/kit'
import { DashLink } from '@/components/dash/dash-link'
import { delta } from '@/components/dash/kit-style'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  previousPeriod,
  useWaitTimeStats,
  waitFigure,
  type WaitDesk,
  type WaitTimeStats,
} from '@/lib/api/analytics'
import { bucketsOf } from '../buckets'
import { SERIES, StackedBars } from '../charts'
import { minutes, num, stationName, type TFn } from '../format'
import {
  DataTable,
  Figures,
  LoadError,
  NeedsUpdate,
  Quiet,
  useExport,
  ViewSkeleton,
  type Col,
} from '../kit'
import { analyticsReport } from '../reports'
import type { ViewProps } from '../view-props'

/** Minutes for a table cell: "—" without data, "Not enough data" below the minimum. */
const cellMinutes = (n: number, v: number | null, minN: number, t: TFn) =>
  n === 0 ? '—' : n < minN ? t('analytics.wait.notEnough') : minutes(v, t)

/**
 * Waiting times, the only place they are shown. One wait is one queue entry at one desk, from
 * joining that desk's queue to being taken (or the desk's first act: vitals, payment, medicine
 * handed over, sample collected). Only finished waits count; over 12 hours or across midnight is
 * left out as a data error. Median and 90th percentile, never an average; below 5 waits a figure
 * says "Not enough data".
 */
export function WaitingView({ period, dept, clinic }: ViewProps) {
  const { t } = useTranslation()
  const p = { from: period.from, to: period.to }
  const q = useWaitTimeStats(p, dept)
  const prev = useWaitTimeStats(previousPeriod(p), dept)
  const w = q.data

  useExport(() => (w && !w.needsUpdate ? waitingReport(w, t, clinic) : null))

  if (q.error) return <LoadError error={q.error} />
  if (!w) return <ViewSkeleton />
  if (w.needsUpdate) return <NeedsUpdate />

  const R = w.rules
  const P = prev.data && !prev.data.needsUpdate ? prev.data : null
  const median = waitFigure(w.overall, 'median', R)
  const p90 = waitFigure(w.overall, 'p90', R)
  const arrival = waitFigure(w.arrival, 'median', R)
  const pMedian = P ? waitFigure(P.overall, 'median', P.rules) : null
  const pP90 = P ? waitFigure(P.overall, 'p90', P.rules) : null
  const pArrival = P ? waitFigure(P.arrival, 'median', P.rules) : null
  // shorter is better
  const mDelta = (a: number | null, b: number | null) =>
    a != null && b != null ? delta(Math.round(a), Math.round(b), false, t) : undefined
  const forgotten = w.desks.reduce((s, d) => s + d.forgotten, 0)

  // the daily median (a day under the minimum shows no bar); a long period: per month, the
  // middle of the daily medians weighted by the waits of each day
  const bk = bucketsOf(w.from || p.from, w.to || p.to)
  const byKey = new Map<string, { n: number; sum: number }>()
  for (const d of w.days) {
    if (d.median == null || d.n === 0) continue
    const k = bk.of(d.day)
    const cur = byKey.get(k) ?? { n: 0, sum: 0 }
    cur.n += d.n
    cur.sum += d.median * d.n
    byKey.set(k, cur)
  }
  const values = bk.keys.map((k) => {
    const x = byKey.get(k)
    return x && x.n >= R.minN ? Math.round((x.sum / x.n) * 10) / 10 : null
  })

  return (
    <>
      <Figures>
        <Kpi
          i={0}
          icon={Hourglass}
          tint="teal"
          label={t('analytics.wait.median')}
          value={0}
          text={minutes(median, t)}
          unit=""
          delta={mDelta(median, pMedian)}
        />
        <Kpi
          i={1}
          icon={Timer}
          tint="amber"
          label={t('analytics.wait.p90')}
          value={0}
          text={minutes(p90, t)}
          unit=""
          delta={mDelta(p90, pP90)}
        />
        <Kpi
          i={2}
          icon={DoorOpen}
          tint="violet"
          label={t('analytics.wait.arrival')}
          value={0}
          text={minutes(arrival, t)}
          unit=""
          delta={mDelta(arrival, pArrival)}
        />
        <Kpi
          i={3}
          icon={Hash}
          tint="navy"
          label={t('analytics.wait.counted')}
          value={w.overall.n}
          unit=""
          delta={
            w.overall.excluded > 0
              ? {
                  text: t('analytics.wait.leftOut', { count: w.overall.excluded }),
                  good: null,
                  up: null,
                }
              : undefined
          }
        />
      </Figures>
      <Hint>{t('analytics.wait.rule', { min: R.minN, hours: R.maxHours })}</Hint>

      <Panel i={1} icon={ChartColumn} tint="teal" title={t('analytics.wait.chartTitle')}>
        {values.every((v) => v == null) ? (
          <Quiet>{t('analytics.wait.notEnough')}</Quiet>
        ) : (
          <StackedBars
            labels={bk.long}
            tickLabels={bk.short}
            series={[
              {
                key: 'median',
                label: t('analytics.wait.median'),
                color: SERIES[0],
                values,
              },
            ]}
            format={(v) => minutes(v, t)}
            tick={(v) => formatNumber(v)}
            noData={t('analytics.wait.notEnough')}
            ariaLabel={t('analytics.wait.chartAria', { period: period.label })}
          />
        )}
        <Hint>{t(bk.monthly ? 'analytics.wait.chartNoteMonth' : 'analytics.wait.chartNote')}</Hint>
      </Panel>

      <Panel i={2} icon={Clock} tint="amber" title={t('analytics.wait.tableTitle')}>
        <DeskTable w={w} />
        {forgotten > 0 && (
          <DashLink
            href="/app/visits"
            className={cn(
              buttonVariants({ variant: 'tint-amber', size: 'sm' }),
              // a long sentence (Kinyarwanda) wraps inside the button instead of running out of it
              'h-auto min-h-8 self-start py-1 text-left whitespace-normal',
            )}
          >
            <History size={16} aria-hidden="true" />
            {t('dashboard.forgottenHint', { count: forgotten })}
          </DashLink>
        )}
        <Hint>{t('analytics.wait.tableNote')}</Hint>
      </Panel>
    </>
  )
}

function DeskTable({ w }: { w: WaitTimeStats }) {
  const { t } = useTranslation()
  const minN = w.rules.minN
  const sum = (f: (d: WaitDesk) => number) => w.desks.reduce((s, d) => s + f(d), 0)
  const cols: Col<WaitDesk>[] = [
    {
      key: 'station',
      label: t('analytics.wait.desk'),
      cell: (d) => <b>{stationName(d.station, t)}</b>,
      sort: (d) => stationName(d.station, t),
    },
    {
      key: 'n',
      label: t('analytics.wait.n'),
      align: 'right',
      cell: (d) => num(d.n),
      sort: (d) => d.n,
      total: num(w.overall.n),
    },
    {
      key: 'median',
      label: t('analytics.wait.medianShort'),
      align: 'right',
      cell: (d) => cellMinutes(d.n, d.median, minN, t),
      sort: (d) => (d.n >= minN ? d.median : null),
      total: cellMinutes(w.overall.n, w.overall.median, minN, t),
    },
    {
      key: 'p90',
      label: t('analytics.wait.p90Short'),
      align: 'right',
      cell: (d) => cellMinutes(d.n, d.p90, minN, t),
      sort: (d) => (d.n >= minN ? d.p90 : null),
      total: cellMinutes(w.overall.n, w.overall.p90, minN, t),
    },
    {
      key: 'excluded',
      label: t('analytics.wait.excluded'),
      align: 'right',
      wide: true,
      cell: (d) => num(d.excluded),
      sort: (d) => d.excluded,
      total: num(w.overall.excluded),
    },
    {
      key: 'now',
      label: t('analytics.wait.waitingNow'),
      align: 'right',
      cell: (d) => num(d.waitingNow),
      sort: (d) => d.waitingNow,
      total: num(sum((d) => d.waitingNow)),
    },
    {
      key: 'longest',
      label: t('analytics.wait.longestNow'),
      align: 'right',
      wide: true,
      cell: (d) => (d.longestNow == null ? '—' : minutes(d.longestNow, t)),
      sort: (d) => d.longestNow,
    },
    {
      key: 'forgotten',
      label: t('analytics.wait.forgotten'),
      align: 'right',
      wide: true,
      cell: (d) => num(d.forgotten),
      sort: (d) => d.forgotten,
      total: num(sum((d) => d.forgotten)),
    },
  ]
  return (
    <DataTable
      rows={w.desks}
      cols={cols}
      rowKey={(d) => d.station}
      totalsLabel={t('analytics.wait.allDesks')}
      empty={<Quiet>{t('analytics.noData')}</Quiet>}
      caption={t('analytics.wait.tableTitle')}
    />
  )
}

/* ---------------------------------------------------------------- export */

function waitingReport(w: WaitTimeStats, t: TFn, clinic: ViewProps['clinic']) {
  const R = w.rules
  const fig = (n: number, v: number | null) => (n >= R.minN && v != null ? v : null)
  return analyticsReport({
    t,
    clinic,
    title: t('analytics.wait.reportTitle'),
    code: 'WAI',
    name: 'waiting-times',
    from: w.from,
    to: w.to,
    // a figure under the minimum of waits is left out (never printed as 0)
    figures: [
      { label: t('analytics.wait.median'), value: fig(w.overall.n, w.overall.median), unit: 'min' },
      { label: t('analytics.wait.p90'), value: fig(w.overall.n, w.overall.p90), unit: 'min' },
      {
        label: t('analytics.wait.arrival'),
        value: fig(w.arrival.n, w.arrival.median),
        unit: 'min',
      },
      { label: t('analytics.wait.counted'), value: w.overall.n as number | null },
      { label: t('analytics.wait.excluded'), value: w.overall.excluded as number | null },
    ].flatMap((f) => (f.value == null ? [] : [{ ...f, value: f.value }])),
    summary: t('analytics.wait.rule', { min: R.minN, hours: R.maxHours }),
    sections: [
      {
        name: t('analytics.wait.reportTitle'),
        tables: [
          {
            title: t('analytics.wait.tableTitle'),
            note: t('analytics.wait.tableNote'),
            columns: [
              { label: t('analytics.wait.desk') },
              { label: t('analytics.wait.n'), kind: 'number' },
              { label: t('analytics.wait.medianMin'), kind: 'number' },
              { label: t('analytics.wait.p90Min'), kind: 'number' },
              { label: t('analytics.wait.meanMin'), kind: 'number' },
              { label: t('analytics.wait.excluded'), kind: 'number' },
              { label: t('analytics.wait.waitingNow'), kind: 'number' },
              { label: t('analytics.wait.longestNowMin'), kind: 'number' },
              { label: t('analytics.wait.forgotten'), kind: 'number' },
            ],
            rows: w.desks.map((d) => [
              stationName(d.station, t),
              d.n,
              fig(d.n, d.median),
              fig(d.n, d.p90),
              fig(d.n, d.mean),
              d.excluded,
              d.waitingNow,
              d.longestNow,
              d.forgotten,
            ]),
            totals: [1, 5, 6, 8],
          },
          {
            title: t('analytics.wait.daysTitle'),
            columns: [
              { label: t('report.cols.date'), kind: 'date' },
              { label: t('analytics.wait.n'), kind: 'number' },
              { label: t('analytics.wait.medianMin'), kind: 'number' },
            ],
            rows: w.days.map((d) => [d.day, d.n, fig(d.n, d.median)]),
            totals: [1],
          },
          {
            title: t('analytics.wait.turnaroundTitle'),
            columns: [
              { label: t('analytics.wait.desk') },
              { label: t('analytics.wait.n'), kind: 'number' },
              { label: t('analytics.wait.medianMin'), kind: 'number' },
              { label: t('analytics.wait.p90Min'), kind: 'number' },
            ],
            rows: w.turnaround.map((d) => [
              stationName(d.station, t),
              d.n,
              fig(d.n, d.median),
              fig(d.n, d.p90),
            ]),
          },
        ],
      },
    ],
  })
}

import { ChartColumn, HeartPulse, Hourglass, Siren, TriangleAlert, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '@mmc/shared'
import { Hint, Kpi, Panel } from '@/components/dash/kit'
import {
  useStaffActivity,
  useWaitTimeStats,
  waitFigure,
  type ActivityPerson,
} from '@/lib/api/analytics'
import { useDeskSummary } from '@/lib/api/desk'
import { bucketsOf, sumBy } from '../buckets'
import { SERIES, StackedBars } from '../charts'
import { minutes, num, roleName, short, type TFn } from '../format'
import { DataTable, Figures, LoadError, NeedsUpdate, Quiet, useExport, ViewSkeleton } from '../kit'
import { analyticsReport } from '../reports'
import type { ViewProps } from '../view-props'

/**
 * Triage in the period: vitals taken (per day and per nurse), patients in red and yellow now, and
 * the wait for vitals (median, from the waiting-time figures).
 */
export function TriageView({ period, update, dept, clinic }: ViewProps) {
  const { t } = useTranslation()
  const p = { from: period.from, to: period.to }
  const desk = useDeskSummary(p)
  const staff = useStaffActivity(p, dept)
  const wait = useWaitTimeStats(p, dept)
  const d = desk.data
  const a = staff.data && !staff.data.needsUpdate ? staff.data : null
  const w = wait.data && !wait.data.needsUpdate ? wait.data : null
  const triageDesk = w?.desks.find((x) => x.station === 'triage')
  const waitMedian = triageDesk ? waitFigure(triageDesk, 'median', w!.rules) : null
  const nurses = (a?.people ?? []).filter((x) => (x.counts.vitals ?? 0) > 0)

  useExport(() => (d ? triageReport(d.tiles.vitalsToday, nurses, p, t, clinic) : null))

  if (desk.error) return <LoadError error={desk.error} />
  if (!d) return <ViewSkeleton />

  const bk = bucketsOf(p.from, p.to)
  const perDay = a
    ? sumBy(
        bk,
        a.days.filter((x) => x.kind === 'vitals'),
        (x) => x.day,
        (x) => x.n,
      )
    : []

  return (
    <>
      <Figures>
        <Kpi
          i={0}
          icon={HeartPulse}
          tint="teal"
          label={t('analytics.triage.vitals')}
          value={Number(d.tiles.vitalsToday)}
          unit=""
        />
        <Kpi
          i={1}
          icon={Siren}
          tint="coral"
          label={t('analytics.triage.redNow')}
          value={Number(d.tiles.triageRed)}
          unit={t('dashboard.units.now')}
        />
        <Kpi
          i={2}
          icon={TriangleAlert}
          tint="amber"
          label={t('analytics.triage.yellowNow')}
          value={Number(d.tiles.triageYellow)}
          unit={t('dashboard.units.now')}
        />
        <Kpi
          i={3}
          icon={Hourglass}
          tint="violet"
          label={t('analytics.triage.wait')}
          value={0}
          text={w ? minutes(waitMedian, t) : '—'}
          unit=""
        />
      </Figures>
      <Hint>{t('analytics.triage.note')}</Hint>

      <Panel i={1} icon={ChartColumn} tint="teal" title={t('analytics.triage.chartTitle')}>
        {staff.error ? (
          <LoadError error={staff.error} />
        ) : staff.data?.needsUpdate ? (
          <NeedsUpdate />
        ) : !a ? (
          <div className="skeleton h-[200px] rounded-md" />
        ) : perDay.every((v) => !v) ? (
          <Quiet>{t('analytics.noData')}</Quiet>
        ) : (
          <StackedBars
            labels={bk.long}
            tickLabels={bk.short}
            series={[
              {
                key: 'vitals',
                label: t('analytics.triage.vitals'),
                color: SERIES[0],
                values: perDay,
              },
            ]}
            format={(v) => formatNumber(v)}
            tick={short}
            ariaLabel={t('analytics.triage.chartAria', { period: period.label })}
          />
        )}
      </Panel>

      <Panel i={2} icon={Users} tint="navy" title={t('analytics.triage.byNurse')}>
        <DataTable<ActivityPerson>
          rows={nurses}
          rowKey={(x) => x.id}
          onRow={(x) => update({ view: 'staff', person: x.id, kind: 'vitals', by: undefined })}
          rowLabel={(x) => t('analytics.staff.openPerson', { name: x.name })}
          cols={[
            {
              key: 'name',
              label: t('report.cols.name'),
              cell: (x) => (
                <span className="flex min-w-0 flex-col">
                  <span className="[overflow-wrap:anywhere]">{x.name}</span>
                  <span className="text-ink-3 text-[12px] font-normal">{roleName(x.role, t)}</span>
                </span>
              ),
              sort: (x) => x.name,
            },
            {
              key: 'vitals',
              label: t('analytics.triage.vitals'),
              align: 'right',
              cell: (x) => num(x.counts.vitals ?? 0),
              sort: (x) => x.counts.vitals ?? 0,
              total: num(nurses.reduce((n, x) => n + (x.counts.vitals ?? 0), 0)),
            },
          ]}
          initialSort={{ key: 'vitals', desc: true }}
          totalsLabel={t('report.total')}
          empty={<Quiet>{t('analytics.staff.nobody')}</Quiet>}
          caption={t('analytics.triage.byNurse')}
        />
      </Panel>
    </>
  )
}

function triageReport(
  vitals: number,
  nurses: ActivityPerson[],
  p: { from: string; to: string },
  t: TFn,
  clinic: ViewProps['clinic'],
) {
  return analyticsReport({
    t,
    clinic,
    title: t('analytics.triage.reportTitle'),
    code: 'TRI',
    name: 'triage',
    from: p.from,
    to: p.to,
    figures: [{ label: t('analytics.triage.vitals'), value: Number(vitals) }],
    sections: [
      {
        name: t('analytics.triage.reportTitle'),
        tables: [
          {
            title: t('analytics.triage.byNurse'),
            columns: [
              { label: t('report.cols.name') },
              { label: t('report.cols.role') },
              { label: t('analytics.triage.vitals'), kind: 'number' },
            ],
            rows: nurses.map((x) => [x.name, roleName(x.role, t), x.counts.vitals ?? 0]),
            totals: [2],
          },
        ],
      },
    ],
  })
}

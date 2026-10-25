import { CircleSlash, FlaskConical, ListOrdered, Siren, Timer, TestTubes } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Hint, Kpi, Panel } from '@/components/dash/kit'
import { StaffLink } from '@/components/staff/staff-link'
import { useWaitTimeStats, waitFigure } from '@/lib/api/analytics'
import { useLabSummary, type LabSummary } from '@/lib/api/lab'
import { PickBars } from '../charts'
import { minutes, num, when, type TFn } from '../format'
import { DataTable, Figures, LoadError, Quiet, useExport, ViewSkeleton } from '../kit'
import { analyticsReport } from '../reports'
import type { ViewProps } from '../view-props'

type NotDone = NonNullable<LabSummary['notDone']>[number]

/**
 * The laboratory in the period: tests done, urgent, not done (with the reason), the most ordered
 * tests, and the turnaround from order to verified result (median, from the waiting-time figures;
 * it is not a waiting time).
 */
export function LabView({ period, dept, clinic }: ViewProps) {
  const { t } = useTranslation()
  const p = { from: period.from, to: period.to }
  const q = useLabSummary(p)
  const w = useWaitTimeStats(p, dept)
  const lab = q.data
  const ta = w.data && !w.data.needsUpdate ? w.data.turnaround : []
  const rules = w.data?.rules
  const labTa = ta.find((x) => x.station === 'laboratory')
  const turnaround = labTa ? waitFigure(labTa, 'median', rules) : null
  const notDone = lab?.notDone ?? []

  useExport(() => (lab ? labReport(lab, p, ta, rules?.minN ?? 5, t, clinic) : null))

  if (q.error) return <LoadError error={q.error} />
  if (!lab) return <ViewSkeleton />

  return (
    <>
      <Figures>
        <Kpi
          i={0}
          icon={TestTubes}
          tint="teal"
          label={t('analytics.lab.done')}
          value={Number(lab.doneToday)}
          unit=""
        />
        <Kpi
          i={1}
          icon={Siren}
          tint="coral"
          label={t('analytics.lab.urgent')}
          value={Number(lab.urgent)}
          unit=""
        />
        <Kpi
          i={2}
          icon={CircleSlash}
          tint="amber"
          label={t('analytics.lab.notDone')}
          value={notDone.length}
          unit=""
        />
        <Kpi
          i={3}
          icon={Timer}
          tint="violet"
          label={t('analytics.lab.turnaround')}
          value={0}
          text={
            labTa
              ? minutes(turnaround, t)
              : Number(lab.turnaroundMin) > 0
                ? minutes(Number(lab.turnaroundMin), t)
                : '—'
          }
          unit=""
        />
      </Figures>
      <Hint>{t('analytics.lab.turnaroundNote')}</Hint>

      <Panel i={1} icon={ListOrdered} tint="teal" title={t('analytics.lab.mostOrdered')}>
        {lab.byTest.length === 0 ? (
          <Quiet>{t('analytics.noData')}</Quiet>
        ) : (
          <PickBars
            rows={lab.byTest.slice(0, 15).map((x) => ({
              key: x.test,
              label: x.test,
              value: Number(x.count),
            }))}
          />
        )}
      </Panel>

      <Panel
        i={2}
        icon={FlaskConical}
        tint="amber"
        title={t('analytics.lab.notDoneTitle')}
        right={num(notDone.length)}
      >
        <DataTable<NotDone>
          rows={notDone}
          rowKey={(r) => r.id}
          cols={[
            {
              key: 'test',
              label: t('analytics.lab.test'),
              cell: (r) => <b>{r.test}</b>,
              sort: (r) => r.test,
            },
            {
              key: 'patient',
              label: t('analytics.patient'),
              cell: (r) =>
                r.encounterId ? (
                  <StaffLink
                    to="/app/visit"
                    search={{ encounter: r.encounterId }}
                    className="text-primary font-semibold [overflow-wrap:anywhere]"
                  >
                    {r.patient}
                  </StaffLink>
                ) : (
                  r.patient
                ),
              sort: (r) => r.patient,
            },
            {
              key: 'reason',
              label: t('analytics.reason'),
              cell: (r) => r.reason ?? '—',
            },
            {
              key: 'at',
              label: t('report.cols.dateTime'),
              wide: true,
              cell: (r) => <span className="whitespace-nowrap">{when(r.at)}</span>,
              sort: (r) => r.at,
            },
          ]}
          initialSort={{ key: 'at', desc: true }}
          empty={<Quiet>{t('analytics.lab.allDone')}</Quiet>}
          caption={t('analytics.lab.notDoneTitle')}
        />
      </Panel>
    </>
  )
}

function labReport(
  lab: LabSummary,
  p: { from: string; to: string },
  ta: { station: string; n: number; median: number | null; p90: number | null }[],
  minN: number,
  t: TFn,
  clinic: ViewProps['clinic'],
) {
  const fig = (n: number, v: number | null) => (n >= minN ? v : null)
  return analyticsReport({
    t,
    clinic,
    title: t('analytics.lab.reportTitle'),
    code: 'LAB',
    name: 'laboratory',
    from: p.from,
    to: p.to,
    figures: [
      { label: t('analytics.lab.done'), value: Number(lab.doneToday) },
      { label: t('analytics.lab.urgent'), value: Number(lab.urgent) },
      { label: t('analytics.lab.notDone'), value: (lab.notDone ?? []).length },
    ],
    sections: [
      {
        name: t('analytics.lab.reportTitle'),
        tables: [
          {
            title: t('analytics.lab.mostOrdered'),
            columns: [
              { label: t('analytics.lab.test') },
              { label: t('analytics.lab.count'), kind: 'number' },
            ],
            rows: lab.byTest.map((x) => [x.test, Number(x.count)]),
            totals: [1],
          },
          {
            title: t('analytics.lab.notDoneTitle'),
            columns: [
              { label: t('report.cols.dateTime'), kind: 'datetime' },
              { label: t('analytics.lab.test') },
              { label: t('analytics.patient') },
              { label: t('analytics.reason') },
            ],
            rows: (lab.notDone ?? []).map((r) => [r.at, r.test, r.patient, r.reason]),
          },
          {
            title: t('analytics.wait.turnaroundTitle'),
            note: t('analytics.lab.turnaroundNote'),
            columns: [
              { label: t('analytics.wait.desk') },
              { label: t('analytics.wait.n'), kind: 'number' },
              { label: t('analytics.wait.medianMin'), kind: 'number' },
              { label: t('analytics.wait.p90Min'), kind: 'number' },
            ],
            rows: ta.map((x) => [
              t(`register.stations.${x.station}`, { defaultValue: x.station }),
              x.n,
              fig(x.n, x.median),
              fig(x.n, x.p90),
            ]),
          },
        ],
      },
    ],
  })
}

import { useTranslation } from 'react-i18next'
import { formatNumber } from '@mmc/shared'
import { StaffLink } from '@/components/staff/staff-link'
import { Badge } from '@/components/ui/badge'
import {
  isMoneyKind,
  useStaffActivityDetail,
  type ActivityKind,
  type ActivityRecord,
  type AnalyticsPeriod,
} from '@/lib/api/analytics'
import { cn } from '@/lib/utils'
import { bucketsOf } from '../buckets'
import { Legend, PickBars, StackedBars } from '../charts'
import { dayLong, kindName, num, payMethod, roleName, short, when } from '../format'
import { Block, DataTable, Drawer, LoadError, NeedsUpdate, Quiet, Stat } from '../kit'
import { workSeries } from '../work-series'

/**
 * One person's work in the period (the side panel of "Who did what", `person=`): their four main
 * figures, work per day, work by kind (click a kind to list only those records), the records
 * newest first with a link to each visit, sign-ins with failed attempts and, for the manager,
 * the money they took.
 */
export function PersonDrawer({
  userId,
  period,
  periodLabel,
  kind,
  manager,
  onKind,
  onClose,
}: {
  userId: string
  period: AnalyticsPeriod
  periodLabel: string
  kind: ActivityKind | null
  manager: boolean
  onKind: (k: ActivityKind | null) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const q = useStaffActivityDetail(userId, period, kind)
  const d = q.data
  const person = d?.person
  const counts = Object.entries(d?.counts ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]) as [ActivityKind, number][]
  const bk = bucketsOf(d?.from || period.from, d?.to || period.to)
  const kinds = counts.map(([k]) => k)
  const series = d ? workSeries(bk, d.days, kinds, kind, t) : []
  const m = d?.money

  return (
    <Drawer
      title={person?.name || t('analytics.staff.person')}
      subtitle={
        person && (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {roleName(person.role, t)}
            {person.staffId ? ` · ${person.staffId}` : ''}
            {person.departments.length > 0 &&
              ` · ${person.departments.map((x) => x.name).join(', ')}`}
            {!person.active && (
              <Badge tone="grey" dot={false}>
                {t('analytics.staff.left')}
              </Badge>
            )}
            <span>· {periodLabel}</span>
          </span>
        )
      }
      onClose={onClose}
    >
      {q.error ? (
        <LoadError error={q.error} />
      ) : !d ? (
        <div className="skeleton h-[300px] rounded-xl" aria-busy="true" />
      ) : d.needsUpdate ? (
        <NeedsUpdate />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5">
            {counts.length === 0 && <Quiet>{t('analytics.staff.nothing')}</Quiet>}
            {counts.slice(0, 4).map(([k, n]) => (
              <Stat key={k} label={kindName(k, t)} value={formatNumber(n)} />
            ))}
          </div>

          {series.some((s) => s.values.some((v) => (v ?? 0) > 0)) && (
            <Block title={t('analytics.staff.perDay')}>
              {series.length > 1 && (
                <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
              )}
              <StackedBars
                labels={bk.long}
                tickLabels={bk.short}
                series={series}
                format={(v) => formatNumber(v)}
                tick={short}
                ariaLabel={t('analytics.staff.perDayAria', { name: person?.name ?? '' })}
              />
            </Block>
          )}

          {counts.length > 0 && (
            <Block title={t('analytics.staff.byKind')} right={t('analytics.staff.byKindHint')}>
              <PickBars
                rows={counts.map(([k, n]) => ({ key: k, label: kindName(k, t), value: n }))}
                chosen={kind}
                onPick={(k) => onKind(kind === k ? null : (k as ActivityKind))}
              />
            </Block>
          )}

          <Block
            title={
              kind
                ? t('analytics.staff.recordsKind', { kind: kindName(kind, t) })
                : t('analytics.staff.recordsTitle')
            }
            right={
              d.total > d.records.length
                ? t('analytics.staff.capped', {
                    shown: d.records.length,
                    total: formatNumber(d.total),
                  })
                : num(d.total)
            }
          >
            <DataTable<ActivityRecord>
              rows={d.records}
              rowKey={(r) => `${r.at}-${r.kind}-${r.encounterId ?? ''}-${r.what ?? ''}`}
              pageSize={20}
              cols={[
                {
                  key: 'at',
                  label: t('report.cols.when'),
                  cell: (r) => (
                    <span className="flex flex-col whitespace-nowrap">
                      {when(r.at)}
                      <span className="text-ink-3 text-[12px]">{kindName(r.kind, t)}</span>
                    </span>
                  ),
                  sort: (r) => r.at,
                },
                {
                  key: 'patient',
                  label: t('analytics.patient'),
                  cell: (r) => (
                    <span className="flex min-w-0 flex-col">
                      {r.encounterId ? (
                        <StaffLink
                          to="/app/visit"
                          search={{ encounter: r.encounterId }}
                          className="text-primary font-semibold [overflow-wrap:anywhere]"
                        >
                          {r.patientName ?? t('analytics.staff.hidden')}
                        </StaffLink>
                      ) : (
                        <span className="[overflow-wrap:anywhere]">
                          {r.patientName ?? (r.patientId ? t('analytics.staff.hidden') : '—')}
                        </span>
                      )}
                      <span className="text-ink-3 text-[12px] [overflow-wrap:anywhere]">
                        {[r.fileNumber, r.what].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  ),
                },
                ...(manager
                  ? [
                      {
                        key: 'amount',
                        label: t('analytics.amountRwf'),
                        align: 'right' as const,
                        cell: (r: ActivityRecord) =>
                          isMoneyKind(r.kind) || r.amount ? num(r.amount) : '',
                      },
                    ]
                  : []),
              ]}
              empty={<Quiet>{t('analytics.staff.nothing')}</Quiet>}
              caption={t('analytics.staff.recordsTitle')}
            />
          </Block>

          <Block title={t('analytics.staff.signIns')} right={num(d.signIns.length)}>
            {d.signIns.length === 0 ? (
              <Quiet>{t('analytics.staff.noSignIns')}</Quiet>
            ) : (
              <DataTable
                rows={d.signIns}
                rowKey={(r) => `${r.at}-${r.ok}`}
                pageSize={10}
                cols={[
                  {
                    key: 'at',
                    label: t('report.cols.when'),
                    cell: (r) => when(r.at),
                    sort: (r) => r.at,
                  },
                  {
                    key: 'ok',
                    label: t('report.cols.status'),
                    cell: (r) =>
                      r.ok ? (
                        <Badge tone="green">{t('analytics.staff.signInOk')}</Badge>
                      ) : (
                        <span className="flex flex-col gap-0.5">
                          <Badge tone="red" className="self-start">
                            {t('dashboard.failedLogin')}
                          </Badge>
                          {r.reason && <span className="text-ink-3 text-[12px]">{r.reason}</span>}
                        </span>
                      ),
                  },
                ]}
                empty={null}
                caption={t('analytics.staff.signIns')}
              />
            )}
          </Block>

          {m &&
            (m.byMethod.length > 0 ||
              m.refunds.length > 0 ||
              m.voided.length > 0 ||
              m.closes.length > 0) && (
              <Block title={t('analytics.staff.money')}>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {m.byMethod.map((x) => (
                    <Stat
                      key={x.method}
                      label={payMethod(x.method, t)}
                      value={num(x.amount)}
                      note={t('analytics.revenue.paymentsN', { count: x.count })}
                    />
                  ))}
                </div>
                {m.refunds.length > 0 && (
                  <MoneyList
                    title={t('analytics.revenue.refundsList')}
                    rows={m.refunds.map((r) => ({
                      k: r.at,
                      left: r.patient ?? '—',
                      sub: `${when(r.at)} · ${payMethod(r.method, t)} · ${r.reason ?? t('analytics.noReason')}`,
                      right: `−${num(r.amount)}`,
                    }))}
                  />
                )}
                {m.voided.length > 0 && (
                  <MoneyList
                    title={t('analytics.revenue.voidedList')}
                    rows={m.voided.map((r) => ({
                      k: r.at,
                      left: r.patient ?? '—',
                      sub: `${when(r.at)} · ${r.reason ?? t('analytics.noReason')}${r.by ? ` · ${r.by}` : ''}`,
                      right: num(r.amount),
                      strike: true,
                    }))}
                  />
                )}
                {m.closes.length > 0 && (
                  <MoneyList
                    title={t('report.cash.title')}
                    rows={m.closes.map((c) => ({
                      k: c.day,
                      left: dayLong(c.day),
                      sub: `${t('report.cash.expected')} ${num(c.expected)} · ${t('report.cash.counted')} ${num(c.counted)}`,
                      right: `${c.variance > 0 ? '+' : ''}${num(c.variance)}`,
                      bad: c.variance < 0,
                    }))}
                  />
                )}
              </Block>
            )}
        </>
      )}
    </Drawer>
  )
}

function MoneyList({
  title,
  rows,
}: {
  title: string
  rows: { k: string; left: string; sub: string; right: string; strike?: boolean; bad?: boolean }[]
}) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-ink-2 m-0 text-[13px] font-bold">{title}</h4>
      <ul className="m-0 flex list-none flex-col p-0 text-[14px]">
        {rows.map((r, i) => (
          <li key={`${r.k}-${i}`} className="border-grid border-b py-1.5 last:border-b-0">
            <span className="flex justify-between gap-2">
              <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{r.left}</span>
              <span
                className={cn(
                  'font-semibold tabular-nums',
                  r.strike && 'line-through',
                  r.bad && 'text-red',
                )}
              >
                {r.right}
              </span>
            </span>
            <span className="text-ink-3 block text-[12px]">{r.sub}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

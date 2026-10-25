import { countsAsRecord, type ActivityKind } from '@/lib/api/analytics'
import { sumBy, type Buckets } from './buckets'
import { OTHER, seriesColor, type BarSeries } from './charts'
import { kindName, type TFn } from './format'

/**
 * The series of a work chart: one kind when one is chosen; otherwise the four biggest kinds of
 * records (patients seen and money are not records) in the page's kind order, so a kind keeps
 * its colour whatever its rank, and the rest together as "Other".
 */
export function workSeries(
  bk: Buckets,
  rows: readonly { day: string; kind: ActivityKind; n: number }[],
  kinds: readonly ActivityKind[],
  only: ActivityKind | null,
  t: TFn,
): BarSeries[] {
  const per = (list: readonly { day: string; n: number }[]) =>
    sumBy(
      bk,
      list,
      (r) => r.day,
      (r) => r.n,
    )
  if (only)
    return [
      {
        key: only,
        label: kindName(only, t),
        color: seriesColor(0),
        values: per(rows.filter((r) => r.kind === only)),
      },
    ]
  const record = rows.filter((r) => countsAsRecord(r.kind))
  const totals = new Map<ActivityKind, number>()
  for (const r of record) totals.set(r.kind, (totals.get(r.kind) ?? 0) + r.n)
  const order = kinds.filter((k) => (totals.get(k) ?? 0) > 0)
  // kinds the list does not name (the person's own list is shorter) still count
  for (const k of totals.keys()) if (!order.includes(k)) order.push(k)
  const top = [...order].sort((a, b) => totals.get(b)! - totals.get(a)!).slice(0, 4)
  const rest = order.filter((k) => !top.includes(k))
  const shown = order.filter((k) => top.includes(k))
  return [
    ...shown.map((k, i) => ({
      key: k,
      label: kindName(k, t),
      color: seriesColor(i),
      values: per(record.filter((r) => r.kind === k)),
    })),
    ...(rest.length
      ? [
          {
            key: 'other',
            label: t('analytics.staff.otherKinds'),
            color: OTHER,
            values: per(record.filter((r) => rest.includes(r.kind))),
          },
        ]
      : []),
  ]
}

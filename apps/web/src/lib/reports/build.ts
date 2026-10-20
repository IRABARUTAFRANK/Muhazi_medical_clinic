import { formatDate, type ClinicProfile, type StaffUser } from '@mmc/shared'
import type { DashboardData } from '@/lib/api/dashboard'
import type { CashierSummary } from '@/lib/api/finance'
import type { LabOrder, LabSummary } from '@/lib/api/lab'
import type { StockItem, StockMovement, StockSales } from '@/lib/api/stock'
import type { Report, ReportSection } from '@/lib/report'

type TFn = (key: string, opts?: Record<string, unknown>) => string
const periodOf = (from: string, to: string) =>
  from === to
    ? formatDate(new Date(from))
    : `${formatDate(new Date(from))} – ${formatDate(new Date(to))}`
const stem = (name: string, from: string, to: string) =>
  `${name}_${from}${from === to ? '' : `_${to}`}`

/** The manager's activity report: the whole dashboard, section by section. */
export function dashboardReport(
  d: DashboardData,
  clinic: ClinicProfile,
  user: StaffUser,
  t: TFn,
): Report {
  const station = (s: string) => t(`register.stations.${s}`, { defaultValue: s })
  const group = (g: string) => t(`prices.groups.${g}`, { defaultValue: g })
  const role = (r: string) => t(`staff.roles.${r}`, { defaultValue: r })
  const sections: ReportSection[] = [
    {
      name: t('report.sheets.overview'),
      summary: [
        { label: t('dashboard.tiles.registered'), value: d.tiles.registered },
        { label: t('dashboard.tiles.visits'), value: d.tiles.visits },
        { label: t('dashboard.tiles.waiting'), value: d.tiles.waitingNow },
        { label: t('dashboard.tiles.avgWait'), value: `${d.tiles.avgWaitMin} min` },
        ...(d.manager && d.tiles.revenue != null
          ? [
              { label: t('dashboard.tiles.revenue'), value: d.tiles.revenue },
              {
                label: t('dashboard.tiles.openBills'),
                value: `${d.tiles.openBills ?? 0} · ${(d.tiles.openBillsDue ?? 0).toLocaleString('en-US')} RWF`,
              },
            ]
          : []),
        {
          label: t('dashboard.tiles.beds'),
          value: `${d.tiles.bedsOccupied} / ${d.tiles.bedsTotal}`,
        },
      ],
      tables: [
        {
          title: t('report.t.visitsByType'),
          columns: [
            { label: t('report.cols.type'), width: 28 },
            { label: t('report.cols.visits'), kind: 'number' },
          ],
          rows: d.visitsByGroup.map((x) => [group(x.group), x.count]),
          totals: [1],
        },
        {
          title: t('report.t.waitByStation'),
          columns: [
            { label: t('report.cols.station'), width: 24 },
            { label: t('report.cols.waiting'), kind: 'number' },
            { label: t('report.cols.avgMin'), kind: 'number' },
            { label: t('report.cols.longestMin'), kind: 'number' },
          ],
          rows: d.waitByStation.map((x) => [station(x.station), x.waiting, x.minutes, x.longest]),
        },
        {
          title: t('report.t.bookings'),
          columns: [
            { label: t('report.cols.item'), width: 24 },
            { label: t('report.cols.count'), kind: 'number' },
          ],
          rows: [
            [t('report.t.booked'), d.bookings.booked],
            [t('report.t.missed'), d.bookings.missed],
            [t('report.t.pendingRequests'), d.bookings.pending],
          ],
        },
      ],
    },
  ]
  if (d.manager) {
    sections.push({
      name: t('report.sheets.money'),
      summary: [
        { label: t('dashboard.tiles.revenue'), value: d.tiles.revenue ?? 0 },
        { label: t('report.previous'), value: d.tiles.revenuePrev ?? 0 },
      ],
      tables: [
        {
          title: t('report.t.collections'),
          columns: [
            { label: t('report.cols.method'), width: 20 },
            { label: t('report.cols.amount'), kind: 'money', width: 18 },
          ],
          rows: d.collections.map((x) => [
            t(`visit.payment.methods.${x.method}`, { defaultValue: x.method }),
            x.amount,
          ]),
          totals: [1],
        },
        {
          title: t('report.t.revenueByDay'),
          columns: [
            { label: t('report.cols.day'), kind: 'date', width: 14 },
            { label: t('report.cols.amount'), kind: 'money', width: 18 },
          ],
          rows: d.revenue30d.map((x) => [x.day, x.amount]),
          totals: [1],
        },
        {
          title: t('report.t.topTreatments'),
          columns: [
            { label: t('report.cols.treatment'), width: 36 },
            { label: t('report.cols.count'), kind: 'number' },
            { label: t('report.cols.amount'), kind: 'money', width: 18 },
          ],
          rows: d.topTreatments.map((x) => [x.name, x.count, x.amount ?? 0]),
          totals: [1, 2],
        },
      ],
    })
  }
  sections.push({
    name: t('report.sheets.staff'),
    tables: [
      {
        title: t('report.t.staffWork'),
        note: t('report.staffNote'),
        columns: [
          { label: t('report.cols.name'), width: 28 },
          { label: t('report.cols.role'), width: 18 },
          { label: t('report.cols.staffId'), width: 14 },
          { label: t('report.cols.registrations'), kind: 'number' },
          { label: t('report.cols.vitals'), kind: 'number' },
          { label: t('report.cols.charges'), kind: 'number' },
          ...(d.manager
            ? [
                { label: t('report.cols.payments'), kind: 'number' as const },
                { label: t('report.cols.collected'), kind: 'money' as const, width: 18 },
              ]
            : []),
          { label: t('report.cols.lastSignIn'), kind: 'datetime' as const, width: 18 },
        ],
        rows: d.staff.map((s) => [
          s.name,
          role(s.role),
          s.staffId ?? '',
          s.registrations,
          s.vitals,
          s.charges,
          ...(d.manager ? [s.payments ?? 0, s.collected ?? 0] : []),
          s.lastSignIn ?? '',
        ]),
        totals: d.manager ? [3, 4, 5, 6, 7] : [3, 4, 5],
      },
    ],
  })
  sections.push({
    name: t('report.sheets.stock'),
    tables: [
      {
        title: t('report.t.reorder'),
        columns: [
          { label: t('stock.cols.item'), width: 32 },
          { label: t('stock.cols.onHand'), kind: 'number' },
          { label: t('report.cols.reorderLevel'), kind: 'number' },
        ],
        rows: d.reorder.map((x) => [x.name, x.onHand, x.min]),
      },
      {
        title: t('report.t.expiring'),
        columns: [
          { label: t('report.cols.horizon'), width: 20 },
          { label: t('report.cols.batches'), kind: 'number' },
        ],
        rows: [
          ['30', d.expiring.d30],
          ['60', d.expiring.d60],
          ['90', d.expiring.d90],
        ].map(([h, n]) => [t('report.withinDays', { count: Number(h) }), n]),
      },
    ],
  })
  return {
    title: t('report.titles.activity'),
    period: periodOf(d.from, d.to),
    clinic,
    producedBy: user.name,
    fileName: stem('activity-report', d.from, d.to),
    sections,
  }
}

/** The cashier's day close. */
export function cashierReport(
  s: CashierSummary,
  clinic: ClinicProfile,
  user: StaffUser,
  t: TFn,
): Report {
  const method = (m: string) => t(`visit.payment.methods.${m}`, { defaultValue: m })
  return {
    title: t('report.titles.dayClose'),
    period: formatDate(new Date(s.day)),
    clinic,
    producedBy: user.name,
    fileName: stem('day-close', s.day, s.day),
    sections: [
      {
        name: t('report.sheets.dayClose'),
        summary: [
          { label: t('finance.tiles.collected'), value: s.total },
          { label: t('finance.paymentsCount', { count: s.count }), value: s.count },
          {
            label: t('finance.tiles.openBills'),
            value: `${s.openBills} · ${s.openDue.toLocaleString('en-US')} RWF`,
          },
        ],
        tables: [
          {
            title: t('finance.byMethod'),
            columns: [
              { label: t('report.cols.method'), width: 20 },
              { label: t('report.cols.count'), kind: 'number' },
              { label: t('report.cols.amount'), kind: 'money', width: 18 },
            ],
            rows: s.byMethod.map((x) => [method(x.method), x.count, x.amount]),
            totals: [1, 2],
          },
          {
            title: t('finance.byCashier'),
            columns: [
              { label: t('report.cols.cashier'), width: 28 },
              { label: t('report.cols.count'), kind: 'number' },
              { label: t('report.cols.amount'), kind: 'money', width: 18 },
            ],
            rows: s.byCashier.map((x) => [x.name, x.count, x.amount]),
            totals: [1, 2],
          },
        ],
      },
      {
        name: t('report.sheets.payments'),
        tables: [
          {
            title: t('finance.payments'),
            columns: [
              { label: t('finance.cols.time'), kind: 'datetime', width: 18 },
              { label: t('finance.cols.patient'), width: 30 },
              { label: t('report.cols.file'), width: 14 },
              { label: t('finance.cols.method'), width: 14 },
              { label: t('report.cols.reference'), width: 24 },
              { label: t('finance.cols.receipt'), width: 18 },
              { label: t('finance.cols.cashier'), width: 24 },
              { label: t('finance.cols.amount'), kind: 'money', width: 18 },
            ],
            rows: s.payments.map((p) => [
              p.at,
              p.patient,
              p.fileNumber,
              method(p.method),
              p.reference ?? '',
              p.invoice ?? '',
              p.cashier ?? '',
              p.amount,
            ]),
            totals: [7],
          },
        ],
      },
    ],
  }
}

/** The laboratory's day: worklist and results. */
export function labReport(
  s: LabSummary | undefined,
  open: LabOrder[],
  done: LabOrder[],
  clinic: ClinicProfile,
  user: StaffUser,
  t: TFn,
): Report {
  const today = new Date()
  const iso = today.toISOString().slice(0, 10)
  const status = (x: string) => t(`lab.status.${x}`, { defaultValue: x })
  const cols = [
    { label: t('report.cols.ordered'), kind: 'datetime' as const, width: 18 },
    { label: t('finance.cols.patient'), width: 28 },
    { label: t('report.cols.file'), width: 14 },
    { label: t('report.cols.test'), width: 28 },
    { label: t('report.cols.status'), width: 18 },
    { label: t('report.cols.orderedBy'), width: 24 },
    { label: t('report.cols.result'), width: 36 },
    { label: t('report.cols.resultAt'), kind: 'datetime' as const, width: 18 },
  ]
  const row = (o: LabOrder) => [
    o.orderedAt,
    o.patient,
    o.fileNumber,
    o.test,
    status(o.status),
    o.orderedBy ?? '',
    o.impression ?? o.findings ?? '',
    o.resultAt ?? '',
  ]
  return {
    title: t('report.titles.lab'),
    period: formatDate(today),
    clinic,
    producedBy: user.name,
    fileName: stem('laboratory', iso, iso),
    sections: [
      {
        name: t('report.sheets.labDay'),
        summary: s
          ? [
              { label: t('lab.tiles.waiting'), value: s.waiting },
              { label: t('lab.tiles.inProcess'), value: s.inProcess },
              { label: t('lab.tiles.toVerify'), value: s.toVerify },
              { label: t('lab.tiles.done'), value: s.doneToday },
              { label: t('lab.tiles.urgent'), value: s.urgent },
              { label: t('lab.tiles.turnaround'), value: `${s.turnaroundMin} min` },
            ]
          : undefined,
        tables: [
          {
            title: t('lab.mostOrdered'),
            columns: [
              { label: t('report.cols.test'), width: 32 },
              { label: t('report.cols.count'), kind: 'number' },
            ],
            rows: (s?.byTest ?? []).map((x) => [x.test, x.count]),
            totals: [1],
          },
          { title: t('lab.worklist'), columns: cols, rows: open.map(row) },
          { title: t('lab.resultsGiven'), columns: cols, rows: done.map(row) },
        ],
      },
    ],
  }
}

/** Medicine stock: on hand and value, movements, sales. */
export function stockReport(
  items: StockItem[],
  moves: StockMovement[],
  sales: StockSales | undefined,
  from: string,
  to: string,
  clinic: ClinicProfile,
  user: StaffUser,
  t: TFn,
): Report {
  const value = items.reduce((s, i) => s + i.costValue, 0)
  return {
    title: t('report.titles.stock'),
    period: periodOf(from, to),
    clinic,
    producedBy: user.name,
    fileName: stem('stock', from, to),
    sections: [
      {
        name: t('report.sheets.onHand'),
        summary: [
          { label: t('stock.tiles.items'), value: items.filter((i) => i.active).length },
          { label: t('stock.tiles.value'), value: Math.round(value) },
          {
            label: t('stock.tiles.low'),
            value: items.filter((i) => i.active && i.onHand <= i.reorderLevel).length,
          },
        ],
        tables: [
          {
            title: t('stock.onHand'),
            columns: [
              { label: t('stock.cols.item'), width: 32 },
              { label: t('report.cols.code'), width: 12 },
              { label: t('stock.cols.onHand'), kind: 'number' },
              { label: t('report.cols.reorderLevel'), kind: 'number' },
              { label: t('stock.cols.cost'), kind: 'number' },
              { label: t('stock.cols.price'), kind: 'number' },
              { label: t('stock.cols.value'), kind: 'money', width: 18 },
              { label: t('stock.cols.expiry'), kind: 'date', width: 14 },
            ],
            rows: items
              .filter((i) => i.active)
              .map((i) => [
                `${i.name}${i.strength ? ` ${i.strength}` : ''}`,
                i.code,
                i.onHand,
                i.reorderLevel,
                i.avgCost ?? 0,
                i.sellingPrice ?? 0,
                Math.round(i.costValue),
                i.earliestExpiry ?? '',
              ]),
            totals: [6],
          },
        ],
      },
      {
        name: t('report.sheets.movements'),
        tables: [
          {
            title: t('stock.movesTitle'),
            columns: [
              { label: t('report.cols.when'), kind: 'datetime', width: 18 },
              { label: t('report.cols.type'), width: 14 },
              { label: t('stock.cols.item'), width: 32 },
              { label: t('stock.quantity'), kind: 'number' },
              { label: t('stock.fromStore'), width: 20 },
              { label: t('stock.toStore'), width: 20 },
              { label: t('stock.batchNo'), width: 16 },
              { label: t('stock.expiry'), kind: 'date', width: 14 },
              { label: t('report.cols.valueAtCost'), kind: 'money', width: 18 },
              { label: t('report.cols.by'), width: 24 },
            ],
            rows: moves.map((m) => [
              m.at,
              t(`stock.types.${m.type}`),
              m.item,
              m.quantity,
              m.from ?? '',
              m.to ?? '',
              m.batch ?? '',
              m.expiry ?? '',
              m.unitCost == null ? 0 : Math.round(m.quantity * m.unitCost),
              m.by ?? '',
            ]),
          },
        ],
      },
      {
        name: t('report.sheets.sales'),
        summary: sales
          ? [
              {
                label: t('stock.sales.revenue'),
                value: Math.round(sales.items.reduce((s, x) => s + x.revenue, 0)),
              },
              {
                label: t('stock.sales.cost'),
                value: Math.round(sales.items.reduce((s, x) => s + x.cost, 0)),
              },
              {
                label: t('stock.sales.margin'),
                value: Math.round(sales.items.reduce((s, x) => s + x.margin, 0)),
              },
              { label: t('stock.sales.value'), value: Math.round(sales.stockValue) },
            ]
          : undefined,
        tables: [
          {
            title: t('stock.sales.byItem'),
            columns: [
              { label: t('stock.cols.item'), width: 32 },
              { label: t('stock.sales.units'), kind: 'number' },
              { label: t('stock.sales.revenue'), kind: 'money', width: 18 },
              { label: t('stock.sales.cost'), kind: 'money', width: 18 },
              { label: t('stock.sales.margin'), kind: 'money', width: 18 },
            ],
            rows: (sales?.items ?? []).map((x) => [
              x.item,
              x.units,
              x.revenue,
              Math.round(x.cost),
              Math.round(x.margin),
            ]),
            totals: [1, 2, 3, 4],
          },
        ],
      },
    ],
  }
}

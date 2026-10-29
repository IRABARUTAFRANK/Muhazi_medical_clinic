import { formatRwf, type ClinicProfile, type StaffUser } from '@mmc/shared'
import i18n from '@/i18n'
import { categoryName } from '@/lib/api/catalogue'
import type { ReceiptsInPeriod } from '@/lib/api/analytics-receipts'
import type { VisitsInPeriod } from '@/lib/api/analytics-documents'
import type { DashboardData } from '@/lib/api/dashboard'
import type { CashierSummary } from '@/lib/api/finance'
import type { LabOrder, LabSummary } from '@/lib/api/lab'
import { isLowStock, type StockItem, type StockMovement, type StockSales } from '@/lib/api/stock'
import { docDate, kigaliParts, makeDocLabels } from '@/lib/doc-style'
import type {
  Cell,
  Report,
  ReportColumn,
  ReportFigure,
  ReportSection,
  ReportTable,
  ReportWords,
} from '@/lib/report'

/**
 * The content of the management reports (document standard C7 / C8): what each report says,
 * in which order, with which key figures and summary sentences. `report.ts` lays it out as a
 * PDF or an Excel workbook.
 */

type TFn = (key: string, opts?: Record<string, unknown>) => string

const ymd = (iso: string) => iso.slice(0, 10).replace(/-/g, '')
/** "24/10/2026" or "01/10/2026 to 24/10/2026". */
const periodOf = (from: string, to: string, t: TFn) =>
  from === to ? docDate(from) : t('report.range', { from: docDate(from), to: docDate(to) })
const periodKeyOf = (from: string, to: string) =>
  from === to ? ymd(from) : `${ymd(from)}-${ymd(to)}`
const stem = (name: string, from: string, to: string) =>
  `${name}_${from}${from === to ? '' : `_${to}`}`
/** Today in Kigali as yyyy-mm-dd. */
const kigaliToday = () => kigaliDay(new Date())
/** The Kigali calendar day (yyyy-mm-dd) of an instant. */
const kigaliDay = (v: string | Date) => {
  const p = kigaliParts(v instanceof Date ? v : new Date(v))
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}
/**
 * The column of a moment in a one-day report: HH:mm when every value falls on that day (the
 * date is already in "Period"), the full date and time otherwise.
 */
const whenColumn = (
  values: (string | null | undefined)[],
  day: string,
  timeLabel: string,
  dateTimeLabel: string,
): ReportColumn =>
  values.every((v) => !v || kigaliDay(v) === day)
    ? { label: timeLabel, kind: 'time', nowrap: true }
    : { label: dateTimeLabel, kind: 'datetime' }

const sentences = (...parts: (string | null | false | undefined)[]) =>
  parts.filter(Boolean).join(' ')

/** The English wording of the notes, until the translations are merged. */
const NOTES_EN: Record<string, string> = {
  title: 'How the figures are counted',
  currency: 'All amounts are in Rwandan francs (RWF). Dates and times are Kigali time.',
  totals: 'Each Total row adds up the rows above it.',
  collected:
    'Collected: every payment taken on the day, before refunds; refunds are shown on their own.',
  cashDiff: 'Cash count: difference = counted − expected; a shortfall carries a minus sign.',
  lowStock:
    'Below reorder level: unexpired units in the pharmacy at or below the item’s reorder level.',
  visits:
    'Visits: every visit opened in the period, whatever its state now. Visits by type of service counts each desk a visit went through, so its total can be higher than the number of visits.',
  registered: 'Patients registered: new patient files created in the period.',
  revenue:
    'Revenue: every payment taken in the period, before refunds. Outstanding on open bills: what is still due on the bills open at the time of printing, whatever the period.',
  previous: 'Previous period: the same number of days immediately before the period.',
  bookings:
    'Bookings: appointments whose date falls in the period. Did not come: marked as no-show. Requests pending: website requests not yet answered.',
  topTreatments:
    'Most frequent treatments: the treatments and medicines charged in the period, by number of times; the amount is what was charged, after discounts.',
  revenueByDay: 'Revenue by day: Net = collected on the day − refunds given that day.',
  beds: 'Beds occupied: at the moment the report was printed.',
  expiring:
    'Medicines expiring: batches whose expiry date falls within 30, 60 or 90 days of today; each horizon includes the shorter ones.',
  staffWork:
    'Work by employee: what each person recorded in the period — Registrations (files created), Vitals (sets of vital signs), Patients (visits treated), Results (results entered), Medicines given (hand-overs), Charges (treatments added), Payments (payments taken) and Collected (their amount). Last sign-in is the most recent one, whatever the period.',
  waitingNow: 'Waiting now: patients in a queue at the moment of printing.',
  byMethod:
    'Collections by payment method: the payments of the period by how they were paid, before refunds.',
  refundsTable:
    'Refunds: money given back in the period, with who gave it back and why; it reduces the net of the day.',
  labFigures:
    'Waiting: ordered, sample not yet taken. In process: sample taken. To verify: result written, not yet verified. Done: results given on the day. Urgent: priority 1 or 2 still waiting. Turnaround: average minutes from the order to the result.',
  stockValue:
    'Value at cost: unexpired units × the unit cost of their batch; expired units are left out. On hand counts every unit in the clinic’s stores.',
  stockSales:
    'Sold and given: units handed over to patients or sold to walk-in buyers in the period, at the prices charged; the cost is that of the batches used; margin = revenue − cost.',
  receipts:
    'One row per receipt given in the period; Still due is what remained on the bill after that payment.',
  visitsList:
    'One row per visit opened in the period. Closed: finished visits. The diagnosis shown is the main one, only to those allowed to see it.',
}

/** "How the figures are counted": the shared lines, then the report's own. */
function notesOf(t: TFn, ...own: (keyof typeof NOTES_EN | false | null | undefined)[]) {
  const say = (key: string) => {
    const v = t(`report.notes.${key}`, { defaultValue: NOTES_EN[key] })
    return v && v !== `report.notes.${key}` ? v : (NOTES_EN[key] ?? key)
  }
  const keys = ['currency', 'totals', ...own.filter((k): k is string => !!k)]
  return { title: say('title'), lines: keys.map(say) }
}

/** What every report shares: the document labels and the report wording. */
function common(t: TFn, clinic: ClinicProfile, user: StaffUser) {
  const words: ReportWords = {
    reportNo: t('report.reportNo'),
    printed: t('report.printed'),
    preparedBy: t('report.preparedBy'),
    checkedBy: t('report.checkedBy'),
    period: t('report.period'),
    total: t('report.total'),
    summarySheet: t('report.sheets.summary'),
    figure: t('report.cols.figure'),
    value: t('report.cols.value'),
    unit: t('report.cols.unit'),
  }
  return {
    clinic,
    producedBy: user.name,
    doc: makeDocLabels(t),
    words,
    lang: i18n.language,
  }
}

/** The manager's activity report: the whole dashboard, section by section. */
export function dashboardReport(
  d: DashboardData,
  clinic: ClinicProfile,
  user: StaffUser,
  t: TFn,
): Report {
  const base = common(t, clinic, user)
  const group = (g: string) => t(`prices.groups.${g}`, { defaultValue: g })
  const role = (r: string) => t(`staff.roles.${r}`, { defaultValue: r })
  const manager = d.manager && d.tiles.revenue != null
  const revenue = d.tiles.revenue ?? 0
  const openBills = d.tiles.openBills ?? 0
  const openDue = d.tiles.openBillsDue ?? 0

  const figures: ReportFigure[] = [
    { label: t('dashboard.tiles.visits'), value: d.tiles.visits },
    { label: t('dashboard.tiles.registered'), value: d.tiles.registered },
    ...(manager ? [] : [{ label: t('dashboard.tiles.waiting'), value: d.tiles.waitingNow }]),
    ...(manager
      ? [
          { label: t('dashboard.tiles.revenuePeriod'), value: revenue, unit: 'RWF' },
          // money given back in the period (0086), so the revenue reads net
          ...((d.tiles.refunded ?? 0) > 0
            ? [{ label: t('report.fig.refunded'), value: d.tiles.refunded ?? 0, unit: 'RWF' }]
            : []),
          { label: t('report.fig.outstanding'), value: openDue, unit: 'RWF' },
        ]
      : []),
    {
      label: t('dashboard.tiles.beds'),
      value: d.tiles.bedsOccupied,
      unit: t('report.units.ofTotal', { total: d.tiles.bedsTotal }),
    },
  ]

  const overview: ReportTable[] = [
    {
      title: t('report.t.visitsByType'),
      columns: [
        { label: t('report.cols.type') },
        { label: t('report.cols.visits'), kind: 'number' },
      ],
      rows: d.visitsByGroup.map((x) => [
        x.name
          ? categoryName(
              { nameEn: x.name, nameKin: x.nameKin ?? null, nameFr: x.nameFr ?? null },
              i18n.language,
            )
          : group(x.group),
        x.count,
      ]),
      totals: [1],
    },
    {
      title: t('report.t.bookings'),
      columns: [
        { label: t('report.cols.item') },
        { label: t('report.cols.count'), kind: 'number' },
      ],
      rows: [
        [t('report.t.booked'), d.bookings.booked],
        [t('report.t.missed'), d.bookings.missed],
        [t('report.t.pendingRequests'), d.bookings.pending],
      ],
    },
    // No waiting-time table: a period report cannot use "waiting now", and the correct waiting
    // times (median and 90th percentile of completed waits per desk) are exported from the
    // Analytics page (Waiting times).
  ]
  const sections: ReportSection[] = [{ name: t('report.sheets.overview'), tables: overview }]

  if (manager) {
    sections.push({
      name: t('report.sheets.money'),
      tables: [
        {
          title: t('report.t.revenueCompare'),
          columns: [
            { label: t('report.period') },
            { label: t('report.cols.amount'), kind: 'money' },
          ],
          rows: [
            [t('report.thisPeriod'), revenue],
            [t('report.previous'), d.tiles.revenuePrev ?? 0],
          ],
        },
        {
          title: t('report.t.collections'),
          columns: [
            { label: t('report.cols.method') },
            { label: t('report.cols.amount'), kind: 'money' },
          ],
          rows: d.collections.map((x) => [base.doc.method(x.method), x.amount]),
          totals: [1],
        },
        {
          title: t('report.t.topTreatments'),
          columns: [
            { label: t('report.cols.treatment') },
            { label: t('report.cols.count'), kind: 'number' },
            { label: t('report.cols.amount'), kind: 'money' },
          ],
          rows: d.topTreatments.map((x) => [x.name, x.count, x.amount]),
          totals: [1, 2],
        },
        {
          // the chosen period day by day (up to 92 days), otherwise the last 30 days
          title: d.revenuePeriod ? t('report.t.revenueByDay') : t('dashboard.revenue30'),
          columns: [
            { label: t('report.cols.day'), kind: 'date' },
            { label: t('report.fig.collected'), kind: 'money' },
            { label: t('report.fig.refunded'), kind: 'money' },
            { label: t('report.cols.net'), kind: 'money' },
          ],
          rows: (d.revenuePeriod ?? d.revenue30d).map((x) => [x.day, x.amount, x.refunds, x.net]),
          totals: [1, 2, 3],
        },
      ],
    })
  }

  const expiring: Cell[][] = [
    [t('report.withinDays', { count: 30 }), d.expiring.d30],
    [t('report.withinDays', { count: 60 }), d.expiring.d60],
    [t('report.withinDays', { count: 90 }), d.expiring.d90],
    ...(d.expiring.expired != null ? [[t('report.t.expired'), d.expiring.expired]] : []),
  ]
  sections.push({
    name: t('report.sheets.stock'),
    tables: [
      {
        title: t('report.t.reorder'),
        columns: [
          { label: t('stock.cols.item') },
          { label: t('stock.cols.onHand'), kind: 'number' },
          { label: t('report.cols.reorderLevel'), kind: 'number' },
        ],
        rows: d.reorder.map((x) => [x.name, x.onHand, x.min]),
      },
      {
        title: t('report.t.expiring'),
        columns: [
          { label: t('report.cols.horizon') },
          { label: t('report.cols.batches'), kind: 'number' },
        ],
        rows: expiring,
      },
    ],
  })

  // the wide staff table last, so the portrait tables run on without a page change
  sections.push({
    name: t('report.sheets.staff'),
    tables: [
      {
        title: t('report.t.staffWork'),
        note: t('report.staffNote'),
        columns: [
          { label: t('report.cols.name') },
          { label: t('report.cols.role') },
          { label: t('report.cols.staffId') },
          { label: t('report.cols.registrations'), kind: 'number' },
          { label: t('report.cols.vitals'), kind: 'number' },
          { label: t('dashboard.cols.patients'), kind: 'number' },
          { label: t('dashboard.cols.results'), kind: 'number' },
          { label: t('dashboard.cols.dispensed'), kind: 'number' },
          { label: t('report.cols.charges'), kind: 'number' },
          ...(d.manager
            ? [
                { label: t('report.cols.payments'), kind: 'number' as const },
                { label: t('report.cols.collected'), kind: 'money' as const },
              ]
            : []),
          { label: t('report.cols.lastSignIn'), kind: 'datetime' as const },
        ],
        rows: d.staff.map((s) => [
          s.active ? s.name : `${s.name} (${t('dashboard.staffLeft')})`,
          role(s.role),
          s.staffId,
          s.registrations,
          s.vitals,
          s.patients ?? 0,
          s.results ?? 0,
          s.dispensed ?? 0,
          s.charges,
          ...(d.manager ? [s.payments ?? 0, s.collected ?? 0] : []),
          s.lastSignIn,
        ]),
        totals: d.manager ? [3, 4, 5, 6, 7, 8, 9, 10] : [3, 4, 5, 6, 7, 8],
      },
    ],
  })

  return {
    ...base,
    title: t('report.titles.activity'),
    period: periodOf(d.from, d.to, t),
    code: 'ACT',
    periodKey: periodKeyOf(d.from, d.to),
    notes: notesOf(
      t,
      'visits',
      'registered',
      !manager && 'waitingNow',
      manager && 'revenue',
      manager && 'previous',
      manager && 'byMethod',
      manager && 'topTreatments',
      manager && 'revenueByDay',
      'bookings',
      'beds',
      'lowStock',
      'expiring',
      'staffWork',
    ),
    fileName: stem('activity-report', d.from, d.to),
    figures,
    summaryText: sentences(
      t('report.summary.visits', { count: d.tiles.visits }),
      manager &&
        (openBills > 0
          ? t('report.summary.revenueOpen', {
              count: openBills,
              amount: formatRwf(revenue),
              due: formatRwf(openDue),
            })
          : t('report.summary.revenue', { amount: formatRwf(revenue) })),
    ),
    sections,
  }
}

/** The cashier's day close. */
export function cashierReport(
  s: CashierSummary,
  clinic: ClinicProfile,
  user: StaffUser,
  t: TFn,
  /** The days of the Payments page (one day: the day close; several: the payments of the period). */
  period?: { from: string; to: string },
): Report {
  const base = common(t, clinic, user)
  const method = base.doc.method
  const day = s.day.slice(0, 10)
  const from = period?.from ?? day
  const to = period?.to ?? day
  const oneDay = from === to
  const when = (values: (string | null | undefined)[]) =>
    whenColumn(values, oneDay ? day : '', t('report.cols.time'), t('report.cols.dateTime'))

  const figures: ReportFigure[] = [
    { label: t('report.fig.collected'), value: s.total, unit: 'RWF' },
    { label: t('finance.payments'), value: s.count },
    ...(s.refunded ? [{ label: t('report.fig.refunded'), value: s.refunded, unit: 'RWF' }] : []),
    { label: t('report.fig.openBills'), value: s.openBills },
    { label: t('report.fig.outstanding'), value: s.openDue, unit: 'RWF' },
  ]

  // cash count: one row per cashier and payment method, from the day closes (one day only)
  const cashRows: Cell[][] = []
  for (const c of oneDay ? (s.closes ?? []) : []) {
    const methods = [...new Set([...Object.keys(c.expected), ...Object.keys(c.counted)])]
    for (const m of methods) {
      const expected = c.expected[m] ?? 0
      const counted = c.counted[m] ?? 0
      cashRows.push([c.cashier, method(m), expected, counted, counted - expected])
    }
  }
  const cashCount: ReportTable | undefined = cashRows.length
    ? {
        title: t('report.cash.title'),
        columns: [
          { label: t('report.cols.cashier') },
          { label: t('report.cols.method') },
          { label: t('report.cash.expected'), kind: 'money' },
          { label: t('report.cash.counted'), kind: 'money' },
          { label: t('report.cash.difference'), kind: 'money', boldNegative: true },
        ],
        rows: cashRows,
        totals: [2, 3, 4],
      }
    : undefined

  const tables: ReportTable[] = [
    {
      title: t('report.t.collections'),
      columns: [
        { label: t('report.cols.method') },
        { label: t('report.cols.count'), kind: 'number' },
        { label: t('report.cols.amount'), kind: 'money' },
      ],
      rows: s.byMethod.map((x) => [method(x.method), x.count, x.amount]),
      totals: [1, 2],
    },
    {
      title: t('finance.byCashier'),
      columns: [
        { label: t('report.cols.cashier') },
        { label: t('report.cols.count'), kind: 'number' },
        { label: t('report.cols.amount'), kind: 'money' },
      ],
      rows: s.byCashier.map((x) => [x.name, x.count, x.amount]),
      totals: [1, 2],
    },
    {
      title: t('finance.payments'),
      columns: [
        when(s.payments.map((p) => p.at)),
        { label: t('finance.cols.patient') },
        { label: t('report.cols.file'), under: true },
        { label: t('report.cols.method'), nowrap: true },
        { label: t('report.cols.reference') },
        { label: t('report.cols.receiptNo') },
        { label: t('report.cols.cashier'), nowrap: true },
        { label: t('report.cols.amount'), kind: 'money' },
      ],
      rows: s.payments.map((p) => [
        p.at,
        p.patient,
        p.fileNumber,
        method(p.method),
        p.reference,
        p.receipt,
        p.cashier,
        p.amount,
      ]),
      totals: [7],
    },
    {
      title: t('report.t.refunds'),
      columns: [
        when((s.refunds ?? []).map((r) => r.at)),
        { label: t('finance.cols.patient') },
        { label: t('report.cols.method') },
        { label: t('report.cols.reference') },
        { label: t('report.cols.reason') },
        { label: t('report.cols.cashier') },
        { label: t('report.cols.amount'), kind: 'money' },
      ],
      rows: (s.refunds ?? []).map((r) => [
        r.at,
        r.patient,
        method(r.method),
        r.reference,
        r.reason,
        r.cashier,
        r.amount,
      ]),
      totals: [6],
    },
  ]

  return {
    ...base,
    title: t(oneDay ? 'report.titles.dayClose' : 'report.titles.payments'),
    period: periodOf(from, to, t),
    code: 'DAY',
    periodKey: periodKeyOf(from, to),
    notes: notesOf(t, 'collected', 'byMethod', 'refundsTable', !!cashCount && 'cashDiff'),
    fileName: stem(oneDay ? 'day-close' : 'payments', from, to),
    figures,
    summaryText: sentences(
      t('report.summary.collected', { count: s.count, amount: formatRwf(s.total) }),
      s.openBills > 0
        ? t('report.summary.open', { count: s.openBills, amount: formatRwf(s.openDue) })
        : t('report.summary.noOpen'),
    ),
    cashCount,
    sections: [{ name: t('report.sheets.dayClose'), tables }],
  }
}

/** The laboratory's day: requests still open and results given. */
export function labReport(
  s: LabSummary | undefined,
  open: LabOrder[],
  done: LabOrder[],
  clinic: ClinicProfile,
  user: StaffUser,
  t: TFn,
): Report {
  const base = common(t, clinic, user)
  const day = kigaliToday()
  const status = (x: string) => t(`lab.status.${x}`, { defaultValue: x })
  const figures: ReportFigure[] = s
    ? [
        { label: t('lab.tiles.waiting'), value: s.waiting },
        { label: t('lab.tiles.inProcess'), value: s.inProcess },
        { label: t('lab.tiles.toVerify'), value: s.toVerify },
        { label: t('lab.tiles.done'), value: s.doneToday },
        { label: t('lab.tiles.urgent'), value: s.urgent },
        { label: t('lab.tiles.turnaround'), value: s.turnaroundMin, unit: 'min' },
      ]
    : []
  // urgent as the worklist shows it (priority 1 and 2)
  const urgent = open.filter((o) => o.priority <= 2).length

  return {
    ...base,
    title: t('report.titles.lab'),
    period: docDate(day),
    code: 'LAB',
    periodKey: ymd(day),
    notes: notesOf(t, 'labFigures'),
    fileName: stem('laboratory', day, day),
    figures,
    summaryText: sentences(
      t('report.summary.lab', {
        count: s?.doneToday ?? done.length,
        minutes: s?.turnaroundMin ?? 0,
      }),
      t('report.summary.labOpen', { count: open.length, urgent: s?.urgent ?? urgent }),
    ),
    sections: [
      {
        name: t('report.sheets.labDay'),
        tables: [
          {
            title: t('lab.mostOrdered'),
            columns: [
              { label: t('report.cols.test') },
              { label: t('report.cols.count'), kind: 'number' },
            ],
            rows: (s?.byTest ?? []).map((x) => [x.test, x.count]),
            totals: [1],
          },
          {
            title: t('lab.worklist'),
            columns: [
              whenColumn(
                open.map((o) => o.orderedAt),
                day,
                t('report.cols.ordered'),
                t('report.cols.ordered'),
              ),
              { label: t('finance.cols.patient') },
              { label: t('report.cols.file'), under: true },
              { label: t('report.cols.test'), pdfWidth: '30%' },
              { label: t('report.cols.status'), nowrap: true },
              { label: t('report.cols.orderedBy') },
            ],
            rows: open.map((o) => [
              o.orderedAt,
              o.patient,
              o.fileNumber,
              o.test,
              status(o.status),
              o.orderedBy,
            ]),
          },
          {
            title: t('lab.resultsGiven'),
            columns: [
              whenColumn(
                done.map((o) => o.resultAt),
                day,
                t('report.cols.time'),
                t('report.cols.resultAt'),
              ),
              { label: t('finance.cols.patient') },
              { label: t('report.cols.file'), under: true },
              { label: t('report.cols.test'), pdfWidth: '18%' },
              { label: t('report.cols.result'), pdfWidth: '32%' },
              { label: t('report.cols.status'), nowrap: true },
              { label: t('report.cols.orderedBy') },
            ],
            rows: done.map((o) => [
              o.resultAt,
              o.patient,
              o.fileNumber,
              o.test,
              o.impression ?? o.findings,
              status(o.status),
              o.orderedBy,
            ]),
          },
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
  const base = common(t, clinic, user)
  const active = items.filter((i) => i.active)
  const value = Math.round(active.reduce((s, i) => s + i.costValue, 0))
  // the rule of the screens (stock page, pharmacy home, manager dashboard): the server's low
  // flag (unexpired units in the pharmacy at or below a reorder level above 0)
  const low = active.filter(isLowStock).length
  const sold = sales ? Math.round(sales.items.reduce((s, x) => s + x.revenue, 0)) : 0
  const cost = sales ? Math.round(sales.items.reduce((s, x) => s + x.cost, 0)) : 0
  const margin = sales ? Math.round(sales.items.reduce((s, x) => s + x.margin, 0)) : 0

  const figures: ReportFigure[] = [
    { label: t('stock.tiles.items'), value: active.length },
    { label: t('stock.tiles.value'), value, unit: 'RWF' },
    { label: t('stock.tiles.low'), value: low },
    ...(sales
      ? [
          { label: t('stock.sales.revenue'), value: sold, unit: 'RWF' },
          { label: t('stock.sales.cost'), value: cost, unit: 'RWF' },
          { label: t('stock.sales.margin'), value: margin, unit: 'RWF' },
        ]
      : []),
  ]

  return {
    ...base,
    title: t('report.titles.stock'),
    period: periodOf(from, to, t),
    code: 'STK',
    periodKey: periodKeyOf(from, to),
    notes: notesOf(t, 'stockValue', 'lowStock', 'stockSales'),
    fileName: stem('stock', from, to),
    figures,
    summaryText: sentences(
      t('report.summary.stock', { count: active.length, value: formatRwf(value), low }),
      sales &&
        sales.items.length > 0 &&
        t('report.summary.sales', { revenue: formatRwf(sold), margin: formatRwf(margin) }),
    ),
    sections: [
      {
        name: t('report.sheets.onHand'),
        tables: [
          {
            title: t('stock.onHand'),
            columns: [
              { label: t('stock.cols.item'), pdfWidth: '34%' },
              { label: t('report.cols.code'), under: true },
              { label: t('stock.cols.onHand'), kind: 'number' },
              { label: t('report.cols.reorderLevel'), kind: 'number' },
              { label: t('stock.cols.cost'), kind: 'money' },
              { label: t('stock.cols.price'), kind: 'money' },
              { label: t('report.cols.valueAtCost'), kind: 'money' },
              { label: t('stock.cols.expiry'), kind: 'date' },
            ],
            rows: active.map((i) => [
              `${i.name}${i.strength ? ` ${i.strength}` : ''}`,
              i.code,
              i.onHand,
              i.reorderLevel,
              i.avgCost,
              i.sellingPrice,
              Math.round(i.costValue),
              i.earliestExpiry,
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
              { label: t('report.cols.dateTime'), kind: 'datetime' },
              { label: t('report.cols.type'), nowrap: true },
              { label: t('stock.cols.item') },
              { label: t('stock.quantity'), kind: 'number' },
              { label: t('stock.fromStore'), nowrap: true },
              { label: t('stock.toStore'), nowrap: true },
              { label: t('stock.batchNo') },
              { label: t('stock.expiry'), kind: 'date' },
              { label: t('report.cols.valueAtCost'), kind: 'money' },
              { label: t('report.cols.by'), nowrap: true },
            ],
            rows: moves.map((m) => [
              m.at,
              t(`stock.types.${m.type}`, { defaultValue: m.type }),
              m.item,
              m.quantity,
              m.from,
              m.to,
              m.batch,
              m.expiry,
              m.unitCost == null ? null : Math.round(m.quantity * m.unitCost),
              m.by,
            ]),
          },
        ],
      },
      {
        name: t('report.sheets.sales'),
        tables: [
          {
            title: t('stock.sales.byItem'),
            columns: [
              { label: t('stock.cols.item') },
              { label: t('stock.sales.units'), kind: 'number' },
              { label: t('stock.sales.revenue'), kind: 'money' },
              { label: t('stock.sales.cost'), kind: 'money' },
              { label: t('stock.sales.margin'), kind: 'money' },
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

/** The receipts of a period (0102): the list as the cash desk's "Export the list (Excel)". */
export function receiptsReport(
  r: ReceiptsInPeriod,
  filters: { cashier?: string | null; method?: string | null },
  clinic: ClinicProfile,
  user: StaffUser,
  t: TFn,
): Report {
  const base = common(t, clinic, user)
  const method = base.doc.method
  const tx = (key: string, en: string, vars?: Record<string, unknown>) =>
    t(key, { defaultValue: en, ...(vars ?? {}) })
  const day = r.from === r.to ? r.from : null
  const when = (values: (string | null | undefined)[]) =>
    day
      ? whenColumn(values, day, t('report.cols.time'), t('report.cols.dateTime'))
      : ({ label: t('report.cols.dateTime'), kind: 'datetime' } as ReportColumn)
  const figures: ReportFigure[] = [
    { label: tx('receipts.count', 'Receipts'), value: r.count },
    { label: t('report.fig.collected'), value: r.total, unit: 'RWF' },
    ...r.byMethod
      .slice(0, 3)
      .map((m) => ({ label: method(m.method), value: m.amount, unit: 'RWF' })),
  ]
  const tables: ReportTable[] = [
    {
      title: tx('receipts.title', 'Receipts'),
      note: [
        filters.cashier ? `${t('report.cols.cashier')}: ${filters.cashier}` : null,
        filters.method ? `${t('report.cols.method')}: ${method(filters.method)}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      columns: [
        { label: t('report.cols.receiptNo'), nowrap: true },
        when(r.receipts.map((x) => x.at)),
        { label: t('finance.cols.patient') },
        { label: t('report.cols.file'), under: true },
        { label: tx('receipts.cols.bill', 'Bill no.'), nowrap: true },
        { label: t('report.cols.method'), nowrap: true },
        { label: t('report.cols.reference') },
        { label: t('report.cols.cashier'), nowrap: true },
        { label: t('report.cols.amount'), kind: 'money' },
        { label: tx('receipts.cols.balance', 'Still due'), kind: 'money' },
      ],
      rows: r.receipts.map((x) => [
        x.receiptNo,
        x.at,
        x.patient.name,
        x.patient.fileNumber,
        x.invoiceNo,
        method(x.method),
        x.reference,
        x.cashier,
        x.amount,
        x.balance,
      ]),
      totals: [8],
    },
    {
      title: t('report.t.collections'),
      columns: [
        { label: t('report.cols.method') },
        { label: t('report.cols.count'), kind: 'number' },
        { label: t('report.cols.amount'), kind: 'money' },
      ],
      rows: r.byMethod.map((x) => [method(x.method), x.count, x.amount]),
      totals: [1, 2],
    },
    {
      title: t('finance.byCashier'),
      columns: [
        { label: t('report.cols.cashier') },
        { label: t('report.cols.count'), kind: 'number' },
        { label: t('report.cols.amount'), kind: 'money' },
      ],
      rows: r.byCashier.map((x) => [x.name, x.count, x.amount]),
      totals: [1, 2],
    },
  ]
  return {
    ...base,
    title: tx('receipts.reportTitle', 'Receipts of the period'),
    period: periodOf(r.from, r.to, t),
    code: 'RCT',
    periodKey: periodKeyOf(r.from, r.to),
    notes: notesOf(t, 'collected', 'receipts'),
    fileName: stem('receipts', r.from, r.to),
    figures,
    summaryText: tx('receipts.summary', '{{count}} receipts for {{amount}}.', {
      count: r.count,
      amount: formatRwf(r.total),
    }),
    sections: [{ name: tx('receipts.title', 'Receipts'), tables }],
  }
}

/** The visits of a period (0102): the patients' documents list as an Excel / PDF report. */
export function visitsListReport(
  v: VisitsInPeriod,
  filters: string[],
  clinic: ClinicProfile,
  user: StaffUser,
  t: TFn,
): Report {
  const base = common(t, clinic, user)
  const tx = (key: string, en: string, vars?: Record<string, unknown>) =>
    t(key, { defaultValue: en, ...(vars ?? {}) })
  const status = (s: string) =>
    s === 'closed' ? tx('documents.status.closed', 'Closed') : tx('documents.status.open', 'Open')
  const figures: ReportFigure[] = [
    { label: t('dashboard.tiles.visits'), value: v.count },
    { label: tx('documents.closedVisits', 'Closed visits'), value: v.closed },
    { label: tx('documents.openVisits', 'Open visits'), value: v.open },
    {
      label: tx('documents.patients', 'Patients'),
      value: new Set(v.visits.map((x) => x.patient.id)).size,
    },
  ]
  const tables: ReportTable[] = [
    {
      title: tx('documents.visitsTitle', 'Visits treated'),
      note: filters.join(' · '),
      columns: [
        { label: t('report.cols.dateTime'), kind: 'datetime' },
        { label: tx('documents.cols.visitNo', 'Visit no.'), nowrap: true },
        { label: t('finance.cols.patient') },
        { label: t('report.cols.file'), under: true },
        { label: tx('documents.cols.doctor', 'Doctor') },
        { label: t('analytics.department') },
        { label: tx('documents.cols.diagnosis', 'Diagnosis') },
        { label: base.doc.insurer },
        { label: tx('documents.cols.status', 'Status'), nowrap: true },
      ],
      rows: v.visits.map((x) => [
        x.at,
        x.reference,
        x.patient.name,
        x.patient.fileNumber,
        x.doctor?.name ?? null,
        x.department?.name ?? null,
        x.diagnosis ? `${x.diagnosis}${x.icd10 ? ` (${x.icd10})` : ''}` : null,
        x.insurer,
        status(x.status),
      ]),
    },
  ]
  return {
    ...base,
    title: tx('documents.title', 'Patients’ documents'),
    period: periodOf(v.from, v.to, t),
    code: 'DOC',
    periodKey: periodKeyOf(v.from, v.to),
    notes: notesOf(t, 'visitsList'),
    fileName: stem('patients-documents', v.from, v.to),
    figures,
    summaryText: tx('documents.summary', '{{count}} visits in the period, {{closed}} closed.', {
      count: v.count,
      closed: v.closed,
    }),
    sections: [{ name: tx('documents.visitsTitle', 'Visits treated'), tables }],
  }
}

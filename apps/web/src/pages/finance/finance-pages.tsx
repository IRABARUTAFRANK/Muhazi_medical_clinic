import { useEffect, useState, type CSSProperties } from 'react'
import { useSearch } from '@tanstack/react-router'
import {
  ArrowUpRight,
  Ban,
  Banknote,
  Calculator,
  CalendarDays,
  Clock,
  CreditCard,
  DoorOpen,
  HandCoins,
  Landmark,
  Printer,
  Undo2,
  Receipt,
  Save,
  ShoppingBag,
  Smartphone,
  type LucideIcon,
  UserRound,
  Wallet,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLINIC_PROFILE, formatDate, formatRwf, formatTime, type StaffUser } from '@mmc/shared'
import { Empty, IconChip, Kpi, Panel, Pill, SectionTitle } from '@/components/dash/kit'
import {
  tableCell,
  tableFirstCell,
  tableHead,
  tableRow,
  type Tint,
} from '@/components/dash/kit-style'
import { ActionRow, ActionRowEnd, BannerChip, PageBanner } from '@/components/dash/page-banner'
import { Button, buttonVariants } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Seg } from '@/components/ui/seg'
import { ListBar, Pager } from '@/components/ui/list-tools'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  useCashActions,
  useCashierSummary,
  useUnpaidDebts,
  type CashierSummary,
  type CashPayment,
  type Debt,
} from '@/lib/api/finance'
import { useClinicInfo } from '@/lib/api/public'
import { ReportButtons } from '@/components/dash/report-buttons'
import { cashierReport } from '@/lib/reports/build'
import { useHomeSummary } from '@/lib/api/home'
import { navForUser } from '@/lib/nav'
import { matches, usePaged } from '@/lib/paging'
import { cn } from '@/lib/utils'
import { useCan, useSwitchedOff } from '@/lib/api/permissions'
import { NotAllowedNotice } from '@/components/clinical/perm-gate'
import { Flash } from '@/components/ui/flash'
import { useConfirm } from '@/lib/confirm'
import { useCounterSales } from '@/lib/api/counter-sales'
import { useLetterhead, usePrintedBy } from '@/lib/report-parts'
import { CounterSalesPanel } from './counter-sales-panel'
import { openCounterReceipt } from './counter-receipt'
import { RefundsDuePanel } from './refunds-due'
import { useRefundsDue } from './refunds-due-data'

const METHOD_ICON: Record<string, LucideIcon> = {
  cash: Banknote,
  momo: Smartphone,
  airtel: Smartphone,
  card: CreditCard,
  bank: Landmark,
}
/** One tint per way of paying, the same as its chip elsewhere. */
const METHOD_TINT: Record<string, Tint> = {
  cash: 'mint',
  momo: 'amber',
  airtel: 'coral',
  card: 'violet',
  bank: 'teal',
}
/** The ways of paying always shown; card and bank (counter sales) appear when used. */
const METHODS = ['cash', 'momo', 'airtel'] as const
const EXTRA_METHODS = ['card', 'bank'] as const
const today = () => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
/** The day `n` days before (YYYY-MM-DD). */
const daysBefore = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00`)
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

/** A load error under the banner. */
function LoadError({ message }: { message: string }) {
  const { t } = useTranslation()
  return (
    <p
      role="alert"
      className="border-red/30 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium"
    >
      {t('dashboard.loadFailed', { message })}
    </p>
  )
}

/**
 * The cashier's work list: counter sales waiting for payment (a walk-in buyer pays first), every
 * open bill (searchable, 15 per page, each with "Take payment"), money to give back after a
 * medicine return, and the unpaid bills of visits that ended with money due.
 */
export function BillsPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  // the manager sees every bill but takes payments only when allowed (Who may do what)
  const canTake = useCan(user)('payment.take')
  const switchedOff = useSwitchedOff(user)
  // a notice about a counter sale opens this page with ?sale=…
  const search = useSearch({ strict: false }) as { sale?: unknown }
  const saleId = typeof search.sale === 'string' ? search.sale : null
  const { data: home, error: loadError } = useHomeSummary()
  const bills = home?.openBills ?? []
  // the figures of the four panels below (the same queries, read once more for the tiles)
  const { data: counterOpen = [] } = useCounterSales('open')
  const { data: refunds = [] } = useRefundsDue()
  const { data: debts = [] } = useUnpaidDebts()
  const [query, setQuery] = useState('')
  const shown = bills.filter((b) => matches(query, b.name, b.file, b.ticket))
  const paged = usePaged(shown, 15, query)
  const due = bills.reduce((s, b) => s + b.balance, 0)
  const sum = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0)
  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="bills">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <PageBanner
          icon={Receipt}
          tint="coral"
          title={t('finance.billsTitle')}
          lead={t('finance.billsLead')}
          meta={
            <BannerChip icon={Receipt}>
              {t('home.billsDue', { count: bills.length, amount: formatRwf(due) })}
            </BannerChip>
          }
        />
        {switchedOff('payment.take') && <NotAllowedNotice feature="payment.take" />}
        {loadError && <LoadError message={loadError.message} />}

        <section className="flex flex-col gap-3">
          <SectionTitle icon={Wallet}>{t('finance.section')}</SectionTitle>
          <div className="pc:grid-cols-[repeat(auto-fit,minmax(150px,1fr))] grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Kpi
              i={0}
              icon={ShoppingBag}
              tint="violet"
              label={t('cashierDesk.counter.title')}
              value={counterOpen.length}
              unit={formatRwf(counterOpen.reduce((s, x) => s + x.total, 0))}
            />
            <Kpi
              i={1}
              icon={Receipt}
              tint="coral"
              label={t('home.openBills')}
              value={bills.length}
              unit={formatRwf(due)}
            />
            <Kpi
              i={2}
              icon={Undo2}
              tint="amber"
              label={t('cashierDesk.refunds.title')}
              value={refunds.length}
              unit={formatRwf(sum(refunds))}
            />
            <Kpi
              i={3}
              icon={DoorOpen}
              tint="navy"
              label={t('cashierDesk.unpaid.title')}
              value={debts.length}
              unit={formatRwf(sum(debts))}
            />
          </div>
        </section>

        <CounterSalesPanel
          i={1}
          canTake={canTake}
          canCancel={canTake || user.role === 'manager'}
          highlightId={saleId}
          cashier={user.name}
        />
        <Panel i={2} icon={Receipt} tint="coral" title={t('home.openBills')}>
          <ListBar query={query} onQuery={setQuery} placeholderKey="list.searchPatient" />
          {paged.total === 0 ? (
            <Empty>{t('home.noOpenBills')}</Empty>
          ) : (
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="w-full border-collapse">
                <thead className="bg-surface">
                  <tr>
                    <th className={tableHead}>{t('finance.cols.patient')}</th>
                    <th className={cn(tableHead, 'hidden text-right sm:table-cell')}>
                      {t('finance.cols.amount')}
                    </th>
                    <th className={cn(tableHead, 'text-right')}>{t('finance.toCollect')}</th>
                    <th className={cn(tableHead, 'w-0')}>
                      <span className="sr-only">{t('home.takePayment')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paged.slice.map((b, i) => (
                    <tr
                      key={b.encounterId}
                      className={cn(tableRow, 'anim-enter')}
                      style={{ '--i': Math.min(i, 12) } as CSSProperties}
                    >
                      <td className={tableFirstCell}>
                        <span className="flex min-w-0 items-center gap-2.5">
                          <Pill tint="amber" icon={Receipt}>
                            {b.ticket ?? '—'}
                          </Pill>
                          <span className="min-w-0">
                            <span className="block">{b.name}</span>
                            <span className="text-ink-3 block text-[13px] font-normal">
                              {b.file}
                              {b.station
                                ? ` · ${t('home.atStation', { station: t(`register.stations.${b.station}`, { defaultValue: b.station }) })}`
                                : ''}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td
                        className={cn(
                          tableCell,
                          'text-ink-3 hidden text-right whitespace-nowrap tabular-nums sm:table-cell',
                        )}
                      >
                        {formatRwf(b.amount)}
                      </td>
                      <td
                        className={cn(
                          tableCell,
                          'text-right font-semibold whitespace-nowrap tabular-nums',
                        )}
                      >
                        {formatRwf(b.balance)}
                      </td>
                      <td className={cn(tableCell, 'text-right whitespace-nowrap')}>
                        <StaffLink
                          to="/app/visit"
                          search={{ encounter: b.encounterId }}
                          className={buttonVariants({
                            variant: canTake ? 'success' : 'tint-blue',
                            size: 'sm',
                          })}
                        >
                          {canTake ? (
                            <Wallet size={14} aria-hidden="true" />
                          ) : (
                            <ArrowUpRight size={14} aria-hidden="true" />
                          )}
                          {t(canTake ? 'home.takePayment' : 'finance.openVisit')}
                        </StaffLink>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager {...paged} onPage={paged.setPage} />
        </Panel>
        {/* the manager may give money back without the "Take payments" switch (as the database allows) */}
        <RefundsDuePanel i={3} canTake={canTake || user.role === 'manager'} />
        <DebtsPanel canTake={canTake} i={4} />
      </main>
    </StaffShell>
  )
}

/**
 * Unpaid bills (the patient pays once at the end of the visit): visits that ended with money due
 * (closed, or the patient left, with the manager's reason) and visits of an earlier day still
 * open with nothing left to do but pay. Never lost: listed here for the cashier and the manager,
 * oldest first among equals, and paid from the visit's payment card when the patient comes back.
 */
export function DebtsPanel({ canTake, i = 2 }: { canTake: boolean; i?: number }) {
  const { t } = useTranslation()
  const { data: debts = [], error } = useUnpaidDebts()
  const [query, setQuery] = useState('')
  const shown = debts.filter((d) =>
    matches(query, d.patient, d.fileNumber, d.phone, d.billNumber, d.reason),
  )
  const paged = usePaged(shown, 15, query)
  const total = debts.reduce((s, d) => s + d.amount, 0)
  const statusLook = (s: Debt['status']): { tint: Tint; icon: LucideIcon } =>
    s === 'left'
      ? { tint: 'coral', icon: DoorOpen }
      : s === 'open'
        ? { tint: 'amber', icon: Clock }
        : { tint: 'navy', icon: Receipt }
  return (
    <Panel
      i={i}
      icon={DoorOpen}
      tint="navy"
      title={t('cashierDesk.unpaid.title')}
      right={t('finance.debtsTotal', { count: debts.length, amount: formatRwf(total) })}
    >
      <p className="text-ink-2 m-0 text-[14px]">{t('cashierDesk.unpaid.lead')}</p>
      {error && <LoadError message={error.message} />}
      {debts.length > 15 && (
        <ListBar query={query} onQuery={setQuery} placeholderKey="list.searchPatient" />
      )}
      {paged.total === 0 ? (
        <Empty>{t(debts.length === 0 ? 'cashierDesk.unpaid.none' : 'cashierDesk.noMatch')}</Empty>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="w-full border-collapse">
            <thead className="bg-surface">
              <tr>
                <th className={tableHead}>{t('finance.cols.patient')}</th>
                <th className={cn(tableHead, 'text-right')}>{t('finance.cols.amount')}</th>
                <th className={cn(tableHead, 'w-0')}>
                  <span className="sr-only">{t('home.takePayment')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {paged.slice.map((d) => {
                const look = d.status ? statusLook(d.status) : null
                return (
                  <tr key={d.encounterId} className={tableRow}>
                    <td className={tableFirstCell}>
                      <span className="flex min-w-0 items-start gap-2.5">
                        {look && d.status && (
                          <Pill tint={look.tint} icon={look.icon}>
                            {t(`cashierDesk.unpaid.status.${d.status}`)}
                          </Pill>
                        )}
                        <span className="min-w-0">
                          <span className="block">{d.patient}</span>
                          <span className="text-ink-3 block text-[13px] font-normal">
                            {[
                              d.fileNumber,
                              d.phone,
                              d.billNumber,
                              (d.since ?? d.closedAt) &&
                                t('cashierDesk.unpaid.since', {
                                  date: formatDate(new Date((d.since ?? d.closedAt)!)),
                                }),
                              d.reason && `“${d.reason}”`,
                              d.closedBy && t('finance.debtBy', { name: d.closedBy }),
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                          {d.total != null && d.total > 0 && (
                            <span className="text-ink-3 block text-[12px] font-normal tabular-nums">
                              {t('cashierDesk.unpaid.billPaid', {
                                total: formatRwf(d.total),
                                paid: formatRwf(d.paid ?? 0),
                              })}
                            </span>
                          )}
                        </span>
                      </span>
                    </td>
                    <td
                      className={cn(
                        tableCell,
                        'text-right font-semibold whitespace-nowrap tabular-nums',
                      )}
                    >
                      {formatRwf(d.amount)}
                    </td>
                    <td className={cn(tableCell, 'text-right whitespace-nowrap')}>
                      <StaffLink
                        to="/app/visit"
                        search={{ encounter: d.encounterId }}
                        className={buttonVariants({
                          variant: canTake ? 'success' : 'tint-blue',
                          size: 'sm',
                        })}
                      >
                        {canTake ? (
                          <Wallet size={14} aria-hidden="true" />
                        ) : (
                          <ArrowUpRight size={14} aria-hidden="true" />
                        )}
                        {t(canTake ? 'home.takePayment' : 'finance.openVisit')}
                      </StaffLink>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager {...paged} onPage={paged.setPage} />
    </Panel>
  )
}

/**
 * Payments of a day and the day close: totals by method and by cashier, every payment with its
 * receipt and reference, filters and search, and a printable summary.
 */
export function PaymentsPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  // the Revenue view's "Open payments of this day" opens this page with ?day=YYYY-MM-DD
  const search = useSearch({ strict: false }) as { day?: unknown }
  const [day, setDay] = useState(() =>
    typeof search.day === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(search.day) &&
    search.day <= today()
      ? search.day
      : today(),
  )
  const { data: s, error: loadError } = useCashierSummary(day)
  const { data: info } = useClinicInfo()
  const [method, setMethod] = useState<string>('all')
  const [query, setQuery] = useState('')
  // the ways of paying of the day: card and bank only when a counter sale used them
  const methods: string[] = [
    ...METHODS,
    ...EXTRA_METHODS.filter((m) => (s?.byMethod ?? []).some((x) => x.method === m)),
  ]
  const payments = (s?.payments ?? []).filter(
    (p) =>
      (method === 'all' || p.method === method) &&
      matches(
        query,
        p.patient,
        p.fileNumber,
        p.invoice,
        p.reference,
        p.cashier,
        p.receipt,
        p.counterSale,
      ),
  )
  // counter sales of the day (and some days before, for a sale paid later): to print the
  // receipt again with its lines
  const { data: daySales = [] } = useCounterSales(null, { from: daysBefore(day, 14), to: day })
  const letterhead = useLetterhead()
  const printedBy = usePrintedBy()
  const reprintCounter = (p: CashPayment) => {
    const sale = daySales.find((x) => x.id === p.counterSaleId)
    const ok = openCounterReceipt(
      sale ?? {
        number: p.counterSale ?? '',
        buyer: p.patient,
        phone: null,
        total: p.amount,
        lines: [],
      },
      {
        receipt: p.receipt ?? null,
        method: p.method,
        amount: p.amount,
        reference: p.reference,
        at: p.at,
        cashier: p.cashier,
      },
      letterhead,
      t,
      printedBy,
    )
    if (!ok) setCashError(t('report.popupBlocked'))
  }
  const paged = usePaged(payments, 20, `${day}|${method}|${query}`)
  // printing the day close lists every payment, not only the page on screen
  const [printing, setPrinting] = useState(false)
  useEffect(() => {
    if (!printing) return
    const done = () => setPrinting(false)
    window.addEventListener('afterprint', done, { once: true })
    const id = window.setTimeout(() => window.print(), 50)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('afterprint', done)
    }
  }, [printing])
  const methodName = (m: string) => t(`visit.payment.methods.${m}`, { defaultValue: m })
  // cancelling a wrong payment, counting the cash (migration 0062)
  const cash = useCashActions()
  const confirm = useConfirm()
  const isManager = user.role === 'manager'
  // the cash count: whoever may take payments, or still has payments of their own to count (a
  // cashier switched off during the day counts what she took; the database asks the same)
  const canTake = useCan(user)('payment.take')
  const switchedOff = useSwitchedOff(user)
  const canCount = canTake || (s?.payments ?? []).some((p) => p.mine && !p.counted)
  const [cashNotice, setCashNotice] = useState<string | null>(null)
  const [cashError, setCashError] = useState<string | null>(null)
  // the count's answer lives here: saving refreshes the day, and the panel starts again from the
  // saved count, so a message kept inside it would vanish at once
  const [countMsg, setCountMsg] = useState<CountMsg | null>(null)
  // what the day holds: the payments less the money given back, as the cash count expects
  const refundedOf = (m: string) =>
    (s?.refunds ?? []).filter((r) => r.method === m).reduce((sum, r) => sum + r.amount, 0)
  const amountOf = (m: string) =>
    (s?.byMethod.find((x) => x.method === m)?.amount ?? 0) - refundedOf(m)
  const countOf = (m: string) => s?.byMethod.find((x) => x.method === m)?.count ?? 0
  const dayTotal = (s?.total ?? 0) - (s?.refunded ?? 0)
  const countLine = (count: number, refunded: number) =>
    `${t('finance.paymentsCount', { count })}${
      refunded > 0 ? ` · ${t('finance.afterRefunds', { amount: formatRwf(refunded) })}` : ''
    }`

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="payments">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4 print:overflow-visible">
        <PageBanner
          icon={HandCoins}
          tint="mint"
          title={t('finance.paymentsTitle')}
          lead={t('finance.paymentsLead')}
          meta={
            <>
              <BannerChip icon={CalendarDays}>{formatDate(new Date(day))}</BannerChip>
              <BannerChip icon={HandCoins}>{formatRwf(dayTotal)}</BannerChip>
            </>
          }
        />
        <ActionRow>
          <label className="border-border bg-card text-ink flex h-9 items-center gap-2 rounded-md border px-3 text-[14px]">
            <CalendarDays size={16} aria-hidden="true" className="text-ink-3" />
            <span className="sr-only">{t('finance.day')}</span>
            <input
              type="date"
              value={day}
              max={today()}
              onChange={(e) => {
                setDay(e.target.value || today())
                setCountMsg(null)
              }}
              className="bg-transparent outline-none"
            />
          </label>
          <ReportButtons
            build={() => (s ? cashierReport(s, info?.profile ?? CLINIC_PROFILE, user, t) : null)}
          />
          <Button variant="tint-grey" onClick={() => setPrinting(true)}>
            <Printer size={16} aria-hidden="true" />
            {t('finance.printDay')}
          </Button>
          <ActionRowEnd />
        </ActionRow>

        {loadError && <LoadError message={loadError.message} />}

        {/* Day close: totals by method, then the day */}
        <section className="flex flex-col gap-3">
          <SectionTitle icon={Wallet}>{t('finance.byMethod')}</SectionTitle>
          <div className="pc:grid-cols-[repeat(auto-fit,minmax(150px,1fr))] grid grid-cols-1 gap-3 sm:grid-cols-2">
            {methods.map((m, i) => (
              <Kpi
                key={m}
                i={i}
                icon={METHOD_ICON[m] ?? Wallet}
                tint={METHOD_TINT[m] ?? 'teal'}
                label={methodName(m)}
                value={amountOf(m)}
                text={formatRwf(amountOf(m))}
                unit={countLine(countOf(m), refundedOf(m))}
              />
            ))}
            <Kpi
              i={methods.length}
              icon={HandCoins}
              tint="navy"
              label={t('finance.dayTotal', { day: formatDate(new Date(day)) })}
              value={dayTotal}
              text={formatRwf(dayTotal)}
              unit={[
                countLine(s?.count ?? 0, s?.refunded ?? 0),
                // walk-in buyers' sales are in the total, said apart
                (s?.counterSales?.count ?? 0) > 0
                  ? t('cashierDesk.counter.inTotal', {
                      count: s!.counterSales!.count,
                      amount: formatRwf(s!.counterSales!.total),
                    })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            />
          </div>
        </section>
        {switchedOff('payment.take') && (
          <NotAllowedNotice feature="payment.take" compact className="print:hidden" />
        )}
        {/* someone outside the cash desk sees only what they took */}
        {s?.scope === 'mine' && (
          <p className="bg-primary-tint text-primary border-primary/30 m-0 rounded-md border px-3 py-2 text-[14px] print:hidden">
            {t('finance.mineOnly')}
          </p>
        )}
        {(s?.counterToPay ?? []).length > 0 && day === today() && (
          <p className="border-amber/30 bg-amber-bg text-amber m-0 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-[14px] font-medium print:hidden">
            <ShoppingBag size={16} aria-hidden="true" />
            {t('cashierDesk.counter.waitingNote', {
              count: s!.counterToPay!.length,
              amount: formatRwf(s!.counterToPay!.reduce((a, c) => a + c.total, 0)),
            })}
            <StaffLink
              to="/app/bills"
              className={buttonVariants({ size: 'sm', variant: 'tint-amber' })}
            >
              <ArrowUpRight size={14} aria-hidden="true" />
              {t('cashierDesk.counter.open')}
            </StaffLink>
          </p>
        )}

        {s && s.byCashier.length > 0 && (
          <Panel i={1} icon={UserRound} tint="teal" title={t('finance.byCashier')}>
            <div className="flex flex-wrap gap-2">
              {s.byCashier.map((c) => (
                <span
                  key={c.name}
                  className="border-border bg-card inline-flex min-h-10 items-center gap-2 rounded-md border py-1 pr-3 pl-1 text-[14px]"
                >
                  <IconChip icon={UserRound} tint="teal" size="sm" />
                  <b>{c.name}</b>
                  <span className="tabular-nums">{formatRwf(c.amount)}</span>
                  <span className="text-ink-3 text-[12px]">({c.count})</span>
                </span>
              ))}
            </div>
          </Panel>
        )}

        <Panel i={2} icon={HandCoins} tint="mint" title={t('finance.payments')}>
          <ListBar query={query} onQuery={setQuery} placeholderKey="finance.searchPayments" />
          <Seg
            className="self-start print:hidden"
            label={t('finance.cols.method')}
            value={method}
            onChange={setMethod}
            options={['all', ...methods].map((m) => ({
              value: m,
              label: m === 'all' ? t('notices.filters.all') : methodName(m),
            }))}
          />
          {paged.total === 0 ? (
            <Empty>{t('finance.nothingYet')}</Empty>
          ) : (
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="w-full border-collapse">
                <thead className="bg-surface">
                  <tr>
                    <th className={tableHead}>{t('finance.cols.time')}</th>
                    <th className={tableHead}>{t('finance.cols.patient')}</th>
                    <th className={tableHead}>{t('finance.cols.method')}</th>
                    <th className={cn(tableHead, 'hidden sm:table-cell')}>
                      {t('finance.cols.receipt')}
                    </th>
                    <th className={cn(tableHead, 'hidden md:table-cell')}>
                      {t('finance.cols.cashier')}
                    </th>
                    <th className={cn(tableHead, 'text-right')}>{t('finance.cols.amount')}</th>
                    <th className={cn(tableHead, 'w-0 print:hidden')}>
                      <span className="sr-only">{t('finance.cancelPayment')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(printing ? payments : paged.slice).map((p) => {
                    const Icon = METHOD_ICON[p.method] ?? Wallet
                    return (
                      <tr key={p.id} className={tableRow}>
                        <td
                          className={cn(
                            tableFirstCell,
                            'text-ink-2 whitespace-nowrap tabular-nums',
                          )}
                        >
                          {formatTime(new Date(p.at))}
                        </td>
                        <td className={tableCell}>
                          <span className="block font-medium">
                            {p.patient || (p.counterSale ? t('cashierDesk.counter.walkIn') : '—')}
                          </span>
                          {p.counterSale ? (
                            <span className="text-ink-3 inline-flex items-center gap-1 text-[12px]">
                              <ShoppingBag size={12} aria-hidden="true" />
                              {t('cashierDesk.counter.saleLine', { number: p.counterSale })}
                            </span>
                          ) : (
                            <span className="text-ink-3 text-[12px]">{p.fileNumber}</span>
                          )}
                        </td>
                        <td className={tableCell}>
                          <Pill tint={METHOD_TINT[p.method] ?? 'teal'} icon={Icon}>
                            {methodName(p.method)}
                          </Pill>
                          {p.reference && (
                            <span className="text-ink-3 block text-[12px]">{p.reference}</span>
                          )}
                        </td>
                        <td className={cn(tableCell, 'hidden tabular-nums sm:table-cell')}>
                          {p.receipt ?? p.invoice ?? p.counterSale ?? '—'}
                        </td>
                        <td className={cn(tableCell, 'text-ink-2 hidden md:table-cell')}>
                          {p.cashier ?? '—'}
                        </td>
                        <td
                          className={cn(
                            tableCell,
                            'text-right font-semibold whitespace-nowrap tabular-nums',
                          )}
                        >
                          {formatRwf(p.amount)}
                        </td>
                        <td className={cn(tableCell, 'text-right whitespace-nowrap print:hidden')}>
                          <span className="inline-flex gap-1">
                            {/* the visit prints the receipt again (all its payments) */}
                            {p.encounterId && (
                              <StaffLink
                                to="/app/visit"
                                search={{ encounter: p.encounterId }}
                                className={buttonVariants({ size: 'sm', variant: 'tint-grey' })}
                                title={t('finance.reprint')}
                                aria-label={t('finance.reprint')}
                              >
                                <Printer size={14} aria-hidden="true" />
                              </StaffLink>
                            )}
                            {/* a counter sale's receipt is printed again from here */}
                            {!p.encounterId && p.counterSaleId && (
                              <Button
                                size="sm"
                                variant="tint-grey"
                                title={t('cashierDesk.counter.reprint')}
                                aria-label={t('cashierDesk.counter.reprint')}
                                onClick={() => reprintCounter(p)}
                              >
                                <Printer size={14} aria-hidden="true" />
                              </Button>
                            )}
                            {(isManager || (p.mine && !p.counted && day === today())) && (
                              <Button
                                size="sm"
                                variant="tint-coral"
                                title={t('finance.cancelPaymentHint')}
                                aria-label={t('finance.cancelPayment')}
                                onClick={async () => {
                                  const r = await confirm({
                                    title: t('confirm.finance.voidTitle', {
                                      amount: formatRwf(p.amount),
                                      patient:
                                        p.patient ||
                                        (p.counterSale ? t('cashierDesk.counter.walkIn') : '—'),
                                    }),
                                    body: p.counterSaleId
                                      ? t('cashierDesk.confirm.voidSaleBodyAsk', {
                                          number: p.counterSale ?? '',
                                        })
                                      : t('confirm.finance.voidBodyAsk'),
                                    input: {
                                      label: t('finance.cancelWhy'),
                                      required: true,
                                      multiline: true,
                                    },
                                    confirmLabel: t('confirm.finance.voidYes'),
                                    tone: 'danger',
                                  })
                                  if (!r.ok) return
                                  const reason = r.value
                                  setCashError(null)
                                  cash.voidPayment
                                    .mutateAsync({ id: p.id, reason })
                                    .then((r) =>
                                      setCashNotice(
                                        // a counter sale not yet handed over is unpaid again
                                        r.counterSaleId || p.counterSaleId
                                          ? t('cashierDesk.counter.voided', {
                                              amount: formatRwf(p.amount),
                                              number: p.counterSale ?? '',
                                            })
                                          : t('finance.cancelled', {
                                              amount: formatRwf(p.amount),
                                            }),
                                      ),
                                    )
                                    .catch((e: unknown) =>
                                      setCashError(e instanceof Error ? e.message : String(e)),
                                    )
                                }}
                              >
                                <Ban size={14} aria-hidden="true" />
                              </Button>
                            )}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Pager {...paged} onPage={paged.setPage} />
        </Panel>
        {(cashNotice || cashError) && (
          <Flash
            key={cashNotice ?? cashError ?? ''}
            tone={cashError ? 'error' : 'success'}
            onClose={() => {
              setCashNotice(null)
              setCashError(null)
            }}
          >
            {cashError ?? cashNotice}
          </Flash>
        )}
        {s && (
          <CountCashPanel
            // the day's figures arrive after the page opens: start again from the saved count
            key={`${day}|${JSON.stringify((s.closes ?? []).find((c) => c.mine)?.counted ?? {})}`}
            day={day}
            summary={s}
            canCount={canCount}
            msg={countMsg}
            onMsg={setCountMsg}
          />
        )}
        {s && (s.voided ?? []).length > 0 && (
          <Panel
            i={4}
            icon={Ban}
            tint="coral"
            title={t('finance.voidedTitle')}
            right={String(s.voided!.length)}
          >
            <div className="flex flex-col">
              {s.voided!.map((v) => (
                <div
                  key={v.id}
                  className="border-grid hover:bg-hover flex min-h-10 flex-wrap items-center gap-3 border-b py-2 text-[14px] transition-colors duration-120 last:border-b-0"
                >
                  <Pill tint="coral" icon={Ban}>
                    {methodName(v.method)}
                  </Pill>
                  <span className="min-w-[180px] flex-1">
                    <span className="block font-medium">{v.patient}</span>
                    <span className="text-ink-3 block text-[13px]">
                      {[
                        v.receipt,
                        v.reason && `“${v.reason}”`,
                        v.by && t('finance.cancelledBy', { name: v.by }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="text-ink-3 font-semibold tabular-nums line-through">
                    {formatRwf(v.amount)}
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        )}
        {s && (s.refunds ?? []).length > 0 && (
          <Panel
            i={5}
            icon={Undo2}
            tint="amber"
            title={t('finance.refundsTitle')}
            right={formatRwf(s.refunded ?? 0)}
          >
            <div className="flex flex-col">
              {s.refunds!.map((r) => (
                <div
                  key={r.id}
                  className="border-grid hover:bg-hover flex min-h-10 flex-wrap items-center gap-3 border-b py-2 text-[14px] transition-colors duration-120 last:border-b-0"
                >
                  <Pill tint="amber" icon={Clock}>
                    {formatTime(new Date(r.at))}
                  </Pill>
                  <span className="min-w-[180px] flex-1">
                    <span className="block font-medium">
                      {r.patient} · {methodName(r.method)}
                    </span>
                    <span className="text-ink-3 block text-[13px]">
                      {[r.reference, `“${r.reason}”`, r.cashier].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className="text-amber font-semibold tabular-nums">
                    −{formatRwf(r.amount)}
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </main>
    </StaffShell>
  )
}

/**
 * Count the cash: at the end of the day each person who took payments says what they hold per
 * method; the difference with what the payments say is kept (the manager sees everyone's).
 */
type CountMsg = { ok: boolean; text: string }

function CountCashPanel({
  day,
  summary,
  canCount,
  msg,
  onMsg: setMsg,
}: {
  day: string
  summary: CashierSummary
  canCount: boolean
  /** Kept by the page, so it stays shown when the panel starts again from the saved count. */
  msg: CountMsg | null
  onMsg: (m: CountMsg | null) => void
}) {
  const { t } = useTranslation()
  const cash = useCashActions()
  const confirm = useConfirm()
  const expected = summary.myExpected ?? {}
  const mineClose = (summary.closes ?? []).find((c) => c.mine)
  // cash, MoMo and Airtel always; card and bank when a counter sale was paid that way
  const methods: string[] = [
    ...METHODS,
    ...EXTRA_METHODS.filter(
      (m) => Number(expected[m] ?? 0) !== 0 || mineClose?.counted?.[m] != null,
    ),
  ]
  const [counted, setCounted] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      methods.map((m) => [m, mineClose?.counted?.[m] != null ? String(mineClose.counted[m]) : '']),
    ),
  )
  const [note, setNote] = useState(mineClose?.note ?? '')
  const total = (o: Record<string, number | string>) =>
    methods.reduce((sum, m) => sum + (Number(o[m]) || 0), 0)
  // another cashier's count: every way of paying it holds
  const totalAll = (o: Record<string, number | string>) =>
    Object.values(o ?? {}).reduce<number>((sum, v) => sum + (Number(v) || 0), 0)
  // nothing typed yet: no difference to show (an empty box is not a count of 0)
  const typed = methods.some((m) => (counted[m] ?? '').trim() !== '')
  const diff = total(counted) - total(expected)
  const save = async () => {
    setMsg(null)
    if (!typed) return setMsg({ ok: false, text: t('finance.countEmpty') })
    if (
      !(await confirm({
        title: t('confirm.finance.countTitle', { day: formatDate(new Date(day)) }),
        body: t('confirm.finance.countBody', {
          counted: formatRwf(total(counted)),
          diff: `${diff > 0 ? '+' : ''}${formatRwf(diff)}`,
        }),
        confirmLabel: t('confirm.finance.countYes'),
      }))
    )
      return
    try {
      const r = await cash.closeDay.mutateAsync({
        day,
        counted: Object.fromEntries(methods.map((m) => [m, Number(counted[m]) || 0])),
        note,
      })
      setMsg({
        ok: true,
        text: t('finance.countSaved', { diff: formatRwf(Number(r?.variance ?? diff)) }),
      })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
  }
  return (
    <Panel i={3} icon={Calculator} tint="navy" title={t('finance.countTitle')}>
      {canCount && (
        <>
          <p className="text-ink-2 m-0 text-[14px]">{t('finance.countLead')}</p>
          {(summary.counterSales?.count ?? 0) > 0 && (
            <p className="text-ink-3 m-0 text-[13px]">{t('cashierDesk.counter.inCount')}</p>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            {methods.map((m) => (
              <Field
                key={m}
                label={`${t(`visit.payment.methods.${m}`)} · ${t('finance.expected', { amount: formatRwf(Number(expected[m] ?? 0)) })}`}
                inputMode="numeric"
                value={counted[m] ?? ''}
                onChange={(e) =>
                  setCounted((c) => ({ ...c, [m]: e.target.value.replace(/[^\d]/g, '') }))
                }
                aria-label={t('finance.countedOf', { method: t(`visit.payment.methods.${m}`) })}
              />
            ))}
          </div>
          <Field
            label={t('finance.countNote')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('finance.countNotePh')}
          />
          <span className="flex flex-wrap items-center gap-3">
            <Button variant="success" onClick={() => void save()} loading={cash.closeDay.isPending}>
              <Save size={16} aria-hidden="true" />
              {t(mineClose ? 'finance.countUpdate' : 'finance.countSave')}
            </Button>
            {typed ? (
              <span
                className={cn(
                  'text-[14px] font-semibold tabular-nums',
                  diff === 0 ? 'text-green' : 'text-red',
                )}
              >
                {t('finance.difference', { amount: `${diff > 0 ? '+' : ''}${formatRwf(diff)}` })}
              </span>
            ) : (
              <span className="text-ink-3 text-[13px]">{t('finance.countHint')}</span>
            )}
          </span>
          {msg && (
            <Flash key={msg.text} tone={msg.ok ? 'success' : 'error'} onClose={() => setMsg(null)}>
              {msg.text}
            </Flash>
          )}
        </>
      )}
      {(summary.closes ?? []).length > 0 && (
        <div className="flex flex-col">
          <span className="text-ink-2 flex items-center gap-1.5 text-[14px] font-semibold">
            <Calculator size={14} aria-hidden="true" className="text-navy-ink" />
            {t('finance.countsOfDay')}
          </span>
          {(summary.closes ?? []).map((c, i) => (
            <div
              key={i}
              className="border-grid hover:bg-hover flex min-h-10 flex-wrap items-center gap-3 border-b py-2 text-[14px] transition-colors duration-120 last:border-b-0"
            >
              <span className="min-w-[160px] flex-1 font-medium">{c.cashier ?? '—'}</span>
              <span className="text-ink-3 text-[13px] tabular-nums">
                {t('finance.expectedCounted', {
                  expected: formatRwf(totalAll(c.expected ?? {})),
                  counted: formatRwf(totalAll(c.counted ?? {})),
                })}
              </span>
              <span
                className={cn(
                  'font-semibold tabular-nums',
                  Number(c.variance) === 0 ? 'text-green' : 'text-red',
                )}
              >
                {Number(c.variance) > 0 ? '+' : ''}
                {formatRwf(Number(c.variance))}
              </span>
              {c.note && <span className="text-ink-3 w-full text-[13px]">“{c.note}”</span>}
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

import { useEffect, useState, type CSSProperties } from 'react'
import {
  Ban,
  Banknote,
  Calculator,
  CalendarDays,
  HandCoins,
  Printer,
  Receipt,
  Smartphone,
  type LucideIcon,
  UserRound,
  Wallet,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLINIC_PROFILE, formatDate, formatRwf, formatTime, type StaffUser } from '@mmc/shared'
import { Empty, IconChip, Panel, Pill } from '@/components/dash/kit'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { Button, buttonVariants } from '@/components/ui/button'
import { ListBar, Pager } from '@/components/ui/list-tools'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  useCashActions,
  useCashierSummary,
  useUnpaidDebts,
  type CashierSummary,
} from '@/lib/api/finance'
import { useClinicInfo } from '@/lib/api/public'
import { ReportButtons } from '@/components/dash/report-buttons'
import { cashierReport } from '@/lib/reports/build'
import { useHomeSummary } from '@/lib/api/home'
import { navForUser } from '@/lib/nav'
import { matches, usePaged } from '@/lib/paging'
import { cn } from '@/lib/utils'
import { useCan } from '@/lib/api/permissions'
import { Flash } from '@/components/ui/flash'

const METHOD_ICON: Record<string, LucideIcon> = {
  cash: Banknote,
  momo: Smartphone,
  airtel: Smartphone,
}
const METHODS = ['cash', 'momo', 'airtel'] as const
const today = () => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Every open bill, searchable, 15 per page, each with "Take payment". */
export function BillsPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  // the manager sees every bill but takes payments only when allowed (Who may do what)
  const canTake = useCan(user)('payment.take')
  const { data: home } = useHomeSummary()
  const bills = home?.openBills ?? []
  const [query, setQuery] = useState('')
  const shown = bills.filter((b) => matches(query, b.name, b.file, b.ticket))
  const paged = usePaged(shown, 15, query)
  const due = bills.reduce((s, b) => s + b.balance, 0)
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
        <Panel i={1} icon={Receipt} tint="coral" title={t('home.openBills')}>
          <ListBar query={query} onQuery={setQuery} placeholderKey="list.searchPatient" />
          {paged.total === 0 ? (
            <Empty>{t('home.noOpenBills')}</Empty>
          ) : (
            <div className="flex flex-col">
              {paged.slice.map((b, i) => (
                <div
                  key={b.encounterId}
                  className="border-grid anim-enter flex min-h-12 flex-wrap items-center gap-3 border-b py-2.5 text-[14px] last:border-b-0"
                  style={{ '--i': Math.min(i, 12) } as CSSProperties}
                >
                  <Pill tint="amber" icon={Receipt}>
                    {b.ticket ?? '—'}
                  </Pill>
                  <span className="min-w-[180px] flex-1">
                    <span className="block font-semibold">{b.name}</span>
                    <span className="text-ink-3 block text-[13px]">
                      {b.file}
                      {b.station
                        ? ` · ${t('home.atStation', { station: t(`register.stations.${b.station}`, { defaultValue: b.station }) })}`
                        : ''}
                    </span>
                  </span>
                  <span className="text-ink-3 text-[13px] tabular-nums">
                    {t('finance.billTotal', { amount: formatRwf(b.amount) })}
                  </span>
                  <span className="font-bold whitespace-nowrap tabular-nums">
                    {formatRwf(b.balance)}
                  </span>
                  <StaffLink
                    to="/app/visit"
                    search={{ encounter: b.encounterId }}
                    className={buttonVariants({
                      variant: canTake ? 'primary' : 'default',
                      size: 'sm',
                    })}
                  >
                    <Wallet size={14} aria-hidden="true" />
                    {t(canTake ? 'home.takePayment' : 'finance.openVisit')}
                  </StaffLink>
                </div>
              ))}
            </div>
          )}
          <Pager {...paged} onPage={paged.setPage} />
        </Panel>
        <DebtsPanel canTake={canTake} />
      </main>
    </StaffShell>
  )
}

/**
 * Money still owed on finished visits (the patient left without paying, with the manager's
 * reason): it can be paid when the patient comes back, from the visit's payment card.
 */
function DebtsPanel({ canTake }: { canTake: boolean }) {
  const { t } = useTranslation()
  const { data: debts = [] } = useUnpaidDebts()
  const total = debts.reduce((s, d) => s + d.amount, 0)
  return (
    <Panel
      i={2}
      icon={Wallet}
      tint="amber"
      title={t('finance.debtsTitle')}
      right={t('finance.debtsTotal', { count: debts.length, amount: formatRwf(total) })}
    >
      {debts.length === 0 ? (
        <Empty>{t('finance.noDebts')}</Empty>
      ) : (
        <div className="flex flex-col">
          {debts.map((d) => (
            <div
              key={d.encounterId}
              className="border-grid flex min-h-12 flex-wrap items-center gap-3 border-b py-2.5 text-[14px] last:border-b-0"
            >
              <span className="min-w-[180px] flex-1">
                <span className="block font-semibold">{d.patient}</span>
                <span className="text-ink-3 block text-[13px]">
                  {[
                    d.fileNumber,
                    d.phone,
                    d.closedAt && formatDate(new Date(d.closedAt)),
                    d.reason && `“${d.reason}”`,
                    d.closedBy && t('finance.debtBy', { name: d.closedBy }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <span className="font-bold whitespace-nowrap tabular-nums">
                {formatRwf(d.amount)}
              </span>
              <StaffLink
                to="/app/visit"
                search={{ encounter: d.encounterId }}
                className={buttonVariants({ variant: canTake ? 'primary' : 'default', size: 'sm' })}
              >
                <Wallet size={14} aria-hidden="true" />
                {t(canTake ? 'home.takePayment' : 'finance.openVisit')}
              </StaffLink>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

/**
 * Payments of a day and the day close: totals by method and by cashier, every payment with its
 * receipt and reference, filters and search, and a printable summary.
 */
export function PaymentsPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const [day, setDay] = useState(today)
  const { data: s } = useCashierSummary(day)
  const { data: info } = useClinicInfo()
  const [method, setMethod] = useState<string>('all')
  const [query, setQuery] = useState('')
  const payments = (s?.payments ?? []).filter(
    (p) =>
      (method === 'all' || p.method === method) &&
      matches(query, p.patient, p.fileNumber, p.invoice, p.reference, p.cashier),
  )
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
  const isManager = user.role === 'manager'
  const canCount = useCan(user)('payment.take') || user.role === 'cashier'
  const [cashNotice, setCashNotice] = useState<string | null>(null)
  const [cashError, setCashError] = useState<string | null>(null)
  const amountOf = (m: string) => s?.byMethod.find((x) => x.method === m)?.amount ?? 0
  const countOf = (m: string) => s?.byMethod.find((x) => x.method === m)?.count ?? 0

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="payments">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4 print:overflow-visible">
        <PageBanner
          icon={HandCoins}
          tint="violet"
          title={t('finance.paymentsTitle')}
          lead={t('finance.paymentsLead')}
          meta={<BannerChip icon={HandCoins}>{formatRwf(s?.total ?? 0)}</BannerChip>}
        >
          <label className="border-border bg-card flex h-10 items-center gap-2 rounded-lg border px-3 text-[14px]">
            <CalendarDays size={16} aria-hidden="true" className="text-ink-3" />
            <span className="sr-only">{t('finance.day')}</span>
            <input
              type="date"
              value={day}
              max={today()}
              onChange={(e) => setDay(e.target.value || today())}
              className="bg-transparent outline-none"
            />
          </label>
          <ReportButtons
            build={() => (s ? cashierReport(s, info?.profile ?? CLINIC_PROFILE, user, t) : null)}
          />
          <Button onClick={() => setPrinting(true)}>
            <Printer size={16} aria-hidden="true" />
            {t('finance.printDay')}
          </Button>
        </PageBanner>

        {/* Day close: totals by method and by cashier */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {METHODS.map((m, i) => {
            const Icon = METHOD_ICON[m] ?? Wallet
            return (
              <div
                key={m}
                className="bg-card shadow-card anim-enter flex items-center gap-3 rounded-[16px] px-4 py-3"
                style={{ '--i': i } as CSSProperties}
              >
                <IconChip
                  icon={Icon}
                  tint={m === 'cash' ? 'mint' : m === 'momo' ? 'amber' : 'coral'}
                />
                <span className="min-w-0 flex-1">
                  <span className="text-ink-2 block text-[13px] font-semibold">
                    {methodName(m)}
                  </span>
                  <span className="block text-[20px] font-extrabold tabular-nums">
                    {formatRwf(amountOf(m))}
                  </span>
                  <span className="text-ink-3 block text-[12px]">
                    {t('finance.paymentsCount', { count: countOf(m) })}
                  </span>
                </span>
              </div>
            )
          })}
          <div className="bg-navy anim-enter flex items-center gap-3 rounded-[16px] px-4 py-3 text-white">
            <HandCoins size={22} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold text-white/80">
                {t('finance.dayTotal', { day: formatDate(new Date(day)) })}
              </span>
              <span className="block text-[22px] font-extrabold tabular-nums">
                {formatRwf(s?.total ?? 0)}
              </span>
              <span className="block text-[12px] text-white/70">
                {t('finance.paymentsCount', { count: s?.count ?? 0 })}
              </span>
            </span>
          </div>
        </div>

        {s && s.byCashier.length > 0 && (
          <Panel i={1} icon={UserRound} tint="teal" title={t('finance.byCashier')}>
            <div className="flex flex-wrap gap-2">
              {s.byCashier.map((c) => (
                <span
                  key={c.name}
                  className="border-border bg-surface inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[14px]"
                >
                  <UserRound size={14} aria-hidden="true" className="text-ink-3" />
                  <b>{c.name}</b>
                  <span className="tabular-nums">{formatRwf(c.amount)}</span>
                  <span className="text-ink-3 text-[12px]">({c.count})</span>
                </span>
              ))}
            </div>
          </Panel>
        )}

        <Panel i={2} icon={HandCoins} tint="violet" title={t('finance.payments')}>
          <ListBar query={query} onQuery={setQuery} placeholderKey="finance.searchPayments" />
          <div className="flex flex-wrap gap-2 print:hidden">
            {(['all', ...METHODS] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={method === m}
                onClick={() => setMethod(m)}
                className={cn(
                  'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold',
                  method === m
                    ? 'border-primary bg-primary text-white'
                    : 'border-border bg-card text-ink-2 hover:bg-hover',
                )}
              >
                {m === 'all' ? t('notices.filters.all') : methodName(m)}
              </button>
            ))}
          </div>
          {paged.total === 0 ? (
            <Empty>{t('finance.nothingYet')}</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[14px]">
                <thead>
                  <tr className="text-ink-3 text-left text-[12px] tracking-[.04em] uppercase">
                    <th className="border-border border-b py-2 pr-2 font-semibold">
                      {t('finance.cols.time')}
                    </th>
                    <th className="border-border border-b py-2 pr-2 font-semibold">
                      {t('finance.cols.patient')}
                    </th>
                    <th className="border-border border-b py-2 pr-2 font-semibold">
                      {t('finance.cols.method')}
                    </th>
                    <th className="border-border hidden border-b py-2 pr-2 font-semibold sm:table-cell">
                      {t('finance.cols.receipt')}
                    </th>
                    <th className="border-border hidden border-b py-2 pr-2 font-semibold md:table-cell">
                      {t('finance.cols.cashier')}
                    </th>
                    <th className="border-border border-b py-2 text-right font-semibold">
                      {t('finance.cols.amount')}
                    </th>
                    <th className="border-border w-0 border-b py-2 print:hidden">
                      <span className="sr-only">{t('finance.cancelPayment')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(printing ? payments : paged.slice).map((p) => {
                    const Icon = METHOD_ICON[p.method] ?? Wallet
                    return (
                      <tr key={p.id} className="border-grid border-b last:border-b-0">
                        <td className="text-ink-2 py-2 pr-2 tabular-nums">
                          {formatTime(new Date(p.at))}
                        </td>
                        <td className="py-2 pr-2">
                          <span className="block font-semibold">{p.patient}</span>
                          <span className="text-ink-3 text-[12px]">{p.fileNumber}</span>
                        </td>
                        <td className="py-2 pr-2">
                          <span className="inline-flex items-center gap-1.5">
                            <Icon size={14} aria-hidden="true" className="text-ink-3" />
                            {methodName(p.method)}
                          </span>
                          {p.reference && (
                            <span className="text-ink-3 block text-[12px]">{p.reference}</span>
                          )}
                        </td>
                        <td className="hidden py-2 pr-2 tabular-nums sm:table-cell">
                          {p.invoice ?? '—'}
                        </td>
                        <td className="text-ink-2 hidden py-2 pr-2 md:table-cell">
                          {p.cashier ?? '—'}
                        </td>
                        <td className="py-2 text-right font-bold tabular-nums">
                          {formatRwf(p.amount)}
                        </td>
                        <td className="py-2 pl-2 text-right print:hidden">
                          {(isManager || (p.mine && !p.counted && day === today())) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="hover:text-red"
                              title={t('finance.cancelPaymentHint')}
                              aria-label={t('finance.cancelPayment')}
                              onClick={() => {
                                const reason = window.prompt(t('finance.cancelWhy'))
                                if (!reason) return
                                setCashError(null)
                                cash.voidPayment
                                  .mutateAsync({ id: p.id, reason })
                                  .then(() =>
                                    setCashNotice(
                                      t('finance.cancelled', { amount: formatRwf(p.amount) }),
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
        {s && <CountCashPanel day={day} summary={s} canCount={canCount} />}
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
                  className="border-grid flex flex-wrap items-center gap-3 border-b py-2 text-[14px] last:border-b-0"
                >
                  <span className="min-w-[180px] flex-1">
                    <span className="block font-semibold">
                      {v.patient} · {methodName(v.method)}
                    </span>
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
                  <span className="text-ink-3 font-bold tabular-nums line-through">
                    {formatRwf(v.amount)}
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
function CountCashPanel({
  day,
  summary,
  canCount,
}: {
  day: string
  summary: CashierSummary
  canCount: boolean
}) {
  const { t } = useTranslation()
  const cash = useCashActions()
  const expected = summary.myExpected ?? {}
  const mineClose = (summary.closes ?? []).find((c) => c.mine)
  const [counted, setCounted] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      ['cash', 'momo', 'airtel'].map((m) => [
        m,
        mineClose?.counted?.[m] != null ? String(mineClose.counted[m]) : '',
      ]),
    ),
  )
  const [note, setNote] = useState(mineClose?.note ?? '')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const methods = ['cash', 'momo', 'airtel']
  const total = (o: Record<string, number | string>) =>
    methods.reduce((sum, m) => sum + (Number(o[m]) || 0), 0)
  const diff = total(counted) - total(expected)
  const save = async () => {
    setMsg(null)
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
          <p className="text-ink-2 m-0 text-[13px]">{t('finance.countLead')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {methods.map((m) => (
              <label key={m} className="text-ink-2 flex flex-col gap-1 text-[13px] font-semibold">
                {t(`visit.payment.methods.${m}`)} ·{' '}
                {t('finance.expected', { amount: formatRwf(Number(expected[m] ?? 0)) })}
                <input
                  inputMode="numeric"
                  className="border-border bg-card focus:border-primary h-10 rounded-lg border px-2.5 text-[14px] font-normal outline-none"
                  value={counted[m] ?? ''}
                  onChange={(e) =>
                    setCounted((c) => ({ ...c, [m]: e.target.value.replace(/[^\d]/g, '') }))
                  }
                  aria-label={t('finance.countedOf', { method: t(`visit.payment.methods.${m}`) })}
                />
              </label>
            ))}
          </div>
          <label className="text-ink-2 flex flex-col gap-1 text-[13px] font-semibold">
            {t('finance.countNote')}
            <input
              className="border-border bg-card focus:border-primary h-10 rounded-lg border px-2.5 text-[14px] font-normal outline-none"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('finance.countNotePh')}
            />
          </label>
          <span className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={() => void save()} loading={cash.closeDay.isPending}>
              <Calculator size={16} aria-hidden="true" />
              {t(mineClose ? 'finance.countUpdate' : 'finance.countSave')}
            </Button>
            <span
              className={cn(
                'text-[14px] font-bold tabular-nums',
                diff === 0 ? 'text-green' : 'text-red',
              )}
            >
              {t('finance.difference', { amount: `${diff > 0 ? '+' : ''}${formatRwf(diff)}` })}
            </span>
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
          <span className="text-ink-2 text-[13px] font-semibold">{t('finance.countsOfDay')}</span>
          {(summary.closes ?? []).map((c, i) => (
            <div
              key={i}
              className="border-grid flex flex-wrap items-center gap-3 border-b py-2 text-[14px] last:border-b-0"
            >
              <span className="min-w-[160px] flex-1 font-semibold">{c.cashier ?? '—'}</span>
              <span className="text-ink-3 text-[13px] tabular-nums">
                {t('finance.expectedCounted', {
                  expected: formatRwf(total(c.expected ?? {})),
                  counted: formatRwf(total(c.counted ?? {})),
                })}
              </span>
              <span
                className={cn(
                  'font-bold tabular-nums',
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

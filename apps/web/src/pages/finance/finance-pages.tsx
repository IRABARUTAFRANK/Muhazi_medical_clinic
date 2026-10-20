import { useState, type CSSProperties } from 'react'
import {
  Banknote,
  CalendarDays,
  HandCoins,
  Printer,
  Receipt,
  Smartphone,
  UserRound,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLINIC_PROFILE, formatDate, formatRwf, formatTime, type StaffUser } from '@mmc/shared'
import { Empty, IconChip, Panel, Pill } from '@/components/dash/kit'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { Button, buttonVariants } from '@/components/ui/button'
import { ListBar, Pager } from '@/components/ui/list-tools'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import { useCashierSummary } from '@/lib/api/finance'
import { useClinicInfo } from '@/lib/api/public'
import { ReportButtons } from '@/components/dash/report-buttons'
import { cashierReport } from '@/lib/reports/build'
import { useHomeSummary } from '@/lib/api/home'
import { navForUser } from '@/lib/nav'
import { matches, usePaged } from '@/lib/paging'
import { cn } from '@/lib/utils'

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
          user={user}
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
                    className={buttonVariants({ variant: 'primary', size: 'sm' })}
                  >
                    <Wallet size={14} aria-hidden="true" />
                    {t('home.takePayment')}
                  </StaffLink>
                </div>
              ))}
            </div>
          )}
          <Pager {...paged} onPage={paged.setPage} />
        </Panel>
      </main>
    </StaffShell>
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
  const methodName = (m: string) => t(`visit.payment.methods.${m}`, { defaultValue: m })
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
          user={user}
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
          <Button onClick={() => window.print()}>
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
                  </tr>
                </thead>
                <tbody>
                  {paged.slice.map((p) => {
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
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Pager {...paged} onPage={paged.setPage} />
        </Panel>
      </main>
    </StaffShell>
  )
}

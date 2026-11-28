import { useState, type FormEvent } from 'react'
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Banknote,
  CalendarCheck,
  Coins,
  Eye,
  Landmark,
  Percent,
  Receipt,
  TrendingDown,
  TrendingUp,
  Undo2,
  Wallet,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf, type StaffUser } from '@mmc/shared'
import { Empty, Kpi, Panel, SectionTitle } from '@/components/dash/kit'
import { tableCell, tableFirstCell, tableHead, tableRow } from '@/components/dash/kit-style'
import { ActionRow, BannerChip, PageBanner } from '@/components/dash/page-banner'
import { PeriodCustom, PeriodSeg } from '@/components/dash/period-filter'
import { ReportButtons } from '@/components/dash/report-buttons'
import { StaffShell } from '@/components/staff/staff-shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Seg } from '@/components/ui/seg'
import { Select } from '@/components/ui/select'
import { SidePanel } from '@/components/ui/side-panel'
import {
  CUSTOM_UNITS,
  PAYE_MODES,
  SALARY_INTERVALS,
  EXPENSE_GROUPS,
  SYSTEM_OUT_KINDS,
  cleanPercent,
  expenseGroup,
  intervalWords,
  deductionName,
  kindName,
  rateWorkWords,
  workedOut,
  useAccountsActions,
  useDeductions,
  useDailySalaryAlertCheck,
  useExpenses,
  useFinanceSummary,
  useMoneyKinds,
  useSalaryOverview,
  type CustomUnit,
  type Expense,
  type ExpenseGroup,
  type ExpenseKind,
  type FinanceSummary,
  type PayeMode,
  type SalaryInterval,
  type SalaryPeriod,
  type SalaryPerson,
} from '@/lib/api/accounts'
import { useClinicInfo } from '@/lib/api/public'
import { useConfirm } from '@/lib/confirm'
import { kigaliToday } from '@/lib/clock'
import { navForUser } from '@/lib/nav'
import { usePeriod } from '@/lib/period'
import { useSession } from '@/store/session'
import { financeMoneyReport, payrollReport, payslipReport } from '@/lib/reports/build'
import { cn } from '@/lib/utils'
import { CLINIC_PROFILE } from '@mmc/shared'

import { Note, PanelForm, ReportsLink } from './accounts-kit'
import {
  ACCOUNTS_TABS,
  METHODS,
  STATUSES,
  STATUS_TONE,
  errText,
  figureAmount,
  figureLabel,
  type AccountsTab,
  type Msg,
} from './accounts-tabs'
import { IncomePanel } from './income-panel'
import { KindsTab } from './kinds-tab'
import { TaxesTab } from './taxes-tab'

/**
 * Finance (0179): the clinic's accounts for the cashier (the accountant) and the manager — the
 * money in by method against the money out (salaries, taxes, other expenses, stock bought) and
 * the net; the employees' salaries, every pay period of the year marked paid or not; the taxes
 * the clinic pays with their periods (0184); the other expenses; the printed reports in the
 * clinic's template.
 */
export function AccountsPage({
  user,
  initialTab,
  initialYear,
}: {
  user: StaffUser
  initialTab?: AccountsTab
  initialYear?: number
}) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<AccountsTab>(initialTab ?? 'money')
  useDailySalaryAlertCheck(true)
  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="finance">
      <main className="pc:px-8 pc:pb-10 relative flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <PageBanner
          icon={Landmark}
          tint="mint"
          title={t('accounts.title')}
          lead={t('accounts.lead')}
        />
        <Seg
          label={t('accounts.title')}
          value={tab}
          onChange={setTab}
          options={ACCOUNTS_TABS.map((k) => ({ value: k, label: t(`accounts.tabs.${k}`) }))}
          className="self-start"
        />
        {tab === 'money' && <MoneyTab user={user} />}
        {tab === 'salaries' && <SalariesTab user={user} initialYear={initialYear} />}
        {tab === 'taxes' && <TaxesTab user={user} initialYear={initialYear} />}
        {tab === 'expenses' && <ExpensesTab />}
        {tab === 'setup' && <KindsTab />}
      </main>
    </StaffShell>
  )
}

/* ---------------------------------------------------------------- the money */
function MoneyTab({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const period = usePeriod('month')
  const { data: s, error } = useFinanceSummary(period.from, period.to)
  const { data: info } = useClinicInfo()
  const method = (m: string) => t(`visit.payment.methods.${m}`, { defaultValue: m })
  return (
    <div className="flex flex-col gap-4">
      <ActionRow>
        <PeriodSeg period={period} className="max-w-full flex-wrap" />
        <div className="flex flex-wrap gap-2">
          <ReportsLink id="finance.money" />
          <ReportButtons
            build={() =>
              s ? financeMoneyReport(s, info?.profile ?? CLINIC_PROFILE, user, t, method) : null
            }
          />
        </div>
      </ActionRow>
      <PeriodCustom period={period} />
      {error && <p className="text-red m-0 text-[14px] font-medium">{error.message}</p>}
      {s && (
        <>
          <div className="pc:grid-cols-[repeat(auto-fit,minmax(170px,1fr))] grid grid-cols-2 gap-3">
            <Kpi
              i={0}
              icon={Coins}
              tint="teal"
              label={t('accounts.money.revenue')}
              value={Math.round(s.netRevenue)}
              unit="RWF"
            />
            <Kpi
              i={1}
              icon={ArrowDownToLine}
              tint="mint"
              label={t('accounts.money.otherIncome')}
              value={Math.round(s.otherIncome)}
              unit="RWF"
            />
            <Kpi
              i={2}
              icon={Wallet}
              tint="amber"
              label={t('accounts.money.staffCost')}
              value={Math.round(s.salaries + s.statutory + s.remittances)}
              unit="RWF"
            />
            <Kpi
              i={3}
              icon={Receipt}
              tint="rose"
              label={t('accounts.money.other')}
              value={Math.round(s.otherExpenses)}
              unit="RWF"
            />
            <Kpi
              i={4}
              icon={Banknote}
              tint="navy"
              label={t('accounts.money.stock')}
              value={Math.round(s.stockBought)}
              unit="RWF"
            />
            <Kpi
              i={5}
              icon={s.net >= 0 ? TrendingUp : TrendingDown}
              tint={s.net >= 0 ? 'mint' : 'coral'}
              label={t('accounts.money.net')}
              value={Math.round(s.net)}
              unit="RWF"
            />
            <Kpi
              i={6}
              icon={AlertTriangle}
              tint="amber"
              label={t('accounts.money.salariesDue')}
              value={Math.round(s.salariesDue)}
              unit="RWF"
            />
          </div>
          <p className="text-ink-3 m-0 text-[13px]">
            {t('accounts.money.how', {
              revenue: formatRwf(Math.round(s.revenue)),
              refunds: formatRwf(Math.round(s.refunds)),
            })}
          </p>
          <div className="pc:grid-cols-2 grid grid-cols-1 gap-4">
            <Panel i={1} icon={ArrowDownToLine} tint="teal" title={t('accounts.money.byKindIn')}>
              <KindTable rows={s.byKindIn} />
            </Panel>
            <Panel i={2} icon={ArrowUpFromLine} tint="coral" title={t('accounts.money.byKindOut')}>
              <KindTable rows={s.byKindOut} />
            </Panel>
            <Panel i={3} icon={Coins} tint="teal" title={t('accounts.money.byMethod')}>
              {s.byMethod.length === 0 ? (
                <Empty icon={Coins}>{t('accounts.money.none')}</Empty>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[14px] max-sm:[&_td]:px-2 max-sm:[&_th]:px-2">
                    <thead className="bg-surface">
                      <tr className="border-border border-b">
                        <th className={tableHead}>{t('report.cols.method')}</th>
                        <th className={cn(tableHead, 'text-right')}>{t('report.cols.count')}</th>
                        <th className={cn(tableHead, 'text-right')}>{t('report.cols.amount')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.byMethod.map((x) => (
                        <tr key={x.method} className={tableRow}>
                          <td className={figureLabel}>{method(x.method)}</td>
                          <td className={cn(tableCell, 'text-right tabular-nums')}>{x.count}</td>
                          <td className={cn(figureAmount, 'font-semibold')}>
                            {formatRwf(x.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
            <Panel i={4} icon={Percent} tint="violet" title={t('accounts.money.taxesApart')}>
              <div className="flex flex-col gap-2 text-[14px]">
                <p className="text-ink-3 m-0 text-[13px]">{t('accounts.money.taxesApartHint')}</p>
                <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2">
                  <div>
                    <dt className="text-ink-3 text-[12px]">{t('accounts.money.taxes')}</dt>
                    <dd className="m-0 font-semibold tabular-nums">{formatRwf(s.taxes)}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-3 text-[12px]">{t('accounts.money.taxesDue')}</dt>
                    <dd className="m-0 font-semibold tabular-nums">{formatRwf(s.taxesDue)}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-3 text-[12px]">{t('accounts.money.afterTax')}</dt>
                    <dd
                      className={cn(
                        'm-0 font-semibold tabular-nums',
                        s.net - s.taxes >= 0 ? 'text-green' : 'text-red',
                      )}
                    >
                      {formatRwf(s.net - s.taxes)}
                    </dd>
                  </div>
                </dl>
              </div>
            </Panel>
          </div>
          <Panel i={5} icon={CalendarCheck} tint="navy" title={t('accounts.money.byMonth')}>
            {s.byMonth.length === 0 ? (
              <Empty icon={CalendarCheck}>{t('accounts.money.none')}</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[14px] [&_td]:px-2 [&_th]:px-2">
                  <thead className="bg-surface">
                    <tr className="border-border border-b">
                      <th className={tableHead}>{t('accounts.money.month')}</th>
                      {(
                        ['revenue', 'otherIncome', 'staffCost', 'other', 'stock', 'net'] as const
                      ).map((k) => (
                        <th
                          key={k}
                          className={cn(
                            tableHead,
                            'min-w-24 py-1.5 text-right align-bottom leading-tight whitespace-normal',
                          )}
                        >
                          {t(`accounts.money.${k}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {s.byMonth.map((m) => {
                      const net =
                        m.revenue - m.refunds + m.otherIncome - m.salaries - m.other - m.stock
                      return (
                        <tr key={m.month} className={tableRow}>
                          <td className={cn(figureLabel, 'whitespace-nowrap')}>{m.month}</td>
                          <td className={figureAmount}>{formatRwf(m.revenue - m.refunds)}</td>
                          <td className={figureAmount}>{formatRwf(m.otherIncome)}</td>
                          <td className={figureAmount}>{formatRwf(m.salaries)}</td>
                          <td className={figureAmount}>{formatRwf(m.other)}</td>
                          <td className={figureAmount}>{formatRwf(m.stock)}</td>
                          <td
                            className={cn(
                              figureAmount,
                              'font-semibold',
                              net >= 0 ? 'text-green' : 'text-red',
                            )}
                          >
                            {formatRwf(net)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          <IncomePanel i={6} from={period.from} to={period.to} />
        </>
      )}
    </div>
  )
}

/** Money in or out by kind (0185): the built-in kinds translated, the accountant's as named. */
function KindTable({ rows }: { rows: FinanceSummary['byKindIn'] }) {
  const { t } = useTranslation()
  if (rows.length === 0) return <Empty icon={Coins}>{t('accounts.money.none')}</Empty>
  const total = rows.reduce((s, x) => s + x.amount, 0)
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[14px]">
        <thead className="bg-surface">
          <tr className="border-border border-b">
            <th className={tableHead}>{t('accounts.kinds.kind')}</th>
            <th className={cn(tableHead, 'text-right')}>{t('report.cols.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.id} className={tableRow}>
              <td className={figureLabel}>{kindName(t, x)}</td>
              <td className={figureAmount}>{formatRwf(x.amount)}</td>
            </tr>
          ))}
          <tr className="border-border border-t">
            <td className={cn(figureLabel, 'font-semibold')}>{t('report.total')}</td>
            <td className={cn(figureAmount, 'font-semibold')}>{formatRwf(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

/* ---------------------------------------------------------------- the salaries */

/**
 * 0181: a compact list (one row per employee, one View button); the employee's side panel holds
 * the pay periods and every action (mark paid, skip, undo, change or remove the salary).
 */
function SalariesTab({ user, initialYear }: { user: StaffUser; initialYear?: number }) {
  const { t } = useTranslation()
  const thisYear = Number(kigaliToday().slice(0, 4))
  const [year, setYear] = useState(initialYear ?? thisYear)
  const { data, error, isLoading } = useSalaryOverview(year)
  const { data: info } = useClinicInfo()
  const [who, setWho] = useState<{ id: string; name: string; role: string } | null>(null)
  const [msg, setMsg] = useState<Msg | null>(null)
  const years = [thisYear - 2, thisYear - 1, thisYear, thisYear + 1]
  const people = data?.people ?? []
  const overdueTotal = people.reduce((s, p) => s + p.overdue, 0)
  const roleWord = (role: string) => t(`staff.roles.${role}`, { defaultValue: role })
  return (
    <div className="flex flex-col gap-4">
      <ActionRow>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink-2 text-[13px] font-semibold">
            {t('accounts.salaries.year')}
          </span>
          <select
            aria-label={t('accounts.salaries.year')}
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="border-border bg-surface text-ink h-9 rounded-md border px-2 text-[14px] font-medium"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          {overdueTotal > 0 && (
            <Badge tone="red">{t('accounts.salaries.overdueCount', { count: overdueTotal })}</Badge>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <ReportsLink id="finance.payroll" />
          <ReportButtons
            build={() =>
              data ? payrollReport(data, info?.profile ?? CLINIC_PROFILE, user, t) : null
            }
          />
        </div>
      </ActionRow>
      {error && <p className="text-red m-0 text-[14px] font-medium">{error.message}</p>}
      {msg && !who && <Note msg={msg} />}
      <Panel i={1} icon={Wallet} tint="amber" title={t('accounts.salaries.title', { year })}>
        {isLoading ? null : people.length === 0 ? (
          <Empty icon={Wallet}>{t('accounts.salaries.none')}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[14px] [&_td]:px-2 [&_th]:px-2 [&_th]:py-1.5 [&_th]:leading-tight [&_th]:whitespace-normal">
              <thead className="bg-surface">
                <tr className="border-border border-b">
                  <th className={tableHead}>{t('accounts.salaries.cols.employee')}</th>
                  <th className={cn(tableHead, 'text-right')}>
                    {t('accounts.salaries.cols.amount')}
                  </th>
                  <th className={tableHead}>{t('accounts.salaries.cols.nextDue')}</th>
                  <th className={cn(tableHead, 'text-right')}>
                    {t('accounts.salaries.cols.paidYear')}
                  </th>
                  <th className={tableHead}>{t('accounts.salaries.cols.periods')}</th>
                  <th className={tableHead}></th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id} className={tableRow}>
                    <td className={cn(tableFirstCell, 'min-w-36')}>
                      {p.name}
                      <span className="text-ink-3 block text-[12px]">
                        {roleWord(p.role)}
                        {p.staffId ? ` · ${p.staffId}` : ''}
                      </span>
                    </td>
                    <td className={cn(figureAmount, 'font-semibold')}>
                      {formatRwf(p.amount)}
                      <span className="text-ink-3 block text-[12px] font-normal">
                        {intervalWords(t, p.intervalKind, p.customEvery, p.customUnit)}
                      </span>
                    </td>
                    <td className={tableCell}>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="whitespace-nowrap">
                          {p.nextDue ? formatDate(new Date(p.nextDue)) : '—'}
                        </span>
                        {p.overdue > 0 && (
                          <Badge tone="red">
                            {t('accounts.salaries.overdueCount', { count: p.overdue })}
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className={figureAmount}>{formatRwf(p.paidThisYear)}</td>
                    <td className={tableCell}>
                      <span className="flex flex-wrap gap-1">
                        {STATUSES.map((s) => {
                          const n = p.periods.filter((x) => x.status === s).length
                          return n > 0 ? (
                            <Badge key={s} tone={STATUS_TONE[s]}>
                              {n} {t(`accounts.status.${s}`)}
                            </Badge>
                          ) : null
                        })}
                      </span>
                    </td>
                    <td className={cn(tableCell, 'text-right whitespace-nowrap')}>
                      <Button
                        size="sm"
                        variant="tint-blue"
                        onClick={() => {
                          setMsg(null)
                          setWho({ id: p.id, name: p.name, role: p.role })
                        }}
                      >
                        <Eye size={14} aria-hidden="true" />
                        {t('accounts.salaries.view')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.withoutSalary.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 pt-2 text-[13px]">
            <span className="text-ink-3">{t('accounts.salaries.without')}</span>
            {data.withoutSalary.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant="tint-grey"
                onClick={() => {
                  setMsg(null)
                  setWho({ id: p.id, name: p.name, role: p.role })
                }}
              >
                {p.name}
              </Button>
            ))}
          </div>
        )}
      </Panel>
      {who && (
        <SalaryPanel
          key={who.id}
          who={who}
          person={people.find((p) => p.id === who.id) ?? null}
          msg={msg}
          onMsg={setMsg}
          onClose={() => {
            setWho(null)
            setMsg(null)
          }}
        />
      )}
    </div>
  )
}

/** One employee: the salary set, the pay periods of the year and the actions (0181). */
function SalaryPanel({
  who,
  person,
  msg,
  onMsg,
  onClose,
}: {
  who: { id: string; name: string; role: string }
  person: SalaryPerson | null
  msg: Msg | null
  onMsg: (m: Msg) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { unpaySalary, skipSalary } = useAccountsActions()
  // without a salary yet, the form opens straight away
  const [editing, setEditing] = useState(!person)
  const [paying, setPaying] = useState<SalaryPeriod | null>(null)
  // 0186: the pay slip of one period, opened from its row
  const [slip, setSlip] = useState<SalaryPeriod | null>(null)
  const method = (m: string | null) =>
    m ? t(`visit.payment.methods.${m}`, { defaultValue: m }) : ''
  const undo = async (period: SalaryPeriod) => {
    if (!period.id) return
    const why = await confirm({
      title: t('accounts.salaries.undoTitle', { name: who.name }),
      body: t('accounts.salaries.undoBody', { date: formatDate(new Date(period.dueOn)) }),
      confirmLabel: t('accounts.salaries.undoYes'),
      tone: 'danger',
      input: { label: t('accounts.salaries.reason'), required: true },
    })
    if (!why.ok) return
    try {
      await unpaySalary.mutateAsync({ periodId: period.id, reason: why.value })
      onMsg({ ok: true, text: t('accounts.salaries.undone') })
    } catch (e) {
      onMsg({ ok: false, text: errText(e) })
    }
  }
  const skip = async (period: SalaryPeriod) => {
    const why = await confirm({
      title: t('accounts.salaries.skipTitle', { name: who.name }),
      body: t('accounts.salaries.skipBody', { date: formatDate(new Date(period.dueOn)) }),
      confirmLabel: t('accounts.salaries.skipYes'),
      input: { label: t('accounts.salaries.reason'), required: true },
    })
    if (!why.ok) return
    try {
      await skipSalary.mutateAsync({
        profileId: who.id,
        periodStart: period.periodStart,
        reason: why.value,
      })
      setPaying(null)
      onMsg({ ok: true, text: t('accounts.salaries.skipped') })
    } catch (e) {
      onMsg({ ok: false, text: errText(e) })
    }
  }
  const subtitle = [t(`staff.roles.${who.role}`, { defaultValue: who.role }), person?.staffId]
    .filter(Boolean)
    .join(' · ')
  return (
    <SidePanel
      open
      onClose={onClose}
      hue="amber"
      icon={Wallet}
      title={who.name}
      subtitle={subtitle}
      tags={
        person && person.overdue > 0 ? (
          <Badge tone="red">{t('accounts.salaries.overdueCount', { count: person.overdue })}</Badge>
        ) : undefined
      }
      actions={
        person && !editing ? (
          <Button
            size="sm"
            variant="tint-amber"
            onClick={() => {
              setPaying(null)
              setEditing(true)
            }}
          >
            {t('accounts.salaries.edit')}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        {msg && <Note msg={msg} />}
        {person && !editing && (
          <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 text-[14px] sm:grid-cols-3">
            <div>
              <dt className="text-ink-3 text-[12px]">{t('accounts.salaries.cols.amount')}</dt>
              <dd className="m-0 font-semibold tabular-nums">{formatRwf(person.amount)}</dd>
            </div>
            <div>
              <dt className="text-ink-3 text-[12px]">{t('accounts.salaries.cols.interval')}</dt>
              <dd className="m-0">
                {intervalWords(t, person.intervalKind, person.customEvery, person.customUnit)}
                {person.payDay ? ` · ${t('accounts.salaries.payDay', { day: person.payDay })}` : ''}
              </dd>
            </div>
            <div>
              <dt className="text-ink-3 text-[12px]">{t('accounts.salaries.anchor')}</dt>
              <dd className="m-0">{formatDate(new Date(person.anchorOn))}</dd>
            </div>
            <div>
              <dt className="text-ink-3 text-[12px]">{t('accounts.salaries.cols.paidYear')}</dt>
              <dd className="m-0 tabular-nums">{formatRwf(person.paidThisYear)}</dd>
            </div>
            <div>
              <dt className="text-ink-3 text-[12px]">{t('accounts.salaries.cols.nextDue')}</dt>
              <dd className="m-0">{person.nextDue ? formatDate(new Date(person.nextDue)) : '—'}</dd>
            </div>
            <div>
              <dt className="text-ink-3 text-[12px]">{t('accounts.salaries.payeMode')}</dt>
              <dd className="m-0">{t(`accounts.salaries.payeModes.${person.payeMode}`)}</dd>
            </div>
            {person.note && (
              <div>
                <dt className="text-ink-3 text-[12px]">{t('accounts.salaries.note')}</dt>
                <dd className="m-0">{person.note}</dd>
              </div>
            )}
          </dl>
        )}
        {editing && (
          <SalaryForm
            profileId={who.id}
            name={who.name}
            current={person}
            onClose={() => (person ? setEditing(false) : onClose())}
            onMsg={onMsg}
          />
        )}
        {paying && person && !editing && (
          <PayForm person={person} period={paying} onClose={() => setPaying(null)} onMsg={onMsg} />
        )}
        {slip && person && !editing && (
          <PayslipView person={person} period={slip} onClose={() => setSlip(null)} />
        )}
        {person && !editing && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px] [&_td]:px-2 [&_th]:px-2">
              <thead className="bg-surface">
                <tr className="border-border border-b">
                  {/* the headings may wrap too: the table fits the panel in every language */}
                  <th className={cn(tableHead, 'whitespace-normal')}>
                    {t('accounts.salaries.cols.period')}
                  </th>
                  <th className={cn(tableHead, 'whitespace-normal')}>
                    {t('accounts.salaries.cols.dueOn')}
                  </th>
                  <th className={cn(tableHead, 'text-right whitespace-normal')}>
                    {t('accounts.salaries.gross')}
                  </th>
                  <th className={cn(tableHead, 'text-right whitespace-normal')}>
                    {t('accounts.salaries.net')}
                  </th>
                  <th className={cn(tableHead, 'whitespace-normal')}>
                    {t('accounts.salaries.cols.status')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {person.periods.map((x) => {
                  const detail =
                    x.status === 'paid'
                      ? [
                          x.paidOn ? formatDate(new Date(x.paidOn)) : null,
                          method(x.method),
                          x.reference,
                          x.paidBy,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : x.status === 'skipped'
                        ? x.note
                        : ''
                  const here = paying?.periodStart === x.periodStart
                  const open = slip?.periodStart === x.periodStart
                  return (
                    <tr
                      key={x.periodStart}
                      className={cn(tableRow, (here || open) && 'bg-yellow-bg')}
                    >
                      {/* the period may break between its two dates */}
                      <td className={figureLabel}>
                        <span className="whitespace-nowrap">
                          {formatDate(new Date(x.periodStart))} –
                        </span>{' '}
                        <span className="whitespace-nowrap">
                          {formatDate(new Date(x.periodEnd))}
                        </span>
                        <button
                          type="button"
                          className="text-teal block text-left text-[12px] underline-offset-2 hover:underline"
                          onClick={() => setSlip(open ? null : x)}
                        >
                          {t('accounts.salaries.payslip')}
                        </button>
                      </td>
                      <td className={cn(tableCell, 'whitespace-nowrap')}>
                        {formatDate(new Date(x.dueOn))}
                      </td>
                      <td className={figureAmount}>{formatRwf(x.gross)}</td>
                      <td className={cn(figureAmount, 'font-semibold')}>
                        {formatRwf(x.status === 'paid' ? (x.paidAmount ?? x.net) : x.net)}
                      </td>
                      <td className={cn(tableCell, 'max-sm:min-w-48')}>
                        <Badge tone={STATUS_TONE[x.status]}>
                          {t(`accounts.status.${x.status}`)}
                        </Badge>
                        {detail && <span className="text-ink-3 block text-[12px]">{detail}</span>}
                        <span className="mt-1 flex flex-wrap gap-1">
                          {x.status === 'due' || x.status === 'overdue' ? (
                            <>
                              <Button
                                size="sm"
                                variant={here ? 'tint-grey' : 'primary'}
                                onClick={() => setPaying(here ? null : x)}
                              >
                                <CalendarCheck size={14} aria-hidden="true" />
                                {t('accounts.salaries.markPaid')}
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => void skip(x)}>
                                {t('accounts.salaries.skip')}
                              </Button>
                            </>
                          ) : (
                            <Button size="sm" variant="tint-grey" onClick={() => void undo(x)}>
                              <Undo2 size={14} aria-hidden="true" />
                              {t('accounts.salaries.undo')}
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
      </div>
    </SidePanel>
  )
}

/** The pay slip of one period (0186): gross, each deduction, net, the employer's contributions. */
function PayslipView({
  person,
  period,
  onClose,
}: {
  person: SalaryPerson
  period: SalaryPeriod
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { data: info } = useClinicInfo()
  const user = useSession((s) => s.user)
  const agency = (a: string) => t(`accounts.deductions.agencies.${a}`)
  return (
    <PanelForm
      title={t('accounts.salaries.payslipTitle', {
        name: person.name,
        period: `${formatDate(new Date(period.periodStart))} – ${formatDate(new Date(period.periodEnd))}`,
      })}
    >
      <div className="flex min-w-0 flex-col gap-3">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px] max-sm:[&_td]:px-2">
            <tbody>
              <tr className={tableRow}>
                <td className={cn(figureLabel, 'font-semibold')}>{t('accounts.salaries.gross')}</td>
                <td className={cn(figureAmount, 'font-semibold')}>{formatRwf(period.gross)}</td>
                <td className={cn(tableCell, 'text-ink-3 text-right text-[12px]')}>
                  {t('accounts.salaries.employerShare')}
                </td>
              </tr>
              {period.deductions.map((l) => (
                <tr key={l.ruleId} className={tableRow}>
                  <td className={figureLabel}>
                    {l.code ? deductionName(t, l) : l.name}
                    <span className="text-ink-3 block text-[12px]">
                      {agency(l.agency)} · {t(`accounts.deductions.bases.${l.base}`)}
                    </span>
                  </td>
                  <td className={figureAmount}>
                    {l.employee ? `− ${formatRwf(l.employee)}` : '—'}
                  </td>
                  <td className={cn(figureAmount, 'text-ink-3')}>
                    {l.employer ? formatRwf(l.employer) : '—'}
                  </td>
                </tr>
              ))}
              <tr className="border-border border-t">
                <td className={cn(figureLabel, 'font-semibold')}>{t('accounts.salaries.net')}</td>
                <td className={cn(figureAmount, 'text-green font-semibold')}>
                  {formatRwf(period.net)}
                </td>
                <td className={cn(figureAmount, 'font-semibold')}>
                  {formatRwf(period.employerTotal)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-ink-3 m-0 text-[13px]">
          {t('accounts.salaries.payslipHint', {
            cost: formatRwf(period.gross + period.employerTotal),
            withheld: formatRwf(period.gross - period.net),
          })}
        </p>
        <div className="flex flex-wrap gap-2">
          {user && (
            <ReportButtons
              build={() => payslipReport(person, period, info?.profile ?? CLINIC_PROFILE, user, t)}
            />
          )}
          <Button onClick={onClose}>{t('accounts.cancel')}</Button>
        </div>
      </div>
    </PanelForm>
  )
}

function SalaryForm({
  profileId,
  name,
  current,
  onClose,
  onMsg,
}: {
  profileId: string
  name: string
  current: SalaryPerson | null
  onClose: () => void
  onMsg: (m: Msg) => void
}) {
  const { t } = useTranslation()
  const { setSalary, removeSalary, setStaffDeduction } = useAccountsActions()
  const { data: deductions } = useDeductions()
  const confirm = useConfirm()
  // 0186: the rules that may apply (PAYE is the salary's own mode), ticked as set or by default
  const rules = (deductions?.rules ?? []).filter((r) => r.active && r.code !== 'paye')
  const [payeMode, setPayeMode] = useState<PayeMode>(current?.payeMode ?? 'normal')
  const [ticks, setTicks] = useState<Record<string, { on: boolean; until: string }>>(() =>
    Object.fromEntries(
      (current?.deductions ?? []).map((d) => [d.ruleId, { on: d.applies, until: d.until ?? '' }]),
    ),
  )
  const tickOf = (ruleId: string, dflt: boolean) => ticks[ruleId] ?? { on: dflt, until: '' }
  const [amount, setAmount] = useState(current ? String(current.amount) : '')
  const [interval, setInterval] = useState<SalaryInterval>(current?.intervalKind ?? 'monthly')
  // 0180: a custom interval: every N days, weeks or months
  const [every, setEvery] = useState(current?.customEvery ? String(current.customEvery) : '')
  const [unit, setUnit] = useState<CustomUnit>(current?.customUnit ?? 'days')
  const [anchor, setAnchor] = useState(current?.anchorOn ?? kigaliToday())
  const [payDay, setPayDay] = useState(current?.payDay ? String(current.payDay) : '')
  const [note, setNote] = useState(current?.note ?? '')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const a = Number(amount)
    if (!Number.isFinite(a) || a < 0)
      return onMsg({ ok: false, text: t('accounts.salaries.errors.amount') })
    if (!anchor) return onMsg({ ok: false, text: t('accounts.salaries.errors.anchor') })
    const n = Number(every)
    if (interval === 'custom' && (!Number.isInteger(n) || n < 1 || n > 365))
      return onMsg({ ok: false, text: t('accounts.salaries.errors.custom') })
    try {
      await setSalary.mutateAsync({
        profileId,
        amount: Math.round(a),
        interval,
        customEvery: interval === 'custom' ? n : null,
        customUnit: interval === 'custom' ? unit : null,
        anchorOn: anchor,
        payDay: payDay ? Number(payDay) : null,
        payeMode,
        note,
      })
      // the ticks that differ from the rule's default, or carry an "until": saved per employee
      for (const r of rules) {
        const k = tickOf(r.id, r.defaultOn)
        const stored = current?.deductions.find((d) => d.ruleId === r.id)
        const changed = stored
          ? stored.applies !== k.on || (stored.until ?? '') !== k.until
          : k.on !== r.defaultOn || k.until !== ''
        if (changed)
          await setStaffDeduction.mutateAsync({
            profileId,
            ruleId: r.id,
            applies: k.on,
            until: k.until || null,
          })
      }
      onMsg({ ok: true, text: t('accounts.salaries.saved', { name }) })
      onClose()
    } catch (err) {
      onMsg({ ok: false, text: errText(err) })
    }
  }
  const remove = async () => {
    if (
      !(await confirm({
        title: t('accounts.salaries.removeTitle', { name }),
        body: t('accounts.salaries.removeBody'),
        confirmLabel: t('accounts.salaries.removeYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await removeSalary.mutateAsync(profileId)
      onMsg({ ok: true, text: t('accounts.salaries.removed', { name }) })
      onClose()
    } catch (err) {
      onMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <PanelForm title={t('accounts.salaries.setTitle', { name })}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* the custom interval's words are long: its select takes the whole row (a select's
              value cannot wrap), and so does the amount above it, so no half row is left empty */}
          <Field
            wrapperClassName={interval === 'custom' ? 'sm:col-span-2' : undefined}
            label={t('accounts.salaries.cols.amount')}
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
          />
          <Select
            wrapperClassName={interval === 'custom' ? 'sm:col-span-2' : undefined}
            label={t('accounts.salaries.cols.interval')}
            value={interval}
            onChange={(e) => setInterval(e.target.value as SalaryInterval)}
          >
            {SALARY_INTERVALS.map((k) => (
              <option key={k} value={k}>
                {t(`accounts.intervals.${k}`)}
              </option>
            ))}
          </Select>
          {interval === 'custom' && (
            <div className="flex items-end gap-2">
              <Field
                wrapperClassName="w-24"
                label={t('accounts.salaries.customEvery')}
                inputMode="numeric"
                value={every}
                onChange={(e) => setEvery(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
              />
              <Select
                wrapperClassName="min-w-0 flex-1"
                label={t('accounts.salaries.customUnit')}
                value={unit}
                onChange={(e) => setUnit(e.target.value as CustomUnit)}
              >
                {CUSTOM_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {t(`accounts.units.${u}`, { count: Number(every) || 2 })}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <Field
            label={t('accounts.salaries.anchor')}
            type="date"
            value={anchor}
            onChange={(e) => setAnchor(e.target.value)}
          />
          <Field
            label={t('accounts.salaries.payDayField')}
            inputMode="numeric"
            placeholder={t('accounts.salaries.payDayPh')}
            value={payDay}
            onChange={(e) => setPayDay(e.target.value.replace(/[^\d]/g, '').slice(0, 2))}
          />
        </div>
        <Field
          label={t('accounts.salaries.note')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <p className="text-ink-3 m-0 text-[13px]">{t('accounts.salaries.setHint')}</p>
        <div className="border-border rounded-md border p-3">
          <h4 className="text-ink m-0 mb-2 text-[14px] font-semibold">
            {t('accounts.salaries.deductionsTitle')}
          </h4>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select
              label={t('accounts.salaries.payeMode')}
              value={payeMode}
              onChange={(e) => setPayeMode(e.target.value as PayeMode)}
            >
              {PAYE_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`accounts.salaries.payeModes.${m}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="mt-2 flex flex-col gap-1">
            {rules.map((r) => {
              const k = tickOf(r.id, r.defaultOn)
              return (
                <label key={r.id} className="flex flex-wrap items-center gap-2 text-[14px]">
                  <input
                    type="checkbox"
                    className="flex-none"
                    checked={k.on}
                    onChange={(e) =>
                      setTicks((x) => ({ ...x, [r.id]: { ...k, on: e.target.checked } }))
                    }
                  />
                  <span className="min-w-0 flex-[1_1_10rem]">
                    {deductionName(t, r)}
                    <span className="text-ink-3 ml-1 text-[12px]">
                      {r.current
                        ? [
                            r.current.employeeAmount != null
                              ? t('accounts.deductions.fixedWords', {
                                  amount: r.current.employeeAmount,
                                })
                              : r.current.employeeRate != null
                                ? `${r.current.employeeRate}%`
                                : null,
                            r.current.employerAmount != null || r.current.employerRate != null
                              ? t('accounts.salaries.employerPlus', {
                                  share:
                                    r.current.employerAmount != null
                                      ? t('accounts.deductions.fixedWords', {
                                          amount: r.current.employerAmount,
                                        })
                                      : `${r.current.employerRate}%`,
                                })
                              : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        : ''}
                    </span>
                  </span>
                  {/* 0194: a deduction the accountant added (a loan, an advance) can end on a
                      date, whether a percentage or a fixed amount */}
                  {k.on && (!r.code || r.current?.employeeAmount != null) && (
                    <input
                      type="date"
                      aria-label={t('accounts.salaries.until')}
                      className="border-border bg-card text-ink ml-auto h-8 rounded-md border px-2 text-[13px]"
                      value={k.until}
                      onChange={(e) =>
                        setTicks((x) => ({ ...x, [r.id]: { ...k, until: e.target.value } }))
                      }
                    />
                  )}
                </label>
              )
            })}
          </div>
          <p className="text-ink-3 m-0 mt-2 text-[12px]">{t('accounts.salaries.deductionsHint')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" type="submit" loading={setSalary.isPending}>
            {t('accounts.salaries.save')}
          </Button>
          <Button onClick={onClose}>{t('accounts.cancel')}</Button>
          {current && (
            <Button variant="tint-coral" className="ml-auto" onClick={() => void remove()}>
              {t('accounts.salaries.remove')}
            </Button>
          )}
        </div>
      </form>
    </PanelForm>
  )
}

function PayForm({
  person,
  period,
  onClose,
  onMsg,
}: {
  person: SalaryPerson
  period: SalaryPeriod
  onClose: () => void
  onMsg: (m: Msg) => void
}) {
  const { t } = useTranslation()
  const { paySalary } = useAccountsActions()
  const [paidOn, setPaidOn] = useState(kigaliToday())
  // 0186: the net to pay, after the deductions
  const [amount, setAmount] = useState(String(period.net))
  const [method, setMethod] = useState<string>('cash')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const a = Number(amount)
    if (!Number.isFinite(a) || a <= 0)
      return onMsg({ ok: false, text: t('accounts.salaries.errors.paid') })
    try {
      await paySalary.mutateAsync({
        profileId: person.id,
        periodStart: period.periodStart,
        paidOn,
        amount: Math.round(a),
        method,
        reference,
        note,
      })
      onMsg({
        ok: true,
        text: t('accounts.salaries.paidOk', {
          name: person.name,
          date: formatDate(new Date(paidOn)),
        }),
      })
      onClose()
    } catch (err) {
      onMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <PanelForm
      title={t('accounts.salaries.payTitle', {
        name: person.name,
        period: `${formatDate(new Date(period.periodStart))} – ${formatDate(new Date(period.periodEnd))}`,
      })}
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label={t('accounts.salaries.paidOn')}
            type="date"
            value={paidOn}
            max={kigaliToday()}
            onChange={(e) => setPaidOn(e.target.value)}
          />
          <Field
            label={t('accounts.salaries.netPaid')}
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
          />
          <Select
            label={t('report.cols.method')}
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`visit.payment.methods.${m}`)}
              </option>
            ))}
          </Select>
          <Field
            label={t('accounts.reference')}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
        <Field
          label={t('accounts.salaries.note')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <p className="text-ink-3 m-0 text-[13px]">
          {t('accounts.salaries.payNetHint', {
            gross: formatRwf(period.gross),
            withheld: formatRwf(period.gross - period.net),
            employer: formatRwf(period.employerTotal),
          })}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" type="submit" loading={paySalary.isPending}>
            <CalendarCheck size={16} aria-hidden="true" />
            {t('accounts.salaries.markPaid')}
          </Button>
          <Button onClick={onClose}>{t('accounts.cancel')}</Button>
        </div>
      </form>
    </PanelForm>
  )
}

/* ---------------------------------------------------------------- other expenses */
function ExpensesTab() {
  const { t } = useTranslation()
  const period = usePeriod('month')
  const { data: rows = [], error } = useExpenses(period.from, period.to)
  const { data: kinds = [] } = useMoneyKinds()
  const { addExpense, voidExpense } = useAccountsActions()
  const confirm = useConfirm()
  // 0185: the kinds of money out the accountant records by hand (not those the system fills)
  const choices = kinds.filter(
    (k) => k.side === 'out' && k.active && !SYSTEM_OUT_KINDS.includes(k.code ?? ''),
  )
  const [kindId, setKindId] = useState('')
  const chosen = choices.find((k) => k.id === kindId)
  const [label, setLabel] = useState('')
  const [amount, setAmount] = useState('')
  // 0194: a one-off tax: a fixed amount, or a percentage of an amount typed here
  const [how, setHow] = useState<'fixed' | 'percent'>('fixed')
  const [rate, setRate] = useState('')
  const [base, setBase] = useState('')
  const [method, setMethod] = useState<string>('cash')
  const [reference, setReference] = useState('')
  const [paidOn, setPaidOn] = useState(kigaliToday())
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<Msg | null>(null)
  const methodWord = (m: string) => t(`visit.payment.methods.${m}`, { defaultValue: m })
  const pct = chosen?.code === 'tax' && how === 'percent'
  const pRate = Number(rate)
  const pBase = Number(base)
  const rateOk = rate !== '' && Number.isFinite(pRate) && pRate > 0 && pRate <= 100
  const baseOk = base !== '' && Number.isFinite(pBase) && pBase > 0
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const a = Number(amount)
    if (!kindId) return setMsg({ ok: false, text: t('accounts.expenses.errors.kind') })
    if (label.trim().length < 2)
      return setMsg({ ok: false, text: t('accounts.expenses.errors.label') })
    if (pct && (!rateOk || !baseOk))
      return setMsg({ ok: false, text: t('accounts.expenses.errors.rate') })
    if (!pct && (!Number.isFinite(a) || a <= 0))
      return setMsg({ ok: false, text: t('accounts.expenses.errors.amount') })
    try {
      await addExpense.mutateAsync({
        label: label.trim(),
        amount: pct ? null : Math.round(a),
        method,
        reference,
        paidOn,
        note,
        kindId,
        rate: pct ? pRate : null,
        baseAmount: pct ? Math.round(pBase) : null,
      })
      setMsg({ ok: true, text: t('accounts.expenses.added') })
      setLabel('')
      setAmount('')
      setRate('')
      setBase('')
      setHow('fixed')
      setReference('')
      setNote('')
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  const undo = async (id: string, what: string) => {
    const why = await confirm({
      title: t('accounts.expenses.voidTitle', { what }),
      confirmLabel: t('accounts.expenses.voidYes'),
      tone: 'danger',
      input: { label: t('accounts.salaries.reason'), required: true },
    })
    if (!why.ok) return
    try {
      await voidExpense.mutateAsync({ id, reason: why.value })
      setMsg({ ok: true, text: t('accounts.expenses.voided') })
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  // 0214: one group at a time, Other expenses first (the same figure as on the Money tab);
  // within a group, one kind if wanted
  const [group, setGroup] = useState<ExpenseGroup>('other')
  const [kindFilter, setKindFilter] = useState('')
  const kindKey = (r: Expense) => r.kindId ?? `kind:${r.kind}`
  const kindLabel = (r: Expense) =>
    r.kindName
      ? kindName(t, { code: r.kindCode ?? null, name: r.kindName })
      : t(`accounts.expenses.kinds.${r.kind as ExpenseKind}`)
  const inGroup = rows.filter((r) => group === 'all' || expenseGroup(r) === group)
  const kindsHere = [...new Map(inGroup.map((r) => [kindKey(r), kindLabel(r)])).entries()].sort(
    (a, b) => a[1].localeCompare(b[1]),
  )
  const kindOn = kindsHere.some(([k]) => k === kindFilter) ? kindFilter : ''
  const shown = kindOn ? inGroup.filter((r) => kindKey(r) === kindOn) : inGroup
  const total = shown.filter((r) => !r.voided).reduce((s, r) => s + r.amount, 0)
  const groupWord = t(`accounts.expenses.groups.${group}`)
  return (
    <div className="flex flex-col gap-4">
      <ActionRow>
        <PeriodSeg period={period} className="max-w-full flex-wrap" />
        <div className="flex flex-wrap items-center gap-2">
          <BannerChip icon={Receipt}>
            {t('accounts.expenses.totalOf', {
              what: kindOn ? (kindsHere.find(([k]) => k === kindOn)?.[1] ?? groupWord) : groupWord,
              amount: formatRwf(total),
            })}
          </BannerChip>
          <ReportsLink id="finance.expenses" />
        </div>
      </ActionRow>
      <PeriodCustom period={period} />
      {error && <p className="text-red m-0 text-[14px] font-medium">{error.message}</p>}
      {msg && <Note msg={msg} />}
      <Panel i={1} icon={Receipt} tint="violet" title={t('accounts.expenses.add')}>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
            <Select
              label={t('accounts.expenses.kindField')}
              value={kindId}
              onChange={(e) => {
                setKindId(e.target.value)
                setHow('fixed')
              }}
            >
              <option value="">{t('accounts.expenses.kindPh')}</option>
              {choices.map((k) => (
                <option key={k.id} value={k.id}>
                  {kindName(t, k)}
                </option>
              ))}
            </Select>
            <Field
              wrapperClassName="lg:col-span-2"
              label={t('accounts.expenses.label')}
              placeholder={
                chosen?.code === 'tax'
                  ? t('accounts.expenses.taxPh')
                  : t('accounts.expenses.labelPh')
              }
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            {chosen?.code === 'tax' && (
              <Select
                label={t('accounts.taxes.howField')}
                value={how}
                onChange={(e) => setHow(e.target.value as 'fixed' | 'percent')}
              >
                <option value="fixed">{t('accounts.taxes.how.fixed')}</option>
                <option value="percent">{t('accounts.taxes.how.percent')}</option>
              </Select>
            )}
            {pct ? (
              <>
                <Field
                  label={t('accounts.taxes.rateField')}
                  inputMode="decimal"
                  placeholder="15"
                  value={rate}
                  onChange={(e) => setRate(cleanPercent(e.target.value))}
                />
                <Field
                  label={t('accounts.taxes.cols.base')}
                  inputMode="numeric"
                  value={base}
                  onChange={(e) => setBase(e.target.value.replace(/[^\d]/g, '').slice(0, 12))}
                />
              </>
            ) : (
              <Field
                label={t('report.cols.amount')}
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
              />
            )}
            <Select
              label={t('report.cols.method')}
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`visit.payment.methods.${m}`)}
                </option>
              ))}
            </Select>
            <Field
              label={t('accounts.expenses.paidOn')}
              type="date"
              value={paidOn}
              max={kigaliToday()}
              onChange={(e) => setPaidOn(e.target.value)}
            />
          </div>
          {pct && rateOk && baseOk && (
            <p className="text-ink m-0 text-[14px] font-semibold">
              {t('accounts.taxes.payWork', {
                rate: pRate,
                base: formatRwf(Math.round(pBase)),
                amount: formatRwf(workedOut(pBase, pRate)),
              })}
            </p>
          )}
          {chosen?.description && (
            <p className="text-ink-3 m-0 text-[13px]">{chosen.description}</p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label={t('accounts.reference')}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
            <Field
              label={t('accounts.salaries.note')}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <p className="text-ink-3 m-0 text-[13px]">{t('accounts.expenses.kindsHint')}</p>
          <Button
            variant="primary"
            type="submit"
            className="self-start"
            loading={addExpense.isPending}
          >
            {t('accounts.expenses.save')}
          </Button>
        </form>
      </Panel>
      <SectionTitle icon={Receipt}>{t('accounts.expenses.list')}</SectionTitle>
      <div className="flex flex-wrap items-end gap-3">
        <Seg
          label={t('accounts.expenses.show')}
          value={group}
          onChange={(g) => {
            setGroup(g)
            setKindFilter('')
          }}
          options={EXPENSE_GROUPS.map((g) => ({
            value: g,
            label: t(`accounts.expenses.groups.${g}`),
          }))}
        />
        {kindsHere.length > 1 && (
          <Select
            wrapperClassName="w-56 max-w-full"
            label={t('accounts.expenses.kind')}
            value={kindOn}
            onChange={(e) => setKindFilter(e.target.value)}
          >
            <option value="">{t('accounts.expenses.kindAll')}</option>
            {kindsHere.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        )}
      </div>
      <p className="text-ink-3 m-0 -mt-1 text-[13px]">
        {t(`accounts.expenses.groupHints.${group}`)}
      </p>
      {shown.length === 0 ? (
        <Empty icon={Receipt}>
          {t(rows.length === 0 ? 'accounts.expenses.none' : 'accounts.expenses.noneHere')}
        </Empty>
      ) : (
        <div className="border-border bg-card overflow-x-auto rounded-md border">
          {/* seven columns: tighter cells, so the Void button of a row stays in sight beside the
              app's sidebar (it was past the right edge at 1024 px, and at 1366 px in Kinyarwanda) */}
          <table className="w-full border-collapse text-[14px] [&_td]:px-2 [&_th]:px-2">
            <thead className="bg-surface">
              <tr className="border-border border-b">
                <th className={tableHead}>{t('accounts.expenses.paidOn')}</th>
                <th className={tableHead}>{t('accounts.expenses.label')}</th>
                <th className={tableHead}>{t('accounts.expenses.kind')}</th>
                <th className={cn(tableHead, 'text-right')}>{t('report.cols.amount')}</th>
                <th className={tableHead}>{t('report.cols.method')}</th>
                <th className={tableHead}>{t('report.cols.by')}</th>
                <th className={tableHead}></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className={cn(tableRow, r.voided && 'opacity-60')}>
                  <td className={cn(figureLabel, 'whitespace-nowrap')}>
                    {formatDate(new Date(r.paidOn))}
                  </td>
                  <td className={cn(tableCell, 'min-w-28')}>
                    {r.label}
                    {r.voided && (
                      <span className="text-red block text-[12px]">
                        {t('accounts.expenses.voidedTag', { why: r.voidReason ?? '' })}
                      </span>
                    )}
                  </td>
                  <td className={tableCell}>{kindLabel(r)}</td>
                  <td className={cn(figureAmount, 'font-semibold', r.voided && 'line-through')}>
                    {formatRwf(r.amount)}
                    {r.rate != null && r.baseAmount != null && (
                      <span className="text-ink-3 block min-w-24 text-[12px] font-normal whitespace-normal">
                        {rateWorkWords(t, r.rate, r.baseAmount)}
                      </span>
                    )}
                  </td>
                  <td className={tableCell}>
                    <span className="whitespace-nowrap">{methodWord(r.method)}</span>
                    {r.reference && (
                      <>
                        {' · '}
                        <span className="whitespace-nowrap">{r.reference}</span>
                      </>
                    )}
                  </td>
                  <td className={tableCell}>{r.paidBy ?? '—'}</td>
                  <td className={cn(tableCell, 'text-right')}>
                    {/* 0214: what the system recorded is undone where it was made */}
                    {!r.voided &&
                      (expenseGroup(r) === 'salaries' || r.periodId ? (
                        <span className="text-ink-3 inline-block min-w-24 text-[12px] whitespace-normal">
                          {t(
                            expenseGroup(r) === 'salaries'
                              ? r.kindCode === 'remittance'
                                ? 'accounts.expenses.undoOnTaxes'
                                : 'accounts.expenses.undoOnSalaries'
                              : 'accounts.expenses.undoOnTaxes',
                          )}
                        </span>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => void undo(r.id, r.label)}>
                          {t('accounts.expenses.void')}
                        </Button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

import { useState, type FormEvent } from 'react'
import {
  AlertTriangle,
  Banknote,
  CalendarCheck,
  Coins,
  Landmark,
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
import {
  SALARY_INTERVALS,
  useAccountsActions,
  useDailySalaryAlertCheck,
  useExpenses,
  useFinanceSummary,
  useSalaryOverview,
  type SalaryInterval,
  type SalaryPeriod,
  type SalaryPerson,
} from '@/lib/api/accounts'
import { useClinicInfo } from '@/lib/api/public'
import { useConfirm } from '@/lib/confirm'
import { kigaliToday } from '@/lib/clock'
import { navForUser } from '@/lib/nav'
import { usePeriod } from '@/lib/period'
import { financeMoneyReport, payrollReport } from '@/lib/reports/build'
import { cn } from '@/lib/utils'
import { CLINIC_PROFILE } from '@mmc/shared'

import { ACCOUNTS_TABS, type AccountsTab } from './accounts-tabs'

const METHODS = ['cash', 'momo', 'airtel', 'bank', 'card'] as const

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Finance (0179): the clinic's accounts for the cashier (the accountant) and the manager — the
 * money in by method against the money out (salaries, other expenses, stock bought) and the net;
 * the employees' salaries, every pay period of the year marked paid or not; the other expenses;
 * the printed reports in the clinic's template.
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
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
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
        {tab === 'expenses' && <ExpensesTab />}
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
        <ReportButtons
          build={() =>
            s ? financeMoneyReport(s, info?.profile ?? CLINIC_PROFILE, user, t, method) : null
          }
        />
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
              icon={Wallet}
              tint="amber"
              label={t('accounts.money.salaries')}
              value={Math.round(s.salaries)}
              unit="RWF"
            />
            <Kpi
              i={2}
              icon={Receipt}
              tint="violet"
              label={t('accounts.money.other')}
              value={Math.round(s.otherExpenses)}
              unit="RWF"
            />
            <Kpi
              i={3}
              icon={Banknote}
              tint="navy"
              label={t('accounts.money.stock')}
              value={Math.round(s.stockBought)}
              unit="RWF"
            />
            <Kpi
              i={4}
              icon={s.net >= 0 ? TrendingUp : TrendingDown}
              tint={s.net >= 0 ? 'mint' : 'coral'}
              label={t('accounts.money.net')}
              value={Math.round(s.net)}
              unit="RWF"
            />
            <Kpi
              i={5}
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
            <Panel i={1} icon={Coins} tint="teal" title={t('accounts.money.byMethod')}>
              {s.byMethod.length === 0 ? (
                <Empty icon={Coins}>{t('accounts.money.none')}</Empty>
              ) : (
                <table className="w-full border-collapse text-[14px]">
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
                        <td className={tableFirstCell}>{method(x.method)}</td>
                        <td className={cn(tableCell, 'text-right tabular-nums')}>{x.count}</td>
                        <td className={cn(tableCell, 'text-right font-semibold tabular-nums')}>
                          {formatRwf(x.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
            <Panel i={2} icon={CalendarCheck} tint="navy" title={t('accounts.money.byMonth')}>
              {s.byMonth.length === 0 ? (
                <Empty icon={CalendarCheck}>{t('accounts.money.none')}</Empty>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[14px]">
                    <thead className="bg-surface">
                      <tr className="border-border border-b">
                        <th className={tableHead}>{t('accounts.money.month')}</th>
                        <th className={cn(tableHead, 'text-right')}>
                          {t('accounts.money.revenue')}
                        </th>
                        <th className={cn(tableHead, 'text-right')}>
                          {t('accounts.money.salaries')}
                        </th>
                        <th className={cn(tableHead, 'text-right')}>{t('accounts.money.other')}</th>
                        <th className={cn(tableHead, 'text-right')}>{t('accounts.money.stock')}</th>
                        <th className={cn(tableHead, 'text-right')}>{t('accounts.money.net')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.byMonth.map((m) => {
                        const net = m.revenue - m.refunds - m.salaries - m.other - m.stock
                        return (
                          <tr key={m.month} className={tableRow}>
                            <td className={cn(tableFirstCell, 'whitespace-nowrap')}>{m.month}</td>
                            <td className={cn(tableCell, 'text-right tabular-nums')}>
                              {formatRwf(m.revenue - m.refunds)}
                            </td>
                            <td className={cn(tableCell, 'text-right tabular-nums')}>
                              {formatRwf(m.salaries)}
                            </td>
                            <td className={cn(tableCell, 'text-right tabular-nums')}>
                              {formatRwf(m.other)}
                            </td>
                            <td className={cn(tableCell, 'text-right tabular-nums')}>
                              {formatRwf(m.stock)}
                            </td>
                            <td
                              className={cn(
                                tableCell,
                                'text-right font-semibold tabular-nums',
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
          </div>
        </>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- the salaries */
const STATUS_TONE: Record<SalaryPeriod['status'], 'green' | 'red' | 'yellow' | 'grey'> = {
  paid: 'green',
  overdue: 'red',
  due: 'yellow',
  skipped: 'grey',
}

function SalariesTab({ user, initialYear }: { user: StaffUser; initialYear?: number }) {
  const { t } = useTranslation()
  const thisYear = Number(kigaliToday().slice(0, 4))
  const [year, setYear] = useState(initialYear ?? thisYear)
  const { data, error, isLoading } = useSalaryOverview(year)
  const { data: info } = useClinicInfo()
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [paying, setPaying] = useState<{ person: SalaryPerson; period: SalaryPeriod } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const years = [thisYear - 2, thisYear - 1, thisYear, thisYear + 1]
  const people = data?.people ?? []
  const overdueTotal = people.reduce((s, p) => s + p.overdue, 0)
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
        <ReportButtons
          build={() =>
            data ? payrollReport(data, info?.profile ?? CLINIC_PROFILE, user, t) : null
          }
        />
      </ActionRow>
      {error && <p className="text-red m-0 text-[14px] font-medium">{error.message}</p>}
      {msg && (
        <p
          className={cn(
            'm-0 rounded-md px-3 py-2 text-[14px] font-medium',
            msg.ok ? 'bg-green-bg text-green' : 'bg-red-bg text-red',
          )}
        >
          {msg.text}
        </p>
      )}
      <Panel i={1} icon={Wallet} tint="amber" title={t('accounts.salaries.title', { year })}>
        {isLoading ? null : people.length === 0 ? (
          <Empty icon={Wallet}>{t('accounts.salaries.none')}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[14px]">
              <thead className="bg-surface">
                <tr className="border-border border-b">
                  <th className={tableHead}>{t('accounts.salaries.cols.employee')}</th>
                  <th className={cn(tableHead, 'text-right')}>
                    {t('accounts.salaries.cols.amount')}
                  </th>
                  <th className={tableHead}>{t('accounts.salaries.cols.interval')}</th>
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
                  <PersonRows
                    key={p.id}
                    p={p}
                    open={open === p.id}
                    onToggle={() => setOpen(open === p.id ? null : p.id)}
                    onEdit={() => setEditing({ id: p.id, name: p.name })}
                    onPay={(period) => setPaying({ person: p, period })}
                    onMsg={setMsg}
                  />
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
                onClick={() => setEditing({ id: p.id, name: p.name })}
              >
                {p.name}
              </Button>
            ))}
          </div>
        )}
      </Panel>
      {editing && (
        <SalaryForm
          profileId={editing.id}
          name={editing.name}
          current={people.find((p) => p.id === editing.id) ?? null}
          onClose={() => setEditing(null)}
          onMsg={setMsg}
        />
      )}
      {paying && (
        <PayForm
          person={paying.person}
          period={paying.period}
          onClose={() => setPaying(null)}
          onMsg={setMsg}
        />
      )}
    </div>
  )
}

function PersonRows({
  p,
  open,
  onToggle,
  onEdit,
  onPay,
  onMsg,
}: {
  p: SalaryPerson
  open: boolean
  onToggle: () => void
  onEdit: () => void
  onPay: (period: SalaryPeriod) => void
  onMsg: (m: { ok: boolean; text: string }) => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { unpaySalary, skipSalary } = useAccountsActions()
  const method = (m: string | null) =>
    m ? t(`visit.payment.methods.${m}`, { defaultValue: m }) : ''
  const undo = async (period: SalaryPeriod) => {
    if (!period.id) return
    const why = await confirm({
      title: t('accounts.salaries.undoTitle', { name: p.name }),
      body: t('accounts.salaries.undoBody', { date: formatDate(new Date(period.dueOn)) }),
      confirmLabel: t('accounts.salaries.undoYes'),
      tone: 'danger',
      input: { label: t('accounts.salaries.reason'), required: true },
    })
    if (!why) return
    try {
      await unpaySalary.mutateAsync({ periodId: period.id, reason: String(why) })
      onMsg({ ok: true, text: t('accounts.salaries.undone') })
    } catch (e) {
      onMsg({ ok: false, text: errText(e) })
    }
  }
  const skip = async (period: SalaryPeriod) => {
    const why = await confirm({
      title: t('accounts.salaries.skipTitle', { name: p.name }),
      body: t('accounts.salaries.skipBody', { date: formatDate(new Date(period.dueOn)) }),
      confirmLabel: t('accounts.salaries.skipYes'),
      input: { label: t('accounts.salaries.reason'), required: true },
    })
    if (!why) return
    try {
      await skipSalary.mutateAsync({
        profileId: p.id,
        periodStart: period.periodStart,
        reason: String(why),
      })
      onMsg({ ok: true, text: t('accounts.salaries.skipped') })
    } catch (e) {
      onMsg({ ok: false, text: errText(e) })
    }
  }
  return (
    <>
      <tr className={tableRow}>
        <td className={tableFirstCell}>
          {p.name}
          <span className="text-ink-3 block text-[12px]">
            {t(`staff.roles.${p.role}`, { defaultValue: p.role })}
            {p.staffId ? ` · ${p.staffId}` : ''}
          </span>
        </td>
        <td className={cn(tableCell, 'text-right font-semibold tabular-nums')}>
          {formatRwf(p.amount)}
        </td>
        <td className={tableCell}>
          {t(`accounts.intervals.${p.intervalKind}`)}
          <span className="text-ink-3 block text-[12px]">
            {t('accounts.salaries.from', { date: formatDate(new Date(p.anchorOn)) })}
            {p.payDay ? ` · ${t('accounts.salaries.payDay', { day: p.payDay })}` : ''}
          </span>
        </td>
        <td className={tableCell}>
          {p.nextDue ? formatDate(new Date(p.nextDue)) : '—'}
          {p.overdue > 0 && (
            <Badge tone="red" className="ml-2">
              {t('accounts.salaries.overdueCount', { count: p.overdue })}
            </Badge>
          )}
        </td>
        <td className={cn(tableCell, 'text-right tabular-nums')}>{formatRwf(p.paidThisYear)}</td>
        <td className={tableCell}>
          <span className="flex flex-wrap gap-1">
            {p.periods.map((x) => (
              <Badge key={x.periodStart} tone={STATUS_TONE[x.status]}>
                {formatDate(new Date(x.periodStart)).slice(3, 5)}
              </Badge>
            ))}
          </span>
        </td>
        <td className={cn(tableCell, 'whitespace-nowrap')}>
          <Button size="sm" variant="tint-blue" onClick={onToggle}>
            {open ? t('accounts.salaries.hide') : t('accounts.salaries.show')}
          </Button>
          <Button size="sm" variant="ghost" className="ml-1" onClick={onEdit}>
            {t('accounts.salaries.edit')}
          </Button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} className="bg-surface px-3 py-2">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-border border-b">
                  <th className={tableHead}>{t('accounts.salaries.cols.period')}</th>
                  <th className={tableHead}>{t('accounts.salaries.cols.dueOn')}</th>
                  <th className={cn(tableHead, 'text-right')}>
                    {t('accounts.salaries.cols.amount')}
                  </th>
                  <th className={tableHead}>{t('accounts.salaries.cols.status')}</th>
                  <th className={tableHead}>{t('accounts.salaries.cols.paid')}</th>
                  <th className={tableHead}></th>
                </tr>
              </thead>
              <tbody>
                {p.periods.map((x) => (
                  <tr key={x.periodStart} className={tableRow}>
                    <td className={cn(tableCell, 'whitespace-nowrap')}>
                      {formatDate(new Date(x.periodStart))} – {formatDate(new Date(x.periodEnd))}
                    </td>
                    <td className={cn(tableCell, 'whitespace-nowrap')}>
                      {formatDate(new Date(x.dueOn))}
                    </td>
                    <td className={cn(tableCell, 'text-right tabular-nums')}>
                      {formatRwf(x.paidAmount ?? x.amount)}
                    </td>
                    <td className={tableCell}>
                      <Badge tone={STATUS_TONE[x.status]}>{t(`accounts.status.${x.status}`)}</Badge>
                    </td>
                    <td className={tableCell}>
                      {x.status === 'paid'
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
                          : ''}
                    </td>
                    <td className={cn(tableCell, 'text-right whitespace-nowrap')}>
                      {x.status === 'due' || x.status === 'overdue' ? (
                        <>
                          <Button size="sm" variant="primary" onClick={() => onPay(x)}>
                            <CalendarCheck size={14} aria-hidden="true" />
                            {t('accounts.salaries.markPaid')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="ml-1"
                            onClick={() => void skip(x)}
                          >
                            {t('accounts.salaries.skip')}
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" variant="tint-grey" onClick={() => void undo(x)}>
                          <Undo2 size={14} aria-hidden="true" />
                          {t('accounts.salaries.undo')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
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
  onMsg: (m: { ok: boolean; text: string }) => void
}) {
  const { t } = useTranslation()
  const { setSalary, removeSalary } = useAccountsActions()
  const confirm = useConfirm()
  const [amount, setAmount] = useState(current ? String(current.amount) : '')
  const [interval, setInterval] = useState<SalaryInterval>(current?.intervalKind ?? 'monthly')
  const [anchor, setAnchor] = useState(current?.anchorOn ?? kigaliToday())
  const [payDay, setPayDay] = useState(current?.payDay ? String(current.payDay) : '')
  const [note, setNote] = useState(current?.note ?? '')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const a = Number(amount)
    if (!Number.isFinite(a) || a < 0)
      return onMsg({ ok: false, text: t('accounts.salaries.errors.amount') })
    if (!anchor) return onMsg({ ok: false, text: t('accounts.salaries.errors.anchor') })
    try {
      await setSalary.mutateAsync({
        profileId,
        amount: Math.round(a),
        interval,
        anchorOn: anchor,
        payDay: payDay ? Number(payDay) : null,
        note,
      })
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
    <Panel i={2} icon={Wallet} tint="amber" title={t('accounts.salaries.setTitle', { name })}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label={t('accounts.salaries.cols.amount')}
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
          />
          <Select
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
    </Panel>
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
  onMsg: (m: { ok: boolean; text: string }) => void
}) {
  const { t } = useTranslation()
  const { paySalary } = useAccountsActions()
  const [paidOn, setPaidOn] = useState(kigaliToday())
  const [amount, setAmount] = useState(String(period.amount))
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
    <Panel
      i={3}
      icon={CalendarCheck}
      tint="mint"
      title={t('accounts.salaries.payTitle', {
        name: person.name,
        period: `${formatDate(new Date(period.periodStart))} – ${formatDate(new Date(period.periodEnd))}`,
      })}
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label={t('accounts.salaries.paidOn')}
            type="date"
            value={paidOn}
            max={kigaliToday()}
            onChange={(e) => setPaidOn(e.target.value)}
          />
          <Field
            label={t('accounts.salaries.paidAmount')}
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
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" type="submit" loading={paySalary.isPending}>
            <CalendarCheck size={16} aria-hidden="true" />
            {t('accounts.salaries.markPaid')}
          </Button>
          <Button onClick={onClose}>{t('accounts.cancel')}</Button>
        </div>
      </form>
    </Panel>
  )
}

/* ---------------------------------------------------------------- other expenses */
function ExpensesTab() {
  const { t } = useTranslation()
  const period = usePeriod('month')
  const { data: rows = [], error } = useExpenses(period.from, period.to)
  const { addExpense, voidExpense } = useAccountsActions()
  const confirm = useConfirm()
  const [label, setLabel] = useState('')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<string>('cash')
  const [reference, setReference] = useState('')
  const [paidOn, setPaidOn] = useState(kigaliToday())
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const methodWord = (m: string) => t(`visit.payment.methods.${m}`, { defaultValue: m })
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const a = Number(amount)
    if (label.trim().length < 2)
      return setMsg({ ok: false, text: t('accounts.expenses.errors.label') })
    if (!Number.isFinite(a) || a <= 0)
      return setMsg({ ok: false, text: t('accounts.expenses.errors.amount') })
    try {
      await addExpense.mutateAsync({
        label: label.trim(),
        amount: Math.round(a),
        method,
        reference,
        paidOn,
        note,
      })
      setMsg({ ok: true, text: t('accounts.expenses.added') })
      setLabel('')
      setAmount('')
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
    if (!why) return
    try {
      await voidExpense.mutateAsync({ id, reason: String(why) })
      setMsg({ ok: true, text: t('accounts.expenses.voided') })
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  const total = rows.filter((r) => !r.voided).reduce((s, r) => s + r.amount, 0)
  return (
    <div className="flex flex-col gap-4">
      <ActionRow>
        <PeriodSeg period={period} className="max-w-full flex-wrap" />
        <BannerChip icon={Receipt}>
          {t('accounts.expenses.total', { amount: formatRwf(total) })}
        </BannerChip>
      </ActionRow>
      <PeriodCustom period={period} />
      {error && <p className="text-red m-0 text-[14px] font-medium">{error.message}</p>}
      {msg && (
        <p
          className={cn(
            'm-0 rounded-md px-3 py-2 text-[14px] font-medium',
            msg.ok ? 'bg-green-bg text-green' : 'bg-red-bg text-red',
          )}
        >
          {msg.text}
        </p>
      )}
      <Panel i={1} icon={Receipt} tint="violet" title={t('accounts.expenses.add')}>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field
              wrapperClassName="lg:col-span-2"
              label={t('accounts.expenses.label')}
              placeholder={t('accounts.expenses.labelPh')}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <Field
              label={t('report.cols.amount')}
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
              label={t('accounts.expenses.paidOn')}
              type="date"
              value={paidOn}
              max={kigaliToday()}
              onChange={(e) => setPaidOn(e.target.value)}
            />
          </div>
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
      {rows.length === 0 ? (
        <Empty icon={Receipt}>{t('accounts.expenses.none')}</Empty>
      ) : (
        <div className="border-border bg-card overflow-x-auto rounded-md border">
          <table className="w-full border-collapse text-[14px]">
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
              {rows.map((r) => (
                <tr key={r.id} className={cn(tableRow, r.voided && 'opacity-60')}>
                  <td className={cn(tableFirstCell, 'whitespace-nowrap')}>
                    {formatDate(new Date(r.paidOn))}
                  </td>
                  <td className={tableCell}>
                    {r.label}
                    {r.voided && (
                      <span className="text-red block text-[12px]">
                        {t('accounts.expenses.voidedTag', { why: r.voidReason ?? '' })}
                      </span>
                    )}
                  </td>
                  <td className={tableCell}>{t(`accounts.expenses.kinds.${r.kind}`)}</td>
                  <td
                    className={cn(
                      tableCell,
                      'text-right font-semibold tabular-nums',
                      r.voided && 'line-through',
                    )}
                  >
                    {formatRwf(r.amount)}
                  </td>
                  <td className={tableCell}>
                    {methodWord(r.method)}
                    {r.reference ? ` · ${r.reference}` : ''}
                  </td>
                  <td className={tableCell}>{r.paidBy ?? '—'}</td>
                  <td className={cn(tableCell, 'text-right')}>
                    {!r.voided && r.kind === 'other' && (
                      <Button size="sm" variant="ghost" onClick={() => void undo(r.id, r.label)}>
                        {t('accounts.expenses.void')}
                      </Button>
                    )}
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

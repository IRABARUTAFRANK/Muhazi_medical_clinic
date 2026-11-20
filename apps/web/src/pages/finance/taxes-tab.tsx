import { useState, type FormEvent } from 'react'
import { CalendarCheck, Eye, Percent, Plus, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLINIC_PROFILE, formatDate, formatRwf, type StaffUser } from '@mmc/shared'
import { Empty, Panel } from '@/components/dash/kit'
import { tableCell, tableFirstCell, tableHead, tableRow } from '@/components/dash/kit-style'
import { ActionRow } from '@/components/dash/page-banner'
import { ReportButtons } from '@/components/dash/report-buttons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { SidePanel } from '@/components/ui/side-panel'
import {
  CUSTOM_UNITS,
  RATE_BASES,
  SALARY_INTERVALS,
  TAX_HOWS,
  TAX_KINDS,
  cleanPercent,
  defaultRateBase,
  intervalWords,
  rateWorkWords,
  taxHowOf,
  taxHowWords,
  useAccountsActions,
  useTaxOverview,
  workedOut,
  type CustomUnit,
  type RateBase,
  type SalaryInterval,
  type Tax,
  type TaxHow,
  type TaxKind,
  type TaxPeriod,
} from '@/lib/api/accounts'
import { useClinicInfo } from '@/lib/api/public'
import { useConfirm } from '@/lib/confirm'
import { kigaliToday } from '@/lib/clock'
import { taxesReport } from '@/lib/reports/build'
import { cn } from '@/lib/utils'
import { Note, PanelForm, ReportsLink } from './accounts-kit'
import { METHODS, STATUSES, STATUS_TONE, errText, type Msg } from './accounts-tabs'
import { RemittancesPanel } from './remittances-panel'
import { TaxBasePanel } from './tax-base-panel'

/**
 * Taxes (0184): the taxes the clinic pays, each with its schedule (monthly, quarterly, yearly,
 * custom…) and every period of the year marked paid or not, like the salaries. How much (0194):
 * a fixed amount, a percentage (of the result before tax of the period, of all money in during
 * the period, or of an amount typed when paying — worked out by the database for each period,
 * "so far" while it runs, the figure correctable when paying), or typed when paying. A tax paid
 * is an expense of kind tax (a tax kept by the payer is a credit). The list is compact: one row
 * per tax, one View button; the tax's side panel holds the periods and every action.
 */
export function TaxesTab({ user, initialYear }: { user: StaffUser; initialYear?: number }) {
  const { t } = useTranslation()
  const thisYear = Number(kigaliToday().slice(0, 4))
  const [year, setYear] = useState(initialYear ?? thisYear)
  const { data, error, isLoading } = useTaxOverview(year)
  const { data: info } = useClinicInfo()
  // the tax opened, or 'new' for one being added
  const [who, setWho] = useState<string | null>(null)
  const [msg, setMsg] = useState<Msg | null>(null)
  const years = [thisYear - 2, thisYear - 1, thisYear, thisYear + 1]
  const taxes = data?.taxes ?? []
  const overdueTotal = taxes.reduce((s, x) => s + x.overdue, 0)
  const current = who && who !== 'new' ? (taxes.find((x) => x.id === who) ?? null) : null
  return (
    <div className="flex flex-col gap-4">
      <ActionRow>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink-2 text-[13px] font-semibold">{t('accounts.taxes.year')}</span>
          <select
            aria-label={t('accounts.taxes.year')}
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
          <Button
            variant="primary"
            onClick={() => {
              setMsg(null)
              setWho('new')
            }}
          >
            <Plus size={16} aria-hidden="true" />
            {t('accounts.taxes.add')}
          </Button>
          <ReportsLink id="finance.taxes" />
          <ReportButtons
            build={() =>
              data ? taxesReport(data, info?.profile ?? CLINIC_PROFILE, user, t) : null
            }
          />
        </div>
      </ActionRow>
      {error && <p className="text-red m-0 text-[14px] font-medium">{error.message}</p>}
      {msg && !who && <Note msg={msg} />}
      <Panel i={1} icon={Percent} tint="violet" title={t('accounts.taxes.title', { year })}>
        {isLoading ? null : taxes.length === 0 ? (
          <Empty icon={Percent}>{t('accounts.taxes.none')}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[14px]">
              <thead className="bg-surface">
                <tr className="border-border border-b">
                  <th className={tableHead}>{t('accounts.taxes.cols.tax')}</th>
                  <th className={tableHead}>{t('accounts.taxes.cols.howMuch')}</th>
                  <th className={tableHead}>{t('accounts.salaries.cols.nextDue')}</th>
                  <th className={cn(tableHead, 'text-right')}>
                    {t('accounts.salaries.cols.paidYear')}
                  </th>
                  <th className={tableHead}>{t('accounts.salaries.cols.periods')}</th>
                  <th className={tableHead}></th>
                </tr>
              </thead>
              <tbody>
                {taxes.map((x, i) => {
                  // 0194: a percentage tax: the amount of the next period to pay, from its figures
                  const next =
                    x.rate != null && x.nextDue
                      ? x.periods.find(
                          (p) =>
                            p.dueOn === x.nextDue && (p.status === 'due' || p.status === 'overdue'),
                        )
                      : undefined
                  return (
                    <tr key={x.id} className={tableRow}>
                      <td className={tableFirstCell}>
                        {(i === 0 || taxes[i - 1]?.kind !== x.kind) && (
                          <span className="text-violet mb-0.5 block text-[11px] font-semibold tracking-wide uppercase">
                            {t(`accounts.taxes.kinds.${x.kind}`)}
                          </span>
                        )}
                        {x.name}
                        {x.note && <span className="text-ink-3 block text-[12px]">{x.note}</span>}
                      </td>
                      <td className={cn(tableCell, 'min-w-44 font-semibold tabular-nums')}>
                        {taxHowWords(t, x)}
                        <span className="text-ink-3 block text-[12px] font-normal">
                          {intervalWords(t, x.intervalKind, x.customEvery, x.customUnit)}
                        </span>
                      </td>
                      <td className={cn(tableCell, 'whitespace-nowrap')}>
                        {x.nextDue ? formatDate(new Date(x.nextDue)) : '—'}
                        {x.overdue > 0 && (
                          <Badge tone="red" className="ml-2">
                            {t('accounts.salaries.overdueCount', { count: x.overdue })}
                          </Badge>
                        )}
                        {next?.amount != null && (
                          <span className="text-ink-2 block text-[12px] tabular-nums">
                            {formatRwf(next.amount)}
                            {next.running ? ` ${t('accounts.taxes.soFar')}` : ''}
                          </span>
                        )}
                      </td>
                      <td className={cn(tableCell, 'text-right tabular-nums')}>
                        {formatRwf(x.paidThisYear)}
                      </td>
                      <td className={tableCell}>
                        <span className="flex flex-wrap gap-1">
                          {STATUSES.map((s) => {
                            const n = x.periods.filter((p) => p.status === s).length
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
                            setWho(x.id)
                          }}
                        >
                          <Eye size={14} aria-hidden="true" />
                          {t('accounts.salaries.view')}
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-ink-3 m-0 pt-2 text-[13px]">{t('accounts.taxes.oneOffHint')}</p>
      </Panel>
      <RemittancesPanel i={2} year={year} />
      <TaxBasePanel i={3} />
      {who && (who === 'new' || current) && (
        <TaxPanel
          key={who}
          tax={current}
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

/** One tax: what is set, the periods of the year and the actions; or the form of a new tax. */
function TaxPanel({
  tax,
  msg,
  onMsg,
  onClose,
}: {
  tax: Tax | null
  msg: Msg | null
  onMsg: (m: Msg) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { unpayTax, skipTax } = useAccountsActions()
  const [editing, setEditing] = useState(!tax)
  const [paying, setPaying] = useState<TaxPeriod | null>(null)
  const method = (m: string | null) =>
    m ? t(`visit.payment.methods.${m}`, { defaultValue: m }) : ''
  const name = tax?.name ?? t('accounts.taxes.newTitle')
  const undo = async (period: TaxPeriod) => {
    if (!period.id) return
    const why = await confirm({
      title: t('accounts.taxes.undoTitle', { name }),
      body: t('accounts.salaries.undoBody', { date: formatDate(new Date(period.dueOn)) }),
      confirmLabel: t('accounts.salaries.undoYes'),
      tone: 'danger',
      input: { label: t('accounts.salaries.reason'), required: true },
    })
    if (!why.ok) return
    try {
      await unpayTax.mutateAsync({ periodId: period.id, reason: why.value })
      onMsg({ ok: true, text: t('accounts.salaries.undone') })
    } catch (e) {
      onMsg({ ok: false, text: errText(e) })
    }
  }
  const skip = async (period: TaxPeriod) => {
    if (!tax) return
    const why = await confirm({
      title: t('accounts.taxes.skipTitle', { name }),
      body: t('accounts.taxes.skipBody', { date: formatDate(new Date(period.dueOn)) }),
      confirmLabel: t('accounts.salaries.skipYes'),
      input: { label: t('accounts.salaries.reason'), required: true },
    })
    if (!why.ok) return
    try {
      await skipTax.mutateAsync({
        taxId: tax.id,
        periodStart: period.periodStart,
        reason: why.value,
      })
      setPaying(null)
      onMsg({ ok: true, text: t('accounts.salaries.skipped') })
    } catch (e) {
      onMsg({ ok: false, text: errText(e) })
    }
  }
  return (
    <SidePanel
      open
      onClose={onClose}
      hue="violet"
      icon={Percent}
      title={name}
      subtitle={
        tax
          ? `${t(`accounts.taxes.kinds.${tax.kind}`)} · ${intervalWords(t, tax.intervalKind, tax.customEvery, tax.customUnit)}`
          : undefined
      }
      tags={
        tax && tax.overdue > 0 ? (
          <Badge tone="red">{t('accounts.salaries.overdueCount', { count: tax.overdue })}</Badge>
        ) : undefined
      }
      actions={
        tax && !editing ? (
          <Button
            size="sm"
            variant="tint-violet"
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
        {tax && !editing && (
          <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 text-[14px] sm:grid-cols-3">
            <div>
              <dt className="text-ink-3 text-[12px]">{t('accounts.taxes.cols.howMuch')}</dt>
              <dd className="m-0 font-semibold tabular-nums">{taxHowWords(t, tax)}</dd>
            </div>
            <div>
              <dt className="text-ink-3 text-[12px]">{t('accounts.salaries.cols.interval')}</dt>
              <dd className="m-0">
                {intervalWords(t, tax.intervalKind, tax.customEvery, tax.customUnit)}
                {tax.payDay ? ` · ${t('accounts.salaries.payDay', { day: tax.payDay })}` : ''}
              </dd>
            </div>
            <div>
              <dt className="text-ink-3 text-[12px]">{t('accounts.taxes.anchor')}</dt>
              <dd className="m-0">{formatDate(new Date(tax.anchorOn))}</dd>
            </div>
            <div>
              <dt className="text-ink-3 text-[12px]">{t('accounts.salaries.cols.paidYear')}</dt>
              <dd className="m-0 tabular-nums">{formatRwf(tax.paidThisYear)}</dd>
            </div>
            <div>
              <dt className="text-ink-3 text-[12px]">{t('accounts.salaries.cols.nextDue')}</dt>
              <dd className="m-0">{tax.nextDue ? formatDate(new Date(tax.nextDue)) : '—'}</dd>
            </div>
            {tax.note && (
              <div>
                <dt className="text-ink-3 text-[12px]">{t('accounts.salaries.note')}</dt>
                <dd className="m-0">{tax.note}</dd>
              </div>
            )}
          </dl>
        )}
        {editing && (
          <TaxForm
            current={tax}
            onClose={() => (tax ? setEditing(false) : onClose())}
            onMsg={onMsg}
          />
        )}
        {paying && tax && !editing && (
          <TaxPayForm
            key={paying.periodStart}
            tax={tax}
            period={paying}
            onClose={() => setPaying(null)}
            onMsg={onMsg}
          />
        )}
        {tax && !editing && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead className="bg-surface">
                <tr className="border-border border-b">
                  <th className={tableHead}>{t('accounts.salaries.cols.period')}</th>
                  <th className={tableHead}>{t('accounts.salaries.cols.dueOn')}</th>
                  <th className={cn(tableHead, 'text-right')}>{t('accounts.taxes.cols.amount')}</th>
                  <th className={tableHead}>{t('accounts.salaries.cols.status')}</th>
                  <th className={tableHead}></th>
                </tr>
              </thead>
              <tbody>
                {tax.periods.map((x) => {
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
                  const amount = x.paidAmount ?? x.amount
                  // 0194: how a percentage period was (or is being) worked out
                  const work =
                    x.rate == null
                      ? []
                      : x.baseAmount != null && x.baseAmount < 0 && !x.id
                        ? [t('accounts.taxes.loss')]
                        : [
                            // no figure yet (not started, or typed when paying): the amount is "—"
                            x.baseAmount != null
                              ? rateWorkWords(t, x.rate, x.baseAmount) +
                                (x.running ? ` · ${t('accounts.taxes.soFar')}` : '')
                              : null,
                            x.status === 'paid' &&
                            x.paidAmount != null &&
                            x.workedOut != null &&
                            x.paidAmount !== x.workedOut
                              ? t('accounts.taxes.workedOutWas', {
                                  amount: formatRwf(x.workedOut),
                                })
                              : null,
                          ].filter((w): w is string => !!w)
                  return (
                    <tr key={x.periodStart} className={cn(tableRow, here && 'bg-yellow-bg')}>
                      <td className={cn(tableFirstCell, 'whitespace-nowrap')}>
                        {formatDate(new Date(x.periodStart))} – {formatDate(new Date(x.periodEnd))}
                      </td>
                      <td className={cn(tableCell, 'whitespace-nowrap')}>
                        {formatDate(new Date(x.dueOn))}
                      </td>
                      <td className={cn(tableCell, 'text-right tabular-nums')}>
                        <span className="whitespace-nowrap">
                          {amount == null ? '—' : formatRwf(amount)}
                        </span>
                        {work.map((w) => (
                          <span key={w} className="text-ink-3 block text-[12px]">
                            {w}
                          </span>
                        ))}
                      </td>
                      <td className={tableCell}>
                        <Badge tone={STATUS_TONE[x.status]}>
                          {t(`accounts.status.${x.status}`)}
                        </Badge>
                        {detail && <span className="text-ink-3 block text-[12px]">{detail}</span>}
                      </td>
                      <td className={cn(tableCell, 'text-right whitespace-nowrap')}>
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

function TaxForm({
  current,
  onClose,
  onMsg,
}: {
  current: Tax | null
  onClose: () => void
  onMsg: (m: Msg) => void
}) {
  const { t } = useTranslation()
  const { setTax, removeTax } = useAccountsActions()
  const confirm = useConfirm()
  const [name, setName] = useState(current?.name ?? '')
  const [kind, setKind] = useState<TaxKind>(current?.kind ?? 'other')
  // 0194: how much: a fixed amount (a new tax starts there), a percentage, or typed when paying
  const [how, setHow] = useState<TaxHow>(current ? taxHowOf(current) : 'fixed')
  const [amount, setAmount] = useState(current?.amount != null ? String(current.amount) : '')
  const [rate, setRate] = useState(current?.rate != null ? String(current.rate) : '')
  // what the percentage is taken from: follows the kind until the accountant chooses
  const [rateBase, setRateBase] = useState<RateBase>(
    current?.rateBase ?? defaultRateBase(current?.kind ?? 'other'),
  )
  const [baseTouched, setBaseTouched] = useState(current?.rateBase != null)
  const [interval, setInterval] = useState<SalaryInterval>(current?.intervalKind ?? 'monthly')
  const [every, setEvery] = useState(current?.customEvery ? String(current.customEvery) : '')
  const [unit, setUnit] = useState<CustomUnit>(current?.customUnit ?? 'days')
  const [anchor, setAnchor] = useState(current?.anchorOn ?? `${kigaliToday().slice(0, 4)}-01-01`)
  const [payDay, setPayDay] = useState(current?.payDay ? String(current.payDay) : '')
  const [note, setNote] = useState(current?.note ?? '')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (name.trim().length < 2) return onMsg({ ok: false, text: t('accounts.taxes.errors.name') })
    const a = Number(amount)
    if (how === 'fixed' && (amount === '' || !Number.isFinite(a) || a < 0))
      return onMsg({ ok: false, text: t('accounts.taxes.errors.amount') })
    const r = Number(rate)
    if (how === 'percent' && (rate === '' || !Number.isFinite(r) || r <= 0 || r > 100))
      return onMsg({ ok: false, text: t('accounts.taxes.errors.rate') })
    if (!anchor) return onMsg({ ok: false, text: t('accounts.taxes.errors.anchor') })
    const n = Number(every)
    if (interval === 'custom' && (!Number.isInteger(n) || n < 1 || n > 365))
      return onMsg({ ok: false, text: t('accounts.salaries.errors.custom') })
    try {
      await setTax.mutateAsync({
        id: current?.id ?? null,
        name: name.trim(),
        kind,
        amount: how === 'fixed' ? Math.round(a) : null,
        rate: how === 'percent' ? r : null,
        rateBase: how === 'percent' ? rateBase : null,
        interval,
        customEvery: interval === 'custom' ? n : null,
        customUnit: interval === 'custom' ? unit : null,
        anchorOn: anchor,
        payDay: payDay ? Number(payDay) : null,
        note,
      })
      onMsg({ ok: true, text: t('accounts.taxes.saved', { name: name.trim() }) })
      onClose()
    } catch (err) {
      onMsg({ ok: false, text: errText(err) })
    }
  }
  const remove = async () => {
    if (!current) return
    if (
      !(await confirm({
        title: t('accounts.taxes.removeTitle', { name: current.name }),
        body: t('accounts.taxes.removeBody'),
        confirmLabel: t('accounts.salaries.removeYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await removeTax.mutateAsync(current.id)
      onMsg({ ok: true, text: t('accounts.taxes.removed', { name: current.name }) })
      onClose()
    } catch (err) {
      onMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <PanelForm
      title={
        current
          ? t('accounts.taxes.setTitle', { name: current.name })
          : t('accounts.taxes.newTitle')
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label={t('accounts.taxes.name')}
            placeholder={t('accounts.taxes.namePh')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Select
            label={t('accounts.taxes.kindField')}
            value={kind}
            onChange={(e) => {
              const k = e.target.value as TaxKind
              setKind(k)
              if (!baseTouched) setRateBase(defaultRateBase(k))
            }}
          >
            {TAX_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`accounts.taxes.kinds.${k}`)}
              </option>
            ))}
          </Select>
          <p className="text-ink-3 m-0 text-[13px] sm:col-span-2">
            {t(`accounts.taxes.kindHints.${kind}`)} {t('accounts.taxes.kindRule')}
          </p>
          <div className="border-border bg-card flex flex-col gap-2 rounded-md border p-3 sm:col-span-2">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Select
                label={t('accounts.taxes.howField')}
                value={how}
                onChange={(e) => setHow(e.target.value as TaxHow)}
              >
                {TAX_HOWS.map((h) => (
                  <option key={h} value={h}>
                    {t(`accounts.taxes.how.${h}`)}
                  </option>
                ))}
              </Select>
              {how === 'fixed' && (
                <Field
                  label={t('accounts.taxes.fixedField')}
                  inputMode="numeric"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, '').slice(0, 9))}
                />
              )}
              {how === 'percent' && (
                <Field
                  label={t('accounts.taxes.rateField')}
                  inputMode="decimal"
                  placeholder="28"
                  value={rate}
                  onChange={(e) => setRate(cleanPercent(e.target.value))}
                />
              )}
              {how === 'percent' && (
                <Select
                  wrapperClassName="sm:col-span-2"
                  label={t('accounts.taxes.baseField')}
                  value={rateBase}
                  onChange={(e) => {
                    setRateBase(e.target.value as RateBase)
                    setBaseTouched(true)
                  }}
                >
                  {RATE_BASES.map((b) => (
                    <option key={b} value={b}>
                      {t(`accounts.taxes.bases.${b}`)}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            <p className="text-ink-3 m-0 text-[13px]">{t(`accounts.taxes.howHints.${how}`)}</p>
            {how === 'percent' && (
              <p className="text-ink-3 m-0 text-[13px]">
                {t(`accounts.taxes.baseHints.${rateBase}`)}
              </p>
            )}
            {how === 'percent' && Number(rate) > 0 && (
              <p className="text-ink m-0 text-[14px] font-semibold">
                {rateBase === 'typed'
                  ? t('accounts.taxes.rateMeansTyped', { rate: Number(rate) })
                  : t('accounts.taxes.rateMeans', {
                      rate: Number(rate),
                      base: t(`accounts.taxes.baseWords.${rateBase}`),
                    })}
              </p>
            )}
          </div>
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
            label={t('accounts.taxes.anchor')}
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
        <p className="text-ink-3 m-0 text-[13px]">{t('accounts.taxes.setHint')}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" type="submit" loading={setTax.isPending}>
            {t('accounts.taxes.save')}
          </Button>
          <Button onClick={onClose}>{t('accounts.cancel')}</Button>
          {current && (
            <Button variant="tint-coral" className="ml-auto" onClick={() => void remove()}>
              {t('accounts.taxes.remove')}
            </Button>
          )}
        </div>
      </form>
    </PanelForm>
  )
}

function TaxPayForm({
  tax,
  period,
  onClose,
  onMsg,
}: {
  tax: Tax
  period: TaxPeriod
  onClose: () => void
  onMsg: (m: Msg) => void
}) {
  const { t } = useTranslation()
  const { payTax } = useAccountsActions()
  // 0194: a percentage: the figure it is taken from (the period's own, or typed), the working,
  // and the amount paid following the amount worked out until the accountant types over it
  const rate = tax.rate
  const pct = rate != null
  const figure = period.baseAmount
  const [base, setBase] = useState(figure == null ? '' : String(figure))
  const [paidOn, setPaidOn] = useState(kigaliToday())
  const [amount, setAmount] = useState(period.amount == null ? '' : String(period.amount))
  const [amountTyped, setAmountTyped] = useState(false)
  const [method, setMethod] = useState<string>('bank')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const baseNum = base === '' ? null : Number(base)
  const calc = pct && baseNum != null && Number.isFinite(baseNum) ? workedOut(baseNum, rate) : null
  const changeBase = (v: string) => {
    setBase(v)
    if (!amountTyped && rate != null) setAmount(v === '' ? '' : String(workedOut(Number(v), rate)))
  }
  const baseHint = !pct
    ? null
    : figure == null || tax.rateBase === 'typed'
      ? t('accounts.taxes.baseToType')
      : base !== String(figure)
        ? t('accounts.taxes.baseChanged', { amount: formatRwf(figure) })
        : t('accounts.taxes.baseFromFigures') +
          (period.running ? ` · ${t('accounts.taxes.soFar')}` : '')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const a = Number(amount)
    if (pct && base === '' && amount === '')
      return onMsg({ ok: false, text: t('accounts.taxes.errors.base') })
    if (!amount || !Number.isFinite(a) || a <= 0)
      return onMsg({ ok: false, text: t('accounts.taxes.errors.paid') })
    try {
      await payTax.mutateAsync({
        taxId: tax.id,
        periodStart: period.periodStart,
        paidOn,
        amount: Math.round(a),
        method,
        reference,
        note,
        // the figure as shown (a loss is left to the database's own figure)
        baseAmount: pct && baseNum != null && baseNum >= 0 ? Math.round(baseNum) : null,
      })
      onMsg({
        ok: true,
        text: t(tax.kind === 'withheld' ? 'accounts.taxes.creditOk' : 'accounts.taxes.paidOk', {
          name: tax.name,
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
        name: tax.name,
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
          {pct && (
            <div className="flex flex-col gap-1">
              <Field
                label={t('accounts.taxes.cols.base')}
                inputMode="numeric"
                value={base}
                onChange={(e) => changeBase(e.target.value.replace(/[^\d]/g, '').slice(0, 12))}
              />
              {baseHint && <span className="text-ink-3 text-[12px]">{baseHint}</span>}
            </div>
          )}
          {pct && baseNum != null && Number.isFinite(baseNum) && (
            <p className="text-ink m-0 self-center text-[14px] font-semibold sm:col-span-2">
              {baseNum < 0
                ? t('accounts.taxes.payLoss')
                : t('accounts.taxes.payWork', {
                    rate,
                    base: formatRwf(baseNum),
                    amount: formatRwf(calc ?? 0),
                  })}
            </p>
          )}
          <Field
            label={t('accounts.salaries.paidAmount')}
            inputMode="numeric"
            placeholder={period.amount == null ? t('accounts.taxes.amountYouWorkedOut') : undefined}
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value.replace(/[^\d]/g, ''))
              setAmountTyped(true)
            }}
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
          <Button variant="primary" type="submit" loading={payTax.isPending}>
            <CalendarCheck size={16} aria-hidden="true" />
            {t('accounts.salaries.markPaid')}
          </Button>
          <Button onClick={onClose}>{t('accounts.cancel')}</Button>
        </div>
      </form>
    </PanelForm>
  )
}

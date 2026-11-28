import { useEffect, useState, type FormEvent } from 'react'
import { Calculator, CalendarClock, History, Percent, Plus, Scissors } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf } from '@mmc/shared'
import { Empty, Panel } from '@/components/dash/kit'
import { tableCell, tableFirstCell, tableHead, tableRow } from '@/components/dash/kit-style'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import {
  AGENCIES,
  PAYE_MODES,
  cleanPercent,
  deductionName,
  rateWords,
  useAccountsActions,
  useDeductions,
  usePayslipPreview,
  useSalaryOverview,
  type Agency,
  type DeductionRate,
  type DeductionRule,
  type PayeMode,
  type PayeSet,
} from '@/lib/api/accounts'
import { useConfirm } from '@/lib/confirm'
import { kigaliToday } from '@/lib/clock'
import { payeWith, setOn } from '@/lib/payslip'
import { cn } from '@/lib/utils'
import { Note, PanelForm } from './accounts-kit'
import { errText, figureAmount, figureLabel, type Msg } from './accounts-tabs'

/** A share as typed (0194): a percentage takes a comma as the decimal mark ('0,5' → 0.5); a
 *  fixed amount is whole francs. */
const shareInput = (kind: 'rate' | 'amount', v: string) =>
  kind === 'rate' ? cleanPercent(v) : v.replace(/[^\d]/g, '').slice(0, 9)

/** In force today, still to come, or replaced by a later date. */
type RateState = 'now' | 'coming' | 'before'
const stateOf = (dates: string[], d: string, today: string): RateState => {
  if (d > today) return 'coming'
  const inForce = dates
    .filter((x) => x <= today)
    .sort()
    .at(-1)
  return d === inForce ? 'now' : 'before'
}
const STATE_TONE: Record<RateState, 'green' | 'blue' | 'grey'> = {
  now: 'green',
  coming: 'blue',
  before: 'grey',
}
const firstOfMonth = () => kigaliToday().slice(0, 8) + '01'

/**
 * The deductions on salaries (0186): PAYE with its bands, RSSB pension, maternity, Mutuelle,
 * occupational hazards, RAMA, and any other the accountant adds (a loan, a union fee…). Each is
 * a percentage or a fixed amount, with the employee's share and the employer's share, on the
 * gross or on the net, valid from a date. An employee's salary ticks which apply. 0194: switching
 * a share between Percentage and Fixed amount empties its number; a percentage takes a comma and
 * is at most 100. 0214: every part editable — a rule switched off and on, a built-in rule's
 * "Paid to" and "Computed on", the rates by date (in force, coming, before; changed or removed),
 * the PAYE bands by date with the casual worker's rate, the hand-over day of the next month, and a
 * salary tried before it is paid.
 */
export function DeductionsPanel({ i }: { i: number }) {
  const { t } = useTranslation()
  const { data, error } = useDeductions()
  const [msg, setMsg] = useState<Msg | null>(null)
  const [form, setForm] = useState<{ rule: DeductionRule | null; at?: DeductionRate } | null>(null)
  const [bands, setBands] = useState(false)
  const [trying, setTrying] = useState(false)
  const [openRates, setOpenRates] = useState<string | null>(null)
  const rules = data?.rules ?? []
  const today = data?.today ?? kigaliToday()
  return (
    <Panel
      i={i}
      icon={Scissors}
      tint="amber"
      title={t('accounts.deductions.title')}
      right={
        <span className="flex flex-wrap gap-2">
          <Button size="sm" variant="tint-teal" onClick={() => setTrying((b) => !b)}>
            <Calculator size={14} aria-hidden="true" />
            {t('accounts.deductions.try.open')}
          </Button>
          <Button size="sm" variant="tint-violet" onClick={() => setBands((b) => !b)}>
            <Percent size={14} aria-hidden="true" />
            {t('accounts.deductions.payeBands')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setMsg(null)
              setForm({ rule: null })
            }}
          >
            <Plus size={14} aria-hidden="true" />
            {t('accounts.deductions.add')}
          </Button>
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-ink-3 m-0 text-[13px]">{t('accounts.deductions.lead')}</p>
        {error && <p className="text-red m-0 text-[14px] font-medium">{error.message}</p>}
        {msg && <Note msg={msg} />}
        {trying && <TrySalary onClose={() => setTrying(false)} />}
        {bands && data && (
          <PayeBandsForm
            sets={data.payeSets}
            today={today}
            onClose={() => setBands(false)}
            onMsg={setMsg}
          />
        )}
        {form && (
          <DeductionForm
            key={`${form.rule?.id ?? 'new'}:${form.at?.validFrom ?? ''}`}
            current={form.rule}
            at={form.at}
            onClose={() => setForm(null)}
            onMsg={setMsg}
          />
        )}
        {rules.length === 0 ? (
          <Empty icon={Scissors}>{t('accounts.deductions.none')}</Empty>
        ) : (
          <div className="@container overflow-x-auto">
            <table className="w-full border-collapse text-[14px]">
              <thead className="bg-surface">
                <tr className="border-border border-b">
                  <th className={tableHead}>{t('accounts.deductions.cols.name')}</th>
                  {/* the two shares hold a few figures: their headings wrap over them */}
                  <th className={cn(tableHead, 'py-1.5 leading-tight whitespace-normal')}>
                    {t('accounts.deductions.cols.employee')}
                  </th>
                  <th className={cn(tableHead, 'py-1.5 leading-tight whitespace-normal')}>
                    {t('accounts.deductions.cols.employer')}
                  </th>
                  <th className={tableHead}>{t('accounts.deductions.cols.default')}</th>
                  <th className={cn(tableHead, '@max-[48rem]:hidden')}></th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <RuleRow
                    key={r.id}
                    r={r}
                    today={today}
                    salaried={data?.salaried ?? 0}
                    ratesOpen={openRates === r.id}
                    onRates={() => setOpenRates((x) => (x === r.id ? null : r.id))}
                    onChange={(at) => {
                      setMsg(null)
                      if (r.code === 'paye') setBands(true)
                      else setForm({ rule: r, at })
                    }}
                    onMsg={setMsg}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <HandOverDays days={data.remitDays} onMsg={setMsg} />}
      </div>
    </Panel>
  )
}

function RuleRow({
  r,
  today,
  salaried,
  ratesOpen,
  onRates,
  onChange,
  onMsg,
}: {
  r: DeductionRule
  today: string
  salaried: number
  ratesOpen: boolean
  onRates: () => void
  onChange: (at?: DeductionRate) => void
  onMsg: (m: Msg) => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { removeDeduction, setDeductionActive, removeDeductionRate } = useAccountsActions()
  const name = deductionName(t, r)
  const paye = r.code === 'paye'
  const switchTo = async (active: boolean) => {
    if (
      !(await confirm({
        title: t(active ? 'accounts.deductions.onTitle' : 'accounts.deductions.offTitle', { name }),
        body: t(active ? 'accounts.deductions.onBody' : 'accounts.deductions.offBody'),
        confirmLabel: t(active ? 'accounts.deductions.switchOn' : 'accounts.deductions.switchOff'),
        tone: active ? 'primary' : 'danger',
      }))
    )
      return
    try {
      await setDeductionActive.mutateAsync({ id: r.id, active })
      onMsg({
        ok: true,
        text: t(active ? 'accounts.deductions.switchedOn' : 'accounts.deductions.removed', {
          name,
        }),
      })
    } catch (e) {
      onMsg({ ok: false, text: errText(e) })
    }
  }
  const remove = async () => {
    if (
      !(await confirm({
        title: t('accounts.deductions.removeTitle', { name }),
        body: t('accounts.deductions.removeBody'),
        confirmLabel: t('accounts.salaries.removeYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await removeDeduction.mutateAsync(r.id)
      onMsg({ ok: true, text: t('accounts.deductions.deleted', { name }) })
    } catch (e) {
      onMsg({ ok: false, text: errText(e) })
    }
  }
  const removeRate = async (x: DeductionRate) => {
    const date = formatDate(new Date(x.validFrom))
    if (
      !(await confirm({
        title: t('accounts.deductions.removeRateTitle', { date, name }),
        body: t('accounts.deductions.removeRateBody'),
        confirmLabel: t('accounts.salaries.removeYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await removeDeductionRate.mutateAsync({ ruleId: r.id, validFrom: x.validFrom })
      onMsg({ ok: true, text: t('accounts.deductions.rateRemoved', { date, name }) })
    } catch (e) {
      onMsg({ ok: false, text: errText(e) })
    }
  }
  const agency = t(`accounts.deductions.agencies.${r.agency}`)
  const base = t(`accounts.deductions.bases.${r.base}`)
  const dates = r.rates.map((x) => x.validFrom)
  const coming = r.rates.filter((x) => x.validFrom > today)
  const actions = (
    <>
      <Button size="sm" variant="tint-blue" onClick={() => onChange()}>
        {t('accounts.salaries.edit')}
      </Button>
      {!paye && r.rates.length > 0 && (
        <Button size="sm" variant="ghost" aria-expanded={ratesOpen} onClick={onRates}>
          <History size={14} aria-hidden="true" />
          {t(ratesOpen ? 'accounts.deductions.ratesHide' : 'accounts.deductions.rates')}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => void switchTo(!r.active)}>
        {t(r.active ? 'accounts.deductions.switchOff' : 'accounts.deductions.switchOn')}
      </Button>
      {!r.code && (
        <Button size="sm" variant="ghost" onClick={() => void remove()}>
          {t('accounts.kinds.remove')}
        </Button>
      )}
    </>
  )
  return (
    <>
      <tr className={cn(tableRow, !r.active && 'bg-surface/60')}>
        <td className={cn(tableFirstCell, !r.active && 'opacity-60')}>
          <span className="flex flex-wrap items-center gap-2">
            {name}
            {r.code && <Badge tone="grey">{t('accounts.kinds.builtin')}</Badge>}
            {!r.active && <Badge tone="yellow">{t('accounts.deductions.off')}</Badge>}
            {r.active && coming.length > 0 && (
              <Badge tone="blue">
                {t('accounts.deductions.comingBadge', {
                  date: formatDate(new Date(coming[0]!.validFrom)),
                })}
              </Badge>
            )}
          </span>
          <span className="text-ink-3 block text-[12px]">
            {agency} · {base}
            {r.current
              ? ` · ${t('accounts.deductions.validFrom', { date: formatDate(new Date(r.current.validFrom)) })}`
              : ''}
            {r.note ? ` · ${r.note}` : ''}
          </span>
          <span className="mt-1.5 hidden flex-wrap gap-1 @max-[48rem]:flex">{actions}</span>
        </td>
        <td className={cn(tableCell, 'whitespace-nowrap tabular-nums', !r.active && 'opacity-60')}>
          {paye
            ? t('accounts.deductions.byBands')
            : rateWords(t, r.current?.employeeRate ?? null, r.current?.employeeAmount ?? null)}
        </td>
        <td className={cn(tableCell, 'whitespace-nowrap tabular-nums', !r.active && 'opacity-60')}>
          {paye
            ? '—'
            : rateWords(t, r.current?.employerRate ?? null, r.current?.employerAmount ?? null)}
        </td>
        <td className={cn(tableCell, 'min-w-36', !r.active && 'opacity-60')}>
          {!r.active
            ? t('accounts.deductions.offWords')
            : paye
              ? t('accounts.deductions.payeOnSalary')
              : t(r.defaultOn ? 'accounts.deductions.defaultYes' : 'accounts.deductions.defaultNo')}
          {r.active && (
            <span className="text-ink-3 block text-[12px]">
              {t('accounts.deductions.appliesTo', { count: r.people, total: salaried })}
            </span>
          )}
        </td>
        <td className={cn(tableCell, 'text-right @max-[48rem]:hidden')}>
          <span className="inline-flex flex-wrap justify-end gap-1">{actions}</span>
        </td>
      </tr>
      {ratesOpen && (
        <tr className="border-border border-b">
          <td colSpan={5} className="bg-surface px-3 py-2">
            <p className="text-ink-3 m-0 mb-2 text-[12px]">{t('accounts.deductions.ratesLead')}</p>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {[...r.rates].reverse().map((x) => {
                const st = stateOf(dates, x.validFrom, today)
                return (
                  <li
                    key={x.validFrom}
                    className="border-border bg-card flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2.5 py-1.5"
                  >
                    <span className="text-ink text-[14px] font-semibold whitespace-nowrap">
                      {t('accounts.deductions.rateFrom', {
                        date: formatDate(new Date(x.validFrom)),
                      })}
                    </span>
                    <Badge tone={STATE_TONE[st]}>{t(`accounts.deductions.rateState.${st}`)}</Badge>
                    <span className="text-ink-2 min-w-0 text-[13px] tabular-nums">
                      {t('accounts.deductions.rateShares', {
                        employee: rateWords(t, x.employeeRate, x.employeeAmount),
                        employer: rateWords(t, x.employerRate, x.employerAmount),
                      })}
                    </span>
                    {x.setBy && (
                      <span className="text-ink-3 min-w-0 text-[12px]">
                        {t('accounts.deductions.setBy', {
                          name: x.setBy,
                          date: x.setAt ? formatDate(new Date(x.setAt)) : '',
                        })}
                      </span>
                    )}
                    <span className="ml-auto inline-flex gap-1">
                      <Button size="sm" variant="tint-blue" onClick={() => onChange(x)}>
                        {t('accounts.salaries.edit')}
                      </Button>
                      {r.rates.length > 1 && (
                        <Button size="sm" variant="ghost" onClick={() => void removeRate(x)}>
                          {t('accounts.kinds.remove')}
                        </Button>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          </td>
        </tr>
      )}
    </>
  )
}

/** A rule's name, agency, base, and the rates from a date (earlier periods keep their rates). */
function DeductionForm({
  current,
  at,
  onClose,
  onMsg,
}: {
  current: DeductionRule | null
  /** 0214: the dated rates to change (default: those in force today). */
  at?: DeductionRate
  onClose: () => void
  onMsg: (m: Msg) => void
}) {
  const { t } = useTranslation()
  const { setDeduction } = useAccountsActions()
  const builtin = !!current?.code
  const paye = current?.code === 'paye'
  const start = at ?? current?.current ?? null
  const [name, setName] = useState(current?.name ?? '')
  const [agency, setAgency] = useState<string>(current?.agency ?? 'other')
  const [base, setBase] = useState<string>(current?.base ?? 'gross')
  const [defaultOn, setDefaultOn] = useState(current?.defaultOn ?? false)
  const [employeeKind, setEmployeeKind] = useState<'rate' | 'amount'>(
    start?.employeeAmount != null ? 'amount' : 'rate',
  )
  const [employee, setEmployee] = useState(
    start?.employeeAmount != null
      ? String(start.employeeAmount)
      : start?.employeeRate != null
        ? String(start.employeeRate)
        : '',
  )
  const [employerKind, setEmployerKind] = useState<'rate' | 'amount'>(
    start?.employerAmount != null ? 'amount' : 'rate',
  )
  const [employer, setEmployer] = useState(
    start?.employerAmount != null
      ? String(start.employerAmount)
      : start?.employerRate != null
        ? String(start.employerRate)
        : '',
  )
  const [validFrom, setValidFrom] = useState(at?.validFrom ?? firstOfMonth())
  const [note, setNote] = useState(current?.note ?? '')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!builtin && name.trim().length < 2)
      return onMsg({ ok: false, text: t('accounts.deductions.errors.name') })
    const emp = employee === '' ? null : Number(employee)
    const er = employer === '' ? null : Number(employer)
    if ((emp != null && !(emp >= 0)) || (er != null && !(er >= 0)))
      return onMsg({ ok: false, text: t('accounts.deductions.errors.rate') })
    if (!paye && emp == null && er == null)
      return onMsg({ ok: false, text: t('accounts.deductions.errors.rate') })
    // 0194: a share in percent is at most 100 (said in plain words before the database refuses)
    if (
      (employeeKind === 'rate' && emp != null && emp > 100) ||
      (employerKind === 'rate' && er != null && er > 100)
    )
      return onMsg({ ok: false, text: t('accounts.deductions.errors.percent') })
    if (!paye && !validFrom)
      return onMsg({ ok: false, text: t('accounts.deductions.errors.validFrom') })
    try {
      await setDeduction.mutateAsync({
        id: current?.id ?? null,
        name: builtin ? current!.name : name.trim(),
        agency,
        base,
        defaultOn,
        employeeRate: employeeKind === 'rate' ? emp : null,
        employeeAmount: employeeKind === 'amount' ? emp : null,
        employerRate: employerKind === 'rate' ? er : null,
        employerAmount: employerKind === 'amount' ? er : null,
        validFrom: paye ? null : validFrom,
        note,
        // 0214: a rule switched off stays off when its rates are changed
        active: current?.active ?? true,
      })
      onMsg({
        ok: true,
        text: t('accounts.deductions.saved', {
          name: builtin ? deductionName(t, current!) : name.trim(),
        }),
      })
      onClose()
    } catch (err) {
      onMsg({ ok: false, text: errText(err) })
    }
  }
  const kindSelect = (
    value: 'rate' | 'amount',
    onChange: (v: 'rate' | 'amount') => void,
    label: string,
  ) => (
    <Select
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as 'rate' | 'amount')}
    >
      <option value="rate">{t('accounts.deductions.percent')}</option>
      <option value="amount">{t('accounts.deductions.fixed')}</option>
    </Select>
  )
  return (
    <PanelForm
      title={
        current
          ? t('accounts.deductions.changeTitle', { name: deductionName(t, current) })
          : t('accounts.deductions.newTitle')
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        {!paye && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {!builtin && (
              <Field
                label={t('accounts.deductions.cols.name')}
                placeholder={t('accounts.deductions.namePh')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
            <Select
              label={t('accounts.deductions.agency')}
              value={agency}
              onChange={(e) => setAgency(e.target.value)}
            >
              {AGENCIES.map((a) => (
                <option key={a} value={a}>
                  {t(`accounts.deductions.agencies.${a}`)}
                </option>
              ))}
            </Select>
            <Select
              label={t('accounts.deductions.base')}
              value={base}
              onChange={(e) => setBase(e.target.value)}
            >
              <option value="gross">{t('accounts.deductions.bases.gross')}</option>
              <option value="net">{t('accounts.deductions.bases.net')}</option>
            </Select>
          </div>
        )}
        {!paye && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {/* 0194: switching Percentage / Fixed amount empties the number, so 6 (%) never
                silently becomes RWF 6 */}
            {kindSelect(
              employeeKind,
              (v) => {
                setEmployeeKind(v)
                setEmployee('')
              },
              t('accounts.deductions.employeeKind'),
            )}
            <Field
              label={t(
                employeeKind === 'rate'
                  ? 'accounts.deductions.employeeRate'
                  : 'accounts.deductions.employeeAmount',
              )}
              inputMode={employeeKind === 'rate' ? 'decimal' : 'numeric'}
              value={employee}
              onChange={(e) => setEmployee(shareInput(employeeKind, e.target.value))}
            />
            {kindSelect(
              employerKind,
              (v) => {
                setEmployerKind(v)
                setEmployer('')
              },
              t('accounts.deductions.employerKind'),
            )}
            <Field
              label={t(
                employerKind === 'rate'
                  ? 'accounts.deductions.employerRate'
                  : 'accounts.deductions.employerAmount',
              )}
              inputMode={employerKind === 'rate' ? 'decimal' : 'numeric'}
              value={employer}
              onChange={(e) => setEmployer(shareInput(employerKind, e.target.value))}
            />
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {!paye && (
            <Field
              label={t('accounts.deductions.validFromField')}
              type="date"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
            />
          )}
          {!paye && (
            <Select
              label={t('accounts.deductions.cols.default')}
              value={defaultOn ? 'yes' : 'no'}
              onChange={(e) => setDefaultOn(e.target.value === 'yes')}
            >
              <option value="yes">{t('accounts.deductions.defaultYes')}</option>
              <option value="no">{t('accounts.deductions.defaultNo')}</option>
            </Select>
          )}
          <Field
            wrapperClassName={paye ? 'sm:col-span-3' : ''}
            label={t('accounts.salaries.note')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <p className="text-ink-3 m-0 text-[13px]">
          {t(paye ? 'accounts.deductions.payeHint' : 'accounts.deductions.setHint')}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" type="submit" loading={setDeduction.isPending}>
            {t('accounts.deductions.save')}
          </Button>
          <Button onClick={onClose}>{t('accounts.cancel')}</Button>
        </div>
      </form>
    </PanelForm>
  )
}

type BandRow = { lower: string; rate: string }
const rowsOf = (set: PayeSet | null): BandRow[] =>
  set?.bands.length
    ? set.bands.map((b) => ({ lower: String(b.lower), rate: String(b.rate) }))
    : [
        { lower: '0', rate: '0' },
        { lower: '60000', rate: '10' },
        { lower: '100000', rate: '20' },
        { lower: '200000', rate: '30' },
      ]

/**
 * The PAYE bands by date (0214): the sets one after the other (in force, coming, before), one
 * chosen to change or a new set from a date, the casual worker's rate with them, an example worked
 * out from the bands as typed, and a set typed by mistake removed.
 */
function PayeBandsForm({
  sets,
  today,
  onClose,
  onMsg,
}: {
  sets: PayeSet[]
  today: string
  onClose: () => void
  onMsg: (m: Msg) => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { setPayeBands, removePayeBands } = useAccountsActions()
  const inForce = setOn(sets, today) ?? sets.at(-1) ?? null
  const [chosen, setChosen] = useState<string>(inForce?.validFrom ?? 'new')
  const set = sets.find((s) => s.validFrom === chosen) ?? null
  const [validFrom, setValidFrom] = useState(inForce?.validFrom ?? `${today.slice(0, 4)}-01-01`)
  const [rows, setRows] = useState<BandRow[]>(rowsOf(inForce))
  const [casual, setCasual] = useState(String(inForce?.casualRate ?? 15))
  const dates = sets.map((s) => s.validFrom)
  const choose = (v: string) => {
    setChosen(v)
    const s = sets.find((x) => x.validFrom === v)
    if (s) {
      setValidFrom(s.validFrom)
      setRows(rowsOf(s))
      setCasual(String(s.casualRate ?? 15))
    } else {
      // a new set starts from the bands in force, from the first of next month
      const d = new Date(firstOfMonth() + 'T00:00:00Z')
      d.setUTCMonth(d.getUTCMonth() + 1)
      setValidFrom(d.toISOString().slice(0, 10))
      setRows(rowsOf(inForce))
      setCasual(String(inForce?.casualRate ?? 15))
    }
  }
  const list = rows
    .filter((r) => r.lower !== '' && r.rate !== '')
    .map((r) => ({ lower: Number(r.lower), rate: Number(r.rate) }))
  const casualRate = casual === '' ? null : Number(casual)
  const valid = list.length > 0 && list.every((b) => b.lower >= 0 && b.rate >= 0 && b.rate <= 100)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!validFrom || !valid)
      return onMsg({ ok: false, text: t('accounts.deductions.errors.bands') })
    if (new Set(list.map((b) => b.lower)).size < list.length)
      return onMsg({ ok: false, text: t('accounts.deductions.errors.sameStart') })
    if (casualRate == null || !(casualRate >= 0 && casualRate <= 100))
      return onMsg({ ok: false, text: t('accounts.deductions.errors.casual') })
    try {
      await setPayeBands.mutateAsync({ validFrom, bands: list, casualRate })
      onMsg({
        ok: true,
        text: t('accounts.deductions.bandsSaved', { date: formatDate(new Date(validFrom)) }),
      })
      onClose()
    } catch (err) {
      onMsg({ ok: false, text: errText(err) })
    }
  }
  const removeSet = async () => {
    if (!set) return
    const date = formatDate(new Date(set.validFrom))
    if (
      !(await confirm({
        title: t('accounts.deductions.removeSetTitle', { date }),
        body: t('accounts.deductions.removeRateBody'),
        confirmLabel: t('accounts.salaries.removeYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await removePayeBands.mutateAsync(set.validFrom)
      onMsg({ ok: true, text: t('accounts.deductions.setRemoved', { date }) })
      onClose()
    } catch (err) {
      onMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <PanelForm title={t('accounts.deductions.payeBands')}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-ink-3 m-0 text-[13px]">{t('accounts.deductions.bandsHint')}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Select
            label={t('accounts.deductions.bandSet')}
            value={chosen}
            onChange={(e) => choose(e.target.value)}
          >
            {[...sets].reverse().map((s) => (
              <option key={s.validFrom} value={s.validFrom}>
                {t('accounts.deductions.bandSetOption', {
                  date: formatDate(new Date(s.validFrom)),
                  state: t(`accounts.deductions.rateState.${stateOf(dates, s.validFrom, today)}`),
                })}
              </option>
            ))}
            <option value="new">{t('accounts.deductions.newSet')}</option>
          </Select>
          <Field
            label={t('accounts.deductions.validFromField')}
            type="date"
            value={validFrom}
            onChange={(e) => setValidFrom(e.target.value)}
          />
          <Field
            label={t('accounts.deductions.casualRate')}
            inputMode="decimal"
            value={casual}
            onChange={(e) => setCasual(cleanPercent(e.target.value))}
          />
        </div>
        <div className="flex flex-col gap-2">
          {rows.map((r, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <Field
                wrapperClassName="min-w-0 flex-[2_1_5rem] sm:w-40 sm:flex-none"
                label={t('accounts.deductions.bandFrom')}
                inputMode="numeric"
                value={r.lower}
                onChange={(e) =>
                  setRows((xs) =>
                    xs.map((x, j) =>
                      j === i ? { ...x, lower: e.target.value.replace(/[^\d]/g, '') } : x,
                    ),
                  )
                }
              />
              <Field
                wrapperClassName="min-w-0 flex-[1_1_3rem] sm:w-28 sm:flex-none"
                label={t('accounts.deductions.bandRate')}
                inputMode="decimal"
                value={r.rate}
                onChange={(e) =>
                  setRows((xs) =>
                    xs.map((x, j) => (j === i ? { ...x, rate: cleanPercent(e.target.value) } : x)),
                  )
                }
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRows((xs) => xs.filter((_, j) => j !== i))}
              >
                {t('accounts.kinds.remove')}
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="tint-grey"
            className="self-start"
            onClick={() => setRows((xs) => [...xs, { lower: '', rate: '' }])}
          >
            <Plus size={14} aria-hidden="true" />
            {t('accounts.deductions.addBand')}
          </Button>
        </div>
        {valid && (
          <p className="text-ink m-0 text-[14px] font-medium">
            {t('accounts.deductions.bandsTry', {
              gross: formatRwf(500000),
              tax: formatRwf(payeWith(list, 500000)),
              casual: formatRwf(payeWith(list, 500000, 'casual', casualRate ?? 15)),
            })}
          </p>
        )}
        <p className="text-ink-3 m-0 text-[13px]">{t('accounts.deductions.bandsDates')}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" type="submit" loading={setPayeBands.isPending}>
            {t('accounts.deductions.saveBands')}
          </Button>
          {set && sets.length > 1 && (
            <Button
              variant="ghost"
              loading={removePayeBands.isPending}
              onClick={() => void removeSet()}
            >
              {t('accounts.deductions.removeSet')}
            </Button>
          )}
          <Button onClick={onClose}>{t('accounts.cancel')}</Button>
        </div>
      </form>
    </PanelForm>
  )
}

/**
 * The day of the next month what was taken from salaries (and the clinic's part) is handed over
 * to each agency (0214; was the 15th, fixed). The Taxes tab shows each month due on that day.
 */
function HandOverDays({ days, onMsg }: { days: Record<Agency, number>; onMsg: (m: Msg) => void }) {
  const { t } = useTranslation()
  const { setRemitDay } = useAccountsActions()
  const [typed, setTyped] = useState<Record<Agency, string>>({
    rra: String(days.rra),
    rssb: String(days.rssb),
    other: String(days.other),
  })
  const changed = AGENCIES.filter((a) => typed[a] !== String(days[a]))
  const save = async (e: FormEvent) => {
    e.preventDefault()
    const bad = changed.find((a) => !(Number(typed[a]) >= 1 && Number(typed[a]) <= 28))
    if (bad) return onMsg({ ok: false, text: t('accounts.deductions.hand.error') })
    try {
      for (const a of changed) await setRemitDay.mutateAsync({ agency: a, day: Number(typed[a]) })
      onMsg({ ok: true, text: t('accounts.deductions.hand.saved') })
    } catch (err) {
      onMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <form onSubmit={save} className="border-border bg-surface rounded-md border p-3">
      <h3 className="text-ink m-0 flex items-center gap-2 text-[15px] font-semibold">
        <CalendarClock size={16} aria-hidden="true" className="text-amber" />
        {t('accounts.deductions.hand.title')}
      </h3>
      <p className="text-ink-3 m-0 mt-1 mb-3 text-[13px]">{t('accounts.deductions.hand.lead')}</p>
      <div className="flex flex-wrap items-end gap-3">
        {AGENCIES.map((a) => (
          <Field
            key={a}
            wrapperClassName="w-36 max-w-full"
            label={t('accounts.deductions.hand.day', {
              agency: t(`accounts.deductions.agencies.${a}`),
            })}
            inputMode="numeric"
            value={typed[a]}
            onChange={(e) =>
              setTyped((x) => ({ ...x, [a]: e.target.value.replace(/[^\d]/g, '').slice(0, 2) }))
            }
          />
        ))}
        <Button
          variant="primary"
          type="submit"
          disabled={changed.length === 0}
          loading={setRemitDay.isPending}
        >
          {t('accounts.deductions.hand.save')}
        </Button>
      </div>
    </form>
  )
}

/**
 * A salary tried before it is paid (0214): a gross, the PAYE way, the pay date and for whom (one
 * employee's ticks, or the rules on for everyone) give the pay slip with the rules as they are:
 * each line, the net to the employee, the clinic's part and what the salary costs the clinic.
 */
function TrySalary({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const today = kigaliToday()
  const { data: overview } = useSalaryOverview(Number(today.slice(0, 4)))
  const people = (overview?.people ?? []).filter((p) => p.active)
  const [who, setWho] = useState('')
  const [gross, setGross] = useState('300000')
  const [mode, setMode] = useState<PayeMode>('normal')
  const [on, setOnDate] = useState(today)
  // the database is asked when the typing pauses
  const [asked, setAsked] = useState(gross)
  useEffect(() => {
    const id = setTimeout(() => setAsked(gross), 350)
    return () => clearTimeout(id)
  }, [gross])
  const amount = Number(asked)
  const ready = asked !== '' && Number.isFinite(amount) && amount > 0 && !!on
  const {
    data: slip,
    error,
    isFetching,
  } = usePayslipPreview(ready ? { gross: amount, on, mode, profileId: who || null } : null)
  const pick = (id: string) => {
    setWho(id)
    const p = people.find((x) => x.id === id)
    if (p) {
      setGross(String(p.amount))
      setMode(p.payeMode)
    }
  }
  const agency = (a: string) => t(`accounts.deductions.agencies.${a}`)
  return (
    <PanelForm title={t('accounts.deductions.try.title')}>
      <div className="flex flex-col gap-3">
        <p className="text-ink-3 m-0 text-[13px]">{t('accounts.deductions.try.lead')}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
          <Select
            label={t('accounts.deductions.try.who')}
            value={who}
            onChange={(e) => pick(e.target.value)}
          >
            <option value="">{t('accounts.deductions.try.anyone')}</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Field
            label={t('accounts.deductions.try.gross')}
            inputMode="numeric"
            value={gross}
            onChange={(e) => setGross(e.target.value.replace(/[^\d]/g, '').slice(0, 9))}
          />
          <Select
            label={t('accounts.salaries.payeMode')}
            value={mode}
            onChange={(e) => setMode(e.target.value as PayeMode)}
          >
            {PAYE_MODES.map((m) => (
              <option key={m} value={m}>
                {t(`accounts.salaries.payeModes.${m}`)}
              </option>
            ))}
          </Select>
          <Field
            label={t('accounts.deductions.try.on')}
            type="date"
            value={on}
            onChange={(e) => setOnDate(e.target.value)}
          />
        </div>
        {error && <p className="text-red m-0 text-[14px] font-medium">{error.message}</p>}
        {!ready ? (
          <p className="text-ink-3 m-0 text-[14px]">{t('accounts.deductions.try.empty')}</p>
        ) : (
          slip && (
            <div className={cn('overflow-x-auto', isFetching && 'opacity-70')}>
              <table className="w-full border-collapse text-[14px]">
                <thead>
                  <tr className="border-border border-b">
                    <th className={tableHead}>{t('accounts.deductions.cols.name')}</th>
                    <th className={cn(tableHead, 'text-right whitespace-normal')}>
                      {t('accounts.deductions.cols.employee')}
                    </th>
                    <th className={cn(tableHead, 'text-right whitespace-normal')}>
                      {t('accounts.deductions.cols.employer')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className={tableRow}>
                    <td className={figureLabel}>{t('accounts.salaries.gross')}</td>
                    <td className={cn(figureAmount, 'font-semibold')}>{formatRwf(slip.gross)}</td>
                    <td className={figureAmount}></td>
                  </tr>
                  {slip.lines.map((l) => (
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
                      <td className={figureAmount}>
                        {l.employer ? `+ ${formatRwf(l.employer)}` : '—'}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-border border-t-2">
                    <td className={cn(figureLabel, 'font-semibold')}>
                      {t('accounts.deductions.try.totals')}
                    </td>
                    <td className={cn(figureAmount, 'font-semibold')}>
                      − {formatRwf(slip.employeeTotal)}
                    </td>
                    <td className={cn(figureAmount, 'font-semibold')}>
                      + {formatRwf(slip.employerTotal)}
                    </td>
                  </tr>
                </tbody>
              </table>
              <dl className="m-0 mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="bg-green-bg rounded-md px-3 py-2">
                  <dt className="text-green text-[13px] font-medium">
                    {t('accounts.deductions.try.net')}
                  </dt>
                  <dd className="text-ink m-0 text-[18px] font-bold tabular-nums">
                    {formatRwf(slip.net)}
                  </dd>
                </div>
                <div className="bg-amber-bg rounded-md px-3 py-2">
                  <dt className="text-amber text-[13px] font-medium">
                    {t('accounts.deductions.try.cost')}
                  </dt>
                  <dd className="text-ink m-0 text-[18px] font-bold tabular-nums">
                    {formatRwf(slip.gross + slip.employerTotal)}
                  </dd>
                </div>
              </dl>
              <p className="text-ink-3 m-0 mt-2 text-[13px]">
                {t('accounts.deductions.try.where', { amount: formatRwf(slip.employerTotal) })}
              </p>
            </div>
          )
        )}
        <Button className="self-start" onClick={onClose}>
          {t('accounts.deductions.try.close')}
        </Button>
      </div>
    </PanelForm>
  )
}

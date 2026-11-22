import { useState, type FormEvent } from 'react'
import { Percent, Plus, Scissors } from 'lucide-react'
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
  cleanPercent,
  deductionName,
  rateWords,
  useAccountsActions,
  useDeductions,
  type DeductionRule,
} from '@/lib/api/accounts'
import { useConfirm } from '@/lib/confirm'
import { kigaliToday } from '@/lib/clock'
import { cn } from '@/lib/utils'
import { Note, PanelForm } from './accounts-kit'
import { errText, type Msg } from './accounts-tabs'

/** A share as typed (0194): a percentage takes a comma as the decimal mark ('0,5' → 0.5); a
 *  fixed amount is whole francs. */
const shareInput = (kind: 'rate' | 'amount', v: string) =>
  kind === 'rate' ? cleanPercent(v) : v.replace(/[^\d]/g, '').slice(0, 9)

/**
 * The deductions on salaries (0186): PAYE with its bands, RSSB pension, maternity, Mutuelle,
 * occupational hazards, RAMA, and any other the accountant adds (a loan, a union fee…). Each is
 * a percentage or a fixed amount, with the employee's share and the employer's share, on the
 * gross or on the net, valid from a date. An employee's salary ticks which apply. 0194: switching
 * a share between Percentage and Fixed amount empties its number; a percentage takes a comma and
 * is at most 100.
 */
export function DeductionsPanel({ i }: { i: number }) {
  const { t } = useTranslation()
  const { data, error } = useDeductions()
  const [msg, setMsg] = useState<Msg | null>(null)
  const [form, setForm] = useState<{ rule: DeductionRule | null } | null>(null)
  const [bands, setBands] = useState(false)
  const rules = data?.rules ?? []
  return (
    <Panel
      i={i}
      icon={Scissors}
      tint="amber"
      title={t('accounts.deductions.title')}
      right={
        <span className="flex flex-wrap gap-2">
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
        {bands && data && (
          <PayeBandsForm bands={data.payeBands} onClose={() => setBands(false)} onMsg={setMsg} />
        )}
        {form && <DeductionForm current={form.rule} onClose={() => setForm(null)} onMsg={setMsg} />}
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
                    onChange={() => {
                      setMsg(null)
                      setForm({ rule: r })
                    }}
                    onMsg={setMsg}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  )
}

function RuleRow({
  r,
  onChange,
  onMsg,
}: {
  r: DeductionRule
  onChange: () => void
  onMsg: (m: Msg) => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { removeDeduction } = useAccountsActions()
  const remove = async () => {
    if (
      !(await confirm({
        title: t(r.code ? 'accounts.deductions.offTitle' : 'accounts.deductions.removeTitle', {
          name: deductionName(t, r),
        }),
        body: t('accounts.deductions.removeBody'),
        confirmLabel: t('accounts.salaries.removeYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await removeDeduction.mutateAsync(r.id)
      onMsg({ ok: true, text: t('accounts.deductions.removed', { name: deductionName(t, r) }) })
    } catch (e) {
      onMsg({ ok: false, text: errText(e) })
    }
  }
  const agency = t(`accounts.deductions.agencies.${r.agency}`)
  const base = t(`accounts.deductions.bases.${r.base}`)
  const actions = (
    <>
      <Button size="sm" variant="tint-blue" onClick={onChange}>
        {t('accounts.salaries.edit')}
      </Button>
      {r.active && (
        <Button size="sm" variant="ghost" onClick={() => void remove()}>
          {t(r.code ? 'accounts.deductions.switchOff' : 'accounts.kinds.remove')}
        </Button>
      )}
    </>
  )
  return (
    <tr className={cn(tableRow, !r.active && 'opacity-60')}>
      <td className={tableFirstCell}>
        <span className="flex flex-wrap items-center gap-2">
          {deductionName(t, r)}
          {r.code && <Badge tone="grey">{t('accounts.kinds.builtin')}</Badge>}
          {!r.active && <Badge tone="yellow">{t('accounts.deductions.off')}</Badge>}
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
      <td className={cn(tableCell, 'whitespace-nowrap tabular-nums')}>
        {r.code === 'paye'
          ? t('accounts.deductions.byBands')
          : rateWords(t, r.current?.employeeRate ?? null, r.current?.employeeAmount ?? null)}
      </td>
      <td className={cn(tableCell, 'whitespace-nowrap tabular-nums')}>
        {r.code === 'paye'
          ? '—'
          : rateWords(t, r.current?.employerRate ?? null, r.current?.employerAmount ?? null)}
      </td>
      <td className={cn(tableCell, 'min-w-36')}>
        {r.code === 'paye'
          ? t('accounts.deductions.payeOnSalary')
          : t(r.defaultOn ? 'accounts.deductions.defaultYes' : 'accounts.deductions.defaultNo')}
        <span className="text-ink-3 block text-[12px]">
          {t('accounts.deductions.people', { count: r.people })}
        </span>
      </td>
      <td className={cn(tableCell, 'text-right whitespace-nowrap @max-[48rem]:hidden')}>
        <span className="inline-flex gap-1">{actions}</span>
      </td>
    </tr>
  )
}

/** A rule's name, agency, base, and the rates from a date (earlier periods keep their rates). */
function DeductionForm({
  current,
  onClose,
  onMsg,
}: {
  current: DeductionRule | null
  onClose: () => void
  onMsg: (m: Msg) => void
}) {
  const { t } = useTranslation()
  const { setDeduction } = useAccountsActions()
  const builtin = !!current?.code
  const paye = current?.code === 'paye'
  const [name, setName] = useState(current?.name ?? '')
  const [agency, setAgency] = useState<string>(current?.agency ?? 'other')
  const [base, setBase] = useState<string>(current?.base ?? 'gross')
  const [defaultOn, setDefaultOn] = useState(current?.defaultOn ?? false)
  const [employeeKind, setEmployeeKind] = useState<'rate' | 'amount'>(
    current?.current?.employeeAmount != null ? 'amount' : 'rate',
  )
  const [employee, setEmployee] = useState(
    current?.current?.employeeAmount != null
      ? String(current.current.employeeAmount)
      : current?.current?.employeeRate != null
        ? String(current.current.employeeRate)
        : '',
  )
  const [employerKind, setEmployerKind] = useState<'rate' | 'amount'>(
    current?.current?.employerAmount != null ? 'amount' : 'rate',
  )
  const [employer, setEmployer] = useState(
    current?.current?.employerAmount != null
      ? String(current.current.employerAmount)
      : current?.current?.employerRate != null
        ? String(current.current.employerRate)
        : '',
  )
  const [validFrom, setValidFrom] = useState(kigaliToday().slice(0, 8) + '01')
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
        active: true,
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {!builtin && (
            <Field
              label={t('accounts.deductions.cols.name')}
              placeholder={t('accounts.deductions.namePh')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
          {!builtin && (
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
          )}
          {!builtin && (
            <Select
              label={t('accounts.deductions.base')}
              value={base}
              onChange={(e) => setBase(e.target.value)}
            >
              <option value="gross">{t('accounts.deductions.bases.gross')}</option>
              <option value="net">{t('accounts.deductions.bases.net')}</option>
            </Select>
          )}
        </div>
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

/** The PAYE bands valid from a date: a lower bound and a rate per band. */
function PayeBandsForm({
  bands,
  onClose,
  onMsg,
}: {
  bands: { validFrom: string; lower: number; rate: number }[]
  onClose: () => void
  onMsg: (m: Msg) => void
}) {
  const { t } = useTranslation()
  const { setPayeBands } = useAccountsActions()
  const latest = bands.at(-1)?.validFrom ?? null
  const current = latest ? bands.filter((b) => b.validFrom === latest) : []
  const [validFrom, setValidFrom] = useState(latest ?? `${kigaliToday().slice(0, 4)}-01-01`)
  const [rows, setRows] = useState<{ lower: string; rate: string }[]>(
    current.length
      ? current.map((b) => ({ lower: String(b.lower), rate: String(b.rate) }))
      : [
          { lower: '0', rate: '0' },
          { lower: '60000', rate: '10' },
          { lower: '100000', rate: '20' },
          { lower: '200000', rate: '30' },
        ],
  )
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const list = rows
      .filter((r) => r.lower !== '' && r.rate !== '')
      .map((r) => ({ lower: Number(r.lower), rate: Number(r.rate) }))
    if (
      !validFrom ||
      list.length === 0 ||
      list.some((b) => !(b.lower >= 0) || !(b.rate >= 0 && b.rate <= 100))
    )
      return onMsg({ ok: false, text: t('accounts.deductions.errors.bands') })
    try {
      await setPayeBands.mutateAsync({ validFrom, bands: list })
      onMsg({
        ok: true,
        text: t('accounts.deductions.bandsSaved', { date: formatDate(new Date(validFrom)) }),
      })
      onClose()
    } catch (err) {
      onMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <PanelForm title={t('accounts.deductions.payeBands')}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-ink-3 m-0 text-[13px]">{t('accounts.deductions.bandsHint')}</p>
        <Field
          wrapperClassName="sm:w-60"
          label={t('accounts.deductions.validFromField')}
          type="date"
          value={validFrom}
          onChange={(e) => setValidFrom(e.target.value)}
        />
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
                    xs.map((x, j) =>
                      j === i ? { ...x, rate: e.target.value.replace(/[^\d.]/g, '') } : x,
                    ),
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
        <p className="text-ink-3 m-0 text-[13px]">
          {t('accounts.deductions.bandsExample', { tax: formatRwf(114000) })}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" type="submit" loading={setPayeBands.isPending}>
            {t('accounts.deductions.save')}
          </Button>
          <Button onClick={onClose}>{t('accounts.cancel')}</Button>
        </div>
      </form>
    </PanelForm>
  )
}

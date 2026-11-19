import { useState, type FormEvent } from 'react'
import { CalendarCheck, Landmark, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf } from '@mmc/shared'
import { Empty, Panel } from '@/components/dash/kit'
import { tableCell, tableFirstCell, tableHead, tableRow } from '@/components/dash/kit-style'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { useAccountsActions, useRemittances, type Remittance } from '@/lib/api/accounts'
import { useConfirm } from '@/lib/confirm'
import { kigaliToday } from '@/lib/clock'
import { cn } from '@/lib/utils'
import { Note, PanelForm } from './accounts-kit'
import { METHODS, STATUS_TONE, errText, type Msg } from './accounts-tabs'

/**
 * The payroll remittances (0186): per month and agency, what was withheld from the salaries paid
 * in the month (PAYE to RRA; pension, maternity, Mutuelle… to RSSB) plus the clinic's own share,
 * due on the 15th of the next month. Worked out from the pay slips, never typed. Mark paid records
 * the withheld part as money out (the employer's share was recorded with the salaries).
 */
export function RemittancesPanel({ i, year }: { i: number; year: number }) {
  const { t } = useTranslation()
  const { data: rows = [], error } = useRemittances(year)
  const confirm = useConfirm()
  const { unpayRemittance, skipRemittance } = useAccountsActions()
  const [msg, setMsg] = useState<Msg | null>(null)
  const [paying, setPaying] = useState<Remittance | null>(null)
  const method = (m: string | null) =>
    m ? t(`visit.payment.methods.${m}`, { defaultValue: m }) : ''
  const agency = (a: string) => t(`accounts.deductions.agencies.${a}`)
  const undo = async (r: Remittance) => {
    if (!r.id) return
    const why = await confirm({
      title: t('accounts.remittances.undoTitle', { name: `${agency(r.agency)} ${r.month}` }),
      confirmLabel: t('accounts.salaries.undoYes'),
      tone: 'danger',
      input: { label: t('accounts.salaries.reason'), required: true },
    })
    if (!why.ok) return
    try {
      await unpayRemittance.mutateAsync({ id: r.id, reason: why.value })
      setMsg({ ok: true, text: t('accounts.salaries.undone') })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    }
  }
  const skip = async (r: Remittance) => {
    const why = await confirm({
      title: t('accounts.remittances.skipTitle', { name: `${agency(r.agency)} ${r.month}` }),
      confirmLabel: t('accounts.salaries.skipYes'),
      input: { label: t('accounts.salaries.reason'), required: true },
    })
    if (!why.ok) return
    try {
      await skipRemittance.mutateAsync({
        agency: r.agency,
        month: `${r.month}-01`,
        reason: why.value,
      })
      setPaying(null)
      setMsg({ ok: true, text: t('accounts.salaries.skipped') })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    }
  }
  return (
    <Panel i={i} icon={Landmark} tint="navy" title={t('accounts.remittances.title', { year })}>
      <div className="flex flex-col gap-3">
        <p className="text-ink-3 m-0 text-[13px]">{t('accounts.remittances.lead')}</p>
        {error && <p className="text-red m-0 text-[14px] font-medium">{error.message}</p>}
        {msg && <Note msg={msg} />}
        {paying && <RemitForm r={paying} onClose={() => setPaying(null)} onMsg={setMsg} />}
        {rows.length === 0 ? (
          <Empty icon={Landmark}>{t('accounts.remittances.none')}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead className="bg-surface">
                <tr className="border-border border-b">
                  <th className={tableHead}>{t('accounts.money.month')}</th>
                  <th className={tableHead}>{t('accounts.deductions.agency')}</th>
                  <th className={cn(tableHead, 'text-right')}>
                    {t('accounts.remittances.withheld')}
                  </th>
                  <th className={cn(tableHead, 'text-right')}>
                    {t('accounts.remittances.employer')}
                  </th>
                  <th className={cn(tableHead, 'text-right')}>{t('accounts.remittances.total')}</th>
                  <th className={tableHead}>{t('accounts.salaries.cols.dueOn')}</th>
                  <th className={tableHead}>{t('accounts.salaries.cols.status')}</th>
                  <th className={tableHead}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const key = `${r.month}:${r.agency}`
                  const here = paying && `${paying.month}:${paying.agency}` === key
                  const detail =
                    r.status === 'paid'
                      ? [
                          r.paidOn ? formatDate(new Date(r.paidOn)) : null,
                          method(r.method),
                          r.reference,
                          r.paidBy,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : r.status === 'skipped'
                        ? r.note
                        : ''
                  return (
                    <tr key={key} className={cn(tableRow, here && 'bg-yellow-bg')}>
                      <td className={cn(tableFirstCell, 'whitespace-nowrap')}>
                        {r.month}
                        <span className="text-ink-3 block text-[12px]">
                          {t('accounts.remittances.people', { count: r.people })} ·{' '}
                          {r.lines.map((l) => l.name).join(', ')}
                        </span>
                      </td>
                      <td className={tableCell}>{agency(r.agency)}</td>
                      <td className={cn(tableCell, 'text-right tabular-nums')}>
                        {formatRwf(r.employeeTotal)}
                      </td>
                      <td className={cn(tableCell, 'text-right tabular-nums')}>
                        {formatRwf(r.employerTotal)}
                      </td>
                      <td className={cn(tableCell, 'text-right font-semibold tabular-nums')}>
                        {formatRwf(r.total)}
                      </td>
                      <td className={cn(tableCell, 'whitespace-nowrap')}>
                        {formatDate(new Date(r.dueOn))}
                      </td>
                      <td className={tableCell}>
                        <Badge tone={STATUS_TONE[r.status]}>
                          {t(`accounts.status.${r.status}`)}
                        </Badge>
                        {detail && <span className="text-ink-3 block text-[12px]">{detail}</span>}
                      </td>
                      <td className={cn(tableCell, 'text-right whitespace-nowrap')}>
                        {r.status === 'due' || r.status === 'overdue' ? (
                          <>
                            <Button
                              size="sm"
                              variant={here ? 'tint-grey' : 'primary'}
                              onClick={() => setPaying(here ? null : r)}
                            >
                              <CalendarCheck size={14} aria-hidden="true" />
                              {t('accounts.salaries.markPaid')}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="ml-1"
                              onClick={() => void skip(r)}
                            >
                              {t('accounts.salaries.skip')}
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" variant="tint-grey" onClick={() => void undo(r)}>
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
    </Panel>
  )
}

function RemitForm({
  r,
  onClose,
  onMsg,
}: {
  r: Remittance
  onClose: () => void
  onMsg: (m: Msg) => void
}) {
  const { t } = useTranslation()
  const { payRemittance } = useAccountsActions()
  const [paidOn, setPaidOn] = useState(kigaliToday())
  const [amount, setAmount] = useState(String(r.total))
  const [method, setMethod] = useState<string>('bank')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const agency = t(`accounts.deductions.agencies.${r.agency}`)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const a = Number(amount)
    if (!Number.isFinite(a) || a <= 0)
      return onMsg({ ok: false, text: t('accounts.salaries.errors.paid') })
    try {
      await payRemittance.mutateAsync({
        agency: r.agency,
        month: `${r.month}-01`,
        paidOn,
        amount: Math.round(a),
        method,
        reference,
        note,
      })
      onMsg({
        ok: true,
        text: t('accounts.remittances.paidOk', {
          name: `${agency} ${r.month}`,
          date: formatDate(new Date(paidOn)),
        }),
      })
      onClose()
    } catch (err) {
      onMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <PanelForm title={t('accounts.remittances.payTitle', { name: `${agency} ${r.month}` })}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-ink-3 m-0 text-[13px]">
          {t('accounts.remittances.payHint', {
            withheld: formatRwf(r.employeeTotal),
            employer: formatRwf(r.employerTotal),
          })}
        </p>
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
          <Button variant="primary" type="submit" loading={payRemittance.isPending}>
            <CalendarCheck size={16} aria-hidden="true" />
            {t('accounts.salaries.markPaid')}
          </Button>
          <Button onClick={onClose}>{t('accounts.cancel')}</Button>
        </div>
      </form>
    </PanelForm>
  )
}

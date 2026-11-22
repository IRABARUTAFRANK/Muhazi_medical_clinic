import { useState, type FormEvent } from 'react'
import { ArrowDownToLine } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf } from '@mmc/shared'
import { Empty, Panel } from '@/components/dash/kit'
import { tableCell, tableHead, tableRow } from '@/components/dash/kit-style'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { kindName, useAccountsActions, useIncomes, useMoneyKinds } from '@/lib/api/accounts'
import { useConfirm } from '@/lib/confirm'
import { kigaliToday } from '@/lib/clock'
import { cn } from '@/lib/utils'
import { Note } from './accounts-kit'
import { METHODS, errText, figureAmount, figureLabel, type Msg } from './accounts-tabs'

/**
 * Other money in (0185): what the clinic receives that is not a patient's bill nor a walk-in
 * sale — rent received, a training fee, a donation… — recorded with its kind, who paid and how.
 * Patients' money is never typed here: it is taken at the cash desk.
 */
export function IncomePanel({ i, from, to }: { i: number; from: string; to: string }) {
  const { t } = useTranslation()
  const { data: rows = [], error } = useIncomes(from, to)
  const { data: kinds = [] } = useMoneyKinds()
  const { addIncome, voidIncome } = useAccountsActions()
  const confirm = useConfirm()
  const choices = kinds.filter((k) => k.side === 'in' && !k.code && k.active)
  const [kindId, setKindId] = useState('')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<string>('cash')
  const [receivedOn, setReceivedOn] = useState(kigaliToday())
  const [who, setWho] = useState('')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<Msg | null>(null)
  const chosen = choices.find((k) => k.id === kindId)
  const methodWord = (m: string) => t(`visit.payment.methods.${m}`, { defaultValue: m })
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const a = Number(amount)
    if (!kindId) return setMsg({ ok: false, text: t('accounts.income.errors.kind') })
    if (!Number.isFinite(a) || a <= 0)
      return setMsg({ ok: false, text: t('accounts.income.errors.amount') })
    try {
      await addIncome.mutateAsync({
        kindId,
        amount: Math.round(a),
        method,
        receivedOn,
        from: who,
        reference,
        note,
      })
      setMsg({ ok: true, text: t('accounts.income.added') })
      setAmount('')
      setWho('')
      setReference('')
      setNote('')
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  const undo = async (id: string, what: string) => {
    const why = await confirm({
      title: t('accounts.income.voidTitle', { what }),
      confirmLabel: t('accounts.expenses.voidYes'),
      tone: 'danger',
      input: { label: t('accounts.salaries.reason'), required: true },
    })
    if (!why.ok) return
    try {
      await voidIncome.mutateAsync({ id, reason: why.value })
      setMsg({ ok: true, text: t('accounts.income.voided') })
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  const total = rows.filter((r) => !r.voided).reduce((s, r) => s + r.amount, 0)
  return (
    <Panel
      i={i}
      icon={ArrowDownToLine}
      tint="teal"
      title={t('accounts.income.title')}
      right={
        <span className="text-ink-2 text-[13px] font-semibold">
          {t('accounts.income.total', { amount: formatRwf(total) })}
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-ink-3 m-0 text-[13px]">{t('accounts.income.lead')}</p>
        {msg && <Note msg={msg} />}
        {error && <p className="text-red m-0 text-[14px] font-medium">{error.message}</p>}
        {choices.length === 0 ? (
          <p className="text-ink-2 m-0 text-[14px]">{t('accounts.income.noKinds')}</p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Select
                label={t('accounts.income.kind')}
                value={kindId}
                onChange={(e) => setKindId(e.target.value)}
              >
                <option value="">{t('accounts.income.kindPh')}</option>
                {choices.map((k) => (
                  <option key={k.id} value={k.id}>
                    {kindName(t, k)}
                  </option>
                ))}
              </Select>
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
                label={t('accounts.income.receivedOn')}
                type="date"
                value={receivedOn}
                max={kigaliToday()}
                onChange={(e) => setReceivedOn(e.target.value)}
              />
            </div>
            {chosen?.description && (
              <p className="text-ink-3 m-0 text-[13px]">{chosen.description}</p>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field
                label={t('accounts.income.from')}
                placeholder={t('accounts.income.fromPh')}
                value={who}
                onChange={(e) => setWho(e.target.value)}
              />
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
              loading={addIncome.isPending}
            >
              {t('accounts.income.save')}
            </Button>
          </form>
        )}
        {rows.length === 0 ? (
          <Empty icon={ArrowDownToLine}>{t('accounts.income.none')}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[14px] [&_td]:px-2 [&_th]:px-2">
              <thead className="bg-surface">
                <tr className="border-border border-b">
                  <th className={tableHead}>{t('accounts.income.receivedOn')}</th>
                  <th className={tableHead}>{t('accounts.income.kind')}</th>
                  <th className={tableHead}>{t('accounts.income.from')}</th>
                  <th className={cn(tableHead, 'text-right')}>{t('report.cols.amount')}</th>
                  <th className={tableHead}>{t('report.cols.method')}</th>
                  <th className={tableHead}>{t('report.cols.by')}</th>
                  <th className={tableHead}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={cn(tableRow, r.voided && 'opacity-60')}>
                    <td className={cn(figureLabel, 'whitespace-nowrap')}>
                      {formatDate(new Date(r.receivedOn))}
                    </td>
                    <td className={tableCell}>
                      {r.kind}
                      {r.note && <span className="text-ink-3 block text-[12px]">{r.note}</span>}
                      {r.voided && (
                        <span className="text-red block text-[12px]">
                          {t('accounts.expenses.voidedTag', { why: r.voidReason ?? '' })}
                        </span>
                      )}
                    </td>
                    <td className={tableCell}>{r.from ?? '—'}</td>
                    <td className={cn(figureAmount, 'font-semibold', r.voided && 'line-through')}>
                      {formatRwf(r.amount)}
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
                    <td className={tableCell}>{r.recordedBy ?? '—'}</td>
                    <td className={cn(tableCell, 'text-right')}>
                      {!r.voided && (
                        <Button size="sm" variant="ghost" onClick={() => void undo(r.id, r.kind)}>
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
    </Panel>
  )
}

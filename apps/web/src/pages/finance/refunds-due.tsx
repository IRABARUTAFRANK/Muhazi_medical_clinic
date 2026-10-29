import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, Receipt, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf } from '@mmc/shared'
import { Empty, Panel, Pill } from '@/components/dash/kit'
import { card, focusedForm } from '@/components/dash/kit-style'
import { Button, buttonVariants } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Flash } from '@/components/ui/flash'
import { Select } from '@/components/ui/select'
import { StaffLink } from '@/components/staff/staff-link'
import { useBillingActions } from '@/lib/api/billing'
import { useConfirm } from '@/lib/confirm'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { sampleRefunds, useRefundsDue, type RefundDue } from './refunds-due-data'

type Method = 'cash' | 'momo' | 'airtel'
const METHODS: Method[] = ['cash', 'momo', 'airtel']

/**
 * Money to give back (medicines returned after the bill was posted): each patient, how much, why,
 * and "Give back" with the way of paying it back. Every refund is confirmed and kept under the
 * cashier's name; it is taken off what the cashier holds in the day's count.
 */
export function RefundsDuePanel({ i, canTake }: { i: number; canTake: boolean }) {
  const { t } = useTranslation()
  const { data: list = [], error: loadError } = useRefundsDue()
  const [notice, setNotice] = useState<string | null>(null)
  const total = list.reduce((s, r) => s + r.amount, 0)
  // always on the Bills page: empty, it says where a refund comes from
  return (
    <Panel
      i={i}
      icon={Undo2}
      tint="amber"
      title={t('cashierDesk.refunds.title')}
      right={
        list.length > 0
          ? t('cashierDesk.refunds.total', { count: list.length, amount: formatRwf(total) })
          : undefined
      }
    >
      <p className="text-ink-2 m-0 text-[14px]">{t('cashierDesk.refunds.lead')}</p>
      {loadError && (
        <p
          role="alert"
          className="border-red/30 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium"
        >
          {t('dashboard.loadFailed', { message: loadError.message })}
        </p>
      )}
      {list.length === 0 ? (
        <Empty>{t('cashierDesk.refunds.noneHelp')}</Empty>
      ) : (
        <div className="flex flex-col">
          {list.map((r) => (
            <RefundRow
              key={r.invoiceId}
              r={r}
              canTake={canTake}
              onDone={(amount) =>
                setNotice(
                  t('cashierDesk.refunds.done', { amount: formatRwf(amount), name: r.patient }),
                )
              }
            />
          ))}
        </div>
      )}
      {notice && (
        <Flash key={notice} onClose={() => setNotice(null)}>
          {notice}
        </Flash>
      )}
    </Panel>
  )
}

function RefundRow({
  r,
  canTake,
  onDone,
}: {
  r: RefundDue
  canTake: boolean
  onDone: (amount: number) => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { refund } = useBillingActions(r.encounterId)
  const confirm = useConfirm()
  const [open, setOpen] = useState(false)
  const [method, setMethod] = useState<Method>('cash')
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)
  const needsRef = method !== 'cash'
  const methodName = (m: string) => t(`visit.payment.methods.${m}`, { defaultValue: m })
  const reason =
    r.notes.length > 0
      ? t('cashierDesk.refunds.reason', {
          notes: r.notes.map((n) => [n.number, n.reason].filter(Boolean).join(': ')).join('; '),
        })
      : t('cashierDesk.refunds.reasonPlain')

  const give = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (needsRef && !reference.trim()) return setError(t('visit.payment.errors.reference'))
    if (
      !(await confirm({
        title: t('confirm.visit.refund', {
          amount: formatRwf(r.amount),
          name: r.patient,
          method: methodName(method),
        }),
        body: t('cashierDesk.refunds.confirmBody', { reason }),
        confirmLabel: t('confirm.visit.refundYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await refund.mutateAsync({ method, amount: Math.round(r.amount), reason, reference })
      if (!supabase) {
        const s = sampleRefunds.find((x) => x.invoiceId === r.invoiceId)
        if (s) s.amount = 0
      }
      void qc.invalidateQueries({ queryKey: ['finance'] })
      void qc.invalidateQueries({ queryKey: ['home'] })
      setOpen(false)
      onDone(r.amount)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="border-grid hover:bg-hover -mx-2 flex flex-col gap-2 rounded-md border-b px-2 py-2.5 text-[14px] transition-colors duration-120 last:border-b-0">
      <div className="flex min-h-10 flex-wrap items-center gap-3">
        {r.billNumber && (
          <Pill tint="amber" icon={Receipt}>
            {r.billNumber}
          </Pill>
        )}
        <span className="min-w-[180px] flex-1">
          <span className="block font-medium">{r.patient}</span>
          <span className="text-ink-3 block text-[13px]">
            {[
              r.fileNumber,
              r.phone,
              ...r.notes.map((n) =>
                [n.number, `“${n.reason}”`, formatDate(new Date(n.at))].filter(Boolean).join(' '),
              ),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        <span className="text-amber font-semibold whitespace-nowrap tabular-nums">
          −{formatRwf(r.amount)}
        </span>
        {canTake && !open && (
          <Button size="sm" variant="danger-solid" onClick={() => setOpen(true)}>
            <Undo2 size={14} aria-hidden="true" />
            {t('cashierDesk.refunds.give')}
          </Button>
        )}
        <StaffLink
          to="/app/visit"
          search={{ encounter: r.encounterId }}
          className={buttonVariants({ size: 'sm', variant: 'tint-blue' })}
        >
          <ArrowUpRight size={14} aria-hidden="true" />
          {t('finance.openVisit')}
        </StaffLink>
      </div>
      {open && (
        <form onSubmit={(e) => void give(e)} className={cn(card, 'p-3', focusedForm)}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label={t('visit.refund.method')}
              value={method}
              onChange={(e) => setMethod(e.target.value as Method)}
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {methodName(m)}
                </option>
              ))}
            </Select>
            <Field label={t('visit.payment.amount')} value={formatRwf(r.amount)} readOnly />
          </div>
          {needsRef && (
            <Field
              label={t('visit.payment.reference')}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              required
            />
          )}
          {error && (
            <p
              role="alert"
              className="border-red/30 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium"
            >
              {error}
            </p>
          )}
          <span className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger-solid" loading={refund.isPending}>
              <Undo2 size={16} aria-hidden="true" />
              {t('visit.refund.give', { amount: formatRwf(r.amount) })}
            </Button>
            <Button type="button" variant="tint-grey" onClick={() => setOpen(false)}>
              {t('cashierDesk.counter.back')}
            </Button>
          </span>
        </form>
      )}
    </div>
  )
}

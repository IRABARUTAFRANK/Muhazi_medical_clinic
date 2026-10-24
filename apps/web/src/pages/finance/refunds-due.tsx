import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf } from '@mmc/shared'
import { Empty, Panel, Pill } from '@/components/dash/kit'
import { Button, buttonVariants } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Flash } from '@/components/ui/flash'
import { Select } from '@/components/ui/select'
import { StaffLink } from '@/components/staff/staff-link'
import { useBillingActions } from '@/lib/api/billing'
import { useConfirm } from '@/lib/confirm'
import { supabase } from '@/lib/supabase'
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
  // shown only when something is to give back (or the list could not be read)
  if (list.length === 0 && !loadError && !notice) return null
  return (
    <Panel
      i={i}
      icon={Undo2}
      tint="amber"
      title={t('cashierDesk.refunds.title')}
      right={t('cashierDesk.refunds.total', { count: list.length, amount: formatRwf(total) })}
    >
      <p className="text-ink-2 m-0 text-[13px]">{t('cashierDesk.refunds.lead')}</p>
      {loadError && (
        <p
          role="alert"
          className="bg-red-bg text-red m-0 rounded-xl px-3 py-2 text-[14px] font-semibold"
        >
          {t('dashboard.loadFailed', { message: loadError.message })}
        </p>
      )}
      {list.length === 0 ? (
        <Empty>{t('cashierDesk.refunds.none')}</Empty>
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
    <div className="border-grid flex flex-col gap-2 border-b py-2.5 text-[14px] last:border-b-0">
      <div className="flex flex-wrap items-center gap-3">
        {r.billNumber && <Pill tint="amber">{r.billNumber}</Pill>}
        <span className="min-w-[180px] flex-1">
          <span className="block font-semibold">{r.patient}</span>
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
        <span className="text-amber font-bold whitespace-nowrap tabular-nums">
          −{formatRwf(r.amount)}
        </span>
        {canTake && !open && (
          <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
            <Undo2 size={14} aria-hidden="true" />
            {t('cashierDesk.refunds.give')}
          </Button>
        )}
        <StaffLink
          to="/app/visit"
          search={{ encounter: r.encounterId }}
          className={buttonVariants({ size: 'sm', variant: 'ghost' })}
        >
          {t('finance.openVisit')}
        </StaffLink>
      </div>
      {open && (
        <form
          onSubmit={(e) => void give(e)}
          className="border-border bg-surface flex flex-col gap-3 rounded-xl border p-3"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
              className="bg-red-bg text-red m-0 rounded-xl px-3 py-2 text-[14px] font-semibold"
            >
              {error}
            </p>
          )}
          <span className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={refund.isPending}>
              {t('visit.refund.give', { amount: formatRwf(r.amount) })}
            </Button>
            <Button type="button" onClick={() => setOpen(false)}>
              {t('cashierDesk.counter.back')}
            </Button>
          </span>
        </form>
      )}
    </div>
  )
}

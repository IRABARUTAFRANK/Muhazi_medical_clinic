import { useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import {
  Ban,
  CircleCheck,
  PackageCheck,
  Printer,
  ShoppingBag,
  TriangleAlert,
  Undo2,
  Wallet,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf, formatTime } from '@mmc/shared'
import { Empty, Pill } from '@/components/dash/kit'
import { Panel } from '@/components/dash/kit'
import { card, focusedForm, selectedRow } from '@/components/dash/kit-style'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Flash } from '@/components/ui/flash'
import { Select } from '@/components/ui/select'
import {
  useCounterSaleActions,
  useCounterSales,
  type CounterPaymentMethod,
  type CounterSale,
} from '@/lib/api/counter-sales'
import { useConfirm } from '@/lib/confirm'
import { useLetterhead, usePrintedBy } from '@/lib/report-parts'
import { cn } from '@/lib/utils'
import { openCounterReceipt } from './counter-receipt'

/** The ways a walk-in buyer may pay (take_counter_payment). Every one but cash needs a reference. */
const COUNTER_METHODS: CounterPaymentMethod[] = ['cash', 'momo', 'airtel', 'card', 'bank']

/**
 * Counter sales at the cashier: a walk-in buyer without a visit pays FIRST, then collects the
 * medicines at the pharmacy. The pharmacist usually takes the payment at the pharmacy desk; the
 * sales sent here unpaid wait in this list: the cashier takes the whole total with a receipt, or
 * cancels a sale the buyer no longer wants.
 * Below, the sales paid and still to collect at the pharmacy (the receipt can be printed again).
 */
export function CounterSalesPanel({
  i,
  canTake,
  canCancel,
  highlightId,
  cashier,
}: {
  i: number
  /** May take payments (payment.take). */
  canTake: boolean
  /** May cancel an unpaid sale (payment.take or the manager). */
  canCancel: boolean
  /** A sale opened from a notice (?sale=…): shown first and marked. */
  highlightId?: string | null
  /** The person signed in, printed as who received the money. */
  cashier: string
}) {
  const { t } = useTranslation()
  const { data: open = [], error: loadError } = useCounterSales('open')
  const { data: paid = [] } = useCounterSales('paid')
  const actions = useCounterSaleActions()
  const confirm = useConfirm()
  const letterhead = useLetterhead()
  const printedBy = usePrintedBy()
  const [payingId, setPayingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // a notice's sale comes first and into view
  const waiting = [...open].sort((a, b) =>
    a.id === highlightId ? -1 : b.id === highlightId ? 1 : a.at.localeCompare(b.at),
  )
  const total = open.reduce((s, x) => s + x.total, 0)
  useEffect(() => {
    if (!highlightId) return
    const el = document.getElementById(`sale-${highlightId}`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [highlightId, open.length, paid.length])

  const buyerOf = (s: Pick<CounterSale, 'buyer'>) =>
    s.buyer?.trim() || t('cashierDesk.counter.walkIn')

  const printReceipt = (
    s: CounterSale,
    pay: {
      receipt: string | null
      method: string | null
      amount: number
      reference?: string | null
      at?: string | null
      cashier?: string | null
    },
  ) => {
    const ok = openCounterReceipt(s, pay, letterhead, t, printedBy)
    if (!ok) setError(t('report.popupBlocked'))
  }

  const cancel = async (s: CounterSale) => {
    const r = await confirm({
      title: t('cashierDesk.confirm.cancelSaleTitle', { number: s.number, buyer: buyerOf(s) }),
      body: t('cashierDesk.confirm.cancelSaleBodyAsk'),
      input: { label: t('cashierDesk.counter.cancelWhy'), required: true, multiline: true },
      confirmLabel: t('cashierDesk.confirm.cancelSaleYes'),
      tone: 'danger',
    })
    if (!r.ok) return
    const reason = r.value
    if (reason.length < 3) return setError(t('cashierDesk.counter.cancelWhyShort'))
    setError(null)
    try {
      await actions.cancel.mutateAsync({ saleId: s.id, reason })
      setNotice(t('cashierDesk.counter.cancelled', { number: s.number }))
      if (payingId === s.id) setPayingId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Panel
      i={i}
      icon={ShoppingBag}
      tint="violet"
      title={t('cashierDesk.counter.title')}
      right={t('cashierDesk.counter.waiting', { count: open.length, amount: formatRwf(total) })}
    >
      <p className="text-ink-2 m-0 text-[14px]">{t('cashierDesk.counter.lead')}</p>
      {loadError && (
        <p
          role="alert"
          className="border-red/30 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium"
        >
          {t('dashboard.loadFailed', { message: loadError.message })}
        </p>
      )}
      {waiting.length === 0 ? (
        <Empty>{t('cashierDesk.counter.none')}</Empty>
      ) : (
        <div className="flex flex-col">
          {waiting.map((s, n) => {
            const short = s.lines.filter((l) => l.inStock < l.quantity)
            return (
              <div
                key={s.id}
                id={`sale-${s.id}`}
                className={cn(
                  'border-grid anim-enter -mx-2 flex flex-col gap-2 rounded-md border-b px-2 py-3 text-[14px] transition-colors duration-120 last:border-b-0',
                  s.id === highlightId ? selectedRow : 'hover:bg-hover',
                )}
                style={{ '--i': Math.min(n, 12) } as CSSProperties}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <Pill tint="violet" icon={ShoppingBag}>
                    {s.number}
                  </Pill>
                  <span className="min-w-[180px] flex-1">
                    <span className="block font-medium">{buyerOf(s)}</span>
                    <span className="text-ink-3 block text-[13px]">
                      {[
                        s.phone,
                        t('cashierDesk.counter.writtenBy', {
                          name: s.by ?? '—',
                          time: formatTime(new Date(s.at)),
                        }),
                        s.store,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="text-[16px] font-semibold whitespace-nowrap tabular-nums">
                    {formatRwf(s.total)}
                  </span>
                  {canTake && payingId !== s.id && (
                    <Button
                      size="sm"
                      variant="success"
                      onClick={() => {
                        setError(null)
                        setPayingId(s.id)
                      }}
                    >
                      <Wallet size={14} aria-hidden="true" />
                      {t('home.takePayment')}
                    </Button>
                  )}
                  {canCancel && (
                    <Button
                      size="sm"
                      variant="tint-coral"
                      title={t('cashierDesk.counter.cancel')}
                      aria-label={t('cashierDesk.counter.cancel')}
                      onClick={() => void cancel(s)}
                    >
                      <Ban size={14} aria-hidden="true" />
                    </Button>
                  )}
                </div>
                <ul className="text-ink-2 m-0 flex list-none flex-col gap-0.5 p-0 text-[14px]">
                  {s.lines.map((l) => (
                    <li key={l.itemId} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-ink min-w-0 flex-1">
                        {l.item} × {l.quantity}
                        {l.unit ? ` ${l.unit}` : ''}
                      </span>
                      <span className="tabular-nums">
                        {formatRwf(l.unitPrice)} · <b>{formatRwf(l.lineTotal)}</b>
                      </span>
                    </li>
                  ))}
                </ul>
                {short.length > 0 && (
                  <p className="text-amber m-0 flex items-center gap-1.5 text-[14px] font-semibold">
                    <TriangleAlert size={14} aria-hidden="true" />
                    {t('cashierDesk.counter.short', {
                      list: short.map((l) => `${l.item} (${l.inStock})`).join(', '),
                    })}
                  </p>
                )}
                {s.note && <p className="text-ink-3 m-0 text-[13px]">“{s.note}”</p>}
                {canTake && payingId === s.id && (
                  <CounterPayForm
                    sale={s}
                    buyer={buyerOf(s)}
                    onCancel={() => setPayingId(null)}
                    onPaid={(r, input) => {
                      setPayingId(null)
                      setError(null)
                      setNotice(
                        t('cashierDesk.counter.paid', {
                          receipt: r.receipt ?? '',
                          number: s.number,
                        }),
                      )
                      // the buyer leaves with the receipt to collect at the pharmacy
                      printReceipt(s, {
                        receipt: r.receipt,
                        method: input.method,
                        amount: r.amount,
                        reference: input.reference ?? null,
                        cashier,
                      })
                    }}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {paid.length > 0 && (
        <div className="flex flex-col">
          <span className="text-ink-2 flex items-center gap-1.5 text-[14px] font-semibold">
            <PackageCheck size={14} aria-hidden="true" className="text-green" />
            {t('cashierDesk.counter.toCollect', { count: paid.length })}
          </span>
          {paid.map((s) => (
            <div
              key={s.id}
              id={`sale-${s.id}`}
              className={cn(
                'border-grid -mx-2 flex min-h-10 flex-wrap items-center gap-3 rounded-md border-b px-2 py-2 text-[14px] transition-colors duration-120 last:border-b-0',
                s.id === highlightId ? selectedRow : 'hover:bg-hover',
              )}
            >
              <Pill tint="mint" icon={CircleCheck}>
                {s.number}
              </Pill>
              <span className="min-w-[160px] flex-1">
                <span className="block font-medium">{buyerOf(s)}</span>
                <span className="text-ink-3 block text-[13px]">
                  {[
                    s.receipt,
                    s.method && t(`visit.payment.methods.${s.method}`, { defaultValue: s.method }),
                    s.paidAt && formatTime(new Date(s.paidAt)),
                    s.cashier,
                    t('cashierDesk.counter.atPharmacy'),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <span className="font-semibold whitespace-nowrap tabular-nums">
                {formatRwf(s.total)}
              </span>
              <Button
                size="sm"
                variant="tint-grey"
                title={t('cashierDesk.counter.reprint')}
                aria-label={t('cashierDesk.counter.reprint')}
                onClick={() =>
                  printReceipt(s, {
                    receipt: s.receipt,
                    method: s.method,
                    amount: s.total,
                    at: s.paidAt,
                    cashier: s.cashier,
                  })
                }
              >
                <Printer size={14} aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {(notice || error) && (
        <Flash
          key={notice ?? error ?? ''}
          tone={error ? 'error' : 'success'}
          onClose={() => {
            setNotice(null)
            setError(null)
          }}
        >
          {error ?? notice}
        </Flash>
      )}
    </Panel>
  )
}

/** The payment of a counter sale: always the whole total, by one way of paying. */
function CounterPayForm({
  sale,
  buyer,
  onCancel,
  onPaid,
}: {
  sale: CounterSale
  buyer: string
  onCancel: () => void
  onPaid: (
    r: { receipt: string | null; amount: number },
    input: { method: CounterPaymentMethod; reference?: string },
  ) => void
}) {
  const { t } = useTranslation()
  const { pay } = useCounterSaleActions()
  const confirm = useConfirm()
  const [method, setMethod] = useState<CounterPaymentMethod>('cash')
  const [reference, setReference] = useState('')
  const [phone, setPhone] = useState('')
  const [error, setError] = useState<string | null>(null)
  const needsRef = method !== 'cash'
  const mobile = method === 'momo' || method === 'airtel'
  const methodName = (m: string) => t(`visit.payment.methods.${m}`, { defaultValue: m })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (needsRef && !reference.trim()) return setError(t('visit.payment.errors.reference'))
    if (
      !(await confirm({
        title: t('cashierDesk.confirm.payTitle', {
          amount: formatRwf(sale.total),
          buyer,
          number: sale.number,
          method: methodName(method),
        }),
        body: t('cashierDesk.confirm.payBody'),
        confirmLabel: t('cashierDesk.confirm.payYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      const r = await pay.mutateAsync({
        saleId: sale.id,
        method,
        reference: needsRef ? reference : undefined,
        payerPhone: mobile ? phone : undefined,
      })
      onPaid(
        { receipt: r.receipt, amount: r.amount },
        { method, reference: needsRef ? reference.trim() : undefined },
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className={cn(card, 'p-3', focusedForm)}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label={t('visit.payment.method')}
          value={method}
          onChange={(e) => setMethod(e.target.value as CounterPaymentMethod)}
        >
          {COUNTER_METHODS.map((m) => (
            <option key={m} value={m}>
              {methodName(m)}
            </option>
          ))}
        </Select>
        <Field label={t('visit.payment.amount')} value={formatRwf(sale.total)} readOnly />
      </div>
      {needsRef && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t('visit.payment.reference')}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            required
          />
          {mobile && (
            <Field
              label={t('visit.payment.phone')}
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={sale.phone ?? '07xx xxx xxx'}
            />
          )}
        </div>
      )}
      <p className="text-ink-3 m-0 text-[13px]">{t('cashierDesk.counter.payNote')}</p>
      {error && (
        <p
          role="alert"
          className="border-red/30 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium"
        >
          {error}
        </p>
      )}
      <span className="flex flex-wrap gap-2">
        <Button type="submit" variant="success" loading={pay.isPending}>
          <Wallet size={16} aria-hidden="true" />
          {t('visit.payment.take', { amount: formatRwf(sale.total) })}
        </Button>
        <Button type="button" variant="tint-grey" onClick={onCancel}>
          <Undo2 size={16} aria-hidden="true" />
          {t('cashierDesk.counter.back')}
        </Button>
      </span>
    </form>
  )
}

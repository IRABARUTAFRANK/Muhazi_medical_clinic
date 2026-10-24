import { useState } from 'react'
import { Ban, HandCoins, PackageCheck, Receipt, Send } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf, formatTime } from '@mmc/shared'
import type { StaffUser } from '@mmc/shared'
import { Empty, Panel } from '@/components/dash/kit'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Flash } from '@/components/ui/flash'
import { Select } from '@/components/ui/select'
import { ShownList } from '@/components/ui/list-tools'
import {
  useCounterSaleActions,
  useCounterSales,
  type CounterPaymentMethod,
  type CounterSale,
} from '@/lib/api/counter-sales'
import { useCan } from '@/lib/api/permissions'
import { usePharmacyDesk, useStockOverview } from '@/lib/api/stock'
import { useConfirm } from '@/lib/confirm'
import { useNow } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import { useSession } from '@/store/session'
import { useHanded } from './handed'
import { useSearchParam } from './hooks'
import { HandedStrip, LinesEditor, ReasonBox } from './parts'
import {
  dayOf,
  errText,
  itemName,
  needsReference,
  newLine,
  qty,
  usableIn,
  type EditLine,
} from './util'

const METHODS: CounterPaymentMethod[] = ['cash', 'momo', 'airtel', 'card', 'bank']
type Msg = { ok: boolean; text: string } | null

/**
 * Counter sales: a walk-in buyer without a visit pays FIRST, then collects. The pharmacy writes
 * the sale at cash prices (expired stock is never offered) and sends it to the cashier; once it
 * is paid, the pharmacy hands the medicines over (earliest expiry first). Someone allowed to take
 * payments may take it here and hand over at once.
 */
export function CounterSalesPanel() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <CounterSales user={user} />
}

function CounterSales({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const canTake = useCan(user)('payment.take')
  const now = useNow(60_000)
  const today = dayOf(now)
  const { data: stock } = useStockOverview()
  const { data: desk } = usePharmacyDesk(null)
  const { data: sales = [] } = useCounterSales(null)
  const actions = useCounterSaleActions()
  const confirm = useConfirm()
  const addHanded = useHanded((s) => s.add)
  const focusSale = useSearchParam('sale')

  const [lines, setLines] = useState<EditLine[]>(() => [newLine()])
  const [buyer, setBuyer] = useState('')
  const [phone, setPhone] = useState('')
  const [note, setNote] = useState('')
  const [storeChoice, setStoreChoice] = useState('')
  const [payNow, setPayNow] = useState(false)
  const [method, setMethod] = useState<CounterPaymentMethod>('cash')
  const [reference, setReference] = useState('')
  const [msg, setMsg] = useState<Msg>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [paying, setPaying] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  const stores = desk?.stores ?? []
  const storeId =
    storeChoice ||
    desk?.locationId ||
    stock?.mainPharmacyId ||
    stock?.locations.find((l) => l.type === 'pharmacy')?.id ||
    ''
  // only medicines with a price and unexpired units in the store are offered
  const items = (stock?.items ?? []).filter(
    (i) => i.active && i.sellingPrice != null && usableIn(i, storeId) > 0,
  )
  const byId = new Map(items.map((i) => [i.id, i]))
  const chosen = lines.filter((l) => l.itemId && qty(l.quantity) > 0)
  const total = chosen.reduce(
    (s, l) => s + (byId.get(l.itemId)?.sellingPrice ?? 0) * qty(l.quantity),
    0,
  )
  const tooMany = chosen.some((l) => {
    const i = byId.get(l.itemId)
    return !i || qty(l.quantity) > usableIn(i, storeId)
  })
  const refMissing = payNow && needsReference(method) && reference.trim().length < 3
  const ready = chosen.length > 0 && !tooMany && !refMissing

  const handOverAndLabel = async (saleId: string) => {
    const r = await actions.handOver.mutateAsync(saleId)
    for (const l of r.lines) {
      const batchNos = [...new Set(l.batches.map((b) => b.batchNo).filter(Boolean))]
      const expiries = l.batches.map((b) => b.expiry).filter(Boolean) as string[]
      expiries.sort()
      const it = stock?.items.find((x) => x.id === l.itemId)
      addHanded(
        {
          key: r.id,
          kind: 'sale',
          patient: { name: r.buyer || t('counterSale.walkIn'), fileNumber: r.number },
        },
        {
          item: l.item,
          quantity: l.quantity,
          unit: it?.unit ?? null,
          dose: null,
          frequency: null,
          days: null,
          instructions: null,
          batchNo: batchNos.length ? batchNos.join(' / ') : null,
          expiry: expiries[0] ?? null,
          ref: r.number,
        },
      )
    }
    return r
  }

  const reset = () => {
    setLines([newLine()])
    setBuyer('')
    setPhone('')
    setNote('')
    setReference('')
    setPayNow(false)
  }

  const submit = async () => {
    if (!ready) return
    const who = buyer.trim() || t('counterSale.walkIn')
    if (
      !(await confirm(
        payNow
          ? {
              title: t('confirm.counterSale.payTitle', {
                amount: formatRwf(total),
                buyer: who,
              }),
              body: t('confirm.counterSale.payBody', {
                method: t(`visit.payment.methods.${method}`),
                count: chosen.length,
              }),
              confirmLabel: t('confirm.counterSale.payYes'),
              tone: 'danger',
            }
          : {
              title: t('confirm.counterSale.sendTitle', {
                count: chosen.length,
                amount: formatRwf(total),
                buyer: who,
              }),
              body: t('confirm.counterSale.sendBody'),
              confirmLabel: t('confirm.counterSale.sendYes'),
            },
      ))
    )
      return
    setMsg(null)
    setWorking(true)
    try {
      const s = await actions.create.mutateAsync({
        lines: chosen.map((l) => ({ itemId: l.itemId, quantity: qty(l.quantity) })),
        buyerName: buyer,
        buyerPhone: phone,
        locationId: storeChoice || null,
        note,
      })
      if (!payNow) {
        setMsg({
          ok: true,
          text: t('counterSale.sent', { number: s.number, amount: formatRwf(s.total) }),
        })
        reset()
        return
      }
      try {
        const p = await actions.pay.mutateAsync({
          saleId: s.id,
          method,
          reference,
          payerPhone: phone,
        })
        await handOverAndLabel(s.id)
        setMsg({
          ok: true,
          text: t('counterSale.paidHanded', {
            number: s.number,
            receipt: p.receipt ?? '',
            amount: formatRwf(p.amount),
          }),
        })
        reset()
      } catch (e) {
        // the sale is written: it waits in the list below (payment or hand-over to finish)
        setMsg({
          ok: false,
          text: t('counterSale.halfDone', { number: s.number, error: errText(e) }),
        })
        reset()
      }
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    } finally {
      setWorking(false)
    }
  }

  const handOver = async (s: CounterSale) => {
    if (
      !(await confirm({
        title: t('confirm.counterSale.handOverTitle', {
          number: s.number,
          buyer: s.buyer || t('counterSale.walkIn'),
        }),
        body: t('confirm.counterSale.handOverBody', { count: s.lines.length }),
        confirmLabel: t('confirm.stock.handOverYes'),
      }))
    )
      return
    setMsg(null)
    try {
      await handOverAndLabel(s.id)
      setMsg({ ok: true, text: t('counterSale.handed', { number: s.number }) })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    }
  }

  const cancel = async (s: CounterSale, reason: string) => {
    if (
      !(await confirm({
        title: t('confirm.counterSale.cancelTitle', {
          number: s.number,
          buyer: s.buyer || t('counterSale.walkIn'),
        }),
        body: t('confirm.counterSale.cancelBody', { reason }),
        confirmLabel: t('confirm.counterSale.cancelYes'),
        tone: 'danger',
      }))
    )
      return
    setMsg(null)
    try {
      await actions.cancel.mutateAsync({ saleId: s.id, reason })
      setCancelling(null)
      setMsg({ ok: true, text: t('counterSale.cancelled', { number: s.number }) })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    }
  }

  const payOpen = async (s: CounterSale, m: CounterPaymentMethod, ref: string) => {
    if (
      !(await confirm({
        title: t('confirm.counterSale.payTitle', {
          amount: formatRwf(s.total),
          buyer: s.buyer || t('counterSale.walkIn'),
        }),
        body: t('confirm.counterSale.payBody', {
          method: t(`visit.payment.methods.${m}`),
          count: s.lines.length,
        }),
        confirmLabel: t('confirm.counterSale.payYes'),
        tone: 'danger',
      }))
    )
      return
    setMsg(null)
    try {
      const p = await actions.pay.mutateAsync({ saleId: s.id, method: m, reference: ref })
      setPaying(null)
      setMsg({
        ok: true,
        text: t('counterSale.paid', { number: s.number, receipt: p.receipt ?? '' }),
      })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    }
  }

  // waiting ones first (to pay, to hand over), then today's finished ones
  const rank = (s: CounterSale) => (s.status === 'paid' ? 0 : s.status === 'open' ? 1 : 2)
  const shown = sales
    .filter((s) => s.status === 'open' || s.status === 'paid' || s.at.slice(0, 10) === today)
    .sort((a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at))
  const toPay = sales.filter((s) => s.status === 'open').length
  const toHand = sales.filter((s) => s.status === 'paid').length

  return (
    <Panel
      i={3}
      icon={Receipt}
      tint="amber"
      title={t('counterSale.title')}
      right={t('counterSale.waiting', { toPay, toHand })}
    >
      <p className="text-ink-2 m-0 text-[13px]">{t('counterSale.lead')}</p>
      {msg && (
        <Flash key={msg.text} tone={msg.ok ? 'success' : 'error'} onClose={() => setMsg(null)}>
          {msg.text}
        </Flash>
      )}
      <HandedStrip
        kind="sale"
        onBlocked={() => setMsg({ ok: false, text: t('report.popupBlocked') })}
      />
      <div className="flex flex-col gap-3">
        {stores.length > 1 && (
          <Select
            label={t('pharmacy.dispensingStore')}
            value={storeChoice}
            onChange={(e) => setStoreChoice(e.target.value)}
          >
            <option value="">
              {t('pharmacy.mainStoreNamed', {
                name: stores.find((s) => s.isMain)?.name ?? t('pharmacy.mainStore'),
              })}
            </option>
            {stores
              .filter((s) => !s.isMain)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </Select>
        )}
        <LinesEditor
          lines={lines}
          onChange={setLines}
          options={items.map((i) => ({
            value: i.id,
            label: `${itemName(i)} · ${formatRwf(i.sellingPrice ?? 0)} · ${t('stock.inPharmacy', { count: usableIn(i, storeId) })}`,
          }))}
          below={(l) => {
            const i = byId.get(l.itemId)
            if (!i) return null
            const n = qty(l.quantity)
            const have = usableIn(i, storeId)
            return (
              <span
                className={cn('text-[12px]', n > have ? 'text-red font-semibold' : 'text-ink-3')}
              >
                {n > have
                  ? t('counterSale.short', { count: have })
                  : t('counterSale.lineTotal', {
                      price: formatRwf(i.sellingPrice ?? 0),
                      amount: formatRwf((i.sellingPrice ?? 0) * n),
                    })}
              </span>
            )
          }}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label={t('counterSale.buyer')}
            value={buyer}
            onChange={(e) => setBuyer(e.target.value)}
            placeholder={t('counterSale.buyerPh')}
          />
          <Field
            label={t('counterSale.phone')}
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <Field
          label={t('counterSale.note')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <p className="m-0 text-[15px] font-bold">
          {t('counterSale.total', { amount: formatRwf(total) })}
        </p>
        {canTake && (
          <label className="text-ink-2 flex items-center gap-2 text-[13px] font-semibold">
            <input type="checkbox" checked={payNow} onChange={(e) => setPayNow(e.target.checked)} />
            {t('counterSale.payHere')}
          </label>
        )}
        {canTake && payNow && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select
              label={t('visit.payment.method')}
              value={method}
              onChange={(e) => setMethod(e.target.value as CounterPaymentMethod)}
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`visit.payment.methods.${m}`)}
                </option>
              ))}
            </Select>
            {needsReference(method) && (
              <Field
                label={t('visit.payment.reference')}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                required
              />
            )}
          </div>
        )}
        <Button
          variant="primary"
          className="self-start"
          disabled={!ready || working}
          loading={working}
          onClick={() => void submit()}
        >
          {payNow ? (
            <HandCoins size={16} aria-hidden="true" />
          ) : (
            <Send size={16} aria-hidden="true" />
          )}
          {payNow ? t('counterSale.payAndHand') : t('counterSale.sendToCashier')}
        </Button>
      </div>

      <h4 className="m-0 mt-1 text-[14px] font-bold">{t('counterSale.listTitle')}</h4>
      {shown.length === 0 ? (
        <Empty icon={Receipt}>{t('counterSale.none')}</Empty>
      ) : (
        <ShownList items={shown} step={5}>
          {(list) => (
            <div className="flex flex-col gap-2">
              {list.map((s) => (
                <div
                  key={s.id}
                  className={cn(
                    'bg-surface/70 flex flex-col gap-1.5 rounded-lg px-3 py-2',
                    focusSale === s.id && 'ring-primary ring-2',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-[180px] flex-1 text-[13px]">
                      <span className="text-ink block font-semibold">
                        {s.number} · {s.buyer || t('counterSale.walkIn')}
                        {s.phone ? ` · ${s.phone}` : ''}
                      </span>
                      <span className="text-ink-3 block text-[12px]">
                        {s.lines.map((l) => `${l.item} × ${l.quantity}`).join('; ')}
                      </span>
                      <span className="text-ink-3 block text-[12px]">
                        {[
                          formatTime(new Date(s.at)),
                          s.by,
                          s.receipt && t('counterSale.receipt', { receipt: s.receipt }),
                          s.cancelReason && t('counterSale.why', { reason: s.cancelReason }),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <span className="text-[14px] font-bold tabular-nums">{formatRwf(s.total)}</span>
                    <Badge
                      tone={
                        s.status === 'open'
                          ? 'yellow'
                          : s.status === 'paid'
                            ? 'blue'
                            : s.status === 'handed_over'
                              ? 'green'
                              : 'grey'
                      }
                    >
                      {t(`counterSale.status.${s.status}`)}
                    </Badge>
                    {s.status === 'paid' && (
                      <Button
                        size="sm"
                        variant="primary"
                        loading={actions.handOver.isPending && actions.handOver.variables === s.id}
                        disabled={actions.handOver.isPending}
                        onClick={() => void handOver(s)}
                      >
                        <PackageCheck size={14} aria-hidden="true" />
                        {t('stock.handOver')}
                      </Button>
                    )}
                    {s.status === 'open' && canTake && (
                      <Button size="sm" onClick={() => setPaying(paying === s.id ? null : s.id)}>
                        <HandCoins size={14} aria-hidden="true" />
                        {t('counterSale.takePayment')}
                      </Button>
                    )}
                    {s.status === 'open' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setCancelling(cancelling === s.id ? null : s.id)}
                      >
                        <Ban size={14} aria-hidden="true" />
                        {t('counterSale.cancel')}
                      </Button>
                    )}
                  </div>
                  {s.status === 'open' && !canTake && (
                    <span className="text-ink-3 text-[12px]">{t('counterSale.waitCashier')}</span>
                  )}
                  {paying === s.id && (
                    <PayForm
                      busy={actions.pay.isPending}
                      onPay={(m, ref) => void payOpen(s, m, ref)}
                      onCancel={() => setPaying(null)}
                    />
                  )}
                  {cancelling === s.id && (
                    <ReasonBox
                      title={t('counterSale.cancelWhy')}
                      choices={[t('counterSale.reasons.left'), t('counterSale.reasons.mistake')]}
                      confirmLabel={t('counterSale.cancelConfirm')}
                      busy={actions.cancel.isPending}
                      onConfirm={(reason) => void cancel(s, reason)}
                      onCancel={() => setCancelling(null)}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </ShownList>
      )}
    </Panel>
  )
}

function PayForm({
  busy,
  onPay,
  onCancel,
}: {
  busy: boolean
  onPay: (method: CounterPaymentMethod, reference: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [method, setMethod] = useState<CounterPaymentMethod>('cash')
  const [reference, setReference] = useState('')
  const missing = needsReference(method) && reference.trim().length < 3
  return (
    <div className="border-border bg-card flex flex-col gap-2 rounded-lg border p-2.5">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Select
          label={t('visit.payment.method')}
          value={method}
          onChange={(e) => setMethod(e.target.value as CounterPaymentMethod)}
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {t(`visit.payment.methods.${m}`)}
            </option>
          ))}
        </Select>
        {needsReference(method) && (
          <Field
            label={t('visit.payment.reference')}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        )}
      </div>
      <span className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={missing || busy}
          loading={busy}
          onClick={() => onPay(method, reference.trim())}
        >
          {t('counterSale.takePayment')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('staff.form.cancel')}
        </Button>
      </span>
    </div>
  )
}

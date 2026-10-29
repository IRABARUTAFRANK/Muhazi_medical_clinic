import { useState } from 'react'
import { Ban, HandCoins, Hourglass, PackageCheck, Printer, Receipt, Send } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf, formatTime } from '@mmc/shared'
import type { StaffUser } from '@mmc/shared'
import { Empty, Panel, SectionTitle } from '@/components/dash/kit'
import { card, selectedRow } from '@/components/dash/kit-style'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Flash } from '@/components/ui/flash'
import { Select } from '@/components/ui/select'
import { ShownList } from '@/components/ui/list-tools'
import {
  receiptLines,
  useCounterSaleActions,
  useCounterSales,
  type CounterPaymentMethod,
  type CounterSale,
} from '@/lib/api/counter-sales'
import { useCan } from '@/lib/api/permissions'
import { usePharmacyDesk, useStockOverview } from '@/lib/api/stock'
import { useSessionCanDesk } from '@/components/clinical/session-desks'
import { useConfirm } from '@/lib/confirm'
import { useNow } from '@/lib/hooks'
import { useLetterhead, usePrintedBy } from '@/lib/report-parts'
import { cn } from '@/lib/utils'
import { useSession } from '@/store/session'
import { openCounterReceipt } from '../../finance/counter-receipt'
import { useHanded } from './handed'
import { useSearchParam } from './hooks'
import { HandedStrip, LinesEditor, ReasonBox } from './parts'
import {
  breakdownText,
  cashCost,
  piecesAndPacks,
  priceLineText,
  wholePacksText,
} from '../stock-util'
import {
  dayOf,
  errText,
  itemName,
  linePieces,
  needsReference,
  newLine,
  usableIn,
  type EditLine,
} from './util'

const METHODS: CounterPaymentMethod[] = ['cash', 'momo', 'airtel', 'card', 'bank']
type Msg = { ok: boolean; text: string } | null

/**
 * Counter sales: a walk-in buyer without a visit pays FIRST, then collects. The pharmacist writes
 * the sale at cash prices (expired stock is never offered), takes the payment here (counter sales
 * only: visit bills stay with the cashier), hands the medicines over (earliest expiry first) and
 * prints the receipt. The payment counts in the pharmacist's own cash count and in the day's
 * revenue. A sale may still be sent to the cashier instead; the cashier's list keeps working.
 */
export function CounterSalesPanel() {
  const user = useSession((s) => s.user)
  if (!user) return null
  return <CounterSales user={user} />
}

function CounterSales({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  // the pharmacy desk takes the payment of its own counter sales (take_counter_payment)
  const canDesk = useSessionCanDesk()
  const canTake = useCan(user)('payment.take') || canDesk('pharmacy')
  const letterhead = useLetterhead()
  const printedBy = usePrintedBy()
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
  const [method, setMethod] = useState<CounterPaymentMethod>('cash')
  const [reference, setReference] = useState('')
  const [payerPhone, setPayerPhone] = useState('')
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
  /** The pieces a line sells (typed in pieces or in packs). */
  const pieces = (l: EditLine) => linePieces(l, byId.get(l.itemId)?.packSize)
  const chosen = lines.filter((l) => l.itemId && pieces(l) > 0)
  // priced by how the medicine is sold (0107), as the database charges it: whole packs at the
  // pack price, the pieces at the piece price
  const lineCost = (l: EditLine) => cashCost(pieces(l), byId.get(l.itemId) ?? {})
  const total = chosen.reduce((s, l) => s + lineCost(l).total, 0)
  const tooMany = chosen.some((l) => {
    const i = byId.get(l.itemId)
    return !i || pieces(l) > usableIn(i, storeId) || !lineCost(l).ok
  })
  const refMissing = needsReference(method) && reference.trim().length < 3
  const mobile = method === 'momo' || method === 'airtel'
  const ready = chosen.length > 0 && !tooMany

  /** The receipt of a paid sale, in a print window (blocked window: said in the message). */
  const printReceipt = (
    sale: Pick<CounterSale, 'number' | 'buyer' | 'phone' | 'total' | 'lines'>,
    pay: {
      receipt: string | null
      method: string | null
      amount: number
      reference?: string | null
      at?: string | null
      cashier?: string | null
    },
  ) => {
    // a line charged by the pack prints as "… · B/20 × packs at the pack price"
    const ok = openCounterReceipt(
      { ...sale, lines: receiptLines(sale.lines) },
      pay,
      letterhead,
      t,
      printedBy,
    )
    if (!ok) setMsg({ ok: false, text: t('report.popupBlocked') })
  }

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
          packSize: it?.packSize ?? null,
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
    setPayerPhone('')
    setMethod('cash')
  }

  /** Writes the sale; with payNow the pharmacist takes the payment, hands over and prints. */
  const submit = async (payNow: boolean) => {
    if (!ready || (payNow && refMissing)) return
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
        // always in pieces: packs × pieces per pack
        lines: chosen.map((l) => ({ itemId: l.itemId, quantity: pieces(l) })),
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
      // what the receipt lists: the lines as written, at cash prices
      const receiptSale = {
        number: s.number,
        buyer: buyer.trim() || null,
        phone: phone.trim() || null,
        total: s.total,
        lines: chosen.map((l) => {
          const i = byId.get(l.itemId)
          const price = i?.sellingPrice ?? 0
          const c = lineCost(l)
          return {
            itemId: l.itemId,
            item: i ? itemName(i) : l.itemId,
            unit: i?.unit ?? null,
            quantity: pieces(l),
            unitPrice: price,
            lineTotal: c.total,
            inStock: 0,
            packSize: i?.packSize ?? null,
            packs: c.byPack ? c.packs : null,
            packPrice: c.byPack ? c.packPrice : null,
            byPack: c.byPack,
            pieces: c.pieces,
          }
        }),
      }
      try {
        const ref = needsReference(method) ? reference.trim() : undefined
        const p = await actions.pay.mutateAsync({
          saleId: s.id,
          method,
          reference: ref,
          payerPhone: mobile ? payerPhone.trim() || phone.trim() : undefined,
        })
        // the buyer leaves with the receipt; the labels are printed from the strip above
        printReceipt(receiptSale, {
          receipt: p.receipt,
          method,
          amount: p.amount,
          reference: ref ?? null,
          cashier: user.name,
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

  const payOpen = async (s: CounterSale, m: CounterPaymentMethod, ref: string, payer: string) => {
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
      const p = await actions.pay.mutateAsync({
        saleId: s.id,
        method: m,
        reference: needsReference(m) ? ref : undefined,
        payerPhone: payer || undefined,
      })
      setPaying(null)
      printReceipt(s, {
        receipt: p.receipt,
        method: m,
        amount: p.amount,
        reference: needsReference(m) ? ref : null,
        cashier: user.name,
      })
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
      tint="teal"
      title={t('counterSale.title')}
      right={t('counterSale.waiting', { toPay, toHand })}
    >
      <p className="text-ink-2 m-0 text-[14px]">
        {canTake ? t('counterSale.desk.lead') : t('counterSale.lead')}
      </p>
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
          itemOf={(id) => byId.get(id)}
          below={(l) => {
            const i = byId.get(l.itemId)
            if (!i) return null
            const n = pieces(l)
            const have = usableIn(i, storeId)
            const c = lineCost(l)
            return (
              <span
                className={cn(
                  'text-[12px]',
                  n > have || !c.ok ? 'text-red font-semibold' : 'text-ink-2 font-medium',
                )}
              >
                {n > have
                  ? `${t('counterSale.short', { count: have })} · ${piecesAndPacks(t, have, i)}`
                  : !c.ok
                    ? wholePacksText(t, n, i)
                    : priceLineText(t, c, i, formatRwf)}
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
        <p className="m-0 text-[16px] font-semibold">
          {t('counterSale.total', { amount: formatRwf(total) })}
        </p>
        {canTake ? (
          <div className="border-green/30 bg-green-bg/40 flex flex-col gap-3 rounded-md border p-3">
            <span className="text-ink flex items-center gap-1.5 text-[14px] font-semibold">
              <HandCoins size={16} aria-hidden="true" className="text-green" />
              {t('counterSale.desk.payTitle')}
            </span>
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
              {mobile && (
                <Field
                  label={t('visit.payment.phone')}
                  type="tel"
                  value={payerPhone}
                  onChange={(e) => setPayerPhone(e.target.value)}
                  placeholder={phone.trim() || '07xx xxx xxx'}
                />
              )}
            </div>
            <span className="flex flex-wrap items-center gap-2">
              <Button
                variant="success"
                disabled={!ready || refMissing || working}
                loading={working}
                onClick={() => void submit(true)}
                title={refMissing && ready ? t('visit.payment.errors.reference') : undefined}
              >
                {!working && <HandCoins size={16} aria-hidden="true" />}
                {t('counterSale.desk.payHandPrint', { amount: formatRwf(total) })}
              </Button>
              <Button
                variant="tint-grey"
                disabled={!ready || working}
                onClick={() => void submit(false)}
              >
                <Send size={16} aria-hidden="true" />
                {t('counterSale.sendToCashier')}
              </Button>
            </span>
            <span className="text-ink-3 text-[12px]">{t('counterSale.desk.payNote')}</span>
          </div>
        ) : (
          <Button
            variant="primary"
            className="self-start"
            disabled={!ready || working}
            loading={working}
            onClick={() => void submit(false)}
          >
            {!working && <Send size={16} aria-hidden="true" />}
            {t('counterSale.sendToCashier')}
          </Button>
        )}
      </div>

      <SectionTitle icon={Receipt}>{t('counterSale.listTitle')}</SectionTitle>
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
                    card,
                    'gap-1.5 px-3 py-2',
                    focusSale === s.id && cn('border-primary', selectedRow),
                  )}
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-[180px] flex-1 text-[14px]">
                      <span className="text-ink block font-semibold">
                        {s.number} · {s.buyer || t('counterSale.walkIn')}
                        {s.phone ? ` · ${s.phone}` : ''}
                      </span>
                      <span className="text-ink-3 block text-[12px]">
                        {s.lines
                          .map((l) =>
                            l.byPack && l.packs
                              ? `${l.item} × ${breakdownText(
                                  t,
                                  {
                                    packs: l.packs,
                                    pieces: l.pieces ?? l.quantity - l.packs * (l.packSize ?? 1),
                                    size: l.packSize ?? null,
                                  },
                                  l,
                                )}`
                              : `${l.item} × ${l.quantity}${l.unit ? ` ${l.unit}` : ''}`,
                          )
                          .join('; ')}
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
                    <span className="text-[14px] font-semibold tabular-nums">
                      {formatRwf(s.total)}
                    </span>
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
                      icon={
                        s.status === 'open' ? (
                          <Hourglass size={12} aria-hidden="true" />
                        ) : s.status === 'paid' ? (
                          <HandCoins size={12} aria-hidden="true" />
                        ) : s.status === 'handed_over' ? (
                          <PackageCheck size={12} aria-hidden="true" />
                        ) : (
                          <Ban size={12} aria-hidden="true" />
                        )
                      }
                    >
                      {t(`counterSale.status.${s.status}`)}
                    </Badge>
                    {s.status === 'paid' && (
                      <Button
                        size="sm"
                        variant="success"
                        loading={actions.handOver.isPending && actions.handOver.variables === s.id}
                        disabled={actions.handOver.isPending}
                        onClick={() => void handOver(s)}
                      >
                        <PackageCheck size={14} aria-hidden="true" />
                        {t('stock.handOver')}
                      </Button>
                    )}
                    {(s.status === 'paid' || s.status === 'handed_over') && s.receipt && (
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
                    )}
                    {s.status === 'open' && canTake && (
                      <Button
                        size="sm"
                        variant="tint-mint"
                        onClick={() => setPaying(paying === s.id ? null : s.id)}
                      >
                        <HandCoins size={14} aria-hidden="true" />
                        {t('counterSale.takePayment')}
                      </Button>
                    )}
                    {s.status === 'open' && (
                      <Button
                        size="sm"
                        variant="tint-coral"
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
                      phone={s.phone}
                      onPay={(m, ref, payer) => void payOpen(s, m, ref, payer)}
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
  phone,
  onPay,
  onCancel,
}: {
  busy: boolean
  /** The buyer's phone written on the sale (the paying phone by default). */
  phone: string | null
  onPay: (method: CounterPaymentMethod, reference: string, payerPhone: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [method, setMethod] = useState<CounterPaymentMethod>('cash')
  const [reference, setReference] = useState('')
  const [payer, setPayer] = useState('')
  const missing = needsReference(method) && reference.trim().length < 3
  const mobile = method === 'momo' || method === 'airtel'
  return (
    <div className={cn(card, 'gap-2 p-2.5')}>
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
        {mobile && (
          <Field
            label={t('visit.payment.phone')}
            type="tel"
            value={payer}
            onChange={(e) => setPayer(e.target.value)}
            placeholder={phone ?? '07xx xxx xxx'}
          />
        )}
      </div>
      <span className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="success"
          disabled={missing || busy}
          loading={busy}
          onClick={() =>
            onPay(method, reference.trim(), mobile ? payer.trim() || (phone ?? '') : '')
          }
        >
          {!busy && <HandCoins size={14} aria-hidden="true" />}
          {t('counterSale.takePayment')}
        </Button>
        <Button size="sm" variant="tint-grey" onClick={onCancel}>
          {t('staff.form.cancel')}
        </Button>
      </span>
    </div>
  )
}

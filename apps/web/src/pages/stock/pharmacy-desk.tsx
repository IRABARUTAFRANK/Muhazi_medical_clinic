import { useState, type CSSProperties, type FormEvent, type MouseEvent } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowRightLeft,
  Ban,
  FolderOpen,
  PackageCheck,
  PackagePlus,
  Pill,
  Printer,
  ShoppingBag,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { openDispenseLabels } from '@/lib/dispense-label'
import { useLetterhead } from '@/lib/report-parts'
import { useConfirm } from '@/lib/confirm'
import { formatRwf, formatTime } from '@mmc/shared'
import { Empty, Panel } from '@/components/dash/kit'
import { Badge } from '@/components/ui/badge'
import { Reveal } from '@/components/ui/reveal'
import { Button, buttonVariants } from '@/components/ui/button'
import { Flash } from '@/components/ui/flash'
import { ShownList } from '@/components/ui/list-tools'
import { StaffLink } from '@/components/staff/staff-link'
import {
  usePharmacyQueue,
  useStockActions,
  useStockOverview,
  type PharmacyLine,
  type StockItem,
} from '@/lib/api/stock'
import { cn } from '@/lib/utils'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { SearchSelect } from '@/components/ui/search-select'
import type { OpenStock, StockPreset } from './stock-page'

/** Usual reasons a medicine is not handed over; the pharmacist may also type their own. */
const REASONS = ['outOfStock', 'boughtElsewhere', 'refused'] as const

/**
 * The pharmacy hand-over: prescriptions waiting, one card per patient (the doctor who prescribed,
 * what it costs, what is in the pharmacy store). Each medicine is handed over (taken from stock
 * and charged on the bill) or marked "not given" with the reason, which the doctor is told.
 * When the last medicine of a patient is done the patient goes on to the cashier.
 */
export function PharmacyDesk({
  canDispense,
  step = 6,
  encounterId,
  onOpenStock,
}: {
  canDispense: boolean
  step?: number
  /** Only this visit's medicines (the visit screen of a pharmacist). */
  encounterId?: string
  /** On the stock page: open Receive / Send there instead of following the link. */
  onOpenStock?: OpenStock
}) {
  const { t } = useTranslation()
  const letterhead = useLetterhead()
  const { data: all = [] } = usePharmacyQueue()
  // the pharmacy store, for a database that does not send it with each line yet (before 0078)
  const { data: stock } = useStockOverview()
  const pharmacyStore = stock?.locations.find((l) => l.type === 'pharmacy')?.id
  // a link to Receive / Send with the medicine and the store filled in
  const stockLink = (tab: 'receive' | 'send', preset: StockPreset, primary: boolean) => ({
    to: '/app/stock' as const,
    search: { tab, ...preset },
    className: buttonVariants({ size: 'sm', variant: primary ? 'primary' : 'default' }),
    onClick: (e: MouseEvent) => {
      // a plain click on the stock page itself switches the tab there
      if (!onOpenStock || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return
      e.preventDefault()
      onOpenStock(tab, preset)
    },
  })
  const queue = encounterId ? all.filter((q) => q.encounterId === encounterId) : all
  const actions = useStockActions()
  const confirm = useConfirm()
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [refusing, setRefusing] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  // one card per visit, the longest waiting first
  const groups = [...new Set(queue.map((q) => q.encounterId))].map((enc) =>
    queue.filter((q) => q.encounterId === enc),
  )
  const run = async (fn: () => Promise<unknown>, text: string) => {
    setMsg(null)
    try {
      await fn()
      setMsg({ ok: true, text })
      return true
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
      return false
    }
  }
  const give = (q: PharmacyLine) =>
    run(
      () => actions.dispense.mutateAsync(q.requestId),
      t(q.price == null ? 'stock.dispensedNoPrice' : 'stock.dispensedCharged', {
        patient: q.patient,
        item: q.item,
      }),
    )
  const askGive = async (q: PharmacyLine) => {
    if (
      !(await confirm({
        title: t('confirm.stock.handOverTitle', {
          item: q.item,
          quantity: q.quantity,
          patient: q.patient,
        }),
        body: t('confirm.stock.handOverBody'),
        confirmLabel: t('confirm.stock.handOverYes'),
      }))
    )
      return
    await give(q)
  }
  const giveAll = async (lines: PharmacyLine[]) => {
    if (
      !(await confirm({
        title: t('confirm.stock.handOverAllTitle', {
          count: lines.length,
          patient: lines[0]!.patient,
        }),
        body: t('confirm.stock.handOverBody'),
        confirmLabel: t('confirm.stock.handOverYes'),
      }))
    )
      return
    for (const q of lines) if (!(await give(q))) return
    setMsg({ ok: true, text: t('pharmacy.allGiven', { patient: lines[0]!.patient }) })
  }
  const notGiven = async (q: PharmacyLine) => {
    if (
      !(await confirm({
        title: t('confirm.stock.notGivenTitle', { item: q.item, patient: q.patient }),
        body: t('confirm.stock.notGivenBody', { reason: reason.trim() }),
        confirmLabel: t('confirm.stock.notGivenYes'),
        tone: 'danger',
      }))
    )
      return
    const ok = await run(
      () => actions.notGiven.mutateAsync({ requestId: q.requestId, reason: reason.trim() }),
      t('pharmacy.notGivenDone', { item: q.item, doctor: q.prescriber ?? '' }),
    )
    if (ok) {
      setRefusing(null)
      setReason('')
    }
  }
  const busy = actions.dispense.isPending || actions.notGiven.isPending

  return (
    <Panel
      i={1}
      icon={Pill}
      tint="violet"
      title={encounterId ? t('pharmacy.forThisPatient') : t('stock.pharmacyTitle')}
      right={
        encounterId
          ? undefined
          : t('pharmacy.waitingCount', { lines: queue.length, patients: groups.length })
      }
    >
      {msg && (
        <Flash key={msg.text} tone={msg.ok ? 'success' : 'error'} onClose={() => setMsg(null)}>
          {msg.text}
        </Flash>
      )}
      {groups.length === 0 ? (
        <Empty icon={PackageCheck}>{t('stock.pharmacyEmpty')}</Empty>
      ) : (
        <ShownList items={groups} step={step}>
          {(shown) => (
            <div className="flex flex-col gap-3">
              {shown.map((lines, gi) => {
                const first = lines[0]!
                const total = lines.reduce((s, q) => s + (q.price ?? 0) * q.quantity, 0)
                const anyShort = lines.some((q) => q.onHandPharmacy < q.quantity)
                const withDoctor = lines.some((q) => q.doctorHolds)
                return (
                  <div
                    key={first.encounterId}
                    className="border-border anim-enter flex flex-col gap-2 rounded-xl border px-3 py-2.5"
                    style={{ '--i': gi } as CSSProperties}
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Badge tone="blue">{first.ticket ?? '—'}</Badge>
                      <span className="min-w-[180px] flex-1">
                        <span className="block font-semibold">
                          {first.patient}{' '}
                          <span className="text-ink-3 font-normal">· {first.file}</span>
                        </span>
                        <span className="text-ink-3 block text-[12px]">
                          {[
                            first.prescriber &&
                              t('pharmacy.prescribedBy', { name: first.prescriber }),
                            formatTime(new Date(first.at)),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                        {withDoctor && (
                          <span className="text-amber block text-[12px] font-semibold">
                            {t('pharmacy.withDoctor')}
                          </span>
                        )}
                      </span>
                      <span className="text-[14px] font-bold tabular-nums">{formatRwf(total)}</span>
                      <StaffLink
                        to="/app/visit"
                        search={{ encounter: first.encounterId }}
                        className={buttonVariants({ size: 'sm', variant: 'ghost' })}
                        title={t('pharmacy.openVisit')}
                      >
                        <FolderOpen size={14} aria-hidden="true" />
                      </StaffLink>
                      <Button
                        size="sm"
                        variant="ghost"
                        title={t('pharmacy.printLabels')}
                        aria-label={t('pharmacy.printLabels')}
                        onClick={() => {
                          const ok = openDispenseLabels(
                            {
                              clinic: { name: letterhead.name, contacts: letterhead.contacts },
                              patient: { name: first.patient, fileNumber: first.file },
                              date: new Date(),
                              lines: lines.map((q) => ({
                                item: q.item,
                                quantity: q.quantity,
                                unit: q.unit,
                                dose: q.dose,
                                frequency: q.frequency,
                                days: q.days,
                                instructions: q.instructions,
                              })),
                            },
                            {
                              title: t('pharmacy.labelTitle'),
                              days: (n) => t('pharmacy.labelDays', { count: n }),
                            },
                          )
                          if (!ok) setMsg({ ok: false, text: t('report.popupBlocked') })
                        }}
                      >
                        <Printer size={14} aria-hidden="true" />
                      </Button>
                      {canDispense && lines.length > 1 && (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busy || anyShort}
                          onClick={() => void giveAll(lines)}
                          title={anyShort ? t('pharmacy.someShort') : undefined}
                        >
                          <PackageCheck size={14} aria-hidden="true" />
                          {t('pharmacy.giveAll')}
                        </Button>
                      )}
                    </div>
                    {lines.map((q) => {
                      const short = q.onHandPharmacy < q.quantity
                      const pharmacyId = q.pharmacyLocationId ?? pharmacyStore
                      // the other stores hold enough to make up what the pharmacy lacks
                      const sendCovers = q.onHandPharmacy + q.onHandElsewhere >= q.quantity
                      // first when it covers the need, else after Receive (it still helps)
                      const sendLink = (
                        <Link
                          {...stockLink('send', { item: q.itemId, to: pharmacyId }, sendCovers)}
                        >
                          <ArrowRightLeft size={14} aria-hidden="true" />
                          {t('pharmacy.sendIt', { count: q.onHandElsewhere })}
                        </Link>
                      )
                      return (
                        <div
                          key={q.requestId}
                          className="bg-surface/70 flex flex-col gap-2 rounded-lg px-3 py-2"
                        >
                          <div className="flex flex-wrap items-center gap-3">
                            <span className="min-w-[180px] flex-1">
                              <span className="text-ink block text-[14px]">
                                <b>{q.item}</b> × {q.quantity}
                                {q.unit ? ` ${q.unit}` : ''}
                              </span>
                              <span className="text-ink-3 block text-[12px]">
                                {[
                                  q.dose,
                                  q.frequency,
                                  q.days ? t('history.days', { count: q.days }) : null,
                                  q.instructions,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </span>
                            </span>
                            <span className="text-right text-[13px]">
                              <span className="block font-semibold tabular-nums">
                                {q.price == null
                                  ? t('prices.noPrice')
                                  : formatRwf(q.price * q.quantity)}
                              </span>
                              <span
                                className={cn(
                                  'block text-[12px]',
                                  short ? 'text-red font-semibold' : 'text-ink-3',
                                )}
                              >
                                {t('stock.inPharmacy', { count: q.onHandPharmacy })}
                              </span>
                              {(q.expiredInPharmacy ?? 0) > 0 && (
                                <span className="text-red block text-[12px] font-semibold">
                                  {t('pharmacy.expiredHere', { count: q.expiredInPharmacy })}
                                </span>
                              )}
                            </span>
                            {canDispense && (
                              <span className="flex flex-wrap gap-1">
                                <Button
                                  size="sm"
                                  variant={lines.length > 1 ? 'default' : 'primary'}
                                  disabled={short || busy}
                                  loading={
                                    actions.dispense.isPending &&
                                    actions.dispense.variables === q.requestId
                                  }
                                  onClick={() => void askGive(q)}
                                  title={short ? t('pharmacy.shortHint') : undefined}
                                >
                                  <Pill size={14} aria-hidden="true" />
                                  {t('stock.handOver')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() => {
                                    setRefusing(refusing === q.requestId ? null : q.requestId)
                                    setReason(short ? t('pharmacy.reasons.outOfStock') : '')
                                  }}
                                >
                                  <Ban size={14} aria-hidden="true" />
                                  {t('pharmacy.notGiven')}
                                </Button>
                              </span>
                            )}
                          </div>
                          {/* not enough in the pharmacy store: say it plainly, and where to fix it.
                              Hand-overs take from the pharmacy store only, so both links fill
                              it in: send it there from another store, or receive it there. */}
                          {short && canDispense && (
                            <p className="bg-red-bg text-red m-0 flex flex-wrap items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] font-semibold">
                              <span className="min-w-0 flex-1">
                                {sendCovers
                                  ? t('pharmacy.shortSendExplain', {
                                      item: q.item,
                                      have: q.onHandPharmacy,
                                      need: q.quantity,
                                      count: q.onHandElsewhere,
                                    })
                                  : t('pharmacy.shortExplain', {
                                      item: q.item,
                                      have: q.onHandPharmacy,
                                      need: q.quantity,
                                    })}
                              </span>
                              {sendCovers && sendLink}
                              <Link
                                {...stockLink(
                                  'receive',
                                  { item: q.itemId, location: pharmacyId },
                                  !sendCovers,
                                )}
                              >
                                <PackagePlus size={14} aria-hidden="true" />
                                {t('pharmacy.receiveIt')}
                              </Link>
                              {!sendCovers && q.onHandElsewhere > 0 && sendLink}
                            </p>
                          )}
                          {refusing === q.requestId && (
                            <Reveal focus block="nearest">
                              <div className="border-border bg-card flex flex-col gap-2 rounded-lg border p-2.5">
                                <span className="text-[13px] font-semibold">
                                  {t('pharmacy.whyNot', { doctor: q.prescriber ?? '' })}
                                </span>
                                <span className="flex flex-wrap gap-1.5">
                                  {REASONS.map((r) => (
                                    <button
                                      key={r}
                                      type="button"
                                      onClick={() => setReason(t(`pharmacy.reasons.${r}`))}
                                      className={cn(
                                        'rounded-full border px-2.5 py-1 text-[12px] font-semibold',
                                        reason === t(`pharmacy.reasons.${r}`)
                                          ? 'border-primary bg-primary text-white'
                                          : 'border-border text-ink-2 hover:bg-hover',
                                      )}
                                    >
                                      {t(`pharmacy.reasons.${r}`)}
                                    </button>
                                  ))}
                                </span>
                                <input
                                  className="border-border bg-card focus:border-primary h-10 rounded-lg border px-2.5 text-[14px] outline-none"
                                  value={reason}
                                  onChange={(e) => setReason(e.target.value)}
                                  placeholder={t('pharmacy.reasonPh')}
                                  aria-label={t('pharmacy.reasonPh')}
                                />
                                <span className="flex flex-wrap gap-2">
                                  <Button
                                    size="sm"
                                    variant="primary"
                                    disabled={reason.trim().length < 2 || busy}
                                    onClick={() => void notGiven(q)}
                                  >
                                    {t('pharmacy.confirmNotGiven')}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setRefusing(null)}
                                  >
                                    {t('staff.form.cancel')}
                                  </Button>
                                </span>
                              </div>
                            </Reveal>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          )}
        </ShownList>
      )}
      <p className="text-ink-3 m-0 text-[13px]">{t('pharmacy.hint')}</p>
    </Panel>
  )
}

/**
 * "Sell a medicine": to a patient in the clinic without a prescription (or one the doctor
 * forgot). Taken from the pharmacy store, charged on the visit's bill; the patient then goes to
 * the cashier like after any hand-over.
 */
export function SellMedicineCard({
  patients,
}: {
  patients: { encounterId: string; label: string }[]
}) {
  const { t } = useTranslation()
  const { data: stock } = useStockOverview()
  const actions = useStockActions()
  const confirm = useConfirm()
  const [encounterId, setEncounterId] = useState('')
  const [itemId, setItemId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [instructions, setInstructions] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const pharmacyIds = (stock?.locations ?? []).filter((l) => l.type === 'pharmacy').map((l) => l.id)
  const inPharmacy = (i: StockItem) => pharmacyIds.reduce((s, id) => s + (i.byLocation[id] ?? 0), 0)
  const items = (stock?.items ?? []).filter((i) => i.active && inPharmacy(i) > 0)
  const item = items.find((i) => i.id === itemId)
  const q = Number(quantity)
  const sell = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    if (!encounterId || !item || !Number.isFinite(q) || q <= 0) return
    const who = patients.find((p) => p.encounterId === encounterId)?.label ?? ''
    const itemName = `${item.name}${item.strength ? ` ${item.strength}` : ''}`
    if (
      !(await confirm({
        title: t('confirm.stock.sellTitle', { item: itemName, quantity: q, patient: who }),
        body: t('confirm.stock.handOverBody'),
        confirmLabel: t('confirm.stock.sellYes'),
      }))
    )
      return
    try {
      const r = await actions.sell.mutateAsync({ encounterId, itemId, quantity: q, instructions })
      setMsg({
        ok: true,
        text: t(r.charged ? 'stock.dispensedCharged' : 'stock.dispensedNoPrice', {
          patient: who,
          item: itemName,
        }),
      })
      setItemId('')
      setQuantity('')
      setInstructions('')
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    }
  }
  return (
    <Panel i={2} icon={ShoppingBag} tint="teal" title={t('pharmacy.sellTitle')}>
      <p className="text-ink-2 m-0 text-[13px]">{t('pharmacy.sellLead')}</p>
      <form onSubmit={(e) => void sell(e)} className="flex flex-col gap-3">
        <Select
          label={t('pharmacy.sellPatient')}
          value={encounterId}
          onChange={(e) => setEncounterId(e.target.value)}
          required
        >
          <option value="">{t('pharmacy.pickPatient')}</option>
          {patients.map((p) => (
            <option key={p.encounterId} value={p.encounterId}>
              {p.label}
            </option>
          ))}
        </Select>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr]">
          <SearchSelect
            label={t('stock.cols.item')}
            value={itemId}
            onChange={setItemId}
            required
            emptyLabel={t('visit.add.pickItem')}
            options={items.map((i) => ({
              value: i.id,
              label: `${i.name}${i.strength ? ` ${i.strength}` : ''} · ${i.sellingPrice == null ? t('prices.noPrice') : formatRwf(i.sellingPrice)} · ${t('stock.inPharmacy', { count: inPharmacy(i) })}`,
            }))}
          />
          <Field
            label={t('stock.quantity')}
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, ''))}
            required
          />
        </div>
        <Field
          label={t('pharmacy.sellHow')}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={t('pharmacy.sellHowPh')}
        />
        {item && q > 0 && (
          <p className="text-ink-2 m-0 text-[13px] font-semibold">
            {item.sellingPrice == null
              ? t('pharmacy.sellNoPrice')
              : t('pharmacy.sellTotal', { amount: formatRwf(item.sellingPrice * q) })}
          </p>
        )}
        {msg && (
          <Flash key={msg.text} tone={msg.ok ? 'success' : 'error'} onClose={() => setMsg(null)}>
            {msg.text}
          </Flash>
        )}
        <Button
          type="submit"
          variant="primary"
          className="self-start"
          loading={actions.sell.isPending}
          disabled={patients.length === 0}
        >
          <ShoppingBag size={16} aria-hidden="true" />
          {t('pharmacy.sell')}
        </Button>
      </form>
    </Panel>
  )
}

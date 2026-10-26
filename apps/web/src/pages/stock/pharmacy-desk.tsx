import { useState, type CSSProperties, type FormEvent, type MouseEvent } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowRightLeft,
  Ban,
  FolderOpen,
  Hourglass,
  PackageCheck,
  PackagePlus,
  Pill,
  ShieldAlert,
  ShoppingBag,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useConfirm } from '@/lib/confirm'
import { formatRwf, formatTime } from '@mmc/shared'
import { Empty, Panel } from '@/components/dash/kit'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Flash } from '@/components/ui/flash'
import { ShownList } from '@/components/ui/list-tools'
import { StaffLink } from '@/components/staff/staff-link'
import {
  isRoomStore,
  usePharmacyDesk,
  useStockActions,
  useStockOverview,
  type PharmacyLine,
  type PharmacyPatient,
  type StockItem,
} from '@/lib/api/stock'
import { cn } from '@/lib/utils'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { SearchSelect } from '@/components/ui/search-select'
import type { OpenStock, StockPreset } from './stock-page'
import { batchOnLabel, fetchDispensedBatches, useHanded } from './pharmacy/handed'
import { AllergyBox, HandedStrip, ReasonBox } from './pharmacy/parts'
import { ageText, errText, itemName, sexText, usableIn } from './pharmacy/util'
import { CounterSalesPanel } from './pharmacy/counter-sales'
import { RoomStoresSummary } from './pharmacy/room-summary'
import { NoDeskNotice } from '@/components/clinical/desk-gate'
import { useSessionCanDesk } from '@/components/clinical/session-desks'

/** Usual reasons a medicine is not handed over; the pharmacist may also type their own. */
const REASONS = ['outOfStock', 'boughtElsewhere', 'refused'] as const

type Msg = { ok: boolean; text: string } | null

/**
 * The pharmacy hand-over: prescriptions waiting, one card per patient with what the pharmacist
 * checks first (age, sex, allergies, the prescribing rule of each medicine) and what the patient
 * will pay (their share after the insurer). Each medicine is handed over from the dispensing
 * store (taken from stock and put on the visit's bill) or marked "not given" with the reason,
 * which the doctor is told. Nothing is paid here: the patient pays once at the end of the visit.
 * The labels are printed after the hand-over, from the batches really given.
 *
 * On the dashboard and the stock page (not on one visit) the pharmacist also has the counter
 * sales (walk-in buyers, who pay first) and what the room stores wait for (refill requests, return
 * notes, notes on the way), worked in one place: Stock → Room stores.
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
  // The pharmacy desk: a department of the person gives it (or, where no department does, the
  // role). Without it: on one visit the medicines are shown read only; on the dashboard and the
  // stock page the person is told to ask the manager. Room stores ("My store") stay with holders.
  const canDesk = useSessionCanDesk()
  const atDesk = canDesk('pharmacy')
  if (!atDesk && !encounterId) return <NoDeskNotice desks={['pharmacy']} />
  const dispense = canDispense && atDesk
  return (
    <>
      <HandOverPanel
        canDispense={dispense}
        step={step}
        encounterId={encounterId}
        onOpenStock={onOpenStock}
      />
      {!encounterId && dispense && <CounterSalesPanel />}
      {!encounterId && dispense && <RoomStoresSummary />}
    </>
  )
}

function HandOverPanel({
  canDispense,
  step,
  encounterId,
  onOpenStock,
}: {
  canDispense: boolean
  step: number
  encounterId?: string
  onOpenStock?: OpenStock
}) {
  const { t } = useTranslation()
  // the dispensing store: null = the main pharmacy store (the database's choice)
  const [storeChoice, setStoreChoice] = useState<string | null>(null)
  const { data: desk } = usePharmacyDesk(storeChoice)
  const { data: stock } = useStockOverview()
  const actions = useStockActions()
  const confirm = useConfirm()
  const addHanded = useHanded((s) => s.add)
  const updateHanded = useHanded((s) => s.update)
  const [msg, setMsg] = useState<Msg>(null)
  const [refusing, setRefusing] = useState<string | null>(null)
  const [giving, setGiving] = useState<string | null>(null)

  const stores = desk?.stores ?? []
  const storeId =
    desk?.locationId ??
    stock?.mainPharmacyId ??
    stock?.locations.find((l) => l.type === 'pharmacy')?.id ??
    null
  const storeName = stores.find((s) => s.id === storeId)?.name ?? null
  const allLines = desk?.lines ?? []
  const lines = encounterId ? allLines.filter((q) => q.encounterId === encounterId) : allLines
  // one card per visit, in the desk's order (the longest waiting first)
  const order = [...new Set(lines.map((q) => q.encounterId))]
  const patientOf = new Map((desk?.patients ?? []).map((p) => [p.encounterId, p]))
  const groups = order.map((enc) => ({
    patient: patientOf.get(enc) ?? null,
    lines: lines.filter((q) => q.encounterId === enc),
  }))

  // where else the medicine is: other pharmacy or main stores can send it (transfer), room
  // stores return it with a return note made by their holders
  const elsewhere = (q: PharmacyLine) => {
    const item = stock?.items.find((i) => i.id === q.itemId)
    if (!item || !stock) return { sendable: q.onHandElsewhere, inRooms: 0 }
    let sendable = 0
    let inRooms = 0
    for (const l of stock.locations) {
      if (l.id === storeId || l.active === false) continue
      const n = usableIn(item, l.id)
      if (!n) continue
      if (isRoomStore(l)) inRooms += n
      else if (l.type === 'pharmacy' || l.type === 'main_store') sendable += n
    }
    return { sendable, inRooms }
  }

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

  /** Hands one line over; keeps what was given for the labels. False when it was refused. */
  const give = async (q: PharmacyLine, patient: PharmacyPatient | null, last: boolean) => {
    setGiving(q.requestId)
    try {
      const r = await actions.dispense.mutateAsync({
        requestId: q.requestId,
        locationId: storeChoice,
      })
      const batches = await fetchDispensedBatches(r.dispenseId, q.itemId, q.quantity)
      addHanded(
        { key: q.encounterId, kind: 'visit', patient: { name: q.patient, fileNumber: q.file } },
        {
          item: q.item,
          quantity: q.quantity,
          unit: q.unit,
          dose: q.dose,
          frequency: q.frequency,
          days: q.days,
          instructions: q.instructions,
          ...batchOnLabel(batches),
        },
      )
      if (last) {
        // the last medicine: the patient goes on, and pays everything at the end of the visit
        const handedShare = groups
          .find((g) => g.lines[0]?.encounterId === q.encounterId)
          ?.lines.reduce((s, x) => s + x.patientShare, 0)
        updateHanded(q.encounterId, {
          done: true,
          toPay:
            patient?.balance != null
              ? Math.max(0, patient.balance) + (handedShare ?? 0)
              : (handedShare ?? null),
        })
      }
      return true
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
      return false
    } finally {
      setGiving(null)
    }
  }

  const askGive = async (q: PharmacyLine, patient: PharmacyPatient | null, cardLines: number) => {
    if (
      !(await confirm({
        title: t('confirm.stock.handOverTitle', {
          item: q.item,
          quantity: q.quantity,
          patient: q.patient,
        }),
        body: t('confirm.pharmacy.handOverBody', {
          store: storeName ?? t('pharmacy.mainStore'),
          amount: formatRwf(q.patientShare),
        }),
        confirmLabel: t('confirm.stock.handOverYes'),
      }))
    )
      return
    setMsg(null)
    if (await give(q, patient, cardLines === 1))
      setMsg({
        ok: true,
        text: t(q.priced ? 'stock.dispensedCharged' : 'stock.dispensedNoPrice', {
          patient: q.patient,
          item: q.item,
        }),
      })
  }

  const giveAll = async (cardLines: PharmacyLine[], patient: PharmacyPatient | null) => {
    const first = cardLines[0]!
    const share = cardLines.reduce((s, q) => s + q.patientShare, 0)
    if (
      !(await confirm({
        title: t('confirm.stock.handOverAllTitle', {
          count: cardLines.length,
          patient: first.patient,
        }),
        body: t('confirm.pharmacy.handOverAllBody', {
          store: storeName ?? t('pharmacy.mainStore'),
          amount: formatRwf(share),
        }),
        confirmLabel: t('confirm.stock.handOverYes'),
      }))
    )
      return
    setMsg(null)
    for (const [i, q] of cardLines.entries())
      if (!(await give(q, patient, i === cardLines.length - 1))) return
    setMsg({ ok: true, text: t('pharmacy.allGiven', { patient: first.patient }) })
  }

  const notGiven = async (q: PharmacyLine, reason: string, cardLines: number) => {
    if (
      !(await confirm({
        title: t('confirm.stock.notGivenTitle', { item: q.item, patient: q.patient }),
        body: t('confirm.stock.notGivenBody', { reason }),
        confirmLabel: t('confirm.stock.notGivenYes'),
        tone: 'danger',
      }))
    )
      return
    setMsg(null)
    try {
      await actions.notGiven.mutateAsync({ requestId: q.requestId, reason })
      setRefusing(null)
      // the last line of the card: medicines already handed over go on to the cashier
      if (cardLines === 1) updateHanded(q.encounterId, { done: true })
      setMsg({
        ok: true,
        text: t('pharmacy.notGivenDone', { item: q.item, doctor: q.prescriber ?? '' }),
      })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    }
  }
  const busy = giving != null || actions.notGiven.isPending

  return (
    <Panel
      i={1}
      icon={Pill}
      tint="violet"
      title={encounterId ? t('pharmacy.forThisPatient') : t('stock.pharmacyTitle')}
      right={
        encounterId
          ? undefined
          : t('pharmacy.waitingCount', { lines: lines.length, patients: groups.length })
      }
    >
      {stores.length > 1 && (
        <div className="flex flex-wrap items-end gap-2">
          <Select
            label={t('pharmacy.dispensingStore')}
            value={storeChoice ?? ''}
            onChange={(e) => setStoreChoice(e.target.value || null)}
            wrapperClassName="min-w-[220px]"
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
          <span className="text-ink-3 pb-3 text-[12px]">{t('pharmacy.dispensingStoreHint')}</span>
        </div>
      )}
      {msg && (
        <Flash key={msg.text} tone={msg.ok ? 'success' : 'error'} onClose={() => setMsg(null)}>
          {msg.text}
        </Flash>
      )}
      <HandedStrip
        kind="visit"
        only={encounterId}
        onBlocked={() => setMsg({ ok: false, text: t('report.popupBlocked') })}
      />
      {groups.length === 0 ? (
        <Empty icon={PackageCheck}>{t('stock.pharmacyEmpty')}</Empty>
      ) : (
        <ShownList items={groups} step={step}>
          {(shown) => (
            <div className="flex flex-col gap-3">
              {shown.map(({ patient, lines: cardLines }, gi) => {
                const first = cardLines[0]!
                const share = cardLines.reduce((s, q) => s + q.patientShare, 0)
                const insurer = cardLines.reduce((s, q) => s + q.insurerShare, 0)
                const total = cardLines.reduce((s, q) => s + q.lineTotal, 0)
                const anyShort = cardLines.some((q) => q.onHandPharmacy < q.quantity)
                const holds = patient?.doctorHolds ?? cardLines.some((q) => q.doctorHolds)
                const payer = patient?.payer ?? first.payer
                const facts = [
                  sexText(t, patient?.sex ?? first.sex),
                  ageText(t, patient?.ageYears ?? first.ageYears, patient?.ageMonths),
                  payer ? t('pharmacy.payerIs', { payer }) : t('pharmacy.payerCash'),
                ].filter(Boolean)
                return (
                  <div
                    key={first.encounterId}
                    className="border-border anim-enter flex flex-col gap-2 rounded-md border px-3 py-2.5"
                    style={{ '--i': gi } as CSSProperties}
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Badge tone="blue">{first.ticket ?? '—'}</Badge>
                      <span className="min-w-[180px] flex-1">
                        <span className="block font-semibold">
                          {first.patient}{' '}
                          <span className="text-ink-3 font-normal">· {first.file}</span>
                        </span>
                        <span className="text-ink-2 block text-[14px] font-semibold">
                          {facts.join(' · ')}
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
                      </span>
                      <span className="text-right">
                        <span className="block text-[14px] font-semibold tabular-nums">
                          {formatRwf(share)}
                        </span>
                        <span className="text-ink-3 block text-[12px]">
                          {t('pharmacy.patientPays')}
                        </span>
                      </span>
                      <StaffLink
                        to="/app/visit"
                        search={{ encounter: first.encounterId }}
                        className={buttonVariants({ size: 'sm', variant: 'ghost' })}
                        title={t('pharmacy.openVisit')}
                      >
                        <FolderOpen size={14} aria-hidden="true" />
                      </StaffLink>
                      {canDispense && cardLines.length > 1 && (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busy || anyShort || holds}
                          onClick={() => void giveAll(cardLines, patient)}
                          title={
                            holds
                              ? t('pharmacy.doctorHoldsShort')
                              : anyShort
                                ? t('pharmacy.someShort')
                                : undefined
                          }
                        >
                          <PackageCheck size={14} aria-hidden="true" />
                          {t('pharmacy.giveAll')}
                        </Button>
                      )}
                    </div>
                    <AllergyBox allergies={patient?.allergies ?? first.allergies} />
                    {holds && (
                      <p className="border-amber/30 bg-amber-bg text-amber m-0 flex items-start gap-1.5 rounded-md border px-2.5 py-1.5 text-[14px] font-medium">
                        <Hourglass size={16} aria-hidden="true" className="mt-0.5 flex-none" />
                        <span>{t('pharmacy.doctorHolds')}</span>
                      </p>
                    )}
                    {cardLines.map((q) => {
                      const short = q.onHandPharmacy < q.quantity
                      const where = elsewhere(q)
                      // the other pharmacy stores hold enough to make up what this one lacks
                      const sendCovers = q.onHandPharmacy + where.sendable >= q.quantity
                      const sendLink = (
                        <Link
                          {...stockLink(
                            'send',
                            { item: q.itemId, to: storeId ?? undefined },
                            sendCovers,
                          )}
                        >
                          <ArrowRightLeft size={14} aria-hidden="true" />
                          {t('pharmacy.sendIt', { count: where.sendable })}
                        </Link>
                      )
                      return (
                        <div
                          key={q.requestId}
                          className="bg-surface/70 flex flex-col gap-2 rounded-md px-3 py-2"
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
                              {q.prescribingRule && (
                                <span
                                  className={cn(
                                    'mt-0.5 flex items-center gap-1 text-[12px] font-semibold',
                                    q.ruleOk === false ? 'text-red' : 'text-ink-2',
                                  )}
                                >
                                  {q.ruleOk === false && (
                                    <ShieldAlert size={13} aria-hidden="true" />
                                  )}
                                  {q.ruleOk === false
                                    ? t('pharmacy.ruleMismatch', {
                                        rule: q.prescribingRule,
                                        specialty:
                                          q.prescriberSpecialty ?? t('pharmacy.noSpecialty'),
                                      })
                                    : q.ruleOk
                                      ? t('pharmacy.ruleFits', { rule: q.prescribingRule })
                                      : t('pharmacy.rule', { rule: q.prescribingRule })}
                                </span>
                              )}
                            </span>
                            <span className="text-right text-[14px]">
                              {q.priced ? (
                                <>
                                  <span className="block font-semibold tabular-nums">
                                    {t('pharmacy.patientShare', {
                                      amount: formatRwf(q.patientShare),
                                    })}
                                  </span>
                                  {q.insurerShare > 0 && (
                                    <span className="text-ink-3 block text-[12px] tabular-nums">
                                      {t('pharmacy.insurerShare', {
                                        amount: formatRwf(q.insurerShare),
                                        pct: q.coveragePct,
                                      })}
                                    </span>
                                  )}
                                  <span className="text-ink-3 block text-[12px] tabular-nums">
                                    {q.cashPrice != null &&
                                      t('pharmacy.cashEach', { amount: formatRwf(q.cashPrice) })}
                                    {q.payer &&
                                      q.payerPrice != null &&
                                      q.payerPrice !== q.cashPrice &&
                                      ` · ${t('pharmacy.payerEach', { payer: q.payer, amount: formatRwf(q.payerPrice) })}`}
                                  </span>
                                </>
                              ) : (
                                <span className="text-amber block font-semibold">
                                  {t('pharmacy.noPriceFree')}
                                </span>
                              )}
                              <span
                                className={cn(
                                  'block text-[12px]',
                                  short ? 'text-red font-semibold' : 'text-ink-3',
                                )}
                              >
                                {storeName && stores.length > 1
                                  ? t('pharmacy.inStore', {
                                      count: q.onHandPharmacy,
                                      store: storeName,
                                    })
                                  : t('stock.inPharmacy', { count: q.onHandPharmacy })}
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
                                  variant={cardLines.length > 1 ? 'default' : 'primary'}
                                  disabled={short || busy || holds}
                                  loading={giving === q.requestId}
                                  onClick={() => void askGive(q, patient, cardLines.length)}
                                  title={
                                    holds
                                      ? t('pharmacy.doctorHoldsShort')
                                      : short
                                        ? t('pharmacy.shortHint')
                                        : undefined
                                  }
                                >
                                  <Pill size={14} aria-hidden="true" />
                                  {t('stock.handOver')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() =>
                                    setRefusing(refusing === q.requestId ? null : q.requestId)
                                  }
                                >
                                  <Ban size={14} aria-hidden="true" />
                                  {t('pharmacy.notGiven')}
                                </Button>
                              </span>
                            )}
                          </div>
                          {/* not enough in the dispensing store: say it plainly, and where to fix
                              it: send it from another pharmacy store, or receive it. Stock in a
                              room store comes back only by a return note of its holders. */}
                          {short && canDispense && (
                            <div className="border-red/30 bg-red-bg text-red m-0 flex flex-col gap-1.5 rounded-md border px-2.5 py-1.5 text-[14px] font-medium">
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="min-w-0 flex-1">
                                  {sendCovers
                                    ? t('pharmacy.shortSendExplain', {
                                        item: q.item,
                                        have: q.onHandPharmacy,
                                        need: q.quantity,
                                        count: where.sendable,
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
                                    { item: q.itemId, location: storeId ?? undefined },
                                    !sendCovers,
                                  )}
                                >
                                  <PackagePlus size={14} aria-hidden="true" />
                                  {t('pharmacy.receiveIt')}
                                </Link>
                                {!sendCovers && where.sendable > 0 && sendLink}
                              </span>
                              {where.inRooms > 0 && (
                                <span className="text-ink-2 text-[12px] font-normal">
                                  {t('pharmacy.inRoomStores', { count: where.inRooms })}
                                </span>
                              )}
                            </div>
                          )}
                          {refusing === q.requestId && (
                            <ReasonBox
                              title={t('pharmacy.whyNot', { doctor: q.prescriber ?? '' })}
                              choices={REASONS.map((r) => t(`pharmacy.reasons.${r}`))}
                              initial={short ? t('pharmacy.reasons.outOfStock') : ''}
                              confirmLabel={t('pharmacy.confirmNotGiven')}
                              busy={actions.notGiven.isPending}
                              onConfirm={(reason) => void notGiven(q, reason, cardLines.length)}
                              onCancel={() => setRefusing(null)}
                            />
                          )}
                        </div>
                      )
                    })}
                    <p className="border-border m-0 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-t pt-2 text-[14px]">
                      <span className="text-ink-2">
                        {insurer > 0
                          ? t('pharmacy.cardSplit', {
                              total: formatRwf(total),
                              insurer: formatRwf(insurer),
                              payer: payer ?? '',
                            })
                          : t('pharmacy.cardTotal', { total: formatRwf(total) })}
                      </span>
                      <span className="text-ink font-semibold">
                        {t('pharmacy.payAtEnd', { amount: formatRwf(share) })}
                      </span>
                      {patient?.balance != null && patient.balance > 0 && (
                        <span className="text-ink-3 w-full text-[12px]">
                          {t('pharmacy.alreadyOnBill', { amount: formatRwf(patient.balance) })}
                        </span>
                      )}
                    </p>
                  </div>
                )
              })}
            </div>
          )}
        </ShownList>
      )}
      <p className="text-ink-3 m-0 text-[13px]">{t('pharmacy.hintEnd')}</p>
    </Panel>
  )
}

/**
 * "Sell a medicine": to a patient on a visit, without a prescription (or one the doctor forgot).
 * Taken from the dispensing store and put on the visit's bill; the patient pays at the end of
 * the visit with the rest. A walk-in buyer without a visit: the counter sale, who pays first.
 */
export function SellMedicineCard(props: { patients: { encounterId: string; label: string }[] }) {
  // selling is the pharmacy desk's (the hand-over beside it tells the others why)
  const canDesk = useSessionCanDesk()
  return canDesk('pharmacy') ? <SellMedicine {...props} /> : null
}

function SellMedicine({ patients }: { patients: { encounterId: string; label: string }[] }) {
  const { t } = useTranslation()
  const { data: stock } = useStockOverview()
  const { data: desk } = usePharmacyDesk(null)
  const actions = useStockActions()
  const confirm = useConfirm()
  const addHanded = useHanded((s) => s.add)
  const [encounterId, setEncounterId] = useState('')
  const [storeChoice, setStoreChoice] = useState('')
  const [itemId, setItemId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [instructions, setInstructions] = useState('')
  const [msg, setMsg] = useState<Msg>(null)
  const stores = desk?.stores ?? []
  const storeId =
    storeChoice ||
    desk?.locationId ||
    stock?.mainPharmacyId ||
    stock?.locations.find((l) => l.type === 'pharmacy')?.id ||
    ''
  const inStore = (i: StockItem) => usableIn(i, storeId)
  const items = (stock?.items ?? []).filter((i) => i.active && inStore(i) > 0)
  const item = items.find((i) => i.id === itemId)
  const q = Number(quantity)
  const sell = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    if (!encounterId || !item || !Number.isFinite(q) || q <= 0) return
    const who = patients.find((p) => p.encounterId === encounterId)?.label ?? ''
    const name = itemName(item)
    if (
      !(await confirm({
        title: t('confirm.stock.sellTitle', { item: name, quantity: q, patient: who }),
        body: t('confirm.pharmacy.sellBody'),
        confirmLabel: t('confirm.stock.sellYes'),
      }))
    )
      return
    try {
      const r = await actions.sell.mutateAsync({
        encounterId,
        itemId,
        quantity: q,
        instructions,
        locationId: storeChoice || null,
      })
      const batches = await fetchDispensedBatches(r.dispenseId, itemId, q)
      addHanded(
        { key: encounterId, kind: 'visit', patient: { name: who, fileNumber: '' } },
        {
          item: name,
          quantity: q,
          unit: item.unit,
          dose: null,
          frequency: null,
          days: null,
          instructions: instructions.trim() || null,
          ...batchOnLabel(batches),
        },
      )
      setMsg({
        ok: true,
        text: t(r.charged ? 'pharmacy.soldOnBill' : 'stock.dispensedNoPrice', {
          patient: who,
          item: name,
        }),
      })
      setItemId('')
      setQuantity('')
      setInstructions('')
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <Panel i={2} icon={ShoppingBag} tint="teal" title={t('pharmacy.sellTitle')}>
      <p className="text-ink-2 m-0 text-[14px]">{t('pharmacy.sellLeadEnd')}</p>
      <form onSubmit={(e) => void sell(e)} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
          {stores.length > 1 && (
            <Select
              label={t('pharmacy.dispensingStore')}
              value={storeChoice}
              onChange={(e) => {
                setStoreChoice(e.target.value)
                setItemId('')
              }}
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
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr]">
          <SearchSelect
            label={t('stock.cols.item')}
            value={itemId}
            onChange={setItemId}
            required
            emptyLabel={t('visit.add.pickItem')}
            options={items.map((i) => ({
              value: i.id,
              label: `${itemName(i)} · ${i.sellingPrice == null ? t('prices.noPrice') : formatRwf(i.sellingPrice)} · ${t('stock.inPharmacy', { count: inStore(i) })}`,
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
          <p
            className={cn(
              'm-0 text-[14px] font-semibold',
              q > inStore(item) ? 'text-red' : 'text-ink-2',
            )}
          >
            {q > inStore(item)
              ? t('pharmacy.sellShort', { count: inStore(item) })
              : item.sellingPrice == null
                ? t('pharmacy.sellNoPrice')
                : t('pharmacy.sellCashTotal', { amount: formatRwf(item.sellingPrice * q) })}
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
          disabled={patients.length === 0 || (!!item && q > inStore(item))}
        >
          <ShoppingBag size={16} aria-hidden="true" />
          {t('pharmacy.sell')}
        </Button>
      </form>
    </Panel>
  )
}

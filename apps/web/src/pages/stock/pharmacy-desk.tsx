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
  UserRound,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useConfirm } from '@/lib/confirm'
import { formatRwf, formatTime } from '@mmc/shared'
import { Empty, Panel } from '@/components/dash/kit'
import { card } from '@/components/dash/kit-style'
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
import { costOf, partOf, perUnit, usePharmacyActions, withoutDone } from '@/lib/api/pharmacy'
import { priceQuantity, saleModeOf, type Packaging } from '@/lib/pack-pricing'
import { cn } from '@/lib/utils'
import { Field, controlClass } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { SearchSelect } from '@/components/ui/search-select'
import type { OpenStock, StockPreset } from './stock-page'
import { batchOnLabel, fetchDispensedBatches, useHanded } from './pharmacy/handed'
import { AllergyBox, HandedStrip, ReasonBox } from './pharmacy/parts'
import { ageText, errText, itemName, qty, sexText, usableIn } from './pharmacy/util'
import { QtyModeToggle } from './stock-shared'
import {
  cashCost,
  hasPacks,
  packsEquals,
  packsText,
  piecesAndPacks,
  piecesOf,
  priceLineText,
  saleModeText,
  tx,
  wholePacksText,
  type QtyMode,
} from './stock-util'
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
 * which the doctor is told. A line may be given in part (10 of 20, when the store holds only 10):
 * the bill charges what was given, the rest stays "to give" on the card (given later in the visit,
 * or closed with "Not given" and a reason) and the prescriber is told. Nothing is paid here: the
 * patient pays once at the end of the visit. The labels are printed after the hand-over, from the
 * batches really given.
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
  extras = !onOpenStock,
}: {
  canDispense: boolean
  step?: number
  /** Only this visit's medicines (the visit screen of a pharmacist). */
  encounterId?: string
  /** On the stock page: open Receive / Send there instead of following the link. */
  onOpenStock?: OpenStock
  /**
   * Also the counter sales and the room stores' summary under the hand-over. Default: on the
   * dashboard yes; on the stock page (onOpenStock given) no, its own tabs hold them.
   */
  extras?: boolean
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
      {!encounterId && extras && dispense && <CounterSalesPanel />}
      {!encounterId && extras && dispense && <RoomStoresSummary />}
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
  const { dispensePart } = usePharmacyActions()
  const confirm = useConfirm()
  const addHanded = useHanded((s) => s.add)
  const updateHanded = useHanded((s) => s.update)
  const [msg, setMsg] = useState<Msg>(null)
  const [refusing, setRefusing] = useState<string | null>(null)
  const [giving, setGiving] = useState<string | null>(null)
  // the quantity typed for a line (left out: what remains, or what the store holds when short),
  // in pieces or in whole packs (0102)
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [modes, setModes] = useState<Record<string, QtyMode>>({})

  const stores = desk?.stores ?? []
  const storeId =
    desk?.locationId ??
    stock?.mainPharmacyId ??
    stock?.locations.find((l) => l.type === 'pharmacy')?.id ??
    null
  const storeName = stores.find((s) => s.id === storeId)?.name ?? null
  const allLines = withoutDone(desk?.lines ?? [])
  /** The pack size of a line's medicine (the queue says it; else the stock list). */
  const packOf = (q: PharmacyLine) =>
    q.packSize ?? stock?.items.find((i) => i.id === q.itemId)?.packSize ?? null
  /** How a line's medicine is packed and sold (0107: the queue says it; else the stock list). */
  const packagingOf = (q: PharmacyLine): Packaging & { unit?: string | null } => {
    const it = stock?.items.find((i) => i.id === q.itemId)
    return {
      packSize: packOf(q),
      saleMode: q.saleMode ?? it?.saleMode ?? null,
      packPrice: q.packPrice ?? it?.packPrice ?? null,
      packUnit: q.packUnit ?? it?.packUnit ?? null,
      unit: q.unit,
    }
  }
  /** A medicine sold only by the whole pack (0107): given in whole packs. */
  const packOnly = (q: PharmacyLine) => saleModeOf(packagingOf(q)) === 'pack'
  /**
   * What a line gives by default: what remains; sold only by the whole pack, up to whole packs
   * (the database's due: 10 remaining in boxes of 8 → 16).
   */
  const dueOf = (q: PharmacyLine) => {
    const { remaining } = partOf(q)
    const size = packOf(q)
    if (q.due != null) return Math.max(remaining, q.due)
    return packOnly(q) && size && size > 1 ? Math.ceil(remaining / size) * size : remaining
  }
  /**
   * What remains to give on a line, and the quantity to give now (typed in pieces or packs, else
   * the default: all that remains, or what the store holds when short), always as pieces.
   */
  const plan = (q: PharmacyLine) => {
    const part = partOf(q)
    const size = packOf(q)
    const only = packOnly(q) && hasPacks({ packSize: size })
    const due = dueOf(q)
    // sold only by the whole pack: typed in packs
    const mode: QtyMode = only
      ? 'packs'
      : hasPacks({ packSize: size })
        ? (modes[q.requestId] ?? 'pieces')
        : 'pieces'
    const have = Math.max(q.onHandPharmacy, 0)
    // all that is due, or what the store holds when short (whole packs for a pack-only medicine)
    const short = only && size ? Math.floor(have / size) * size : have
    const fallback = Math.min(due, short) || due
    const typed = amounts[q.requestId]
    const typedN =
      typed == null ? (mode === 'packs' && size ? fallback / size : fallback) : qty(typed)
    const n = typed == null ? fallback : piecesOf(typedN, mode, size)
    return {
      ...part,
      n,
      typed: typed ?? String(typedN),
      mode,
      size,
      typedN,
      due,
      only,
      whole: !only || (!!size && n % size === 0),
    }
  }
  /** What the patient pays for `n` pieces of a line (their share after the insurer). */
  const shareOf = (q: PharmacyLine, n: number) => costOf(q, n).patient
  /** Switching pieces ↔ packs keeps the quantity: 40 tablets become 2 packs of 20, and back. */
  const switchMode = (q: PharmacyLine, m: QtyMode) => {
    const p = plan(q)
    const size = Math.max(1, p.size ?? 1)
    setModes((x) => ({ ...x, [q.requestId]: m }))
    setAmounts((a) => ({
      ...a,
      [q.requestId]: m === 'packs' ? String(Math.max(1, Math.floor(p.n / size))) : String(p.n),
    }))
  }
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

  /**
   * Hands `n` units of one line over (all that remains, or a part); keeps what was given for the
   * labels. The remaining units of a part stay on the card. Null when it was refused, else what
   * still remains to give on the line.
   */
  const give = async (
    q: PharmacyLine,
    patient: PharmacyPatient | null,
    n: number,
    /** The other lines of the card are all done: the patient goes on once this one is. */
    lastLine: boolean,
  ): Promise<number | null> => {
    setGiving(q.requestId)
    try {
      const r = await dispensePart.mutateAsync({ line: q, quantity: n, locationId: storeChoice })
      setAmounts((a) => {
        const rest = { ...a }
        delete rest[q.requestId]
        return rest
      })
      setModes((x) => {
        const rest = { ...x }
        delete rest[q.requestId]
        return rest
      })
      const batches = await fetchDispensedBatches(r.dispenseId, q.itemId, r.quantity)
      addHanded(
        { key: q.encounterId, kind: 'visit', patient: { name: q.patient, fileNumber: q.file } },
        {
          item: q.item,
          quantity: r.quantity,
          unit: q.unit,
          packSize: packOf(q),
          dose: q.dose,
          frequency: q.frequency,
          days: q.days,
          instructions: q.instructions,
          ...batchOnLabel(batches),
        },
      )
      if (lastLine && r.remaining === 0) {
        // the last medicine: the patient goes on, and pays everything at the end of the visit
        const handedShare = groups
          .find((g) => g.lines[0]?.encounterId === q.encounterId)
          ?.lines.reduce((s, x) => s + shareOf(x, dueOf(x)), 0)
        updateHanded(q.encounterId, {
          done: true,
          toPay:
            patient?.balance != null
              ? Math.max(0, patient.balance) + (handedShare ?? 0)
              : (handedShare ?? null),
        })
      }
      return r.remaining
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
      return null
    } finally {
      setGiving(null)
    }
  }

  const askGive = async (
    q: PharmacyLine,
    patient: PharmacyPatient | null,
    cardLines: number,
    n: number,
  ) => {
    const { remaining } = partOf(q)
    const part = n < remaining
    if (
      !(await confirm({
        title: t('confirm.stock.handOverTitle', {
          item: q.item,
          quantity: n,
          patient: q.patient,
        }),
        body: [
          t('confirm.pharmacy.handOverBody', {
            store: storeName ?? t('pharmacy.mainStore'),
            amount: formatRwf(shareOf(q, n)),
          }),
          part &&
            t('pharmacy.part.confirmRest', {
              count: remaining - n,
              doctor: q.prescriber ?? t('pharmacy.part.thePrescriber'),
            }),
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: t('confirm.stock.handOverYes'),
      }))
    )
      return
    setMsg(null)
    const left = await give(q, patient, n, cardLines === 1)
    if (left == null) return
    setMsg({
      ok: true,
      text:
        left > 0
          ? t('pharmacy.part.givenPart', {
              item: q.item,
              given: n,
              count: left,
              doctor: q.prescriber ?? t('pharmacy.part.thePrescriber'),
            })
          : t(q.priced ? 'stock.dispensedCharged' : 'stock.dispensedNoPrice', {
              patient: q.patient,
              item: q.item,
            }),
    })
  }

  const giveAll = async (cardLines: PharmacyLine[], patient: PharmacyPatient | null) => {
    const first = cardLines[0]!
    const share = cardLines.reduce((s, q) => s + shareOf(q, dueOf(q)), 0)
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
      if ((await give(q, patient, dueOf(q), i === cardLines.length - 1)) == null) return
    setMsg({ ok: true, text: t('pharmacy.allGiven', { patient: first.patient }) })
  }

  const notGiven = async (
    q: PharmacyLine,
    reason: string,
    cardLines: number,
    /** "Rest not available": the rest is out of stock; the prescriber may send it outside (0102). */
    outOfStock = false,
  ) => {
    // after a part: "not given" closes only what remains (the part given stays on the bill)
    const { given, remaining } = partOf(q)
    const doctor = q.prescriber ?? t('pharmacy.part.thePrescriber')
    if (
      !(await confirm({
        title: outOfStock
          ? tx(
              t,
              'pharmacy.part.restNotAvailableTitle',
              {
                one: 'The other {{count}} {{item}}: not available for {{patient}}?',
                other: 'The other {{count}} {{item}}: not available for {{patient}}?',
              },
              { count: remaining, item: q.item, patient: q.patient },
            )
          : given > 0
            ? t('pharmacy.part.notGivenRestTitle', {
                count: remaining,
                item: q.item,
                patient: q.patient,
              })
            : t('confirm.stock.notGivenTitle', { item: q.item, patient: q.patient }),
        body: outOfStock
          ? tx(
              t,
              'pharmacy.part.restNotAvailableBody',
              'They are marked not given (out of stock) and {{doctor}} is told the quantity, so the rest can be bought at an outside pharmacy. The {{given}} given stay on the bill.',
              { doctor, given },
            )
          : t('confirm.stock.notGivenBody', { reason }),
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
        text:
          given > 0
            ? t('pharmacy.part.restNotGivenDone', {
                item: q.item,
                given,
                doctor: q.prescriber ?? t('pharmacy.part.thePrescriber'),
              })
            : t('pharmacy.notGivenDone', { item: q.item, doctor: q.prescriber ?? '' }),
      })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    }
  }
  const busy = giving != null || actions.notGiven.isPending || dispensePart.isPending

  return (
    <Panel
      i={1}
      icon={Pill}
      tint="mint"
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
            wrapperClassName="min-w-[min(220px,100%)]"
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
                // what is still to give on the card (a part already given is on the bill)
                const left = (q: PharmacyLine) => dueOf(q)
                const share = cardLines.reduce((s, q) => s + shareOf(q, left(q)), 0)
                const insurer = cardLines.reduce((s, q) => s + costOf(q, left(q)).insurer, 0)
                const total = cardLines.reduce((s, q) => s + costOf(q, left(q)).total, 0)
                const anyShort = cardLines.some((q) => q.onHandPharmacy < left(q))
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
                    className={cn(card, 'anim-enter gap-2 px-3 py-2.5')}
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
                        className={buttonVariants({ size: 'sm', variant: 'tint-blue' })}
                        title={t('pharmacy.openVisit')}
                        aria-label={t('pharmacy.openVisit')}
                      >
                        <FolderOpen size={14} aria-hidden="true" />
                      </StaffLink>
                      {canDispense && cardLines.length > 1 && (
                        <Button
                          size="sm"
                          variant="success"
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
                      const p = plan(q)
                      // not enough for all that remains: a part can still be given (what is here)
                      const short = q.onHandPharmacy < p.due
                      const none =
                        q.onHandPharmacy <= 0 || (p.only && !!p.size && q.onHandPharmacy < p.size)
                      const badAmount = p.n < 1 || p.n > p.due || p.n > q.onHandPharmacy || !p.whole
                      const isPart = p.n > 0 && p.n < p.remaining
                      const where = elsewhere(q)
                      const lineCost = costOf(q, p.due)
                      const pk = packagingOf(q)
                      const packInfo = { unit: q.unit, packSize: p.size, packUnit: pk.packUnit }
                      // what the quantity to give now costs, by how it is sold (0107)
                      const priced = priceQuantity(pk, p.n, {
                        cash: q.packPrice != null,
                        piecePrice: perUnit(q).total,
                      })
                      // the other pharmacy stores hold enough to make up what this one lacks
                      const sendCovers = q.onHandPharmacy + where.sendable >= p.remaining
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
                                <b>{q.item}</b> × {p.prescribed}
                                {q.unit ? ` ${q.unit}` : ''}
                                {packsText(t, p.prescribed, p.size, pk.packUnit) && (
                                  <span className="text-ink-3">
                                    {' '}
                                    ({packsText(t, p.prescribed, p.size, pk.packUnit)})
                                  </span>
                                )}
                              </span>
                              {p.size && (
                                <span className="text-ink-3 block text-[12px]">
                                  {saleModeText(t, pk)}
                                </span>
                              )}
                              {/* sold only by the whole pack: the last pack is given whole */}
                              {p.only && p.due > p.remaining && (
                                <span className="text-teal block text-[12px] font-semibold">
                                  {tx(
                                    t,
                                    'packaging.dueWhole',
                                    'Sold only by the whole pack: give {{due}} ({{packs}}) for the {{remaining}} prescribed.',
                                    {
                                      due: p.due,
                                      packs: packsText(t, p.due, p.size, pk.packUnit) ?? '',
                                      remaining: p.remaining,
                                    },
                                  )}
                                </span>
                              )}
                              {q.splitFrom && (
                                <span className="text-ink-3 block text-[12px]">
                                  {tx(
                                    t,
                                    'pharmacy.part.restSentBack',
                                    'The rest of a medicine given in part, sent back by the prescriber.',
                                  )}
                                </span>
                              )}
                              {p.given > 0 && (
                                <span className="text-amber block text-[12px] font-semibold">
                                  {t('pharmacy.part.progress', {
                                    given: p.given,
                                    total: p.prescribed,
                                    count: p.remaining,
                                  })}
                                </span>
                              )}
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
                                      amount: formatRwf(lineCost.patient),
                                    })}
                                  </span>
                                  {lineCost.insurer > 0 && (
                                    <span className="text-ink-3 block text-[12px] tabular-nums">
                                      {t('pharmacy.insurerShare', {
                                        amount: formatRwf(lineCost.insurer),
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
                                  {/* whole packs at the pack price, pieces at the piece
                                      price: the line of what is given now, as the bill says it */}
                                  {p.n > 0 && (priced.packs > 0 || p.size) && (
                                    <span className="text-teal block text-[12px] font-semibold tabular-nums">
                                      {priceLineText(t, priced, pk, formatRwf)}
                                    </span>
                                  )}
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
                                {packsText(t, q.onHandPharmacy, p.size, pk.packUnit) &&
                                  ` · ${packsText(t, q.onHandPharmacy, p.size, pk.packUnit)}`}
                              </span>
                              {(q.expiredInPharmacy ?? 0) > 0 && (
                                <span className="text-red block text-[12px] font-semibold">
                                  {t('pharmacy.expiredHere', { count: q.expiredInPharmacy })}
                                </span>
                              )}
                            </span>
                            {canDispense && (
                              <span className="flex flex-wrap items-center gap-1">
                                {/* how many to give now: all that remains, or a part; in pieces or packs */}
                                <input
                                  className={cn(
                                    controlClass,
                                    'h-8 w-[72px] px-2 text-right tabular-nums',
                                    badAmount && !none && 'border-red',
                                  )}
                                  inputMode="numeric"
                                  value={p.typed}
                                  disabled={busy || holds || none}
                                  onChange={(e) =>
                                    setAmounts((a) => ({
                                      ...a,
                                      [q.requestId]: e.target.value.replace(/[^\d]/g, ''),
                                    }))
                                  }
                                  aria-label={t('pharmacy.part.qtyLabel', {
                                    item: q.item,
                                    count: p.remaining,
                                  })}
                                  title={t('pharmacy.part.qtyLabel', {
                                    item: q.item,
                                    count: p.remaining,
                                  })}
                                />
                                {hasPacks(packInfo) && (
                                  <QtyModeToggle
                                    mode={p.mode}
                                    packsOnly={p.only}
                                    disabled={busy || holds || none}
                                    onChange={(m) => switchMode(q, m)}
                                  />
                                )}
                                {!p.whole && p.n > 0 && (
                                  <span className="text-red w-full text-[12px] font-semibold">
                                    {wholePacksText(t, p.n, pk)}
                                  </span>
                                )}
                                {p.mode === 'packs' && p.typedN > 0 && (
                                  <span className="text-ink-2 w-full text-[12px] font-medium tabular-nums">
                                    {packsEquals(t, p.typedN, p.size ?? 1, q.unit)}
                                  </span>
                                )}
                                <Button
                                  size="sm"
                                  variant={cardLines.length > 1 ? 'tint-mint' : 'success'}
                                  disabled={none || badAmount || busy || holds}
                                  loading={giving === q.requestId}
                                  onClick={() => void askGive(q, patient, cardLines.length, p.n)}
                                  title={
                                    holds
                                      ? t('pharmacy.doctorHoldsShort')
                                      : none
                                        ? t('pharmacy.shortHint')
                                        : badAmount
                                          ? t('pharmacy.part.badAmount', {
                                              count: Math.min(p.remaining, q.onHandPharmacy),
                                            })
                                          : undefined
                                  }
                                >
                                  <Pill size={14} aria-hidden="true" />
                                  {isPart
                                    ? t('pharmacy.part.giveOf', { given: p.n, count: p.remaining })
                                    : t('stock.handOver')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="tint-coral"
                                  disabled={busy}
                                  onClick={() =>
                                    setRefusing(refusing === q.requestId ? null : q.requestId)
                                  }
                                >
                                  <Ban size={14} aria-hidden="true" />
                                  {p.given > 0
                                    ? t('pharmacy.part.notGivenRest', { count: p.remaining })
                                    : t('pharmacy.notGiven')}
                                </Button>
                              </span>
                            )}
                          </div>
                          {/* not enough in the dispensing store: say it plainly, and where to fix
                              it: send it from another pharmacy store, or receive it. Stock in a
                              room store comes back only by a return note of its holders. */}
                          {short && canDispense && (
                            <div className="border-red/30 bg-red-bg text-red m-0 flex flex-col gap-1.5 rounded-md border px-2.5 py-1.5 text-[14px] font-medium">
                              {/* 0102: the over-quantity flow in two clicks: give what is here,
                                  then mark the rest not available (the prescriber is told the
                                  quantity and may send it to an outside pharmacy) */}
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="text-ink text-[15px] font-semibold">
                                  {tx(
                                    t,
                                    'pharmacy.part.shortLine',
                                    'Prescribed {{need}} · in stock {{have}}',
                                    {
                                      need: piecesAndPacks(t, p.prescribed, packInfo),
                                      have: piecesAndPacks(t, q.onHandPharmacy, packInfo),
                                    },
                                  )}
                                </span>
                                {!none && (
                                  <Button
                                    size="sm"
                                    variant="success"
                                    disabled={busy || holds}
                                    loading={giving === q.requestId}
                                    onClick={() =>
                                      void askGive(
                                        q,
                                        patient,
                                        cardLines.length,
                                        p.only && p.size
                                          ? Math.floor(q.onHandPharmacy / p.size) * p.size
                                          : Math.min(q.onHandPharmacy, p.remaining),
                                      )
                                    }
                                  >
                                    <Pill size={14} aria-hidden="true" />
                                    {tx(
                                      t,
                                      'pharmacy.part.giveNow',
                                      { one: 'Give {{count}} now', other: 'Give {{count}} now' },
                                      {
                                        count:
                                          p.only && p.size
                                            ? Math.floor(q.onHandPharmacy / p.size) * p.size
                                            : Math.min(q.onHandPharmacy, p.remaining),
                                      },
                                    )}
                                  </Button>
                                )}
                                {p.given > 0 && (
                                  <Button
                                    size="sm"
                                    variant="tint-coral"
                                    disabled={busy}
                                    loading={actions.notGiven.isPending}
                                    onClick={() =>
                                      void notGiven(
                                        q,
                                        t('pharmacy.reasons.outOfStock'),
                                        cardLines.length,
                                        true,
                                      )
                                    }
                                  >
                                    <Ban size={14} aria-hidden="true" />
                                    {tx(
                                      t,
                                      'pharmacy.part.restNotAvailable',
                                      {
                                        one: 'Rest not available ({{count}})',
                                        other: 'Rest not available ({{count}})',
                                      },
                                      { count: p.remaining },
                                    )}
                                  </Button>
                                )}
                              </span>
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="min-w-0 flex-1">
                                  {sendCovers
                                    ? t('pharmacy.shortSendExplain', {
                                        item: q.item,
                                        have: q.onHandPharmacy,
                                        need: p.remaining,
                                        count: where.sendable,
                                      })
                                    : t('pharmacy.shortExplain', {
                                        item: q.item,
                                        have: q.onHandPharmacy,
                                        need: p.remaining,
                                      })}
                                  {!none && (
                                    <span className="text-ink-2 block text-[12px] font-normal">
                                      {t('pharmacy.part.shortCanPart', {
                                        have: q.onHandPharmacy,
                                        count: p.remaining,
                                      })}
                                    </span>
                                  )}
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
                              title={
                                p.given > 0
                                  ? t('pharmacy.part.whyRest', {
                                      count: p.remaining,
                                      doctor: q.prescriber ?? t('pharmacy.part.thePrescriber'),
                                    })
                                  : t('pharmacy.whyNot', { doctor: q.prescriber ?? '' })
                              }
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
/** A patient on a visit now, as the sale's patient search shows them. */
export interface VisitPatient {
  encounterId: string
  name: string
  fileNumber: string
  ticket: string
  /** Where the patient is now (the desk's name). */
  where: string
}

export function SellMedicineCard(props: { patients: VisitPatient[] }) {
  // selling is the pharmacy desk's (the hand-over beside it tells the others why)
  const canDesk = useSessionCanDesk()
  return canDesk('pharmacy') ? <SellMedicine {...props} /> : null
}

/**
 * The patient of a sale: searched by name, file number or ticket among the patients who have a
 * visit open in the clinic now (a sale goes on that visit's bill). The chosen one shows as a card
 * with "Change".
 */
function VisitPatientSearch({
  patients,
  value,
  onChange,
}: {
  patients: VisitPatient[]
  value: string
  onChange: (encounterId: string) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const chosen = patients.find((p) => p.encounterId === value)
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const hits = words.length
    ? patients.filter((p) => {
        const text = `${p.name} ${p.fileNumber} ${p.ticket}`.toLowerCase()
        return words.every((w) => text.includes(w))
      })
    : []
  if (chosen) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-ink-2 text-[13px] font-medium">{t('pharmacy.sellPatient')}</span>
        <div className="border-primary/40 bg-primary-tint flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2">
          <UserRound size={18} aria-hidden="true" className="text-primary flex-none" />
          <span className="min-w-0 flex-[1_1_12rem]">
            <b className="block">{chosen.name}</b>
            <span className="text-ink-2 text-[13px]">
              {t('pharmacy.sellFound', {
                file: chosen.fileNumber,
                ticket: chosen.ticket,
                where: chosen.where,
              })}
            </span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange('')
              setQuery('')
            }}
          >
            {t('pharmacy.sellChange')}
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Field
        label={t('pharmacy.sellPatient')}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('pharmacy.sellSearchPh')}
        autoComplete="off"
      />
      {words.length > 0 &&
        (hits.length === 0 ? (
          <p className="text-ink-3 m-0 text-[13px]">{t('pharmacy.sellNoMatch')}</p>
        ) : (
          <ul
            className="border-border bg-card m-0 flex max-h-64 list-none flex-col overflow-y-auto rounded-lg border p-1"
            aria-label={t('pharmacy.sellResults')}
          >
            {hits.slice(0, 20).map((p) => (
              <li key={p.encounterId}>
                <button
                  type="button"
                  onClick={() => onChange(p.encounterId)}
                  className="hover:bg-hover focus-visible:ring-primary/30 flex w-full min-w-0 flex-wrap items-baseline gap-x-2 rounded-md px-2.5 py-2 text-left outline-none focus-visible:ring-2"
                >
                  <b className="min-w-0">{p.name}</b>
                  <span className="text-ink-2 text-[13px]">
                    {t('pharmacy.sellFound', {
                      file: p.fileNumber,
                      ticket: p.ticket,
                      where: p.where,
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}
      {patients.length === 0 && (
        <p className="text-ink-3 m-0 text-[13px]">{t('pharmacy.sellNobody')}</p>
      )}
    </div>
  )
}

function SellMedicine({ patients }: { patients: VisitPatient[] }) {
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
  // the quantity typed in pieces or in whole packs (0102): the sale is always in pieces
  const [mode, setMode] = useState<QtyMode>('pieces')
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
  const typedN = Number(quantity)
  const q = item && hasPacks(item) ? piecesOf(typedN, mode, item.packSize) : typedN
  const cost = item ? cashCost(q, item) : null
  // sold only by the whole pack (0107): typed in packs; pieces that are not whole packs refused
  const only = !!item && saleModeOf(item) === 'pack'
  const notWhole = !!cost && q > 0 && !cost.ok
  const sell = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    if (!encounterId || !item || !Number.isFinite(q) || q <= 0) return
    if (notWhole) return setMsg({ ok: false, text: wholePacksText(t, q, item) })
    const who = patients.find((p) => p.encounterId === encounterId)?.name ?? ''
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
        {
          key: encounterId,
          kind: 'visit',
          patient: {
            name: who,
            fileNumber: patients.find((p) => p.encounterId === encounterId)?.fileNumber ?? '',
          },
        },
        {
          item: name,
          quantity: q,
          unit: item.unit,
          packSize: item.packSize ?? null,
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
      setMode('pieces')
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
          <VisitPatientSearch patients={patients} value={encounterId} onChange={setEncounterId} />
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
            onChange={(v) => {
              setItemId(v)
              const it = items.find((i) => i.id === v)
              setMode(it && saleModeOf(it) === 'pack' ? 'packs' : 'pieces')
            }}
            required
            emptyLabel={t('visit.add.pickItem')}
            options={items.map((i) => ({
              value: i.id,
              label: `${itemName(i)} · ${i.sellingPrice == null ? t('prices.noPrice') : formatRwf(i.sellingPrice)} · ${t('stock.inPharmacy', { count: inStore(i) })}`,
            }))}
          />
          <div className="flex items-end gap-2">
            <Field
              label={
                mode === 'packs' ? tx(t, 'stockShared.packs.packs', 'packs') : t('stock.quantity')
              }
              inputMode="numeric"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, ''))}
              required
              wrapperClassName="min-w-0 flex-1"
            />
            {item && hasPacks(item) && (
              <QtyModeToggle
                mode={only ? 'packs' : mode}
                packsOnly={only}
                onChange={setMode}
                className="mb-0.5"
              />
            )}
          </div>
        </div>
        {item && (
          <p className="text-ink-3 m-0 -mt-1 text-[12px]">
            {[
              piecesAndPacks(t, inStore(item), item),
              hasPacks(item) ? saleModeText(t, item) : null,
              mode === 'packs' && typedN > 0
                ? packsEquals(t, typedN, item.packSize ?? 1, item.unit)
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
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
              q > inStore(item) || notWhole ? 'text-red' : 'text-ink-2',
            )}
          >
            {q > inStore(item)
              ? t('pharmacy.sellShort', { count: inStore(item) })
              : notWhole
                ? wholePacksText(t, q, item)
                : item.sellingPrice == null
                  ? t('pharmacy.sellNoPrice')
                  : [
                      t('pharmacy.sellCashTotal', { amount: formatRwf(cost?.total ?? 0) }),
                      cost && hasPacks(item)
                        ? `(${priceLineText(t, cost, item, formatRwf)})`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' ')}
          </p>
        )}
        {msg && (
          <Flash key={msg.text} tone={msg.ok ? 'success' : 'error'} onClose={() => setMsg(null)}>
            {msg.text}
          </Flash>
        )}
        <Button
          type="submit"
          variant="success"
          className="self-start"
          loading={actions.sell.isPending}
          disabled={!encounterId || (!!item && q > inStore(item)) || notWhole}
        >
          <ShoppingBag size={16} aria-hidden="true" />
          {t('pharmacy.sell')}
        </Button>
      </form>
    </Panel>
  )
}

import { useMemo, useState, type FormEvent } from 'react'
import { PackageOpen, Pill, Plus, RotateCcw, Send, Syringe, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Reveal } from '@/components/ui/reveal'
import { SearchSelect, type SearchOption } from '@/components/ui/search-select'
import { Seg } from '@/components/ui/seg'
import { Select } from '@/components/ui/select'
import { NurseOrderRow } from '@/components/clinical/nurse-order-row'
import { NurseRecipient } from '@/components/clinical/nurse-recipient'
import { EmptyNote } from '@/components/clinical/empty-note'
import { OrderSummary } from '@/components/clinical/six-steps/order-summary'
import {
  DoseInput,
  Hinted,
  OrderWhen,
  PartTitle,
} from '@/components/clinical/six-steps/order-form-parts'
import {
  listMedicineOption,
  medicineRefOption,
  sortMedicineRefs,
  treatmentName,
  useListMedicines,
  useMedicineReference,
  useTreatments,
} from '@/lib/api/catalogue'
import { useItems } from '@/lib/api/patients'
import {
  useClinicStock,
  useNurseOrderActions,
  useOrderNurses,
  type NurseOrder,
  type NurseOrderKind,
} from '@/lib/api/nurse-orders'
import {
  contentMl,
  partFigure,
  partModeOf,
  partPrice as rulePartPrice,
  pieceContentOf,
  takeHomeCount,
  type DoseItem,
  type PartMode,
} from '@/lib/dose'
import { doseUnitLabel } from '@/lib/dose-words'
import { fractionText } from '@/lib/fraction'
import { useNow } from '@/lib/hooks'
import {
  OTHER_UNIT,
  decimal,
  defaultUnit,
  doseOf,
  emptyDose,
  numberOf,
  partOf,
  pieceUnitOf,
  unitChoices,
  type DoseValue,
} from '@/lib/order-dose'
import {
  everyHoursOf,
  firstAtAllowed,
  firstAtOf,
  nextHalfHour,
  planText,
  timesOf,
  whenText,
  type WhenValue,
} from '@/lib/order-plan'
import { restOfBox, summarizeOrder, summaryWords } from '@/lib/order-summary'
import { BUTTON_WORD, orderAction } from '@/lib/order-words'
import { useConfirm } from '@/lib/confirm'
import { packsText } from '@/pages/stock/stock-util'

const ROUTES = ['oral', 'IV', 'IM', 'SC', 'topical', 'rectal', 'inhaled', 'other']
const FREQUENCIES = ['OD', 'BD', 'TDS', 'QID', 'Q8H', 'Q6H', 'NOCTE', 'PRN', 'STAT'] as const
/** "All the nurses" in the For whom list. */
const ALL = ''

/** The chooser's row for an act that is not in the price list (written, not billed). */
const TYPED_ACT = '__typed__'

/** 0197: a medicine the clinic does not hold — of the official list (REF + code) or of an
 *  uploaded list (LIST + code), as the prescription form writes them. Never orderable. */
const REF = 'ref:'
const LIST = 'list:'

/** Where the patient takes the medicine (0193). */
type Where = 'here' | 'home' | 'both'

const emptyWhen = (): WhenValue => ({
  giveAt: 'now',
  atDay: '',
  atTime: '',
  repeat: 'once',
  every: '8',
  everyOther: '',
  forKind: 'times',
  forCount: '3',
})

const emptyForm = (kind: NurseOrderKind) => ({
  kind,
  where: 'here' as Where,
  itemId: '',
  // given here (0198): the dose as a number and a unit; the whole pieces and a part of one are
  // proposed from it and stay editable (a number typed is never overwritten)
  dose: emptyDose(),
  quantity: '1',
  /** ½ ¼ ¾ as "0.5"…, or the ml of a bottle by measure; '' = none. */
  part: '',
  /** The price of the part changed on the order, and why. */
  partPriceOn: false,
  partPrice: '',
  partPriceWhy: '',
  route: 'oral',
  // to take home: whole pieces, worked out from the dose each time × how often × days
  homeQuantity: '',
  homeTouched: false,
  homeDose: emptyDose(),
  homeFrequency: '',
  homeDays: '',
  homeInstructions: '',
  // a medical act: from the price list (billed) or written (not billed), how many on the bill
  serviceId: '',
  text: '',
  actQuantity: '1',
  // 0198: give at, repeat
  when: emptyWhen(),
  assignedTo: ALL,
  notes: '',
})
type Form = ReturnType<typeof emptyForm>

/**
 * Step 6 (0127; 0193; 0198): the orders carried out here — MEDICAL ACTS (an injection, a dressing,
 * an IV line…; from the clinic's treatments so it is billed) and MEDICINES of the clinic's stock,
 * given here and/or taken home. For one nurse, all of them, or the doctor himself. The box above
 * Send says what will happen; every field says what it does. Below: each order, with Undo.
 *
 * 0198: the DOSE is a number and a unit (1 g), words for the nurse: it never works out the pieces
 * (Frank: a strength read wrong must not change what leaves the stock) — the doctor types how many
 * tablets; a medicine given in parts may be given as
 * ½ (¼, ¾) of a tablet or some ml of a bottle, with the price of the part (changeable, with a
 * reason). The take-home count is worked out from a dose each time typed in the medicine's own
 * pieces × how often × days. GIVE AT
 * (now or a time up to 7 days ahead) and REPEAT (every N hours: N times, N days or until stopped)
 * — the nurse records each time. Without 0198 in the database the form is the one of 0193.
 *
 * 0197: the medicine list holds everything the clinic knows — its own medicines and products, the
 * official list and every uploaded list (each medicine once) — in two groups: in the clinic's
 * stock (orderable), then not in stock. Choosing one that is not in stock is refused at once in
 * words, with the two ways out (add its delivery; prescribe it to buy outside).
 */
export function NurseOrdersStep({
  encounterId,
  orders,
  canOrder,
  myId,
  isManager,
  patientName,
  patientFile,
  visitOver = false,
  inBed = false,
  onPrescribeOutside,
  onDone,
  onError,
}: {
  encounterId: string
  orders: NurseOrder[]
  /** A doctor working on the open visit. */
  canOrder: boolean
  myId: string
  isManager: boolean
  patientName: string
  /** For the label of a medicine taken home. */
  patientFile?: string | null
  /** The visit is finished (Undo by a nurse then ends the order). */
  visitOver?: boolean
  /** 0198: the patient is in a bed (a repeat on a day patient warns that times stop at the end). */
  inBed?: boolean
  /** Opens the prescription form on this medicine (a clinic item's id, REF or LIST + code): the
   *  way out for one the clinic does not have in stock. */
  onPrescribeOutside?: (pick: string) => void
  onDone: (m: string) => void
  onError: (m: string | null) => void
}) {
  const { t, i18n } = useTranslation()
  const confirm = useConfirm()
  const actions = useNurseOrderActions()
  const now = useNow(60_000)
  const [adding, setAdding] = useState(false)
  const [f, setF] = useState(() => emptyForm('drug'))
  const [err, setErr] = useState<string | null>(null)
  const { data: items = [] } = useItems()
  const { data: stock } = useClinicStock(adding)
  const { data: treatments = [] } = useTreatments(adding)
  const { data: nurses = [] } = useOrderNurses(adding)
  // 0197: the official list and the uploaded lists join the picker (as on Add stock)
  const { data: refs = [] } = useMedicineReference(adding)
  const { data: listMeds = [] } = useListMedicines(adding)
  // the treatments charged on the visit (not the tests a desk carries out)
  const acts = treatments.filter(
    (x) => !x.orderStation && x.active !== false && x.code !== 'BED-STAY',
  )
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }))
  const item = items.find((x) => x.id === f.itemId)
  const service = acts.find((x) => x.id === f.serviceId)
  const pack = item ? (stock?.packs[item.id] ?? null) : null
  const unit = item?.unit || t('nurseOrders.unit')
  const packWord = pack?.packUnit || t('nurseOrders.pack')
  const showHere = f.where !== 'home'
  const showHome = f.where !== 'here'

  // 0198: what one piece holds and how it may be given in parts (the database's answer first)
  const ready = !!stock?.ready198
  const doseItem: DoseItem | null = item
    ? { ...item, saleMode: pack?.mode ?? 'piece', packSize: pack?.size ?? null }
    : null
  const piece = doseItem ? pieceContentOf(doseItem) : null
  const itemMode: PartMode = doseItem ? partModeOf(doseItem) : 'whole'
  // a part is offered only when the database can take it (0198) and the medicine allows it
  const partsOn = f.kind === 'drug' && ready && itemMode !== 'whole'
  const mode: PartMode = partsOn ? itemMode : 'whole'
  const pieceMl = contentMl(piece)
  const units = unitChoices(piece)

  const here = showHere ? Number(f.quantity || 0) : 0
  const home = showHome ? Number(f.homeQuantity || 0) : 0
  const part = partsOn && showHere ? partOf(mode, f.part, pieceMl) : 0
  const partOk = part != null
  const partN = part ?? 0
  const partText =
    partN > 0
      ? mode === 'measure'
        ? partFigure(partN, mode, pieceMl)
        : `${partFigure(partN, mode)} ${unit}`
      : null
  // the price of the part by the medicine's rule (cash), and the one changed on the order
  const rulePrice =
    partN > 0 && item?.cashPrice != null
      ? rulePartPrice(item.dose, partN, item.cashPrice, {
          mode,
          contentMl: pieceMl,
          cash: true,
        })
      : null
  const typedPrice = f.partPriceOn ? numberOf(f.partPrice) : null
  const partPriceNow = f.partPriceOn ? typedPrice : rulePrice
  const ruleWord =
    item?.dose?.partPriceRule === 'whole'
      ? t('nurseOrders.partRuleWhole', { unit })
      : item?.dose?.partPriceRule === 'set' &&
          item.cashPrice != null &&
          rulePrice !== Math.round(item.cashPrice * partN)
        ? t('nurseOrders.partRuleSet')
        : t('nurseOrders.partRuleShare', { price: formatRwf(item?.cashPrice ?? 0), unit })

  // 0198: give at and repeat (an act, or a medicine given here; never only to take home)
  const whenOn = ready && (f.kind === 'act' || (showHere && !!item))
  const w = f.when
  const repeatOn = whenOn && w.repeat === 'repeat'
  const hours = everyHoursOf(w)
  const count = repeatOn ? timesOf(w, hours) : null
  const firstIso = whenOn && w.giveAt === 'later' ? firstAtOf(w.atDay, w.atTime) : null

  // the button the nurse will press: Given / Handed over (all to take home) / Done
  const action = orderAction({ kind: f.kind, quantity: here, homeQuantity: home, part: partN })
  const actCount = Number(f.actQuantity || 0)
  const actName = service ? treatmentName(service, i18n.language) : f.text.trim()
  const summary = summarizeOrder({
    kind: f.kind,
    here,
    home,
    stockUnits: stock && item ? (stock.units[item.id] ?? 0) : null,
    pack,
    cashPrice: item?.cashPrice ?? null,
    service: !!service,
    servicePrice: service?.cashPrice ?? null,
    actCount,
    part: partN,
    partPrice: partPriceNow,
    // the opened pieces hold less than the part: one more piece is opened
    partOpens: partN > 0 && (stock?.open?.[item?.id ?? ''] ?? 0) < partN - 1e-9,
    times: repeatOn && count != null ? (count === 'until' ? null : count) : undefined,
  })
  // a half or a decimal typed in a count is said at once, never turned into a bigger number
  const notWhole = f.kind === 'drug' && (!Number.isInteger(here) || !Number.isInteger(home))
  const blocked =
    f.kind === 'drug' &&
    (notWhole || !partOk || summary.tone === 'short' || summary.tone === 'wholePacks')
  const restAll = f.where === 'both' && !notWhole ? restOfBox(here, pack?.size) : null
  // offered only when the stock really holds the rest of the box (1 tablet left of a box of 100
  // must not offer "the rest of the box goes home (99)")
  const rest =
    restAll != null && summary.left != null && here + restAll > summary.left ? null : restAll
  // the take-home pieces in boxes ("1 box of 20"), when they make one or more
  const homeBoxes =
    pack && home > 0 && !notWhole ? packsText(t, home, pack.size, pack.packUnit) : null

  // ---------------------------------------------------------------- the dose
  // Frank (after 0198): the dose is words for the nurse, never turned into tablets — a strength
  // read wrong, or a dose no tablet gives, must not change what leaves the stock. The doctor types
  // the pieces himself.
  const setDose = (v: DoseValue) => setF((x) => ({ ...x, dose: v }))

  // ---------------------------------------------------------------- the take-home count (B)
  // Worked out only from a dose each time typed in the medicine's own pieces ("1 tab, twice a day,
  // 5 days" = 10, rounded up for halves); a dose in mg or ml is not turned into pieces.
  const pieceUnit = pieceUnitOf(piece)
  const eachOf = (v: DoseValue): number | null => {
    const d = doseOf(v)
    return d && v.unit === pieceUnit ? d.amount : null
  }
  const takeOf = (x: Form) =>
    takeHomeCount({
      each: eachOf(x.homeDose),
      frequency: x.homeFrequency,
      days: numberOf(x.homeDays),
    })
  /** How to take it at home changed: the count follows while the doctor has not typed one. */
  const setHome = (patch: Partial<Form>) =>
    setF((x) => {
      const next = { ...x, ...patch }
      const c = takeOf(next)
      // review 0198: no count any more (when needed, a dose that does not convert): the number
      // worked out before is not left behind; the doctor types it
      if (!next.homeTouched) next.homeQuantity = c ? String(c.total) : ''
      return next
    })
  const take = showHome ? takeOf(f) : null
  const each = showHome && f.kind === 'drug' ? eachOf(f.homeDose) : null
  const eachText = each != null ? `${fractionText(each, i18n.language)} ${unit}` : ''
  const workedOut = (() => {
    if (!showHome || f.kind !== 'drug') return null
    if (f.homeFrequency === 'PRN') return t('nurseOrders.homeWhenNeeded')
    if (!take) return null
    const total = `${take.total} ${unit}`
    const line = take.once
      ? t('nurseOrders.homeWorkedOutOnce', { each: eachText, total })
      : t('nurseOrders.homeWorkedOut', {
          each: eachText,
          perDay: take.perDay,
          days: take.days,
          total,
        })
    return take.roundedUp
      ? `${line} · ${t('nurseOrders.homeRoundedUp', {
          exact: `${fractionText(take.exact, i18n.language)} ${unit}`,
          total,
        })}`
      : line
  })()
  /** The words of the dose each time, printed on the label as typed: "1 tab", "10 ml", "500 mg". */
  const homeDoseWords = (): string => {
    const v = f.homeDose
    if (!doseOf(v)) return ''
    return `${v.amount} ${v.unit === OTHER_UNIT ? v.other.trim() : doseUnitLabel(t, v.unit)}`
  }
  /** The dose given here in words (`dose`, read by every screen that prints it). */
  const hereDoseWords = (): string => {
    const v = f.dose
    if (!doseOf(v)) return ''
    return `${v.amount} ${v.unit === OTHER_UNIT ? v.other.trim() : doseUnitLabel(t, v.unit)}`
  }

  // the picker (0197): everything the clinic knows as a medicine or product, each once — those in
  // the clinic's stock first (how many, the box, the price), then those it does not have: its own
  // with none left, the official list's and the uploaded lists'. Worked out once per change of the
  // lists (thousands of lines), not on every key pressed in the form.
  const medicineOptions = useMemo((): SearchOption[] => {
    const inGroup = t('nurseOrders.groupInStock')
    const noGroup = t('nurseOrders.groupNoStock')
    const none = t('nurseOrders.noStock')
    const own = items.map((it) => {
      const n = stock ? (stock.units[it.id] ?? 0) : null
      const p = stock?.packs[it.id]
      const piece = it.unit || t('nurseOrders.unit')
      const prices = [
        it.cashPrice != null
          ? t('nurseOrders.piecePrice', { price: formatRwf(it.cashPrice), unit: piece })
          : null,
        p && p.mode !== 'piece' && p.packPrice != null
          ? t('nurseOrders.packPrice', {
              price: formatRwf(p.packPrice),
              pack: p.packUnit || t('nurseOrders.pack'),
              size: p.size,
            })
          : null,
      ].filter(Boolean)
      const option: SearchOption = {
        value: it.id,
        label: [it.name, it.strength, it.form ? `· ${it.form}` : null].filter(Boolean).join(' '),
        sub:
          [
            n == null ? null : n > 0 ? t('nurseOrders.inStock', { count: n, unit: piece }) : none,
            p
              ? t('nurseOrders.boxOf', { pack: p.packUnit || t('nurseOrders.pack'), size: p.size })
              : null,
          ]
            .filter(Boolean)
            .join(' · ') || undefined,
        hint: prices.length ? prices.join(' · ') : undefined,
        keywords: it.code,
        group: n == null ? undefined : n > 0 ? inGroup : noGroup,
      }
      return { option, has: n == null || n > 0 }
    })
    // each medicine shows once: one the clinic already holds as its own line; one of an uploaded
    // list (the clinic's own lists come before the official one) once, whatever the lists
    const seen = new Set(items.map((it) => it.code))
    const once = (code: string) => !seen.has(code) && !!seen.add(code)
    const uploaded = listMeds
      .filter((l) => once(l.code))
      .map((l) => ({ ...listMedicineOption(l, t, LIST + l.code), group: noGroup, hint: none }))
    const official = sortMedicineRefs(refs)
      .filter((r) => once(r.code))
      .map((r) => ({ ...medicineRefOption(r, t, REF + r.code), group: noGroup, hint: none }))
    return [
      ...own.filter((x) => x.has).map((x) => x.option),
      ...own.filter((x) => !x.has).map((x) => x.option),
      ...uploaded,
      ...official,
    ]
  }, [items, stock, refs, listMeds, t])
  // 0197: the medicine chosen is not in the clinic's stock (none left, or only on a list): it
  // cannot be given here — said at once under the field, Send stays off
  const offList = f.itemId.startsWith(REF) || f.itemId.startsWith(LIST)
  const notInStock =
    f.kind === 'drug' &&
    !!f.itemId &&
    (offList || (!!item && !!stock && (stock.units[item.id] ?? 0) <= 0))
  const pickedName = medicineOptions.find((o) => o.value === f.itemId)?.label ?? ''
  const notInStockText = t('nurseOrders.notInStock', { name: pickedName })

  /** A medicine chosen: the dose starts in the unit of what one piece holds (mg, ml, tablet). */
  const pickItem = (id: string) => {
    const it = items.find((x) => x.id === id)
    const p = stock?.packs[id]
    const pc = it
      ? pieceContentOf({ ...it, saleMode: p?.mode ?? 'piece', packSize: p?.size ?? null })
      : null
    setErr(null)
    set({
      itemId: id,
      dose: emptyDose(defaultUnit(pc)),
      homeDose: emptyDose(it ? (pc?.content ? defaultUnit(pc) : pieceUnitOf(pc)) : ''),
      quantity: '1',
      part: '',
      partPriceOn: false,
      partPrice: '',
      partPriceWhy: '',
      homeTouched: false,
    })
  }
  const setWhen = (patch: Partial<WhenValue>) =>
    setF((x) => {
      const next = { ...x.when, ...patch }
      // "At a time": the next half hour is proposed
      if (patch.giveAt === 'later' && !next.atDay) {
        const n = nextHalfHour(Date.now())
        next.atDay = n.day
        next.atTime = n.time
      }
      return { ...x, when: next }
    })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr(null)
    if (f.kind === 'drug') {
      if (notInStock) return setErr(`${notInStockText} ${t('nurseOrders.notInStockWays')}`)
      if (!item) return setErr(t('nurseOrders.errMedicine'))
      if (notWhole) return setErr(t(partsOn ? 'nurseOrders.errWholePart' : 'nurseOrders.errWhole'))
      if (!partOk) return setErr(t('nurseOrders.errPart', { unit }))
      if (here + home + partN <= 0) return setErr(t('nurseOrders.errAmounts'))
      // "Both": each part has its number (never a take-home part dropped without a word)
      if (f.where === 'both' && !(here + partN > 0)) return setErr(t('nurseOrders.errHereAmount'))
      if (f.where === 'both' && !(home > 0)) return setErr(t('nurseOrders.errHomeAmount'))
      const days = f.homeDays.trim()
      if (home > 0 && days && !(Number.isInteger(Number(days)) && +days >= 1 && +days <= 365))
        return setErr(t('nurseOrders.errHomeDays'))
      if (
        partN > 0 &&
        f.partPriceOn &&
        (typedPrice == null || typedPrice < 0 || f.partPriceWhy.trim().length < 3)
      )
        return setErr(t('nurseOrders.errPartPrice'))
      if (blocked)
        return setErr(
          summaryWords(t, summary, {
            kind: 'drug',
            unit,
            act: '',
            actCount,
            packUnit: pack?.packUnit ?? null,
            partText,
          }),
        )
    } else {
      if (!service && f.text.trim().length < 2) return setErr(t('nurseOrders.errAct'))
      if (!(actCount > 0)) return setErr(t('nurseOrders.errActQty'))
    }
    if (whenOn && w.giveAt === 'later' && !(firstIso && firstAtAllowed(firstIso, now)))
      return setErr(t('nurseOrders.errFirstAt'))
    if (repeatOn) {
      if (!hours || count == null) return setErr(t('nurseOrders.errRepeat'))
      if (f.kind === 'drug' && !(here + partN > 0)) return setErr(t('nurseOrders.errRepeatHere'))
    }
    const nurse = nurses.find((n) => n.id === f.assignedTo)
    // "Me — I do it myself" (0133): the order is the doctor's; he marks it given or done below
    const self = f.assignedTo === myId
    const what =
      f.kind === 'drug' ? [item?.name, item?.strength].filter(Boolean).join(' ') : actName
    const plan = repeatOn ? planText(t, w, now) : null
    if (
      !(await confirm({
        title: t('nurseOrders.sendQ', { what, name: patientName }),
        body: [
          self
            ? t('nurseOrders.sendToMe', { button: t(BUTTON_WORD[action]) })
            : t(nurse ? 'nurseOrders.sendToOne' : 'nurseOrders.sendToAll', {
                name: nurse?.name ?? '',
              }),
          `${t(
            {
              give: 'nurseOrders.summaryGive',
              hand: 'nurseOrders.summaryHand',
              done: 'nurseOrders.summaryDone',
            }[action],
          )} ${summaryWords(t, summary, {
            kind: f.kind,
            unit,
            act: actName,
            actCount,
            packUnit: pack?.packUnit ?? null,
            partText,
            home: repeatOn ? home : undefined,
          })}`,
          // once: one press ends it; repeated: the plan of the times
          plan ??
            [
              firstIso ? t('nurseOrders.at', { time: whenText(Date.parse(firstIso), now) }) : null,
              t(
                {
                  give: 'nurseOrders.sendOnce',
                  hand: 'nurseOrders.sendOnceHand',
                  done: 'nurseOrders.sendOnceAct',
                }[action],
              ),
            ]
              .filter(Boolean)
              .join(' · '),
        ].join(' '),
        confirmLabel: t(self ? 'nurseOrders.keepYes' : 'nurseOrders.sendYes'),
      }))
    )
      return
    const dose = doseOf(f.dose)
    try {
      await actions.create.mutateAsync({
        encounterId,
        kind: f.kind,
        text: f.kind === 'act' && !service ? f.text : undefined,
        serviceId: f.kind === 'act' ? f.serviceId || null : null,
        serviceName: service ? treatmentName(service, i18n.language) : null,
        itemId: f.kind === 'drug' ? f.itemId : null,
        itemName: item ? [item.name, item.strength].filter(Boolean).join(' ') : null,
        itemUnit: item?.unit ?? null,
        quantity: f.kind === 'drug' ? here : actCount,
        dose: showHere && f.kind === 'drug' ? hereDoseWords() : undefined,
        doseAmount: showHere && f.kind === 'drug' && dose ? dose.amount : null,
        doseUnit: showHere && f.kind === 'drug' && dose ? dose.unit : null,
        route: showHere ? f.route : undefined,
        partAmount: partN > 0 ? (mode === 'measure' ? numberOf(f.part) : partN) : null,
        partUnit: partN > 0 ? (mode === 'measure' ? 'ml' : 'piece') : null,
        partText,
        partPrice: partN > 0 && f.partPriceOn ? typedPrice : null,
        partPriceReason: partN > 0 && f.partPriceOn ? f.partPriceWhy.trim() : null,
        firstAt: whenOn && w.giveAt === 'later' ? firstIso : null,
        everyMinutes: repeatOn && hours ? hours * 60 : null,
        times: repeatOn && typeof count === 'number' ? count : null,
        untilStopped: repeatOn && count === 'until',
        homeQuantity: home,
        homeDose: showHome ? homeDoseWords() : undefined,
        homeFrequency: showHome ? f.homeFrequency : undefined,
        homeDays: showHome && f.homeDays.trim() ? Number(f.homeDays) : null,
        homeInstructions: showHome ? f.homeInstructions : undefined,
        assignedTo: f.assignedTo || null,
        assignedName: self ? null : (nurse?.name ?? null),
        notes: f.notes,
      })
      setF(emptyForm(f.kind))
      setAdding(false)
      onDone(
        t(
          self
            ? 'nurseOrders.keptForMe'
            : nurse
              ? 'nurseOrders.sentToOne'
              : 'nurseOrders.sentToAll',
          {
            what,
            name: nurse?.name ?? '',
            button: t(BUTTON_WORD[action]),
          },
        ),
      )
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x))
    }
  }

  // numbers only; a dot or a comma is kept, so a half is refused in words instead of becoming 5
  const amount = (v: string) => decimal(v)
  return (
    <div className="flex flex-col gap-3">
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-ink-2 text-[13px] font-semibold">{t('nurseOrders.title')}</span>
        {canOrder && !adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus size={14} aria-hidden="true" />
            {t('nurseOrders.add')}
          </Button>
        )}
      </span>
      {adding && (
        <Reveal focus block="nearest">
          <form
            onSubmit={submit}
            className="border-border bg-hover/40 flex flex-col gap-3 rounded-md border p-3"
          >
            <NurseRecipient
              value={f.assignedTo}
              onChange={(v) => set({ assignedTo: v })}
              selfId={myId}
              hint={t('nurseOrders.forWhomHint')}
              meHint={t('nurseOrders.meOrderHint')}
            />
            <div className="flex flex-col gap-1.5">
              <PartTitle title={t('nurseOrders.kindLabel')} hint={t('nurseOrders.kindHint')} />
              <Seg
                label={t('nurseOrders.kindLabel')}
                value={f.kind}
                onChange={(k) => setF({ ...emptyForm(k), assignedTo: f.assignedTo })}
                options={[
                  { value: 'drug', label: t('nurseOrders.kindDrug') },
                  { value: 'act', label: t('nurseOrders.kindAct') },
                ]}
                className="self-start"
              />
              <p className="text-ink-3 m-0 text-xs">
                {t(f.kind === 'drug' ? 'nurseOrders.drugHint' : 'nurseOrders.actHint')}
              </p>
            </div>
            {f.kind === 'drug' ? (
              <>
                <Hinted hint={t('nurseOrders.medicineHint')}>
                  <SearchSelect
                    label={t('clinical.medicine')}
                    value={f.itemId}
                    onChange={pickItem}
                    required
                    emptyLabel={t('clinical.pickMedicine')}
                    options={medicineOptions}
                  />
                </Hinted>
                {notInStock && (
                  <div
                    role="alert"
                    className="border-red bg-red-bg flex min-w-0 flex-col gap-2 rounded-md border px-3 py-2.5 text-[13px]"
                  >
                    <span className="text-red font-semibold">{notInStockText}</span>
                    <span className="text-ink">{t('nurseOrders.notInStockWays')}</span>
                    <span className="flex flex-wrap gap-2">
                      {onPrescribeOutside && (
                        <Button
                          size="sm"
                          onClick={() => {
                            onPrescribeOutside(f.itemId)
                            set({ itemId: '' })
                          }}
                        >
                          <Pill size={14} aria-hidden="true" />
                          {t('nurseOrders.prescribeOutside')}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => set({ itemId: '' })}>
                        <X size={14} aria-hidden="true" />
                        {t('nurseOrders.removeMedicine')}
                      </Button>
                    </span>
                  </div>
                )}
                {!notInStock && (
                  <div className="flex flex-col gap-1.5">
                    <PartTitle title={t('nurseOrders.where')} hint={t('nurseOrders.whereHint')} />
                    <Seg
                      label={t('nurseOrders.where')}
                      value={f.where}
                      onChange={(w) => set({ where: w })}
                      options={[
                        { value: 'here', label: t('nurseOrders.whereHere') },
                        { value: 'home', label: t('nurseOrders.whereHome') },
                        { value: 'both', label: t('nurseOrders.whereBoth') },
                      ]}
                      className="self-start"
                    />
                  </div>
                )}
                {!notInStock && showHere && (
                  <fieldset className="border-border bg-card m-0 flex min-w-0 flex-col gap-3 rounded-md border p-2.5">
                    <legend className="px-1">
                      <PartTitle title={t('nurseOrders.hereTitle')} />
                    </legend>
                    {/* the dose: a number and a unit for the nurse; it counts no tablets */}
                    <Hinted hint={t('nurseOrders.doseHint')}>
                      <DoseInput
                        label={t('nurseOrders.doseWords')}
                        value={f.dose}
                        onChange={setDose}
                        units={units}
                      />
                    </Hinted>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
                      <Hinted hint={t('nurseOrders.hereAmountHint')}>
                        <Field
                          label={t('nurseOrders.hereAmount', { unit })}
                          inputMode="numeric"
                          value={f.quantity}
                          onChange={(e) => set({ quantity: amount(e.target.value) })}
                        />
                      </Hinted>
                      {/* 0198: a part of a piece, when the medicine may be given in parts */}
                      {partsOn && (
                        <Hinted hint={t('nurseOrders.andPartHint', { unit })}>
                          {mode === 'measure' ? (
                            <Field
                              label={t('nurseOrders.andPartMl')}
                              inputMode="decimal"
                              value={f.part}
                              onChange={(e) => set({ part: amount(e.target.value) })}
                            />
                          ) : (
                            <Select
                              label={t('nurseOrders.andPart')}
                              value={f.part}
                              onChange={(e) => set({ part: e.target.value })}
                            >
                              <option value="">{t('nurseOrders.partNone')}</option>
                              {(mode === 'quarter' ? [0.25, 0.5, 0.75] : [0.5]).map((x) => (
                                <option key={x} value={String(x)}>
                                  {`${partFigure(x, mode)} ${unit}`}
                                </option>
                              ))}
                            </Select>
                          )}
                        </Hinted>
                      )}
                      <Hinted hint={t('nurseOrders.routeHint')}>
                        <Select
                          label={t('clinical.route')}
                          value={f.route}
                          onChange={(e) => set({ route: e.target.value })}
                        >
                          {ROUTES.map((r) => (
                            <option key={r} value={r}>
                              {t(`clinical.routes.${r}`, { defaultValue: r })}
                            </option>
                          ))}
                        </Select>
                      </Hinted>
                    </div>
                    {/* 0198: the price of the part, by the medicine's rule, changeable with a reason */}
                    {partN > 0 && partText && (
                      <div className="flex min-w-0 flex-col gap-2 text-[13px]">
                        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                          <span className="text-ink min-w-0">
                            {t('nurseOrders.partPrice', {
                              part: partText,
                              price:
                                partPriceNow != null
                                  ? formatRwf(partPriceNow)
                                  : t('nurseOrders.whyNoPrice'),
                            })}
                            {!f.partPriceOn && rulePrice != null && (
                              <span className="text-ink-3"> ({ruleWord})</span>
                            )}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              set(
                                f.partPriceOn
                                  ? { partPriceOn: false, partPrice: '', partPriceWhy: '' }
                                  : {
                                      partPriceOn: true,
                                      partPrice: rulePrice != null ? String(rulePrice) : '',
                                    },
                              )
                            }
                          >
                            {t(
                              f.partPriceOn
                                ? 'nurseOrders.partPriceKeep'
                                : 'nurseOrders.partPriceChange',
                            )}
                          </Button>
                        </span>
                        {f.partPriceOn && (
                          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                            <Field
                              label={t('nurseOrders.partPriceNew', { part: partText })}
                              inputMode="numeric"
                              value={f.partPrice}
                              onChange={(e) =>
                                set({ partPrice: e.target.value.replace(/\D/g, '') })
                              }
                            />
                            <Hinted hint={t('nurseOrders.partPriceHint')}>
                              <Field
                                label={t('nurseOrders.partPriceWhy')}
                                value={f.partPriceWhy}
                                onChange={(e) => set({ partPriceWhy: e.target.value })}
                              />
                            </Hinted>
                          </div>
                        )}
                      </div>
                    )}
                  </fieldset>
                )}
                {!notInStock && showHome && (
                  <fieldset className="border-border bg-card m-0 flex min-w-0 flex-col gap-2 rounded-md border p-2.5">
                    <legend className="px-1">
                      <PartTitle title={t('nurseOrders.takeHomeTitle')} />
                    </legend>
                    <PartTitle
                      title={t('nurseOrders.howAtHome')}
                      hint={t('nurseOrders.howAtHomeHint')}
                    />
                    {/* the dose each time: typed in the medicine's pieces, the count is worked out */}
                    <Hinted hint={t('nurseOrders.homeDoseHint', { unit })}>
                      <DoseInput
                        label={t('nurseOrders.homeDose')}
                        value={f.homeDose}
                        onChange={(v) => setHome({ homeDose: v })}
                        units={units}
                      />
                    </Hinted>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
                      <Select
                        label={t('nurseOrders.homeOften')}
                        value={f.homeFrequency}
                        onChange={(e) => setHome({ homeFrequency: e.target.value })}
                      >
                        <option value="">{t('nurseOrders.homeOftenPick')}</option>
                        {FREQUENCIES.map((x) => (
                          <option key={x} value={x}>
                            {t(`clinical.frequencies.${x}`)}
                          </option>
                        ))}
                      </Select>
                      <Field
                        label={t('nurseOrders.homeDays')}
                        inputMode="numeric"
                        value={f.homeDays}
                        onChange={(e) => setHome({ homeDays: amount(e.target.value) })}
                      />
                      <Field
                        wrapperClassName="sm:col-span-2 xl:col-span-1"
                        label={t('nurseOrders.homeInstructions')}
                        value={f.homeInstructions}
                        onChange={(e) => set({ homeInstructions: e.target.value })}
                        placeholder={t('nurseOrders.homeInstructionsPh')}
                      />
                    </div>
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="min-w-[12rem] flex-[1_1_14rem]">
                        <Hinted
                          hint={t('nurseOrders.homeAmountHint', {
                            button: t(BUTTON_WORD[f.where === 'home' ? 'hand' : 'give']),
                          })}
                        >
                          <Field
                            label={t('nurseOrders.homeAmount', { unit })}
                            inputMode="numeric"
                            value={f.homeQuantity}
                            onChange={(e) =>
                              set({ homeQuantity: amount(e.target.value), homeTouched: true })
                            }
                          />
                        </Hinted>
                      </div>
                      {homeBoxes && (
                        <span className="text-ink-2 pb-6 text-[13px]">= {homeBoxes}</span>
                      )}
                      {rest != null && (
                        <Button
                          size="sm"
                          variant="tint-grey"
                          className="mb-5"
                          onClick={() => set({ homeQuantity: String(rest), homeTouched: true })}
                        >
                          <PackageOpen size={14} aria-hidden="true" />
                          {t('nurseOrders.restOfPack', { pack: packWord, count: rest })}
                        </Button>
                      )}
                    </div>
                    {workedOut && (
                      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
                        <span aria-live="polite" className="text-ink-2 min-w-0">
                          {workedOut}
                        </span>
                        {take && f.homeQuantity !== String(take.total) && (
                          <Button
                            size="sm"
                            variant="tint-grey"
                            onClick={() =>
                              set({ homeQuantity: String(take.total), homeTouched: false })
                            }
                          >
                            <RotateCcw size={14} aria-hidden="true" />
                            {t('nurseOrders.useCount', { count: take.total })}
                          </Button>
                        )}
                      </span>
                    )}
                  </fieldset>
                )}
              </>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
                {/* 0150: the act is one of the clinic's treatments (billed when it is done);
                    written only when it is not in the price list — then nothing is billed */}
                <Hinted hint={t('nurseOrders.actFieldHint')}>
                  <SearchSelect
                    label={t('nurseOrders.act')}
                    value={f.serviceId || (f.text ? TYPED_ACT : '')}
                    onChange={(v) => {
                      if (v === TYPED_ACT) set({ serviceId: '' })
                      else set({ serviceId: v, text: '' })
                    }}
                    emptyLabel={t('nurseOrders.actPick')}
                    options={[
                      ...(f.text && !f.serviceId
                        ? [{ value: TYPED_ACT, label: t('nurseOrders.typedAct', { name: f.text }) }]
                        : []),
                      ...acts.map((s) => ({
                        value: s.id,
                        label: treatmentName(s, i18n.language),
                        hint: s.cashPrice != null ? formatRwf(s.cashPrice) : undefined,
                        keywords: [s.code, s.nameEn, s.nameFr, s.nameKin].filter(Boolean).join(' '),
                      })),
                    ]}
                    onWrite={(text) => set({ serviceId: '', text })}
                    writeLabel={(text) => t('nurseOrders.writeAct', { name: text })}
                  />
                  {!f.serviceId && f.text && (
                    <span className="text-amber block text-[12px] font-semibold">
                      {t('nurseOrders.typedHint')}
                    </span>
                  )}
                </Hinted>
                <Hinted hint={t('nurseOrders.actOnBillHint')}>
                  <Field
                    label={t('nurseOrders.actOnBill')}
                    inputMode="decimal"
                    value={f.actQuantity}
                    onChange={(e) => set({ actQuantity: e.target.value.replace(/[^\d.]/g, '') })}
                  />
                </Hinted>
              </div>
            )}
            {/* 0198: when, and how often (not for a medicine only to take home) */}
            {whenOn && !notInStock && (
              <OrderWhen
                value={w}
                onChange={setWhen}
                repeatable
                inBed={inBed}
                homeSplit={f.kind === 'drug' && f.where === 'both'}
                now={now}
              />
            )}
            <Hinted hint={t('nurseOrders.notesHint')}>
              <Field
                label={t('nurseOrders.notesLabel')}
                value={f.notes}
                onChange={(e) => set({ notes: e.target.value })}
                placeholder={t('nurseOrders.notesPh')}
              />
            </Hinted>
            {/* what will happen is said once a medicine is chosen (never "no price" for none) */}
            {notInStock || (f.kind === 'drug' && !item) ? null : notWhole || !partOk ? (
              <p
                role="alert"
                className="border-red bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[13px] font-semibold"
              >
                {notWhole
                  ? t(partsOn ? 'nurseOrders.errWholePart' : 'nurseOrders.errWhole')
                  : t('nurseOrders.errPart', { unit })}
              </p>
            ) : (
              <OrderSummary
                summary={summary}
                kind={f.kind}
                hand={action === 'hand'}
                unit={unit}
                act={actName}
                actCount={actCount}
                packUnit={pack?.packUnit ?? null}
                partText={partText}
                home={repeatOn ? home : undefined}
              />
            )}
            {err && (
              <p
                role="alert"
                className="bg-red-bg text-red m-0 rounded-md px-3 py-2 text-[13px] font-semibold"
              >
                {err}
              </p>
            )}
            <span className="flex flex-wrap gap-2">
              <Button
                type="submit"
                variant="primary"
                loading={actions.create.isPending}
                disabled={blocked || notInStock}
              >
                <Send size={14} aria-hidden="true" />
                {t(f.assignedTo === myId ? 'ops.tasks.keep' : 'nurseOrders.send')}
              </Button>
              <Button variant="ghost" onClick={() => setAdding(false)}>
                {t('staff.form.cancel')}
              </Button>
            </span>
          </form>
        </Reveal>
      )}
      {orders.length === 0 && !adding && (
        <EmptyNote>
          <Pill size={14} aria-hidden="true" className="mr-1 inline align-[-2px]" />
          <Syringe size={14} aria-hidden="true" className="mr-1 inline align-[-2px]" />
          {t('nurseOrders.none')}
        </EmptyNote>
      )}
      {orders.map((o) => (
        <NurseOrderRow
          key={o.id}
          order={o}
          patientName={patientName}
          patientFile={patientFile}
          myId={myId}
          isManager={isManager}
          visitOver={visitOver}
          cancel={canOrder && (o.byId === myId || isManager)}
          // the doctor who gave it may do it himself (0133): Given / Done like the nurse
          carryOut={canOrder && o.byId === myId}
          onDone={onDone}
          onError={onError}
        />
      ))}
    </div>
  )
}

import { useState, type FormEvent, type ReactNode } from 'react'
import { PackageOpen, Pill, Plus, Send, Syringe } from 'lucide-react'
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
import { treatmentName, useTreatments } from '@/lib/api/catalogue'
import { useItems } from '@/lib/api/patients'
import {
  useClinicStock,
  useNurseOrderActions,
  useOrderNurses,
  type NurseOrder,
  type NurseOrderKind,
} from '@/lib/api/nurse-orders'
import { restOfBox, summarizeOrder, summaryWords } from '@/lib/order-summary'
import { orderAction } from '@/lib/order-words'
import { useConfirm } from '@/lib/confirm'
import { packsText } from '@/pages/stock/stock-util'

const ROUTES = ['oral', 'IV', 'IM', 'SC', 'topical', 'rectal', 'inhaled', 'other']
const FREQUENCIES = ['OD', 'BD', 'TDS', 'QID', 'Q8H', 'Q6H', 'NOCTE', 'PRN', 'STAT'] as const
/** "All the nurses" in the For whom list. */
const ALL = ''

/** The chooser's row for an act that is not in the price list (written, not billed). */
const TYPED_ACT = '__typed__'

/** Where the patient takes the medicine (0193). */
type Where = 'here' | 'home' | 'both'

const emptyForm = (kind: NurseOrderKind) => ({
  kind,
  where: 'here' as Where,
  itemId: '',
  // given here: whole pieces, the dose and the route are words for the nurse
  quantity: '1',
  dose: '',
  route: 'oral',
  // to take home: whole pieces and how to take them (no silent "three times a day")
  homeQuantity: '',
  homeDose: '',
  homeFrequency: '',
  homeDays: '',
  homeInstructions: '',
  // a medical act: from the price list (billed) or written (not billed), how many on the bill
  serviceId: '',
  text: '',
  actQuantity: '1',
  assignedTo: ALL,
  notes: '',
})

/** A field with its grey one-line hint under it: what it does. */
function Hinted({ hint, children }: { hint: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {children}
      <span className="text-ink-3 text-xs">{hint}</span>
    </div>
  )
}

/** A small heading inside the form, with its hint. */
function PartTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-ink-2 text-[13px] font-semibold">{title}</span>
      {hint && <span className="text-ink-3 text-xs">{hint}</span>}
    </span>
  )
}

/**
 * Step 6 (0127; 0193): the orders carried out here — MEDICAL ACTS (an injection, a dressing, an IV
 * line…; from the clinic's treatments so it is billed) and MEDICINES of the clinic's stock, given
 * here and/or taken home (how many, the dose, and for home how to take it, printed on the label).
 * Each order is carried out ONCE: one press of Given / Handed over / Done takes everything from the
 * stock and puts it on the bill. For one nurse, all of them, or the doctor himself. The box above
 * Send says what will happen; every field says what it does. Below: each order, with Undo.
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
  onDone: (m: string) => void
  onError: (m: string | null) => void
}) {
  const { t, i18n } = useTranslation()
  const confirm = useConfirm()
  const actions = useNurseOrderActions()
  const [adding, setAdding] = useState(false)
  const [f, setF] = useState(() => emptyForm('drug'))
  const [err, setErr] = useState<string | null>(null)
  const { data: items = [] } = useItems()
  const { data: stock } = useClinicStock(adding)
  const { data: treatments = [] } = useTreatments(adding)
  const { data: nurses = [] } = useOrderNurses(adding)
  // the treatments charged on the visit (not the tests a desk carries out)
  const acts = treatments.filter(
    (x) => !x.orderStation && x.active !== false && x.code !== 'BED-STAY',
  )
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }))
  const item = items.find((x) => x.id === f.itemId)
  const service = acts.find((x) => x.id === f.serviceId)
  const pack = item ? (stock?.packs[item.id] ?? null) : null
  const unit = item?.unit || t('nurseOrders.unit')
  const packWord = pack?.packUnit || t('nurseOrders.pack')
  const showHere = f.where !== 'home'
  const showHome = f.where !== 'here'
  const here = showHere ? Number(f.quantity || 0) : 0
  const home = showHome ? Number(f.homeQuantity || 0) : 0
  // the button the nurse will press: Given / Handed over (all to take home) / Done
  const action = orderAction({ kind: f.kind, quantity: here, homeQuantity: home })
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
  })
  // a half or a decimal typed in a count is said at once, never turned into a bigger number
  const notWhole = f.kind === 'drug' && (!Number.isInteger(here) || !Number.isInteger(home))
  const blocked =
    f.kind === 'drug' && (notWhole || summary.tone === 'short' || summary.tone === 'wholePacks')
  const rest = f.where === 'both' && !notWhole ? restOfBox(here, pack?.size) : null
  // the take-home pieces in boxes ("1 box of 20"), when they make one or more
  const homeBoxes =
    pack && home > 0 && !notWhole ? packsText(t, home, pack.size, pack.packUnit) : null

  // the picker: the medicines the clinic has first, with how many and the price; the others
  // last, to prescribe for an outside pharmacy instead
  const medicineOptions: SearchOption[] = items
    .map((it) => {
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
      return {
        option: {
          value: it.id,
          label: [it.name, it.strength, it.form ? `· ${it.form}` : null].filter(Boolean).join(' '),
          sub:
            [
              n == null
                ? null
                : n > 0
                  ? t('nurseOrders.inStock', { count: n })
                  : t('nurseOrders.noStock'),
              p
                ? t('nurseOrders.boxOf', {
                    pack: p.packUnit || t('nurseOrders.pack'),
                    size: p.size,
                  })
                : null,
            ]
              .filter(Boolean)
              .join(' · ') || undefined,
          hint: prices.length ? prices.join(' · ') : undefined,
          keywords: it.code,
          group:
            n == null
              ? undefined
              : n > 0
                ? t('nurseOrders.groupInStock')
                : t('nurseOrders.groupNoStock'),
        },
        has: n == null || n > 0,
      }
    })
    .sort((a, b) => Number(b.has) - Number(a.has))
    .map((x) => x.option)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr(null)
    if (f.kind === 'drug') {
      if (!item) return setErr(t('nurseOrders.errMedicine'))
      if (notWhole) return setErr(t('nurseOrders.errWhole'))
      if (here + home <= 0) return setErr(t('nurseOrders.errAmounts'))
      // "Both": each part has its number (never a take-home part dropped without a word)
      if (f.where === 'both' && !(here > 0)) return setErr(t('nurseOrders.errHereAmount'))
      if (f.where === 'both' && !(home > 0)) return setErr(t('nurseOrders.errHomeAmount'))
      const days = f.homeDays.trim()
      if (home > 0 && days && !(Number.isInteger(Number(days)) && +days >= 1 && +days <= 365))
        return setErr(t('nurseOrders.errHomeDays'))
      if (blocked)
        return setErr(
          summaryWords(t, summary, {
            kind: 'drug',
            unit,
            act: '',
            actCount,
            packUnit: pack?.packUnit ?? null,
          }),
        )
    } else {
      if (!service && f.text.trim().length < 2) return setErr(t('nurseOrders.errAct'))
      if (!(actCount > 0)) return setErr(t('nurseOrders.errActQty'))
    }
    const nurse = nurses.find((n) => n.id === f.assignedTo)
    // "Me — I do it myself" (0133): the order is the doctor's; he marks it given or done below
    const self = f.assignedTo === myId
    const what =
      f.kind === 'drug' ? [item?.name, item?.strength].filter(Boolean).join(' ') : actName
    if (
      !(await confirm({
        title: t('nurseOrders.sendQ', { what, name: patientName }),
        body: [
          self
            ? t('nurseOrders.sendToMe')
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
          })}`,
          t(
            {
              give: 'nurseOrders.sendOnce',
              hand: 'nurseOrders.sendOnceHand',
              done: 'nurseOrders.sendOnceAct',
            }[action],
          ),
        ].join(' '),
        confirmLabel: t(self ? 'nurseOrders.keepYes' : 'nurseOrders.sendYes'),
      }))
    )
      return
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
        dose: showHere ? f.dose : undefined,
        route: showHere ? f.route : undefined,
        homeQuantity: home,
        homeDose: showHome ? f.homeDose : undefined,
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
          },
        ),
      )
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x))
    }
  }

  // numbers only; a dot or a comma is kept, so a half is refused in words instead of becoming 5
  const amount = (v: string) => v.replace(/,/g, '.').replace(/[^\d.]/g, '')
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
                    onChange={(v) => set({ itemId: v })}
                    required
                    emptyLabel={t('clinical.pickMedicine')}
                    options={medicineOptions}
                  />
                </Hinted>
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
                {showHere && (
                  <fieldset className="border-border bg-card m-0 flex min-w-0 flex-col gap-2 rounded-md border p-2.5">
                    <legend className="px-1">
                      <PartTitle title={t('nurseOrders.hereTitle')} />
                    </legend>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
                      <Hinted hint={t('nurseOrders.hereAmountHint')}>
                        <Field
                          label={t('nurseOrders.hereAmount', { unit })}
                          inputMode="numeric"
                          value={f.quantity}
                          onChange={(e) => set({ quantity: amount(e.target.value) })}
                        />
                      </Hinted>
                      <Hinted hint={t('nurseOrders.doseHint')}>
                        <Field
                          label={t('nurseOrders.doseWords')}
                          value={f.dose}
                          onChange={(e) => set({ dose: e.target.value })}
                          placeholder="1 g"
                        />
                      </Hinted>
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
                  </fieldset>
                )}
                {showHome && (
                  <fieldset className="border-border bg-card m-0 flex min-w-0 flex-col gap-2 rounded-md border p-2.5">
                    <legend className="px-1">
                      <PartTitle title={t('nurseOrders.takeHomeTitle')} />
                    </legend>
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="min-w-[12rem] flex-[1_1_14rem]">
                        <Hinted hint={t('nurseOrders.homeAmountHint')}>
                          <Field
                            label={t('nurseOrders.homeAmount', { unit })}
                            inputMode="numeric"
                            value={f.homeQuantity}
                            onChange={(e) => set({ homeQuantity: amount(e.target.value) })}
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
                          onClick={() => set({ homeQuantity: String(rest) })}
                        >
                          <PackageOpen size={14} aria-hidden="true" />
                          {t('nurseOrders.restOfPack', { pack: packWord, count: rest })}
                        </Button>
                      )}
                    </div>
                    <PartTitle
                      title={t('nurseOrders.howAtHome')}
                      hint={t('nurseOrders.howAtHomeHint')}
                    />
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
                      <Field
                        label={t('nurseOrders.homeDose')}
                        value={f.homeDose}
                        onChange={(e) => set({ homeDose: e.target.value })}
                        placeholder={t('nurseOrders.homeDosePh')}
                      />
                      <Select
                        label={t('nurseOrders.homeOften')}
                        value={f.homeFrequency}
                        onChange={(e) => set({ homeFrequency: e.target.value })}
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
                        onChange={(e) => set({ homeDays: amount(e.target.value) })}
                      />
                      <Field
                        label={t('nurseOrders.homeInstructions')}
                        value={f.homeInstructions}
                        onChange={(e) => set({ homeInstructions: e.target.value })}
                        placeholder={t('nurseOrders.homeInstructionsPh')}
                      />
                    </div>
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
            <Hinted hint={t('nurseOrders.notesHint')}>
              <Field
                label={t('nurseOrders.notesLabel')}
                value={f.notes}
                onChange={(e) => set({ notes: e.target.value })}
                placeholder={t('nurseOrders.notesPh')}
              />
            </Hinted>
            {notWhole ? (
              <p
                role="alert"
                className="border-red bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[13px] font-semibold"
              >
                {t('nurseOrders.errWhole')}
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
                disabled={blocked}
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

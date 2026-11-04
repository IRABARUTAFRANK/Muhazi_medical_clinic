import { useState, type FormEvent } from 'react'
import { Pill, Plus, Send, Syringe } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Reveal } from '@/components/ui/reveal'
import { SearchSelect } from '@/components/ui/search-select'
import { Seg } from '@/components/ui/seg'
import { Select } from '@/components/ui/select'
import { NurseOrderRow } from '@/components/clinical/nurse-order-row'
import { NurseRecipient } from '@/components/clinical/nurse-recipient'
import { EmptyNote } from '@/components/clinical/empty-note'
import { treatmentName, useTreatments } from '@/lib/api/catalogue'
import { useItems } from '@/lib/api/patients'
import {
  useNurseOrderActions,
  useOrderNurses,
  type NurseOrder,
  type NurseOrderKind,
} from '@/lib/api/nurse-orders'
import { useConfirm } from '@/lib/confirm'

const ROUTES = ['oral', 'IV', 'IM', 'SC', 'topical', 'rectal', 'inhaled', 'other']
const FREQUENCIES = ['STAT', 'OD', 'BD', 'TDS', 'QID', 'Q8H', 'Q6H', 'NOCTE', 'PRN'] as const
/** "All the nurses" in the For whom list. */
const ALL = ''

const emptyForm = (kind: NurseOrderKind) => ({
  kind,
  text: '',
  serviceId: '',
  itemId: '',
  quantity: '1',
  dose: '',
  route: kind === 'drug' ? 'oral' : 'IM',
  frequency: kind === 'drug' ? 'TDS' : 'STAT',
  doses: kind === 'drug' ? '3' : '1',
  assignedTo: ALL,
  notes: '',
})

/**
 * Step 6 (0127): the orders to the nurses — MEDICAL ACTS (an injection, a dressing, an IV line,
 * a nebulisation…, with a treatment of the catalogue so it is billed) and DRUGS TO GIVE (a
 * medicine of the stock, its dose, route, how often and how many times; taken from the nurse's
 * room store and billed each time it is given), for one nurse or all of them. Below: each
 * order with how far it is (given 2/3) and the times recorded.
 */
export function NurseOrdersStep({
  encounterId,
  orders,
  canOrder,
  myId,
  isManager,
  patientName,
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
  const { data: treatments = [] } = useTreatments(adding)
  const { data: nurses = [] } = useOrderNurses(adding)
  // the treatments charged on the visit (not the tests a desk carries out)
  const acts = treatments.filter(
    (x) => !x.orderStation && x.active !== false && x.code !== 'BED-STAY',
  )
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }))
  const item = items.find((x) => x.id === f.itemId)
  const service = acts.find((x) => x.id === f.serviceId)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr(null)
    const doses = Number(f.doses)
    const quantity = Number(f.quantity)
    if (!Number.isInteger(doses) || doses < 1 || doses > 60)
      return setErr(t('nurseOrders.errTimes'))
    if (!(quantity > 0)) return setErr(t('clinical.errors.rx'))
    if (f.kind === 'drug' && !item) return setErr(t('nurseOrders.errMedicine'))
    if (f.kind === 'act' && f.text.trim().length < 2 && !service)
      return setErr(t('nurseOrders.errAct'))
    const nurse = nurses.find((n) => n.id === f.assignedTo)
    // "Me — I do it myself" (0133): the order is the doctor's; he records each time below
    const self = f.assignedTo === myId
    const what =
      f.text.trim() ||
      (f.kind === 'drug'
        ? [item?.name, item?.strength].filter(Boolean).join(' ')
        : service
          ? treatmentName(service, i18n.language)
          : '')
    if (
      !(await confirm({
        title: t('nurseOrders.sendQ', { what, name: patientName }),
        body: [
          self
            ? t('nurseOrders.sendToMe')
            : t(nurse ? 'nurseOrders.sendToOne' : 'nurseOrders.sendToAll', {
                name: nurse?.name ?? '',
              }),
          t('nurseOrders.times', { count: doses }),
          f.kind === 'drug'
            ? t('nurseOrders.sendDrugBody')
            : service
              ? t('nurseOrders.sendActBody')
              : '',
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: t(self ? 'nurseOrders.keepYes' : 'nurseOrders.sendYes'),
      }))
    )
      return
    try {
      await actions.create.mutateAsync({
        encounterId,
        kind: f.kind,
        text: f.text,
        serviceId: f.kind === 'act' ? f.serviceId || null : null,
        serviceName: service ? treatmentName(service, i18n.language) : null,
        itemId: f.kind === 'drug' ? f.itemId : null,
        itemName: item ? [item.name, item.strength].filter(Boolean).join(' ') : null,
        quantity,
        dose: f.dose,
        route: f.route,
        frequency: f.frequency,
        doses,
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
            />
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
            {f.kind === 'drug' ? (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div className="col-span-2 min-w-0">
                  <SearchSelect
                    label={t('clinical.medicine')}
                    value={f.itemId}
                    onChange={(v) => set({ itemId: v })}
                    required
                    emptyLabel={t('clinical.pickMedicine')}
                    options={items.map((it) => ({
                      value: it.id,
                      label: [it.name, it.strength, it.form ? `· ${it.form}` : null]
                        .filter(Boolean)
                        .join(' '),
                    }))}
                  />
                </div>
                <Field
                  label={t('nurseOrders.dose')}
                  value={f.dose}
                  onChange={(e) => set({ dose: e.target.value })}
                  placeholder="1 g"
                />
                <Field
                  label={t('nurseOrders.unitsLabel', { unit: item?.unit ?? t('nurseOrders.unit') })}
                  inputMode="decimal"
                  value={f.quantity}
                  onChange={(e) => set({ quantity: e.target.value.replace(/[^\d.]/g, '') })}
                  required
                />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div className="col-span-2">
                  <Field
                    label={t('nurseOrders.what')}
                    value={f.text}
                    onChange={(e) => set({ text: e.target.value })}
                    placeholder={t('nurseOrders.whatPh')}
                  />
                </div>
                <div className="col-span-2 min-w-0 lg:col-span-1">
                  <SearchSelect
                    label={t('nurseOrders.billAs')}
                    value={f.serviceId}
                    onChange={(v) => set({ serviceId: v })}
                    emptyLabel={t('nurseOrders.notBilledChoice')}
                    options={acts.map((s) => ({
                      value: s.id,
                      label: treatmentName(s, i18n.language),
                    }))}
                  />
                </div>
                <Field
                  label={t('nurseOrders.quantity')}
                  inputMode="decimal"
                  value={f.quantity}
                  onChange={(e) => set({ quantity: e.target.value.replace(/[^\d.]/g, '') })}
                />
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
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
              <Select
                label={t('nurseOrders.howOften')}
                value={f.frequency}
                onChange={(e) => set({ frequency: e.target.value })}
              >
                {FREQUENCIES.map((x) => (
                  <option key={x} value={x}>
                    {t(`clinical.frequencies.${x}`)}
                  </option>
                ))}
              </Select>
              <Field
                label={t('nurseOrders.timesLabel')}
                inputMode="numeric"
                value={f.doses}
                onChange={(e) => set({ doses: e.target.value.replace(/[^\d]/g, '') })}
                required
              />
            </div>
            <Field
              label={t('nurseOrders.notesLabel')}
              value={f.notes}
              onChange={(e) => set({ notes: e.target.value })}
              placeholder={t('nurseOrders.notesPh')}
            />
            {err && (
              <p
                role="alert"
                className="bg-red-bg text-red m-0 rounded-md px-3 py-2 text-[13px] font-semibold"
              >
                {err}
              </p>
            )}
            <span className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" loading={actions.create.isPending}>
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

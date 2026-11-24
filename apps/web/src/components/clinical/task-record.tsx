import { useMemo, useState, type FormEvent } from 'react'
import { ClipboardCheck, PenLine, Pill, Syringe, TriangleAlert, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf, formatTime } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { SearchSelect, type SearchOption } from '@/components/ui/search-select'
import { Seg } from '@/components/ui/seg'
import { Select } from '@/components/ui/select'
import { Hinted } from '@/components/clinical/six-steps/order-form-parts'
import { treatmentName, useTreatments } from '@/lib/api/catalogue'
import type { OpenTask } from '@/lib/api/desk-ops'
import { useClinicStock, useNurseOrderActions } from '@/lib/api/nurse-orders'
import { useItems } from '@/lib/api/patients'
import { findDuplicate, useRecordForTask, useVisitOrdersAll } from '@/lib/api/task-record'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'

const ROUTES = ['oral', 'IV', 'IM', 'SC', 'topical', 'rectal', 'inhaled', 'other']
/** The act typed in words (not in the price list). */
const TYPED = '__typed__'

/**
 * 0200 · Under a task of the doctor ("give Paracetamol 1 g now"), the nurse records what she gave
 * (a medicine of the clinic's stock) or did (a medical act): it leaves the stock and goes on the
 * bill as an order of the doctor marked given, and the doctor is told. When the doctor already
 * ordered the same thing for this visit and it is still to do, or it was given lately, she is told
 * before sending, with the way out (mark that order given); recording it even so needs why. What
 * was recorded is listed under the task. Shown only when the database has 0200 (task.recorded).
 */
export function TaskRecordPart({
  task,
  canRecord = true,
  className,
}: {
  task: OpenTask
  canRecord?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const recorded = task.recorded ?? []
  if (task.recorded === undefined || !task.encounterId) return null
  return (
    <div className={cn('flex min-w-0 basis-full flex-col gap-2', className)}>
      {recorded.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {recorded.map((r) => (
            <li key={r.id} className="text-ink-2 flex min-w-0 items-start gap-1.5 text-[13px]">
              <ClipboardCheck
                size={14}
                aria-hidden="true"
                className="text-green mt-0.5 flex-none"
              />
              <span className="min-w-0">
                {t('taskRecord.recordedLine', {
                  what:
                    r.kind === 'drug'
                      ? `${r.text} × ${r.quantity} ${r.unit ?? ''}`.trim()
                      : r.quantity > 1
                        ? `${r.text} × ${r.quantity}`
                        : r.text,
                  time: formatTime(new Date(r.at)),
                  name: r.by ?? '',
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {done && (
        <p
          role="status"
          className="border-green/30 bg-green-bg text-green m-0 rounded-md border px-3 py-2 text-[13px] font-medium"
        >
          {done}
        </p>
      )}
      {canRecord && !open && (
        <Button
          size="sm"
          variant="tint-violet"
          className="self-start"
          onClick={() => {
            setDone(null)
            setOpen(true)
          }}
        >
          <PenLine size={14} aria-hidden="true" />
          {t('taskRecord.open')}
        </Button>
      )}
      {canRecord && open && (
        <TaskRecordForm
          task={task}
          onClose={(message) => {
            setOpen(false)
            if (message) setDone(message)
          }}
        />
      )}
    </div>
  )
}

function TaskRecordForm({
  task,
  onClose,
}: {
  task: OpenTask
  onClose: (message?: string) => void
}) {
  const { t, i18n } = useTranslation()
  const confirm = useConfirm()
  const record = useRecordForTask()
  const orderActions = useNurseOrderActions()
  const { data: items = [] } = useItems()
  const { data: stock } = useClinicStock()
  const { data: treatments = [] } = useTreatments(true)
  const { data: orders = [] } = useVisitOrdersAll(task.encounterId)
  const [kind, setKind] = useState<'drug' | 'act'>('drug')
  const [itemId, setItemId] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [text, setText] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [dose, setDose] = useState('')
  const [route, setRoute] = useState('')
  const [note, setNote] = useState('')
  const [evenSo, setEvenSo] = useState(false)
  const [why, setWhy] = useState('')
  const [taskDone, setTaskDone] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const acts = treatments.filter(
    (x) => !x.orderStation && x.active !== false && x.code !== 'BED-STAY',
  )
  // only what the clinic's stock holds can be recorded as given here
  const inStock = (id: string) => (stock ? (stock.units[id] ?? 0) > 0 : true)
  const medicineOptions = useMemo(
    (): SearchOption[] =>
      items
        .filter((it) => inStock(it.id))
        .map((it) => {
          const unit = it.unit || t('nurseOrders.unit')
          const n = stock ? (stock.units[it.id] ?? 0) : null
          return {
            value: it.id,
            label: [it.name, it.strength, it.form ? `· ${it.form}` : null]
              .filter(Boolean)
              .join(' '),
            sub: n != null ? t('nurseOrders.inStock', { count: n, unit }) : undefined,
            hint:
              it.cashPrice != null
                ? t('nurseOrders.piecePrice', { price: formatRwf(it.cashPrice), unit })
                : undefined,
            keywords: [it.code, it.name].filter(Boolean).join(' '),
          }
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, stock, t],
  )
  const item = items.find((x) => x.id === itemId)
  const service = acts.find((x) => x.id === serviceId)
  const unit = item?.unit || t('nurseOrders.unit')
  const qty = Number(quantity || 0)
  const label =
    kind === 'drug'
      ? item
        ? [item.name, item.strength].filter(Boolean).join(' ')
        : ''
      : service
        ? treatmentName(service, i18n.language)
        : text.trim()
  const dup = findDuplicate(orders, {
    kind,
    itemId: itemId || null,
    serviceId: serviceId || null,
    text,
  })
  // what goes on the bill, at the cash price (an insurer's share is worked out on the bill)
  const amount =
    kind === 'drug'
      ? item?.cashPrice != null
        ? item.cashPrice * qty
        : null
      : service?.cashPrice != null
        ? service.cashPrice * qty
        : null
  const left = item && stock ? (stock.units[item.id] ?? 0) : null
  const short = kind === 'drug' && left != null && qty > left

  const giveThat = async () => {
    if (dup?.kind !== 'ordered') return
    const o = dup.order
    if (
      !(await confirm({
        title: t('nurseOrders.giveQ', { what: o.text, name: task.patient ?? '' }),
        body: t('taskRecord.giveThatBody'),
        confirmLabel: t('nurseOrders.giveYes'),
      }))
    )
      return
    setError(null)
    try {
      await orderActions.give.mutateAsync({ id: o.id })
      onClose(t('taskRecord.gaveThat', { what: o.text }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (kind === 'drug' && !item) return setError(t('taskRecord.errMedicine'))
    if (kind === 'act' && !label) return setError(t('taskRecord.errAct'))
    if (!(qty > 0) || (kind === 'drug' && !Number.isInteger(qty)))
      return setError(t('taskRecord.errQuantity'))
    if (dup && !evenSo) return setError(t('taskRecord.errDuplicate'))
    if (dup && evenSo && why.trim().length < 3) return setError(t('taskRecord.errWhy'))
    const what =
      kind === 'drug' ? `${label} × ${qty} ${unit}` : qty > 1 ? `${label} × ${qty}` : label
    if (
      !(await confirm({
        title: t('taskRecord.confirmTitle', { what, name: task.patient ?? '' }),
        body: t(kind === 'drug' ? 'taskRecord.confirmDrug' : 'taskRecord.confirmAct'),
        confirmLabel: t('taskRecord.confirmYes'),
      }))
    )
      return
    try {
      const r = await record.mutateAsync({
        taskId: task.id,
        kind,
        itemId: kind === 'drug' ? itemId : null,
        serviceId: kind === 'act' && serviceId ? serviceId : null,
        text: kind === 'act' && !serviceId ? text.trim() : null,
        quantity: qty,
        dose,
        route,
        note,
        evenSo: !!dup && evenSo,
        why,
        taskDone,
        label,
        unit: kind === 'drug' ? unit : null,
        price: kind === 'drug' ? (item?.cashPrice ?? null) : (service?.cashPrice ?? null),
      })
      onClose(
        [
          r.charged
            ? t('taskRecord.saved', { what, amount: formatRwf(r.billed) })
            : t('taskRecord.savedNotBilled', { what }),
          r.taskDone ? t('taskRecord.savedDone') : null,
        ]
          .filter(Boolean)
          .join(' '),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="border-border bg-card flex min-w-0 flex-col gap-3 rounded-md border p-3"
      aria-label={t('taskRecord.title')}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-ink text-[14px] font-semibold">{t('taskRecord.title')}</span>
        <span className="text-ink-3 text-xs">{t('taskRecord.hint')}</span>
      </span>
      <Seg<'drug' | 'act'>
        label={t('taskRecord.kind')}
        value={kind}
        onChange={(k) => {
          setKind(k)
          setEvenSo(false)
          setError(null)
        }}
        options={[
          { value: 'drug', label: t('taskRecord.kindDrug') },
          { value: 'act', label: t('taskRecord.kindAct') },
        ]}
        className="self-start"
      />
      {kind === 'drug' ? (
        <>
          <Hinted hint={t('taskRecord.medicineHint')}>
            <SearchSelect
              label={t('taskRecord.medicine')}
              value={itemId}
              onChange={(v) => {
                setItemId(v)
                setEvenSo(false)
              }}
              emptyLabel={t('taskRecord.medicinePick')}
              options={medicineOptions}
            />
          </Hinted>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-3">
            <Field
              label={t('taskRecord.howMany', { unit })}
              inputMode="numeric"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, ''))}
            />
            <Field
              label={t('taskRecord.dose')}
              value={dose}
              placeholder={t('taskRecord.dosePh')}
              onChange={(e) => setDose(e.target.value)}
            />
            <Select
              label={t('clinical.route')}
              value={route}
              onChange={(e) => setRoute(e.target.value)}
            >
              <option value="">—</option>
              {ROUTES.map((r) => (
                <option key={r} value={r}>
                  {t(`clinical.routes.${r}`, { defaultValue: r })}
                </option>
              ))}
            </Select>
          </div>
        </>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-3">
          <SearchSelect
            label={t('taskRecord.act')}
            value={serviceId || (text ? TYPED : '')}
            onChange={(v) => {
              if (v === TYPED) setServiceId('')
              else {
                setServiceId(v)
                setText('')
              }
              setEvenSo(false)
            }}
            emptyLabel={t('taskRecord.actPick')}
            options={[
              ...(text && !serviceId
                ? [{ value: TYPED, label: t('nurseOrders.typedAct', { name: text }) }]
                : []),
              ...acts.map((s) => ({
                value: s.id,
                label: treatmentName(s, i18n.language),
                hint: s.cashPrice != null ? formatRwf(s.cashPrice) : undefined,
                keywords: [s.code, s.nameEn, s.nameFr, s.nameKin].filter(Boolean).join(' '),
              })),
            ]}
            onWrite={(w) => {
              setServiceId('')
              setText(w)
            }}
            writeLabel={(w) => t('nurseOrders.writeAct', { name: w })}
          />
          <Field
            label={t('taskRecord.howManyAct')}
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, ''))}
          />
        </div>
      )}
      <Field
        label={t('taskRecord.note')}
        value={note}
        placeholder={t('taskRecord.notePh')}
        onChange={(e) => setNote(e.target.value)}
      />

      {/* the same thing twice: told before sending, with the way out */}
      {dup && (
        <div
          role="alert"
          className="border-amber/40 bg-amber-bg text-amber flex min-w-0 flex-col gap-2 rounded-md border px-3 py-2.5 text-[13px] font-medium"
        >
          <span className="flex min-w-0 items-start gap-2">
            <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
            <span className="min-w-0">
              {dup.kind === 'ordered'
                ? t('taskRecord.dupOrdered', {
                    by: dup.order.by ?? '',
                    what: dup.order.text,
                    time: formatTime(new Date(dup.order.at)),
                  })
                : t('taskRecord.dupGiven', {
                    what: dup.order.text,
                    time: formatTime(new Date(dup.at)),
                    by: dup.by ?? '',
                  })}
            </span>
          </span>
          {dup.kind === 'ordered' &&
            (dup.order.mine ? (
              <Button
                type="button"
                size="sm"
                variant="success"
                className="self-start"
                loading={orderActions.give.isPending}
                onClick={() => void giveThat()}
              >
                {t('taskRecord.giveThat')}
              </Button>
            ) : (
              <span className="text-ink-2 font-normal">
                {t('taskRecord.notMine', { name: dup.order.assignedName ?? '' })}
              </span>
            ))}
          <label className="text-ink flex min-w-0 cursor-pointer items-start gap-2 font-normal">
            <input
              type="checkbox"
              className="accent-primary mt-0.5 size-4 flex-none"
              checked={evenSo}
              onChange={(e) => setEvenSo(e.target.checked)}
            />
            <span className="min-w-0">{t('taskRecord.evenSo')}</span>
          </label>
          {evenSo && (
            <Field
              label={t('taskRecord.why')}
              value={why}
              placeholder={t('taskRecord.whyPh')}
              onChange={(e) => setWhy(e.target.value)}
            />
          )}
        </div>
      )}

      {(kind === 'drug' ? !!item : !!label) && (
        <p
          className={cn(
            'm-0 rounded-md border px-3 py-2 text-[13px]',
            short
              ? 'border-red/30 bg-red-bg text-red font-medium'
              : 'border-border bg-hover text-ink-2',
          )}
        >
          {kind === 'drug'
            ? short
              ? t('taskRecord.short', { count: left ?? 0, unit, asked: qty })
              : amount != null
                ? t('taskRecord.sumDrug', { count: qty, unit, amount: formatRwf(amount) })
                : t('taskRecord.sumDrugNoPrice', { count: qty, unit })
            : amount != null
              ? t('taskRecord.sumAct', { amount: formatRwf(amount) })
              : t('nurseOrders.summaryTyped')}
        </p>
      )}

      <label className="text-ink-2 flex min-w-0 cursor-pointer items-start gap-2 text-[13px]">
        <input
          type="checkbox"
          className="accent-primary mt-0.5 size-4 flex-none"
          checked={taskDone}
          onChange={(e) => setTaskDone(e.target.checked)}
        />
        <span className="min-w-0">{t('taskRecord.taskDone', { title: task.title })}</span>
      </label>

      {error && (
        <p
          role="alert"
          className="bg-red-bg text-red border-red/30 m-0 rounded-md border px-3 py-2 text-[13px] font-medium"
        >
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          loading={record.isPending}
          disabled={short || (!!dup && !evenSo)}
        >
          {kind === 'drug' ? (
            <Pill size={14} aria-hidden="true" />
          ) : (
            <Syringe size={14} aria-hidden="true" />
          )}
          {t('taskRecord.send')}
        </Button>
        <Button type="button" size="sm" variant="tint-grey" onClick={() => onClose()}>
          <X size={14} aria-hidden="true" />
          {t('taskRecord.cancel')}
        </Button>
      </div>
    </form>
  )
}

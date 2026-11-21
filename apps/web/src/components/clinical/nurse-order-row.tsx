import { useState } from 'react'
import {
  Ban,
  CheckCircle2,
  CircleSlash,
  Pill,
  Printer,
  Syringe,
  Undo2,
  UserRound,
  Users,
  XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf, formatTime, type Tone } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import {
  canUndoOrder,
  givenDoses,
  isOnce,
  orderDone,
  orderHow,
  useNurseOrderActions,
  type NurseOrder,
  type NurseOrderDose,
  type NurseOrderStatus,
} from '@/lib/api/nurse-orders'
import {
  giveBody,
  giveButton,
  giveMessage,
  giveTitle,
  giveYes,
  orderAction,
  partLines,
  stateWord,
} from '@/lib/order-words'
import { labelDose, orderLabel } from '@/lib/order-label'
import { openDispenseLabels, type DispenseLabel } from '@/lib/dispense-label'
import { useLetterhead } from '@/lib/report-parts'
import { useOrderUndo } from '@/lib/use-order-undo'

const STATUS_TONE: Record<NurseOrderStatus, Tone> = {
  open: 'yellow',
  done: 'green',
  not_done: 'red',
  cancelled: 'grey',
}
const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`

/**
 * One order of step 6 (0127; 0193): what, for whom, by whom. Since 0193 an order is carried out
 * once: its parts (given here; to take home with how to take it; an act and how it is billed), one
 * button (Given / Handed over / Done), then who did it, what left the stock and what went on the
 * bill, the label of what went home, and Undo for the person who recorded it (the same day) or the
 * manager. An order written before 0193 with several times keeps its count, its bar and Not given.
 * The nurse says it will not be done; the doctor who gave it (or the manager) cancels it.
 */
export function NurseOrderRow({
  order: o,
  patientName,
  patientFile,
  myId,
  isManager = false,
  visitOver = false,
  carryOut = false,
  cancel = false,
  showPatient = false,
  onDone,
  onError,
  onHanded,
}: {
  order: NurseOrder
  /** For the questions before each action, and the label. */
  patientName?: string
  /** The patient's file number, for the label. */
  patientFile?: string | null
  /** The reader: Undo is for the person who recorded it (the same day) or the manager. */
  myId?: string | null
  isManager?: boolean
  /** The visit is finished (a nurse's Undo then ends the order as not done). */
  visitOver?: boolean
  /** The nurse records the times (her order, or one for all nurses at her desk); also the doctor
   * who gave it, doing it himself (0133). */
  carryOut?: boolean
  /** The doctor who gave it (or the manager) may cancel it. */
  cancel?: boolean
  /** The nurse's Home list: the patient's name and file. */
  showPatient?: boolean
  onDone?: (message: string) => void
  onError?: (message: string | null) => void
  /** A medicine handed over to take home: its label, to print now or later (the nurse's Home). */
  onHanded?: (order: NurseOrder, label: DispenseLabel) => void
}) {
  const { t } = useTranslation()
  const actions = useNurseOrderActions()
  const confirm = useConfirm()
  const letterhead = useLetterhead()
  const { undo: askUndo, pending: undoing } = useOrderUndo()
  const [open, setOpen] = useState(false)
  const name = patientName || o.patient || t('confirm.visit.thisPatient')
  const open_ = o.status === 'open'
  const once = isOnce(o)
  const done = orderDone(o)
  const route = (r: string) => t(`clinical.routes.${r}`, { defaultValue: r })
  const frequency = (f: string) => t(`clinical.frequencies.${f}`, { defaultValue: f })
  const how = orderHow(o, route, frequency)
  const given = givenDoses(o)
  const mayUndo = canUndoOrder(o, myId, isManager)
  const forLabel = labelDose(o)
  const run = async (fn: () => Promise<string | null>) => {
    onError?.(null)
    try {
      const message = await fn()
      if (message) onDone?.(message)
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e))
    }
  }
  const give = async () => {
    const r = await confirm({
      title: once ? giveTitle(t, o, name) : t('nurseOrders.giveQ', { what: o.text, name }),
      body: once
        ? giveBody(t, o)
        : t(o.kind === 'drug' ? 'nurseOrders.giveDrugBody' : 'nurseOrders.giveActBody', {
            n: done + 1,
            count: o.dosesPlanned,
          }),
      input: { label: t('nurseOrders.noteLabel'), placeholder: t('nurseOrders.notePh') },
      confirmLabel: once
        ? giveYes(t, o)
        : t(o.kind === 'drug' ? 'nurseOrders.giveYes' : 'nurseOrders.doneYes'),
    })
    if (!r.ok) return
    void run(async () => {
      const res = await actions.give.mutateAsync({ id: o.id, note: r.value })
      // what went home: its label, kept on the nurse's Home to print now or later
      const label = once ? orderLabel(res, labelDose(res)) : null
      if (label) onHanded?.(res, label)
      return giveMessage(t, o, res)
    })
  }
  const skip = async () => {
    const r = await confirm({
      title: t('nurseOrders.skipQ', { what: o.text, name }),
      body: t('nurseOrders.skipBody'),
      input: { label: t('nurseOrders.skipWhy'), required: true, multiline: true },
      confirmLabel: t('nurseOrders.skipYes'),
      tone: 'danger',
    })
    if (!r.ok) return
    void run(async () => {
      await actions.skip.mutateAsync({ id: o.id, reason: r.value })
      return t('nurseOrders.skipSaved', { what: o.text })
    })
  }
  const stop = async (asDoctor: boolean) => {
    const r = await confirm({
      title: t(asDoctor ? 'nurseOrders.cancelQ' : 'nurseOrders.notDoneQ', { what: o.text, name }),
      body: t(asDoctor ? 'nurseOrders.cancelBody' : 'nurseOrders.notDoneBody'),
      input: { label: t('nurseOrders.stopWhy'), required: true, multiline: true },
      confirmLabel: t(asDoctor ? 'nurseOrders.cancelYes' : 'nurseOrders.notDoneYes'),
      tone: 'danger',
    })
    if (!r.ok) return
    void run(async () => {
      await actions.stop.mutateAsync({ id: o.id, reason: r.value })
      return t(asDoctor ? 'nurseOrders.cancelled' : 'nurseOrders.notDoneSaved', { what: o.text })
    })
  }
  const undo = () => void run(() => askUndo(o, { myId, isManager, patientName: name, visitOver }))
  const printLabel = (d: NurseOrderDose) => {
    const line = orderLabel(o, d)
    if (!line) return
    const ok = openDispenseLabels(
      {
        clinic: {
          name: letterhead.legalName,
          contacts: letterhead.contacts,
          phone: letterhead.phone,
        },
        patient: { name, fileNumber: patientFile ?? o.fileNumber ?? '' },
        date: new Date(d.at),
        lines: [line],
        dispensedBy: d.by ? { name: d.by } : null,
      },
      {
        title: t('pharmacy.labelTitle'),
        days: (n) => t('pharmacy.labelDays', { count: n }),
      },
    )
    if (!ok) onError?.(t('report.popupBlocked'))
  }
  /** One time carried out: who, when, what left the stock, what went on the bill. */
  const doseLine = (d: NurseOrderDose) => {
    const pieces = Number(d.quantity ?? 0) + Number(d.homeQuantity ?? 0)
    const unit = o.unit || t('nurseOrders.unit')
    const action = orderAction(o)
    const by = t(
      action === 'done'
        ? 'nurseOrders.doneBy'
        : action === 'hand'
          ? 'nurseOrders.handedBy'
          : 'nurseOrders.givenBy',
      { name: d.by ?? '', when: when(d.at) },
    )
    const stock =
      o.kind === 'drug' && pieces > 0 && d.store
        ? t('nurseOrders.fromStock', { count: pieces, unit, store: d.store })
        : null
    // an older database says only charged
    const onBill = d.onBill ?? d.charged
    const why =
      o.kind === 'act' && !o.serviceId
        ? t('nurseOrders.whyNotListed')
        : d.charged
          ? t('nurseOrders.whyRemoved')
          : t('nurseOrders.whyNoPriceOrClosed')
    return { by, stock, onBill, bill: onBill && d.billed != null ? formatRwf(d.billed) : null, why }
  }
  const busy = actions.give.isPending || actions.skip.isPending || actions.stop.isPending || undoing
  const Icon = o.kind === 'drug' ? Pill : Syringe
  const parts = once ? partLines(t, o) : []
  return (
    <div
      className={cn(
        'border-border flex flex-col gap-2 rounded-md border px-3 py-2.5',
        open_ ? 'bg-card' : 'bg-hover/40',
      )}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span
          className={cn(
            'mt-0.5 inline-flex size-8 flex-none items-center justify-center rounded-full',
            o.kind === 'drug' ? 'bg-violet-bg text-violet' : 'bg-teal-bg text-teal',
          )}
          aria-hidden="true"
        >
          <Icon size={16} />
        </span>
        <span className="min-w-0 flex-[1_1_14rem]">
          {showPatient && o.patient && (
            <span className="text-ink-2 block text-[13px] font-semibold">
              {[o.ticket, o.patient, o.fileNumber].filter(Boolean).join(' · ')}
            </span>
          )}
          <span className={cn('block font-semibold', o.status === 'cancelled' && 'line-through')}>
            {o.text}
          </span>
          {once ? (
            <>
              <span className="text-ink-3 block text-xs">
                {t(o.kind === 'drug' ? 'nurseOrders.kindDrug' : 'nurseOrders.kindAct')}
              </span>
              {parts.map((p) => (
                <span key={p} className="text-ink-2 block text-[13px]">
                  {p}
                </span>
              ))}
            </>
          ) : (
            <span className="text-ink-3 block text-xs">
              {[
                t(o.kind === 'drug' ? 'nurseOrders.kindDrug' : 'nurseOrders.kindAct'),
                how || null,
                o.kind === 'act' && o.service
                  ? t('nurseOrders.billedAs', { service: o.service })
                  : null,
                o.kind === 'drug' && o.quantity
                  ? t('nurseOrders.unitsEach', { count: o.quantity })
                  : null,
                t('nurseOrders.times', { count: o.dosesPlanned }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
          {o.notes && <span className="text-ink-2 block text-[13px]">{o.notes}</span>}
          <span className="text-ink-3 mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
            {o.assignedTo ? (
              <UserRound size={12} aria-hidden="true" />
            ) : (
              <Users size={12} aria-hidden="true" />
            )}
            {o.assignedTo
              ? t('nurseOrders.forNurse', { name: o.assignedName ?? '' })
              : t('nurseOrders.forAll')}
            <span>· {t('nurseOrders.byWhen', { name: o.by ?? '', when: when(o.at) })}</span>
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[o.status]} dot={false}>
            {stateWord(t, o)}
          </Badge>
          {!once && (
            <Badge tone={o.given > 0 ? 'blue' : 'grey'} dot={false} className="tabular-nums">
              {t(o.kind === 'drug' ? 'nurseOrders.progressDrug' : 'nurseOrders.progressAct', {
                given: o.given,
                count: o.dosesPlanned,
              })}
            </Badge>
          )}
        </span>
      </div>
      {/* an older order of several times: the bar (given, not given, still to do) and its times */}
      {!once && (
        <div
          className="bg-hover flex h-1.5 overflow-hidden rounded-full"
          role="img"
          aria-label={t('nurseOrders.progressAria', {
            given: o.given,
            notGiven: o.notGiven,
            count: o.dosesPlanned,
          })}
        >
          <span className="bg-green" style={{ width: `${(o.given / o.dosesPlanned) * 100}%` }} />
          <span className="bg-red" style={{ width: `${(o.notGiven / o.dosesPlanned) * 100}%` }} />
        </div>
      )}
      {!once && o.doses.length > 0 && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((x) => !x)}
          className="text-primary self-start bg-transparent p-0 text-xs font-semibold hover:underline"
        >
          {t('nurseOrders.timesLog', { count: o.doses.length })}
        </button>
      )}
      {!once && open && (
        <ol className="m-0 flex flex-col gap-1 pl-5 text-[13px]">
          {o.doses.map((d, i) => (
            <li key={d.id ?? d.n} className={d.given ? 'text-ink' : 'text-red'}>
              {d.given ? (
                <CheckCircle2 size={12} aria-hidden="true" className="mr-1 inline align-[-1px]" />
              ) : (
                <CircleSlash size={12} aria-hidden="true" className="mr-1 inline align-[-1px]" />
              )}
              {[
                // the times standing, counted 1, 2, 3 (an undone time leaves a gap in its number)
                t(d.given ? 'nurseOrders.doseGiven' : 'nurseOrders.doseNotGiven', { n: i + 1 }),
                when(d.at),
                d.by,
                d.store ? t('clinical.fromStore', { store: d.store }) : null,
                d.note,
                d.given && !d.charged ? t('nurseOrders.notBilled') : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </li>
          ))}
        </ol>
      )}
      {/* a one-time order carried out: who, what left the stock, what went on the bill */}
      {once &&
        given.map((d) => {
          const l = doseLine(d)
          return (
            <span key={d.id ?? d.n} className="flex flex-col gap-0.5 text-[13px]">
              <span className="text-ink">
                <CheckCircle2
                  size={12}
                  aria-hidden="true"
                  className="text-green mr-1 inline align-[-1px]"
                />
                {[l.by, l.stock, l.bill ? t('nurseOrders.onBill', { amount: l.bill }) : null]
                  .filter(Boolean)
                  .join(' · ')}
                {d.note ? ` · ${d.note}` : ''}
              </span>
              {!l.onBill && (
                <span className="text-amber text-[12px] font-semibold">
                  {t('nurseOrders.offBill', { why: l.why })}
                </span>
              )}
            </span>
          )
        })}
      {(o.undone ?? []).map((u) => (
        <span key={`${u.n}-${u.undoneAt}`} className="text-ink-3 text-xs">
          <Undo2 size={12} aria-hidden="true" className="mr-1 inline align-[-1px]" />
          {t('nurseOrders.undoneLog', {
            name: u.undoneBy ?? '',
            when: when(u.undoneAt),
            reason: u.reason ?? '',
          })}
        </span>
      ))}
      {!open_ && o.endReason && !o.endReason.startsWith('undone:') && (
        <span className="text-ink-3 text-xs">
          {t('nurseOrders.endedWhy', {
            name: o.endedBy ?? '',
            when: o.endedAt ? when(o.endedAt) : '',
            reason: o.endReason,
          })}
        </span>
      )}
      {((open_ && (carryOut || cancel)) || mayUndo || forLabel) && (
        <span className="flex flex-wrap gap-2">
          {open_ && carryOut && (
            <>
              <Button size="sm" variant="success" onClick={() => void give()} disabled={busy}>
                <CheckCircle2 size={14} aria-hidden="true" />
                {once
                  ? giveButton(t, o)
                  : t(o.kind === 'drug' ? 'nurseOrders.give' : 'nurseOrders.markDone', {
                      n: done + 1,
                      count: o.dosesPlanned,
                    })}
              </Button>
              {/* an older order of several times: one time not given */}
              {!once && (
                <Button size="sm" onClick={() => void skip()} disabled={busy}>
                  <CircleSlash size={14} aria-hidden="true" />
                  {t('nurseOrders.skip')}
                </Button>
              )}
              {/* the doctor doing his own order cancels it instead (below) */}
              {!cancel && (
                <Button size="sm" variant="ghost" onClick={() => void stop(false)} disabled={busy}>
                  <Ban size={14} aria-hidden="true" />
                  {t('nurseOrders.notDone')}
                </Button>
              )}
            </>
          )}
          {forLabel && o.status !== 'cancelled' && (
            <Button size="sm" variant="tint-grey" onClick={() => printLabel(forLabel)}>
              <Printer size={14} aria-hidden="true" />
              {t('nurseOrders.printLabel')}
            </Button>
          )}
          {mayUndo && (
            <Button size="sm" variant="ghost" onClick={undo} disabled={busy}>
              <Undo2 size={14} aria-hidden="true" />
              {t('nurseOrders.undo')}
            </Button>
          )}
          {open_ && cancel && (
            <Button size="sm" variant="ghost" onClick={() => void stop(true)} disabled={busy}>
              <XCircle size={14} aria-hidden="true" />
              {t('nurseOrders.cancel')}
            </Button>
          )}
        </span>
      )}
    </div>
  )
}

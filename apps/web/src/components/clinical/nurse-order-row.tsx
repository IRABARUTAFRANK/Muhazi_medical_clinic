import { useState } from 'react'
import {
  Ban,
  BedDouble,
  CheckCircle2,
  CircleSlash,
  Clock,
  Pill,
  Printer,
  Square,
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
import { useNow } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import {
  EARLY_MINUTES,
  canUndoOrder,
  canUndoTime,
  dueAtOf,
  givenDoses,
  isOldTimes,
  isOnce,
  isRepeated,
  kigaliHM,
  mayGiveNow,
  nextTime,
  orderDone,
  orderHow,
  timeState,
  useNurseOrderActions,
  type NurseOrder,
  type NurseOrderDose,
  type NurseOrderStatus,
  type OrderTime,
  type TimeState,
} from '@/lib/api/nurse-orders'
import {
  dueWords,
  giveBody,
  giveButton,
  giveMessage,
  giveTitle,
  giveYes,
  inWords,
  orderAction,
  partLines,
  stateWord,
} from '@/lib/order-words'
import { whenText } from '@/lib/order-plan'
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
/** 0198: the badge of a time to give. */
const DUE_TONE: Record<'due' | 'late' | 'later', Tone> = { due: 'blue', late: 'red', later: 'grey' }
const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`
/** A repeated order shows its times around the next one; all of them on request. */
const TIMES_SHOWN = 6

/**
 * One order of step 6 (0127; 0193; 0198): what, for whom, by whom. Since 0193 an order is carried
 * out once: its parts (given here — whole pieces and a part of a piece; to take home with how to
 * take it; an act and how it is billed), one button (Given / Handed over / Done), then who did it,
 * what left the stock and what went on the bill, the label of what went home, and Undo for the
 * person who recorded it (the same day) or the manager. 0198: an order planned for a time says
 * when (Due now / Late / At 14:00); a REPEATED order lists its times, each with Given / Not given
 * on the next one to record and Undo on those recorded; the doctor who wrote it stops the rest.
 * An order written before 0193 with several times keeps its count, its bar and Not given.
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
  /** The doctor who gave it (or the manager) may cancel it (a repeated one: stop the rest). */
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
  const now = useNow(30_000)
  const { undo: askUndo, undoTime: askUndoTime, pending: undoing } = useOrderUndo()
  const [open, setOpen] = useState(false)
  const [allTimes, setAllTimes] = useState(false)
  const name = patientName || o.patient || t('confirm.visit.thisPatient')
  const open_ = o.status === 'open'
  const once = isOnce(o)
  const repeated = isRepeated(o)
  const oldTimes = isOldTimes(o)
  const done = orderDone(o)
  const route = (r: string) => t(`clinical.routes.${r}`, { defaultValue: r })
  const frequency = (f: string) => t(`clinical.frequencies.${f}`, { defaultValue: f })
  const how = orderHow(o, route, frequency)
  const given = givenDoses(o)
  const mayUndo = canUndoOrder(o, myId, isManager)
  const forLabel = labelDose(o)
  // 0198: a one-time order planned for a time, not given yet: when it is due
  const dueAt = o.timed && open_ && !given.length && !repeated ? dueAtOf(o) : null
  const due = dueAt ? dueWords(t, dueAt, now) : null
  const early = !!dueAt && !mayGiveNow(dueAt, now)
  const run = async (fn: () => Promise<string | null>) => {
    onError?.(null)
    try {
      const message = await fn()
      if (message) onDone?.(message)
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e))
    }
  }
  /** Before its time (within 2 hours): "Planned for 14:00 (in 1 h 20): give it now?". */
  const earlyWords = (iso: string | null) =>
    iso && Date.parse(iso) - now > 30 * 60_000
      ? t('nurseOrders.tooEarly', { time: kigaliHM(iso), in: inWords(t, iso, now) })
      : null
  const give = async () => {
    const r = await confirm({
      title: once ? giveTitle(t, o, name) : t('nurseOrders.giveQ', { what: o.text, name }),
      body: once
        ? [earlyWords(dueAt), giveBody(t, o)].filter(Boolean).join(' ')
        : t(o.kind === 'drug' ? 'nurseOrders.giveDrugBody' : 'nurseOrders.giveActBody', {
            n: done + 1,
            count: o.dosesPlanned ?? 0,
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
    // 0198: a repeated order: the doctor stops the times not given yet
    const rest = repeated && asDoctor
    const r = await confirm({
      title: t(
        rest ? 'nurseOrders.stopRestQ' : asDoctor ? 'nurseOrders.cancelQ' : 'nurseOrders.notDoneQ',
        { what: o.text, name },
      ),
      body: t(
        rest
          ? 'nurseOrders.stopRestBody'
          : asDoctor
            ? 'nurseOrders.cancelBody'
            : 'nurseOrders.notDoneBody',
      ),
      input: { label: t('nurseOrders.stopWhy'), required: true, multiline: true },
      confirmLabel: t(
        rest
          ? 'nurseOrders.stopRest'
          : asDoctor
            ? 'nurseOrders.cancelYes'
            : 'nurseOrders.notDoneYes',
      ),
      tone: 'danger',
    })
    if (!r.ok) return
    void run(async () => {
      await actions.stop.mutateAsync({ id: o.id, reason: r.value })
      return t(
        rest
          ? 'nurseOrders.stoppedRest'
          : asDoctor
            ? 'nurseOrders.cancelled'
            : 'nurseOrders.notDoneSaved',
        { what: o.text },
      )
    })
  }
  const undo = () => void run(() => askUndo(o, { myId, isManager, patientName: name, visitOver }))

  // ---------------------------------------------------------------- a repeated order's times
  const times = o.times ?? []
  const next = repeated ? nextTime(o) : null
  const count = o.dosesPlanned
  const timeName = (n: number) =>
    count != null ? t('nurseOrders.timeOf', { n, count }) : t('nurseOrders.timeN', { n })
  const giveTime = async (tm: OrderTime) => {
    const r = await confirm({
      title: t(o.kind === 'drug' ? 'nurseOrders.giveTimeQ' : 'nurseOrders.doneTimeQ', {
        what: o.text,
        name,
        n: tm.n,
      }),
      body: [earlyWords(tm.dueAt), giveBody(t, o)].filter(Boolean).join(' '),
      input: { label: t('nurseOrders.noteLabel'), placeholder: t('nurseOrders.notePh') },
      confirmLabel: t(o.kind === 'drug' ? 'nurseOrders.giveYes' : 'nurseOrders.doneYes'),
    })
    if (!r.ok) return
    void run(async () => {
      const res = await actions.giveTime.mutateAsync({ id: o.id, n: tm.n, note: r.value })
      return giveMessage(t, o, res)
    })
  }
  const skipTime = async (tm: OrderTime) => {
    const r = await confirm({
      title: t('nurseOrders.skipTimeQ', { what: o.text, name, n: tm.n }),
      body: t('nurseOrders.skipBody'),
      input: { label: t('nurseOrders.skipWhy'), required: true, multiline: true },
      confirmLabel: t('nurseOrders.skipYes'),
      tone: 'danger',
    })
    if (!r.ok) return
    void run(async () => {
      await actions.skipTime.mutateAsync({ id: o.id, n: tm.n, reason: r.value })
      return t('nurseOrders.skipSaved', { what: o.text })
    })
  }
  const undoTime = (tm: OrderTime) => {
    if (tm.doseId) void run(() => askUndoTime(o, tm.doseId!))
  }
  /** The times shown: all, or a few around the next one (the recorded ones before it). */
  const shownTimes = (() => {
    if (allTimes || times.length <= TIMES_SHOWN) return times
    const at = next ? times.findIndex((x) => x.n === next.n) : times.length - 1
    const from = Math.max(0, Math.min(at - 2, times.length - TIMES_SHOWN))
    return times.slice(from, from + TIMES_SHOWN)
  })()
  /** What became of a time, in words. */
  const timeWords = (tm: OrderTime, state: TimeState): { text: string; tone: Tone | null } => {
    const at = tm.at ? kigaliHM(tm.at) : ''
    if (state === 'given')
      return {
        text: [
          t(o.kind === 'drug' ? 'nurseOrders.timeGiven' : 'nurseOrders.timeDone', {
            name: tm.by ?? '',
            time: at,
          }),
          tm.billed != null && tm.billed > 0
            ? t('nurseOrders.onBill', { amount: formatRwf(tm.billed) })
            : null,
          tm.note,
        ]
          .filter(Boolean)
          .join(' · '),
        tone: null,
      }
    if (state === 'not_given')
      return {
        text: t('nurseOrders.timeNotGiven', { name: tm.by ?? '', time: at, reason: tm.note ?? '' }),
        tone: null,
      }
    if (state === 'stopped') return { text: t('nurseOrders.timeStopped'), tone: 'grey' }
    const d = dueWords(t, tm.dueAt, now)
    return { text: d.text, tone: DUE_TONE[d.state] }
  }

  // ---------------------------------------------------------------- one time carried out (0193)
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
  const busy =
    actions.give.isPending ||
    actions.skip.isPending ||
    actions.stop.isPending ||
    actions.giveTime.isPending ||
    actions.skipTime.isPending ||
    actions.undoTime.isPending ||
    undoing
  const Icon = o.kind === 'drug' ? Pill : Syringe
  const parts = once || repeated ? partLines(t, o) : []
  const partPriceLine =
    o.part && o.partPrice != null && o.partText
      ? t('nurseOrders.partPriceSet', {
          part: o.partText,
          price: formatRwf(o.partPrice),
          name: o.partPriceBy ?? '',
          reason: o.partPriceReason ?? '',
        })
      : null
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
        {/* 11rem: on a phone the words stay beside the round icon (it is not left alone on a line) */}
        <span className="min-w-0 flex-[1_1_11rem]">
          {showPatient && o.patient && (
            <span className="text-ink-2 flex flex-wrap items-center gap-x-2 text-[13px] font-semibold">
              <span className="min-w-0">
                {[o.ticket, o.patient, o.fileNumber].filter(Boolean).join(' · ')}
              </span>
              {/* 0198: the bed the patient is in */}
              {o.bed && (
                <span className="text-ink-3 inline-flex min-w-0 items-center gap-1 font-medium">
                  <BedDouble size={13} aria-hidden="true" />
                  {o.bed}
                </span>
              )}
            </span>
          )}
          <span className={cn('block font-semibold', o.status === 'cancelled' && 'line-through')}>
            {o.text}
          </span>
          {!oldTimes ? (
            <>
              <span className="text-ink-3 block text-xs">
                {t(o.kind === 'drug' ? 'nurseOrders.kindDrug' : 'nurseOrders.kindAct')}
              </span>
              {parts.map((p) => (
                <span key={p} className="text-ink-2 block text-[13px]">
                  {p}
                </span>
              ))}
              {partPriceLine && <span className="text-ink-3 block text-xs">{partPriceLine}</span>}
              {/* 0198: the next time of a repeated order */}
              {repeated && next && (
                <span className="text-ink-2 block text-[13px]">
                  {[
                    timeName(next.n),
                    t('nurseOrders.nextAt', { time: whenText(Date.parse(next.dueAt), now) }),
                  ].join(' · ')}
                </span>
              )}
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
                t('nurseOrders.times', { count: o.dosesPlanned ?? 0 }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
          {o.notes && <span className="text-ink-2 block text-[13px]">{o.notes}</span>}
          {/* 0200: written by the nurse after doing it, for a task of the doctor */}
          {o.taskId && (
            <span className="text-ink-2 block text-[13px]">
              {t('taskRecord.onOrder', { title: o.taskTitle ?? '' })}
              {o.recordedWhy ? ` · ${t('taskRecord.evenSoWas', { why: o.recordedWhy })}` : ''}
            </span>
          )}
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
          {/* 0198: when a one-time order is due, or the next time of a repeated one */}
          {(due || (repeated && next)) && (
            <Badge tone={DUE_TONE[(due ?? dueWords(t, next!.dueAt, now)).state]} dot={false}>
              <Clock size={12} aria-hidden="true" />
              {(due ?? dueWords(t, next!.dueAt, now)).text}
            </Badge>
          )}
          <Badge tone={STATUS_TONE[o.status]} dot={false}>
            {stateWord(t, o)}
          </Badge>
          {(oldTimes || repeated) && (
            <Badge tone={o.given > 0 ? 'blue' : 'grey'} dot={false} className="tabular-nums">
              {o.dosesPlanned == null
                ? t('nurseOrders.givenSoFar', { count: o.given })
                : t(o.kind === 'drug' ? 'nurseOrders.progressDrug' : 'nurseOrders.progressAct', {
                    given: o.given,
                    count: o.dosesPlanned,
                  })}
            </Badge>
          )}
        </span>
      </div>
      {/* an older order of several times: the bar (given, not given, still to do) and its times */}
      {oldTimes && o.dosesPlanned != null && (
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
      {oldTimes && o.doses.length > 0 && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((x) => !x)}
          className="text-primary self-start bg-transparent p-0 text-xs font-semibold hover:underline"
        >
          {t('nurseOrders.timesLog', { count: o.doses.length })}
        </button>
      )}
      {oldTimes && open && (
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
      {/* 0198: a repeated order: its times, each with what became of it */}
      {repeated && times.length > 0 && (
        <ol className="border-border m-0 flex list-none flex-col gap-1.5 border-t p-0 pt-2">
          {shownTimes.map((tm) => {
            const state = timeState(tm, now)
            const w = timeWords(tm, state)
            const isNext = !!next && tm.n === next.n
            const giveable = isNext && open_ && carryOut && mayGiveNow(tm.dueAt, now)
            const mayUndoTime = !!tm.doseId && canUndoTime(tm, myId, isManager)
            const StateIcon =
              state === 'given' ? CheckCircle2 : state === 'not_given' ? CircleSlash : Square
            return (
              <li
                key={tm.n}
                className={cn(
                  'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded px-1.5 py-0.5 text-[13px]',
                  isNext && 'bg-hover/60',
                )}
              >
                <StateIcon
                  size={14}
                  aria-hidden="true"
                  className={cn(
                    'flex-none',
                    state === 'given'
                      ? 'text-green'
                      : state === 'not_given'
                        ? 'text-red'
                        : 'text-ink-3',
                  )}
                />
                <span className="font-semibold tabular-nums">{timeName(tm.n)}</span>
                <span className="text-ink-2 tabular-nums">
                  {whenText(Date.parse(tm.dueAt), now)}
                </span>
                {w.tone ? (
                  <Badge tone={w.tone} dot={false}>
                    {w.text}
                  </Badge>
                ) : (
                  <span
                    className={cn('min-w-0', state === 'not_given' ? 'text-red' : 'text-ink-2')}
                  >
                    {w.text}
                  </span>
                )}
                {giveable && (
                  <span className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="success"
                      onClick={() => void giveTime(tm)}
                      disabled={busy}
                    >
                      <CheckCircle2 size={14} aria-hidden="true" />
                      {t(o.kind === 'drug' ? 'nurseOrders.give1' : 'nurseOrders.done1')}
                    </Button>
                    <Button size="sm" onClick={() => void skipTime(tm)} disabled={busy}>
                      <CircleSlash size={14} aria-hidden="true" />
                      {t('nurseOrders.skip')}
                    </Button>
                  </span>
                )}
                {isNext && open_ && carryOut && !giveable && (
                  <span className="text-ink-3 text-xs">
                    {t('nurseOrders.fromTime', {
                      time: kigaliHM(
                        new Date(Date.parse(tm.dueAt) - EARLY_MINUTES * 60_000).toISOString(),
                      ),
                    })}
                  </span>
                )}
                {mayUndoTime && (
                  <Button size="sm" variant="ghost" onClick={() => undoTime(tm)} disabled={busy}>
                    <Undo2 size={14} aria-hidden="true" />
                    {t('nurseOrders.undo')}
                  </Button>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {repeated && times.length > TIMES_SHOWN && (
        <button
          type="button"
          aria-expanded={allTimes}
          onClick={() => setAllTimes((x) => !x)}
          className="text-primary self-start bg-transparent p-0 text-xs font-semibold hover:underline"
        >
          {allTimes
            ? t('nurseOrders.showFewerTimes')
            : t('nurseOrders.showAllTimes', { count: times.length })}
        </button>
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
          {repeated ? `${t('nurseOrders.timeN', { n: u.n })} · ` : ''}
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
            reason: o.endReason.replace(/^stopped: /, ''),
          })}
        </span>
      )}
      {((open_ && (carryOut || cancel)) || mayUndo || forLabel) && (
        <span className="flex flex-wrap items-center gap-2">
          {open_ && carryOut && !repeated && (
            <>
              {early && dueAt ? (
                // 0198: planned later: given from 2 hours before its time
                <span className="text-ink-3 text-xs">
                  {t('nurseOrders.fromTime', {
                    time: kigaliHM(
                      new Date(Date.parse(dueAt) - EARLY_MINUTES * 60_000).toISOString(),
                    ),
                  })}
                </span>
              ) : (
                <Button size="sm" variant="success" onClick={() => void give()} disabled={busy}>
                  <CheckCircle2 size={14} aria-hidden="true" />
                  {once
                    ? giveButton(t, o)
                    : t(o.kind === 'drug' ? 'nurseOrders.give' : 'nurseOrders.markDone', {
                        n: done + 1,
                        count: o.dosesPlanned ?? 0,
                      })}
                </Button>
              )}
              {/* an older order of several times: one time not given */}
              {oldTimes && (
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
              {t(repeated ? 'nurseOrders.stopRest' : 'nurseOrders.cancel')}
            </Button>
          )}
        </span>
      )}
    </div>
  )
}

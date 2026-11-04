import { useState } from 'react'
import {
  Ban,
  CheckCircle2,
  CircleSlash,
  Pill,
  Syringe,
  UserRound,
  Users,
  XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime, type Tone } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import {
  orderDone,
  orderHow,
  useNurseOrderActions,
  type NurseOrder,
  type NurseOrderStatus,
} from '@/lib/api/nurse-orders'

const STATUS_TONE: Record<NurseOrderStatus, Tone> = {
  open: 'yellow',
  done: 'green',
  not_done: 'red',
  cancelled: 'grey',
}
const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`

/**
 * One order of the doctor to the nurses (0127): what, how, for whom, how far ("Given 1/3"), each
 * time given or not given (when, by whom, the note or reason). The nurse gives / says not given /
 * says the rest will not be done; the doctor who gave it cancels it.
 */
export function NurseOrderRow({
  order: o,
  patientName,
  carryOut = false,
  cancel = false,
  showPatient = false,
  onDone,
  onError,
}: {
  order: NurseOrder
  /** For the questions before each action. */
  patientName?: string
  /** The nurse records the times (her order, or one for all nurses at her desk); also the doctor
   * who gave it, doing it himself (0133). */
  carryOut?: boolean
  /** The doctor who gave it (or the manager) may cancel it. */
  cancel?: boolean
  /** The nurse's Home list: the patient's name and file. */
  showPatient?: boolean
  onDone?: (message: string) => void
  onError?: (message: string | null) => void
}) {
  const { t } = useTranslation()
  const actions = useNurseOrderActions()
  const confirm = useConfirm()
  const [open, setOpen] = useState(false)
  const name = patientName || o.patient || t('confirm.visit.thisPatient')
  const open_ = o.status === 'open'
  const done = orderDone(o)
  const route = (r: string) => t(`clinical.routes.${r}`, { defaultValue: r })
  const frequency = (f: string) => t(`clinical.frequencies.${f}`, { defaultValue: f })
  const how = orderHow(o, route, frequency)
  const run = async (fn: () => Promise<unknown>, message: string) => {
    onError?.(null)
    try {
      await fn()
      onDone?.(message)
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e))
    }
  }
  const give = async () => {
    const r = await confirm({
      title: t('nurseOrders.giveQ', { what: o.text, name }),
      body: t(o.kind === 'drug' ? 'nurseOrders.giveDrugBody' : 'nurseOrders.giveActBody', {
        n: done + 1,
        count: o.dosesPlanned,
      }),
      input: { label: t('nurseOrders.noteLabel'), placeholder: t('nurseOrders.notePh') },
      confirmLabel: t(o.kind === 'drug' ? 'nurseOrders.giveYes' : 'nurseOrders.doneYes'),
    })
    if (!r.ok) return
    void run(
      () => actions.give.mutateAsync({ id: o.id, note: r.value }),
      t(o.kind === 'drug' ? 'nurseOrders.givenSaved' : 'nurseOrders.doneSaved', { what: o.text }),
    )
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
    void run(
      () => actions.skip.mutateAsync({ id: o.id, reason: r.value }),
      t('nurseOrders.skipSaved', { what: o.text }),
    )
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
    void run(
      () => actions.stop.mutateAsync({ id: o.id, reason: r.value }),
      t(asDoctor ? 'nurseOrders.cancelled' : 'nurseOrders.notDoneSaved', { what: o.text }),
    )
  }
  const busy = actions.give.isPending || actions.skip.isPending || actions.stop.isPending
  const Icon = o.kind === 'drug' ? Pill : Syringe
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
            {t(`nurseOrders.status.${o.status}`)}
          </Badge>
          <Badge tone={o.given > 0 ? 'blue' : 'grey'} dot={false} className="tabular-nums">
            {t(o.kind === 'drug' ? 'nurseOrders.progressDrug' : 'nurseOrders.progressAct', {
              given: o.given,
              count: o.dosesPlanned,
            })}
          </Badge>
        </span>
      </div>
      {/* the progress bar: given, not given, still to do */}
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
      {o.doses.length > 0 && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((x) => !x)}
          className="text-primary self-start bg-transparent p-0 text-xs font-semibold hover:underline"
        >
          {t('nurseOrders.timesLog', { count: o.doses.length })}
        </button>
      )}
      {open && (
        <ol className="m-0 flex flex-col gap-1 pl-5 text-[13px]">
          {o.doses.map((d) => (
            <li key={d.n} className={d.given ? 'text-ink' : 'text-red'}>
              {d.given ? (
                <CheckCircle2 size={12} aria-hidden="true" className="mr-1 inline align-[-1px]" />
              ) : (
                <CircleSlash size={12} aria-hidden="true" className="mr-1 inline align-[-1px]" />
              )}
              {[
                t(d.given ? 'nurseOrders.doseGiven' : 'nurseOrders.doseNotGiven', { n: d.n }),
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
      {!open_ && o.endReason && (
        <span className="text-ink-3 text-xs">
          {t('nurseOrders.endedWhy', {
            name: o.endedBy ?? '',
            when: o.endedAt ? when(o.endedAt) : '',
            reason: o.endReason,
          })}
        </span>
      )}
      {open_ && (carryOut || cancel) && (
        <span className="flex flex-wrap gap-2">
          {carryOut && (
            <>
              <Button size="sm" variant="success" onClick={() => void give()} disabled={busy}>
                <CheckCircle2 size={14} aria-hidden="true" />
                {t(o.kind === 'drug' ? 'nurseOrders.give' : 'nurseOrders.markDone', {
                  n: done + 1,
                  count: o.dosesPlanned,
                })}
              </Button>
              <Button size="sm" onClick={() => void skip()} disabled={busy}>
                <CircleSlash size={14} aria-hidden="true" />
                {t('nurseOrders.skip')}
              </Button>
              {/* the doctor doing his own order cancels it instead (below) */}
              {!cancel && (
                <Button size="sm" variant="ghost" onClick={() => void stop(false)} disabled={busy}>
                  <Ban size={14} aria-hidden="true" />
                  {t('nurseOrders.notDone')}
                </Button>
              )}
            </>
          )}
          {cancel && (
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

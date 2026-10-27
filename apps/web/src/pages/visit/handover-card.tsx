import { useState } from 'react'
import { Check, Send, UserRoundCheck, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatTime } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import type { VisitAccess } from '@/lib/api/calls'
import { useHandoverActions, useHandoverColleagues, type VisitHandover } from '@/lib/api/handover'
import { useConfirm } from '@/lib/confirm'

const control =
  'border-border bg-card text-ink focus:border-primary h-10 w-full rounded-md border px-2.5 text-[14px] outline-none'
const area =
  'border-border bg-card focus:border-primary rounded-md border px-2.5 py-2 text-[14px] font-normal outline-none'
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * "Hand over to a colleague" on the visit (0088, in place of "Cover for me"). The clinician who
 * has the patient picks a colleague of the same desk and writes why and what is still to do; the
 * colleague answers Take (the patient becomes theirs) or Decline with a reason (the patient stays
 * here). Until the answer the patient stays with the sender, who keeps working and may cancel.
 * The colleague sees the same card with Take / Decline while the visit is still read only for them.
 */
export function HandoverCard({
  encounterId,
  access,
  patientName,
  ticket,
  mayHandOver,
  role,
  onDone,
  onError,
}: {
  encounterId: string
  access: VisitAccess
  patientName: string
  ticket?: string
  /** The person may hand over here (a treating desk, clinical notes allowed); the database checks
   *  it again. */
  mayHandOver: boolean
  /** The signed-in person's role: the manager may cancel anyone's handover. */
  role: string
  /** What happened, said in the visit's message line. */
  onDone: (message: string) => void
  onError: (message: string | null) => void
}) {
  const { t } = useTranslation()
  const h = access.handover ?? null

  // nothing to show: no handover waiting and not mine to hand over
  if (!h && !(access.canHandOver && mayHandOver)) return null

  return (
    <Card className="anim-enter">
      <CardHeader hue="mint">
        <span className="inline-flex items-center gap-2">
          <UserRoundCheck size={16} aria-hidden="true" />
          {t(
            h?.forMe
              ? 'handover.titleToYou'
              : h && !h.mine
                ? 'track.handoverWaiting'
                : 'handover.title',
          )}
        </span>
      </CardHeader>
      <CardBody className="gap-3">
        {h?.forMe ? (
          <ToMe h={h} patientName={patientName} onDone={onDone} onError={onError} />
        ) : h ? (
          <Waiting
            h={h}
            patientName={patientName}
            mayCancel={h.mine || role === 'manager'}
            onDone={onDone}
            onError={onError}
          />
        ) : (
          <HandOverForm
            encounterId={encounterId}
            patientName={patientName}
            ticket={ticket}
            onDone={onDone}
            onError={onError}
          />
        )}
      </CardBody>
    </Card>
  )
}

interface Part {
  patientName: string
  onDone: (m: string) => void
  onError: (m: string | null) => void
}

/** The note of a handover, with who sent it and when. */
function Note({ h }: { h: VisitHandover }) {
  const { t } = useTranslation()
  return (
    <span className="text-ink-2 block text-[13px]">
      “{h.note}” · {t('handover.sentAt', { name: h.fromName, time: formatTime(new Date(h.at)) })}
    </span>
  )
}

/**
 * A handover waiting for the colleague's answer. The sender reads who must answer and may cancel;
 * anyone else who opens the visit (the head, another clinician, the manager) reads who handed the
 * patient over to whom; the manager may cancel too.
 */
function Waiting({
  h,
  patientName,
  mayCancel,
  onDone,
  onError,
}: Part & { h: VisitHandover; mayCancel: boolean }) {
  const { t } = useTranslation()
  const { cancel } = useHandoverActions()
  const confirm = useConfirm()
  const name = h.name || patientName
  const withdraw = async () => {
    if (
      !(await confirm({
        title: h.mine
          ? t('confirm.handover.cancel', { name, to: h.toName })
          : t('confirm.handover.cancelOther', { name, from: h.fromName, to: h.toName }),
        body: h.mine
          ? t('confirm.handover.cancelBody', { name, to: h.toName })
          : t('confirm.handover.cancelOtherBody', { name, from: h.fromName, to: h.toName }),
        confirmLabel: t('confirm.handover.cancelYes'),
        tone: 'danger',
      }))
    )
      return
    onError(null)
    try {
      await cancel.mutateAsync(h.id)
      onDone(t('handover.cancelled', { name: h.toName }))
    } catch (e) {
      onError(describe(e))
    }
  }
  return (
    <div className="border-border flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2">
      <span className="min-w-[200px] flex-1 text-[14px]">
        <span className="block font-semibold">
          {h.mine
            ? t('handover.waiting', { name: h.toName })
            : t('handover.othersWaiting', { from: h.fromName, to: h.toName })}
        </span>
        <Note h={h} />
        {h.mine && (
          <span className="text-ink-3 block text-[13px]">
            {t('handover.waitingHint', { name: h.toName })}
          </span>
        )}
      </span>
      <Badge tone="yellow">{t('handover.status.pending')}</Badge>
      {mayCancel && (
        <Button
          size="sm"
          variant="ghost"
          loading={cancel.isPending}
          onClick={() => void withdraw()}
        >
          <X size={14} aria-hidden="true" />
          {t('handover.cancel')}
        </Button>
      )}
    </div>
  )
}

/** The colleague: Take, or Decline with a reason. */
function ToMe({ h, patientName, onDone, onError }: Part & { h: VisitHandover }) {
  const { t } = useTranslation()
  const { take, decline } = useHandoverActions()
  const confirm = useConfirm()
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  // the handover's own patient first (the visit header may still be loading)
  const name = h.name || patientName
  const takeIt = async () => {
    if (
      !(await confirm({
        title: t('confirm.handover.take', { name, by: h.fromName }),
        body: t('confirm.handover.takeBody', { name, by: h.fromName }),
        confirmLabel: t('confirm.handover.takeYes'),
      }))
    )
      return
    onError(null)
    try {
      await take.mutateAsync(h.id)
      onDone(t('handover.taken', { name }))
    } catch (e) {
      onError(describe(e))
    }
  }
  const declineIt = async () => {
    if (reason.trim().length < 3) return onError(t('stockErrors.handoverReason'))
    if (
      !(await confirm({
        title: t('confirm.handover.decline', { name, by: h.fromName }),
        body: t('confirm.handover.declineBody', { name, by: h.fromName }),
        confirmLabel: t('confirm.handover.declineYes'),
        tone: 'danger',
      }))
    )
      return
    onError(null)
    try {
      await decline.mutateAsync({ id: h.id, reason })
      setDeclining(false)
      setReason('')
      onDone(t('handover.declined', { by: h.fromName }))
    } catch (e) {
      onError(describe(e))
    }
  }
  return (
    <div className="border-yellow-dot/50 bg-amber-bg/60 flex flex-col gap-3 rounded-md border px-3 py-2.5">
      <span className="text-[14px]">
        <span className="block font-semibold">{t('handover.toYou', { by: h.fromName })}</span>
        <Note h={h} />
        <span className="text-ink-3 block text-[13px]">{t('handover.toYouHint')}</span>
      </span>
      {declining ? (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
            {t('handover.reason')}
            <textarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('handover.reasonPh')}
              className={area}
            />
          </label>
          <span className="flex flex-wrap gap-2">
            <Button variant="danger" loading={decline.isPending} onClick={() => void declineIt()}>
              <X size={16} aria-hidden="true" />
              {t('handover.decline')}
            </Button>
            <Button variant="ghost" onClick={() => setDeclining(false)}>
              {t('staff.form.cancel')}
            </Button>
          </span>
        </div>
      ) : (
        <span className="flex flex-wrap gap-2">
          <Button variant="success" loading={take.isPending} onClick={() => void takeIt()}>
            <Check size={16} aria-hidden="true" />
            {t('handover.take')}
          </Button>
          <Button variant="danger" onClick={() => setDeclining(true)}>
            <X size={16} aria-hidden="true" />
            {t('handover.decline')}
          </Button>
        </span>
      )}
    </div>
  )
}

/** The holder: pick a colleague of this desk, write the note, confirm. */
function HandOverForm({
  encounterId,
  patientName,
  ticket,
  onDone,
  onError,
}: Part & { encounterId: string; ticket?: string }) {
  const { t } = useTranslation()
  const { handOver } = useHandoverActions()
  const confirm = useConfirm()
  const [open, setOpen] = useState(false)
  const [toId, setToId] = useState('')
  const [note, setNote] = useState('')
  const { data: colleagues = [], isLoading } = useHandoverColleagues(encounterId, open)
  const send = async () => {
    const to = colleagues.find((c) => c.id === toId)
    if (!to) return onError(t('handover.pickColleague'))
    if (note.trim().length < 3) return onError(t('stockErrors.handoverNote'))
    if (
      !(await confirm({
        title: t('confirm.handover.send', { name: patientName, to: to.name }),
        body: t('confirm.handover.sendBody', { name: patientName, to: to.name }),
        confirmLabel: t('confirm.handover.sendYes'),
      }))
    )
      return
    onError(null)
    try {
      await handOver.mutateAsync({
        encounterId,
        toId,
        note,
        toName: to.name,
        patientName,
        ticket,
      })
      setOpen(false)
      setNote('')
      setToId('')
      onDone(t('handover.sent', { name: to.name }))
    } catch (e) {
      onError(describe(e))
    }
  }
  if (!open)
    return (
      <span className="flex flex-wrap items-center gap-3">
        <Button onClick={() => setOpen(true)}>
          <UserRoundCheck size={16} aria-hidden="true" />
          {t('handover.ask')}
        </Button>
        <span className="text-ink-3 text-[13px]">{t('handover.lead')}</span>
      </span>
    )
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
        {t('handover.colleague')}
        <select
          className={control}
          value={toId}
          disabled={isLoading}
          onChange={(e) => setToId(e.target.value)}
        >
          <option value="">{isLoading ? '…' : t('handover.pickColleague')}</option>
          {colleagues.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {t(`staff.roles.${c.role}`, { defaultValue: c.role })}
              {c.station ? ` · ${c.station}` : ''}
              {` · ${t('handover.patients', { count: c.patients })}`}
            </option>
          ))}
        </select>
      </label>
      {!isLoading && colleagues.length === 0 && (
        <p className="bg-hover text-ink-2 m-0 rounded-md px-3 py-2 text-[13px]">
          {t('handover.none')}
        </p>
      )}
      <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
        {t('handover.note')}
        <textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('handover.notePh')}
          className={area}
        />
      </label>
      <span className="flex flex-wrap gap-2">
        <Button
          variant="success"
          loading={handOver.isPending}
          disabled={colleagues.length === 0}
          onClick={() => void send()}
        >
          <Send size={16} aria-hidden="true" />
          {t('handover.send')}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          {t('staff.form.cancel')}
        </Button>
      </span>
    </div>
  )
}

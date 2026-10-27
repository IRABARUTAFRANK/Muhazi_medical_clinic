import { useState, type CSSProperties } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Check, Eye, UserRoundCheck, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatTime } from '@mmc/shared'
import { Panel, Pill } from '@/components/dash/kit'
import type { Tint } from '@/components/dash/kit-style'
import { Button } from '@/components/ui/button'
import { controlClass, labelClass } from '@/components/ui/field'
import { cn } from '@/lib/utils'
import {
  useHandoverActions,
  useMyHandovers,
  type Handover,
  type HandoverStatus,
} from '@/lib/api/handover'
import { useConfirm } from '@/lib/confirm'
import { ErrorBox } from './role-panels'

const rowClass =
  'border-grid flex min-h-10 flex-wrap items-start gap-2.5 border-b py-2 text-[14px] last:border-b-0'
// the reason box: the control's border, radius and focus ring, free in height
const area = cn(controlClass, 'h-auto w-full py-2')
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
const time = (iso: string | null) => (iso ? formatTime(new Date(iso)) : '')
const statusTint: Record<HandoverStatus, Tint> = {
  pending: 'amber',
  taken: 'mint',
  declined: 'coral',
  cancelled: 'navy',
  lapsed: 'navy',
}

/**
 * "Handed to you" on the clinician homes (0088): patients a colleague hands over to me, each with
 * the note and Take / Decline (with a reason); below, my own handovers still waiting or answered
 * today. Nothing shows when there is none (or before 0088).
 */
export function HandoverPanel({ i = 1 }: { i?: number }) {
  const { t } = useTranslation()
  const { data } = useMyHandovers()
  const incoming = data?.incoming ?? []
  const outgoing = data?.outgoing ?? []
  if (!data?.available || (incoming.length === 0 && outgoing.length === 0)) return null
  return (
    <Panel
      i={i}
      icon={UserRoundCheck}
      tint={incoming.length > 0 ? 'coral' : 'violet'}
      title={incoming.length > 0 ? t('handover.homeTitle') : t('handover.homeOutgoing')}
      right={incoming.length > 0 ? t('handover.toAnswer', { count: incoming.length }) : undefined}
    >
      {incoming.length > 0 && (
        <div className="flex flex-col">
          {incoming.map((h, n) => (
            <Incoming key={h.id} h={h} n={n} />
          ))}
        </div>
      )}
      {outgoing.length > 0 && (
        <div className="flex flex-col">
          {incoming.length > 0 && (
            <span className="text-ink-3 pt-1 text-[12px]">{t('handover.homeOutgoing')}</span>
          )}
          {outgoing.map((h, n) => (
            <Outgoing key={h.id} h={h} n={n} />
          ))}
        </div>
      )}
    </Panel>
  )
}

/** A patient handed over to me: open the visit, Take, or Decline with a reason. */
function Incoming({ h, n }: { h: Handover; n: number }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { take, decline } = useHandoverActions()
  const confirm = useConfirm()
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const open = () => void navigate({ to: '/app/visit', search: { encounter: h.encounterId } })
  const takeIt = async () => {
    if (
      !(await confirm({
        title: t('confirm.handover.take', { name: h.name, by: h.fromName }),
        body: t('confirm.handover.takeBody', { name: h.name, by: h.fromName }),
        confirmLabel: t('confirm.handover.takeYes'),
      }))
    )
      return
    setError(null)
    try {
      const r = await take.mutateAsync(h.id)
      await navigate({ to: '/app/visit', search: { encounter: r.encounterId || h.encounterId } })
    } catch (e) {
      setError(describe(e))
    }
  }
  const declineIt = async () => {
    if (reason.trim().length < 3) return setError(t('stockErrors.handoverReason'))
    if (
      !(await confirm({
        title: t('confirm.handover.decline', { name: h.name, by: h.fromName }),
        body: t('confirm.handover.declineBody', { name: h.name, by: h.fromName }),
        confirmLabel: t('confirm.handover.declineYes'),
        tone: 'danger',
      }))
    )
      return
    setError(null)
    try {
      await decline.mutateAsync({ id: h.id, reason })
    } catch (e) {
      setError(describe(e))
    }
  }
  return (
    <div className={rowClass} style={{ '--i': n } as CSSProperties}>
      <Pill tint="coral" icon={UserRoundCheck}>
        {h.ticket}
      </Pill>
      <span className="min-w-[180px] flex-1">
        <span className="block font-semibold">{h.name}</span>
        <span className="text-ink-2 block text-[13px]">
          {t('handover.fromAt', { name: h.fromName, time: time(h.at) })}
        </span>
        <span className="text-ink block text-[13px]">“{h.note}”</span>
      </span>
      <span className="flex flex-wrap gap-2">
        <Button size="sm" variant="tint-blue" onClick={open}>
          <Eye size={14} aria-hidden="true" />
          {t('access.view')}
        </Button>
        <Button
          size="sm"
          variant="success"
          loading={take.isPending && take.variables === h.id}
          onClick={() => void takeIt()}
        >
          <Check size={14} aria-hidden="true" />
          {t('handover.take')}
        </Button>
        {!declining && (
          <Button size="sm" variant="tint-coral" onClick={() => setDeclining(true)}>
            <X size={14} aria-hidden="true" />
            {t('handover.decline')}
          </Button>
        )}
      </span>
      {declining && (
        <div className="flex basis-full flex-col gap-2">
          <label className={labelClass}>
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
            <Button
              size="sm"
              variant="danger-solid"
              loading={decline.isPending}
              onClick={() => void declineIt()}
            >
              <X size={14} aria-hidden="true" />
              {t('handover.decline')}
            </Button>
            <Button size="sm" variant="tint-grey" onClick={() => setDeclining(false)}>
              {t('staff.form.cancel')}
            </Button>
          </span>
        </div>
      )}
      {error && (
        <div className="basis-full">
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}
    </div>
  )
}

/** One of my handovers: waiting (Cancel), or how it was answered. */
function Outgoing({ h, n }: { h: Handover; n: number }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { cancel } = useHandoverActions()
  const confirm = useConfirm()
  const [error, setError] = useState<string | null>(null)
  const withdraw = async () => {
    if (
      !(await confirm({
        title: t('confirm.handover.cancel', { name: h.name, to: h.toName }),
        body: t('confirm.handover.cancelBody', { name: h.name, to: h.toName }),
        confirmLabel: t('confirm.handover.cancelYes'),
        tone: 'danger',
      }))
    )
      return
    setError(null)
    try {
      await cancel.mutateAsync(h.id)
    } catch (e) {
      setError(describe(e))
    }
  }
  const outcome =
    h.status === 'pending'
      ? t('handover.outPending', { to: h.toName, time: time(h.at) })
      : h.status === 'taken'
        ? t('handover.outTaken', { to: h.toName, time: time(h.answeredAt) })
        : h.status === 'declined'
          ? t('handover.outDeclined', { to: h.toName, time: time(h.answeredAt) })
          : h.status === 'cancelled'
            ? t('handover.outCancelled', { time: time(h.answeredAt) })
            : t('handover.outLapsed')
  return (
    <div className={rowClass} style={{ '--i': n } as CSSProperties}>
      <Pill tint={statusTint[h.status]} icon={UserRoundCheck}>
        {h.ticket}
      </Pill>
      <span className="min-w-[180px] flex-1">
        <span className="block font-semibold">{h.name}</span>
        <span className="text-ink-2 block text-[13px]">{outcome}</span>
        {h.status === 'declined' && h.reason && (
          <span className="text-red block text-[13px]">“{h.reason}”</span>
        )}
      </span>
      <span className="flex flex-wrap gap-2">
        {h.status !== 'taken' && (
          <Button
            size="sm"
            variant="tint-blue"
            onClick={() =>
              void navigate({ to: '/app/visit', search: { encounter: h.encounterId } })
            }
          >
            <Eye size={14} aria-hidden="true" />
            {t('common.open')}
          </Button>
        )}
        {h.status === 'pending' && (
          <Button
            size="sm"
            variant="tint-coral"
            loading={cancel.isPending}
            onClick={() => void withdraw()}
          >
            <X size={14} aria-hidden="true" />
            {t('handover.cancel')}
          </Button>
        )}
      </span>
      {error && (
        <div className="basis-full">
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}
    </div>
  )
}

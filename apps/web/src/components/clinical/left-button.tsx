import { useState } from 'react'
import { LogOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { ApiError } from '@/lib/api/errors'
import { useCan } from '@/lib/api/permissions'
import { useVisitActions } from '@/lib/api/visits'
import { useConfirm } from '@/lib/confirm'

/*
 * "Patient has left": closes the visit and takes the patient off every queue. With money still
 * due: the manager, and whoever holds "Let a patient go with money due" (0144), close it giving
 * the reason — what is owed stays on the patient as a debt; the others are told to send the
 * patient to the cashier.
 */
export function LeftButton({
  encounterId,
  name,
  user,
  size = 'sm',
  compact = false,
  onDone,
}: {
  encounterId: string
  name: string
  user: StaffUser
  size?: 'sm' | 'md'
  /** Icon only (list rows); the label shows as the tooltip. */
  compact?: boolean
  onDone?: (message: string) => void
}) {
  const { t } = useTranslation()
  const { endVisit } = useVisitActions()
  const [error, setError] = useState<string | null>(null)
  const confirm = useConfirm()
  const can = useCan(user)
  const mayLeaveOwing = user.role === 'manager' || can('visit.leave_owing')

  const leave = async () => {
    setError(null)
    if (
      !(await confirm({
        title: t('confirm.visit.left', { name }),
        body: t('confirm.visit.leftBody'),
        confirmLabel: t('confirm.visit.leftYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await endVisit.mutateAsync({ encounterId })
      onDone?.(t('visits.left.done', { name }))
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      // the database's own (English) sentence tells the refusal apart whatever the language shown
      const raw = e instanceof ApiError ? e.serverMessage : m
      const due = /still due \((\d+)/.exec(raw)?.[1]
      const hint = e instanceof ApiError ? e.hint : null
      if ((hint === 'leave_reason' || /say why/.test(raw)) && mayLeaveOwing) {
        const r = await confirm({
          title: t('visits.left.reasonPrompt', { amount: due ?? '' }),
          body: t('visits.left.owingBody'),
          input: {
            label: t('confirm.reasonLabel'),
            placeholder: t('confirm.reasonPh'),
            required: true,
            multiline: true,
          },
          confirmLabel: t('confirm.visit.leftYes'),
          tone: 'danger',
        })
        if (!r.ok) return
        try {
          await endVisit.mutateAsync({ encounterId, reason: r.value })
          onDone?.(t('visits.left.doneOwing', { name, amount: due ?? '' }))
        } catch (e2) {
          setError(e2 instanceof Error ? e2.message : String(e2))
        }
        return
      }
      // not allowed, money still due: say plainly where the patient goes and who may close it
      setError(
        hint === 'leave_owing' || /take the payment first/.test(raw)
          ? t('visits.left.unpaid', { amount: due ?? '' })
          : due
            ? t('visits.left.due', { amount: due })
            : m,
      )
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        size={size}
        variant={compact ? 'default' : 'ghost'}
        onClick={() => void leave()}
        loading={endVisit.isPending}
        title={`${t('visits.left.button')} · ${t('visits.left.hint')}`}
        aria-label={compact ? t('visits.left.button') : undefined}
      >
        <LogOut size={14} aria-hidden="true" />
        {!compact && t('visits.left.button')}
      </Button>
      {error && (
        <span role="alert" className="text-red max-w-[260px] text-xs font-semibold">
          {error}
        </span>
      )}
    </span>
  )
}

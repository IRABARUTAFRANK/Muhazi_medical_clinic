import { useState } from 'react'
import { LogOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { ApiError } from '@/lib/api/errors'
import { useVisitActions } from '@/lib/api/visits'
import { useConfirm } from '@/lib/confirm'

/*
 * "Patient has left": closes the visit and takes the patient off every queue. With money still
 * due, reception and the others are told to take the payment first; the manager may still
 * close it, giving the reason.
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
      if (/say why|still due/.test(raw) && user.role === 'manager') {
        const reason = window.prompt(t('visits.left.reasonPrompt', { amount: due ?? '' }))
        if (!reason?.trim()) return
        try {
          await endVisit.mutateAsync({ encounterId, reason })
          onDone?.(t('visits.left.done', { name }))
        } catch (e2) {
          setError(e2 instanceof Error ? e2.message : String(e2))
        }
        return
      }
      // not the manager, money still due: say plainly where the patient goes and who may close it
      setError(
        /take the payment first/.test(raw)
          ? t('visits.left.unpaid', {
              defaultValue:
                'The patient has not paid yet: send them to the cashier. Only the manager can end a visit with money due.',
            })
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

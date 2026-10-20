import { useState } from 'react'
import { LogOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { useVisitActions } from '@/lib/api/visits'

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

  const leave = async () => {
    setError(null)
    if (!window.confirm(t('visits.left.confirm', { name }))) return
    try {
      await endVisit.mutateAsync({ encounterId })
      onDone?.(t('visits.left.done', { name }))
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      const due = /still due \((\d+)/.exec(m)?.[1]
      if (/say why|still due/.test(m) && user.role === 'manager') {
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
      setError(due ? t('visits.left.due', { amount: due }) : m)
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

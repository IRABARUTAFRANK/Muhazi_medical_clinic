import { UserRoundCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { QueueHandover } from '@/lib/api/visits'
import { useSession } from '@/store/session'
import { cn } from '@/lib/utils'

/**
 * The handover on a queue row (0088): "Handed over by Dr X" once the colleague took the patient,
 * "Handed over to you by Dr X" while the colleague still has to answer, and for the others
 * "Handed over by Dr X to Dr Y, waiting". The note shows when the pointer rests on it.
 */
export function HandoverBadge({
  handover: h,
  className,
}: {
  handover: QueueHandover | null | undefined
  className?: string
}) {
  const { t } = useTranslation()
  const me = useSession((s) => s.user?.id)
  if (!h) return null
  const label =
    h.status === 'taken'
      ? t('handover.badgeBy', { name: h.fromName })
      : h.toId === me
        ? t('handover.badgeToYou', { name: h.fromName })
        : t('handover.badgeWaiting', { from: h.fromName, to: h.toName })
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 font-semibold',
        h.status === 'pending' && h.toId === me ? 'text-amber' : 'text-violet',
        className,
      )}
      title={h.note || undefined}
    >
      <UserRoundCheck size={12} aria-hidden="true" />
      {label}
    </span>
  )
}

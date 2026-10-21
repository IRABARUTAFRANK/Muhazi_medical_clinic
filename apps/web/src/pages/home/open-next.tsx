import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { useNextPatient, useTakePatient } from '@/lib/api/visits'
import { cn } from '@/lib/utils'

/**
 * "Open next patient": takes the next patient of the desk (a patient shared with other desks
 * leaves them) and opens the visit. Says so when nobody is waiting.
 */
export function OpenNextButton({
  user,
  className,
  size = 'md',
}: {
  user: StaffUser
  className?: string
  size?: 'sm' | 'md'
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const take = useTakePatient()
  const next = useNextPatient(user)
  const [message, setMessage] = useState<string | null>(null)
  const open = async () => {
    setMessage(null)
    if (!next) {
      setMessage(t('queuePage.nobody'))
      return
    }
    try {
      await take.mutateAsync(next.queueId)
      await navigate({ to: '/app/visit', search: { encounter: next.encounterId } })
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-2', className)}>
      <Button
        variant="primary"
        size={size}
        loading={take.isPending}
        onClick={() => void open()}
        title={next ? `${next.ticket} · ${next.name}` : t('queuePage.nobody')}
      >
        {!take.isPending && <ArrowRight size={16} aria-hidden="true" />}
        {t('home.actions.openNext')}
        {next && <span className="font-normal opacity-80">· {next.ticket}</span>}
      </Button>
      {message && (
        <span role="status" className="text-ink-2 text-[13px] font-semibold">
          {message}
        </span>
      )}
    </span>
  )
}

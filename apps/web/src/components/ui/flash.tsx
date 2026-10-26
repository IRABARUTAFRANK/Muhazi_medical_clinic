import { useEffect, useState, type ReactNode } from 'react'
import { CheckCircle2, TriangleAlert, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useReveal } from '@/lib/hooks'
import { cn } from '@/lib/utils'

/** How long a success message stays on screen. */
const SUCCESS_MS = 5000

/*
 * A message after an action: green success ("2 prices changed.") disappears by itself after a
 * few seconds; a red error stays until it is closed (or the next action replaces it). Both have
 * an × to close them at once. Give `onClose` to clear the page's own message state; pass the
 * message as `key` so a new message shows again. The line fades in and rises; a success
 * check-mark pops (300 ms).
 */
export function Flash({
  tone = 'success',
  children,
  onClose,
  className,
}: {
  tone?: 'success' | 'error'
  children: ReactNode
  onClose?: () => void
  className?: string
}) {
  const { t } = useTranslation()
  const [shown, setShown] = useState(true)
  // a message that appears out of view (at the top while the button is lower) comes into view
  const ref = useReveal<HTMLParagraphElement>({ block: 'nearest' })
  const close = () => {
    setShown(false)
    onClose?.()
  }
  useEffect(() => {
    if (tone !== 'success') return
    const id = window.setTimeout(() => {
      setShown(false)
      onClose?.()
    }, SUCCESS_MS)
    return () => window.clearTimeout(id)
    // the timer starts once per message (the message is the key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tone])
  if (!shown) return null
  const Icon = tone === 'success' ? CheckCircle2 : TriangleAlert
  return (
    <p
      ref={ref}
      role={tone === 'success' ? 'status' : 'alert'}
      className={cn(
        'anim-dialog m-0 flex scroll-mt-4 scroll-mb-4 items-start gap-2 rounded-md border py-2 pr-2 pl-3 text-[14px] font-medium',
        tone === 'success'
          ? 'border-green/25 bg-green-bg text-green'
          : 'border-red/25 bg-red-bg text-red',
        className,
      )}
    >
      <Icon
        size={15}
        aria-hidden="true"
        className={cn('mt-0.5 flex-none', tone === 'success' && 'anim-pop')}
      />
      <span className="min-w-0 flex-1">{children}</span>
      <button
        type="button"
        onClick={close}
        aria-label={t('common.close')}
        title={t('common.close')}
        className="-my-0.5 inline-flex size-6 flex-none items-center justify-center rounded opacity-70 hover:opacity-100"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </p>
  )
}

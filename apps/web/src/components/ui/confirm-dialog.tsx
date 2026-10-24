import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { CircleHelp, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ConfirmContext, type ConfirmOptions } from '@/lib/confirm'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface Pending extends ConfirmOptions {
  resolve: (yes: boolean) => void
}

/**
 * The "Are you sure?" box of the whole app (useConfirm). One at a time; Escape or a click
 * outside answers no; the focus starts on "No, go back" for danger actions, on the yes button
 * otherwise, and returns where it was.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [pending, setPending] = useState<Pending | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const yesRef = useRef<HTMLButtonElement>(null)
  const noRef = useRef<HTMLButtonElement>(null)

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        returnFocus.current = document.activeElement as HTMLElement | null
        setPending((prev) => {
          // a second question while one is open: the first one is answered no
          prev?.resolve(false)
          return { ...options, resolve }
        })
      }),
    [],
  )

  const answer = useCallback(
    (yes: boolean) => {
      pending?.resolve(yes)
      setPending(null)
      returnFocus.current?.focus?.()
    },
    [pending],
  )

  useEffect(() => {
    if (!pending) return
    ;(pending.tone === 'danger' ? noRef : yesRef).current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        answer(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, answer])

  const danger = pending?.tone === 'danger'
  const Icon = danger ? TriangleAlert : CircleHelp
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) answer(false)
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="mmc-confirm-title"
            aria-describedby={pending.body ? 'mmc-confirm-body' : undefined}
            className="bg-card shadow-card anim-enter flex w-full max-w-md flex-col gap-4 rounded-2xl p-5"
          >
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  'inline-flex size-10 flex-none items-center justify-center rounded-full',
                  danger ? 'bg-red-bg text-red' : 'bg-primary-tint text-primary',
                )}
              >
                <Icon size={20} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 id="mmc-confirm-title" className="text-ink m-0 text-[17px] font-bold">
                  {pending.title}
                </h2>
                {pending.body && (
                  <div id="mmc-confirm-body" className="text-ink-2 mt-1 text-[14px]">
                    {pending.body}
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button ref={noRef} variant="ghost" onClick={() => answer(false)}>
                {pending.cancelLabel ?? t('confirm.no')}
              </Button>
              <Button
                ref={yesRef}
                variant={danger ? 'danger' : 'primary'}
                onClick={() => answer(true)}
              >
                {pending.confirmLabel ?? t('confirm.yes')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}

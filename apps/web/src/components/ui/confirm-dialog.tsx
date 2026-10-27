import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { CircleHelp, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  ConfirmContext,
  type Confirm,
  type ConfirmInputResult,
  type ConfirmOptions,
} from '@/lib/confirm'
import { Button } from '@/components/ui/button'
import { controlClass, labelClass } from '@/components/ui/field'
import { heroBand } from '@/components/dash/kit-style'
import { cn } from '@/lib/utils'

interface Pending extends ConfirmOptions {
  resolve: (answer: boolean | ConfirmInputResult) => void
}

/**
 * The "Are you sure?" box of the whole app (useConfirm). One at a time; Escape or a click
 * outside answers no; the focus starts on the text box when there is one, else on "No, go
 * back" for danger actions, on the yes button otherwise, and returns where it was. With an
 * `input`, the yes button stays off while a required box is empty and Enter in a single-line
 * box answers yes. The box fades in and rises 8 px over 200 ms.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [pending, setPending] = useState<Pending | null>(null)
  const [value, setValue] = useState('')
  const returnFocus = useRef<HTMLElement | null>(null)
  const yesRef = useRef<HTMLButtonElement>(null)
  const noRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean | ConfirmInputResult>((resolve) => {
        returnFocus.current = document.activeElement as HTMLElement | null
        setValue(options.input?.initial ?? '')
        setPending((prev) => {
          // a second question while one is open: the first one is answered no
          prev?.resolve(prev.input ? { ok: false } : false)
          return { ...options, resolve }
        })
      }),
    [],
  ) as Confirm

  const answer = useCallback(
    (yes: boolean) => {
      if (!pending) return
      if (pending.input) {
        pending.resolve(yes ? { ok: true, value: value.trim() } : { ok: false })
      } else {
        pending.resolve(yes)
      }
      setPending(null)
      returnFocus.current?.focus?.()
    },
    [pending, value],
  )

  const input = pending?.input
  const missing = Boolean(input?.required) && value.trim() === ''

  useEffect(() => {
    if (!pending) return
    ;(pending.input ? inputRef : pending.tone === 'danger' ? noRef : yesRef).current?.focus()
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
  const boxClass = cn(
    controlClass,
    'w-full',
    input?.multiline && 'h-auto min-h-[84px] resize-y py-2',
  )
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div
          className="anim-dialog fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) answer(false)
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="mmc-confirm-title"
            aria-describedby={pending.body ? 'mmc-confirm-body' : undefined}
            className="bg-card border-card-border shadow-panel anim-dialog flex w-full max-w-md flex-col overflow-hidden rounded-xl border"
          >
            {/* the question on a hero band: teal for an ordinary question, coral for a danger */}
            <div
              className={cn(
                'flex items-start gap-3 px-5 py-4',
                heroBand(danger ? 'coral' : 'teal'),
              )}
            >
              <span className="inline-flex size-9 flex-none items-center justify-center rounded-full bg-white/20 text-white">
                <Icon size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 id="mmc-confirm-title" className="m-0 text-[16px] font-semibold text-white">
                  {pending.title}
                </h2>
                {pending.body && (
                  <div id="mmc-confirm-body" className="mt-1 text-[14px] text-white/85">
                    {pending.body}
                  </div>
                )}
              </div>
            </div>
            {input && (
              <form
                className="px-5 pt-4"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!missing) answer(true)
                }}
              >
                <label className={labelClass}>
                  {input.label}
                  {input.multiline ? (
                    <textarea
                      ref={inputRef as RefObject<HTMLTextAreaElement>}
                      rows={3}
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      placeholder={input.placeholder}
                      maxLength={input.maxLength}
                      required={input.required}
                      className={boxClass}
                    />
                  ) : (
                    <input
                      ref={inputRef as RefObject<HTMLInputElement>}
                      type="text"
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      placeholder={input.placeholder}
                      maxLength={input.maxLength}
                      required={input.required}
                      className={boxClass}
                    />
                  )}
                </label>
              </form>
            )}
            <div className="flex flex-wrap justify-end gap-2 px-5 py-4">
              <Button ref={noRef} variant="ghost" onClick={() => answer(false)}>
                {pending.cancelLabel ?? t('confirm.no')}
              </Button>
              <Button
                ref={yesRef}
                variant={danger ? 'danger' : 'primary'}
                disabled={missing}
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

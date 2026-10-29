import { useEffect, useRef, useState, type FormEvent } from 'react'
import { KeyRound, Lock, LockOpen, Mail, Send } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { Field, controlClass, labelClass } from '@/components/ui/field'
import { SidePanel } from '@/components/ui/side-panel'
import { useVisitEditActions } from '@/lib/api/visits'
import type { VisitEditLock } from '@/lib/api/patients'
import { useEditWindow } from './edit-window'

const errorBox =
  'bg-red-bg text-red m-0 border border-red/30 rounded-md px-3 py-2 text-[13px] font-semibold'

/**
 * The lock of a finished visit, at the top of the clinical record: "This visit is finished on …;
 * to change it press Edit this visit". The button opens a side panel: the reason, then the
 * 6-digit code e-mailed to the person ("Send the code again" makes a new one). Once the code is
 * right, a green banner says until when editing is allowed, with a countdown; the edit buttons of
 * the record show while it runs and hide again after.
 */
export function VisitEditLock({
  encounterId,
  lock,
  patientName,
  onDone,
  onError,
}: {
  encounterId: string
  lock: VisitEditLock
  patientName?: string | null
  onDone: (m: string) => void
  onError: (m: string | null) => void
}) {
  const { t } = useTranslation()
  const { editing, secondsLeft } = useEditWindow(lock)
  const actions = useVisitEditActions(encounterId)
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<'reason' | 'code'>('reason')
  const [reason, setReason] = useState('')
  const [code, setCode] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // the window ended while the page was open: said once
  const wasEditing = useRef(editing)
  useEffect(() => {
    if (wasEditing.current && !editing) onDone(t('visitLock.expired'))
    wasEditing.current = editing
  }, [editing, onDone, t])

  const start = () => {
    setError(null)
    setCode('')
    // a code was already e-mailed and is still valid: straight to typing it
    const pending = lock.pending && new Date(lock.pending.codeUntil).getTime() > Date.now()
    setStep(pending ? 'code' : 'reason')
    setReason(pending ? (lock.pending?.reason ?? reason) : reason)
    setSentTo(null)
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    setError(null)
  }
  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    if (reason.trim().length < 3) return setError(t('visitLock.reasonNeeded'))
    setError(null)
    onError(null)
    try {
      const r = await actions.requestCode.mutateAsync(reason)
      setSentTo(r.masked)
      setCode('')
      setStep('code')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const verify = async (e: FormEvent) => {
    e.preventDefault()
    const c = code.replace(/\s/g, '')
    if (!/^\d{6}$/.test(c)) return setError(t('visitLock.codeFormat'))
    setError(null)
    onError(null)
    try {
      const r = await actions.verifyCode.mutateAsync(c)
      setOpen(false)
      onDone(t('visitLock.opened', { time: formatTime(new Date(r.expiresAt)) }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const closedAt = lock.closedAt ? new Date(lock.closedAt) : null
  const when = closedAt
    ? t(lock.closedBy ? 'visitLock.closedWhenBy' : 'visitLock.closedWhen', {
        date: formatDate(closedAt),
        time: formatTime(closedAt),
        name: lock.closedBy ?? '',
      })
    : ''

  if (editing) {
    const minutes = Math.floor(secondsLeft / 60)
    const left =
      secondsLeft < 60 ? t('visitLock.underMinute') : t('visitLock.minutesLeft', { count: minutes })
    return (
      <div
        role="status"
        aria-live="polite"
        className="bg-green-bg text-green border-green/30 anim-enter flex items-start gap-3 rounded-md border px-4 py-3 text-[14px]"
      >
        <LockOpen size={20} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <b className="block">
            {t('visitLock.activeTitle', {
              time: formatTime(new Date(lock.expiresAt!)),
              left,
            })}
          </b>
          <span className="block text-[13px]">
            {t('visitLock.activeBody', { reason: lock.reason ?? '' })}
          </span>
        </span>
      </div>
    )
  }

  return (
    <>
      <div
        role="status"
        className="bg-yellow-bg text-yellow border-yellow/30 flex flex-wrap items-start gap-3 rounded-md border px-4 py-3 text-[14px]"
      >
        <Lock size={20} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span className="min-w-0 flex-[1_1_16rem]">
          <b className="block">{t('visitLock.closedTitle')}</b>
          <span className="block text-[13px]">
            {[when, t(lock.canRequest ? 'visitLock.closedHow' : 'visitLock.notYours')]
              .filter(Boolean)
              .join(' ')}
          </span>
        </span>
        {lock.canRequest && (
          <Button variant="primary" size="sm" onClick={start} className="self-center">
            <KeyRound size={14} aria-hidden="true" />
            {t('visitLock.edit')}
          </Button>
        )}
      </div>
      <SidePanel
        open={open}
        onClose={close}
        hue="navy"
        icon={KeyRound}
        title={t('visitLock.edit')}
        subtitle={patientName ? t('visitLock.panelSubtitle', { name: patientName }) : undefined}
        footer={
          <Button variant="ghost" onClick={close}>
            {t('staff.form.cancel')}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-ink-2 m-0 text-[14px]">{t('visitLock.explain')}</p>
          {step === 'reason' ? (
            <form onSubmit={send} className="flex flex-col gap-3">
              <label className={labelClass}>
                {t('visitLock.why')}
                <textarea
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t('visitLock.whyPh')}
                  required
                  minLength={3}
                  autoFocus
                  className={`${controlClass} h-auto min-h-[84px] resize-y py-2`}
                />
              </label>
              {error && (
                <p role="alert" className={errorBox}>
                  {error}
                </p>
              )}
              <Button
                type="submit"
                variant="primary"
                className="self-start"
                loading={actions.requestCode.isPending}
              >
                <Mail size={16} aria-hidden="true" />
                {t('visitLock.send')}
              </Button>
            </form>
          ) : (
            <form onSubmit={verify} className="flex flex-col gap-3">
              <p className="bg-blue-bg text-blue border-blue/25 m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-[13px] font-semibold">
                <Mail size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
                {sentTo
                  ? t('visitLock.sent', { email: sentTo })
                  : t('visitLock.pendingNote', {
                      time: lock.pending ? formatTime(new Date(lock.pending.codeUntil)) : '',
                    })}
              </p>
              <Field
                label={t('visitLock.code')}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^\d\s]/g, '').slice(0, 7))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                required
                autoFocus
                className="max-w-[12rem] text-[20px] tracking-[0.3em]"
              />
              {error && (
                <p role="alert" className={errorBox}>
                  {error}
                </p>
              )}
              <span className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" loading={actions.verifyCode.isPending}>
                  <LockOpen size={16} aria-hidden="true" />
                  {t('visitLock.open')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void send()}
                  loading={actions.requestCode.isPending}
                >
                  <Send size={16} aria-hidden="true" />
                  {t('visitLock.resend')}
                </Button>
              </span>
            </form>
          )}
        </div>
      </SidePanel>
    </>
  )
}

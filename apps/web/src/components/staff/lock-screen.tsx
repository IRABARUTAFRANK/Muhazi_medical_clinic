import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Clock, Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatTime } from '@mmc/shared'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { useConfirm } from '@/lib/confirm'
import { IDLE_WARNING_MS, idleDeadline, MAX_UNLOCK_FAILURES, useSession } from '@/store/session'

/** The time of now, refreshed every `ms` (for counters that only need to move slowly). */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return now
}

/**
 * "No activity for 4 h 50 min": shown during the last 10 minutes before this tab signs out for
 * inactivity. Any click, key, touch or scroll keeps the person signed in and hides it at once
 * (the activity moves the time of the last activity, see store/session.ts).
 */
export function IdleWarning() {
  const { t } = useTranslation()
  const lastActiveAt = useSession((s) => s.lastActiveAt)
  const hours = useSession((s) => s.sessionHours)
  const now = useNow(5_000)
  const deadline = idleDeadline({ lastActiveAt, sessionHours: hours })
  const left = deadline - now
  if (lastActiveAt == null || left <= 0 || left > IDLE_WARNING_MS) return null
  const idleMin = Math.floor((now - lastActiveAt) / 60_000)
  const h = Math.floor(idleMin / 60)
  const m = idleMin % 60
  const idle =
    h > 0 && m > 0
      ? t('session.duration.hm', { h, m })
      : h > 0
        ? t('session.duration.h', { h })
        : t('session.duration.m', { m })
  return (
    <div
      role="status"
      className="bg-card text-ink border-card-border border-l-yellow-dot shadow-panel rounded-lg2 fixed right-4 bottom-4 left-4 z-[90] flex flex-col gap-2 border border-l-[3px] px-4 py-3 sm:left-auto sm:max-w-[440px]"
    >
      <span className="flex items-start gap-3">
        <Clock size={16} aria-hidden="true" className="text-yellow mt-0.5 flex-none" />
        <span className="flex-1 text-[13px]">
          <b className="block">{t('session.idleFor', { time: idle })}</b>
          <span className="text-ink-2 block">
            {t('session.signOutIn', { count: Math.max(1, Math.ceil(left / 60_000)) })}
          </span>
          <span className="text-ink-3 block text-xs">{t('session.after')}</span>
        </span>
      </span>
      {/* pressing it is activity, like any click: the warning goes away */}
      <Button size="sm" variant="primary" className="self-end">
        {t('lock.stay')}
      </Button>
    </div>
  )
}

/**
 * Full-screen PIN prompt shown after "Lock the screen now". Time on a locked screen counts as
 * time without activity: once the hours pass, the tab signs out instead (see store/session.ts).
 */
export function LockScreen() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const user = useSession((s) => s.user)
  const lastActiveAt = useSession((s) => s.lastActiveAt)
  const hours = useSession((s) => s.sessionHours)
  const failures = useSession((s) => s.unlockFailures)
  const unlock = useSession((s) => s.unlock)
  const signOut = useSession((s) => s.signOut)
  const confirm = useConfirm()
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!user) return null

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const ok = await unlock(pin)
    setBusy(false)
    if (!ok) {
      const left = MAX_UNLOCK_FAILURES - useSession.getState().unlockFailures
      setError(left > 0 ? t('lock.wrongLeft', { count: left }) : t('lock.wrong'))
      setPin('')
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('lock.byYouTitle')}
      className="workspace text-ink fixed inset-0 z-[100] flex items-center justify-center p-4"
    >
      <form
        onSubmit={submit}
        className="bg-card border-card-border shadow-panel anim-dialog flex w-full max-w-[400px] flex-col overflow-hidden rounded-xl border"
      >
        {/* the lock on the clinic's hero, like every dialog header */}
        <div className="hero hero-clinic flex items-center gap-3 px-6 py-4 text-white">
          <span className="inline-flex size-9 flex-none items-center justify-center rounded-md bg-white/20">
            <Lock size={18} aria-hidden="true" />
          </span>
          <span>
            <span className="block text-[16px] font-semibold">{t('lock.byYouTitle')}</span>
            <span className="text-[13px] text-white/85">
              {t('lock.byYouBody', { name: user.name })}
            </span>
          </span>
        </div>
        <div className="flex flex-col gap-4 p-6">
          <div className="border-primary/30 wash wash-teal rounded-lg2 flex items-center gap-3 border px-3 py-2">
            <Avatar name={user.name} size="md" />
            <span>
              <span className="block font-medium">{user.name}</span>
              <span className="text-ink-3 text-[13px]">{user.username}</span>
            </span>
          </div>
          {lastActiveAt != null && (
            <p className="text-ink-2 m-0 flex items-start gap-2 text-[13px]">
              <Clock size={15} aria-hidden="true" className="text-ink-3 mt-0.5 flex-none" />
              <span>
                {t('lock.idleSignOut', {
                  time: formatTime(new Date(idleDeadline({ lastActiveAt, sessionHours: hours }))),
                  count: hours,
                })}
              </span>
            </p>
          )}
          <Field
            label={t('landing.signin.pin')}
            type="password"
            inputMode="numeric"
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoComplete="current-password"
            required
          />
          {error && (
            <p
              role="alert"
              className="border-red/25 bg-red-bg text-red m-0 rounded-md border px-3 py-1.5 text-[13px] font-medium"
            >
              {error}
            </p>
          )}
          {!error && failures > 0 && (
            <p className="text-ink-3 m-0 text-[12px]">
              {t('lock.wrongLeft', { count: Math.max(1, MAX_UNLOCK_FAILURES - failures) })}
            </p>
          )}
          <Button type="submit" variant="primary" size="lg" disabled={busy}>
            {t('lock.unlock')}
          </Button>
          <button
            type="button"
            className="text-ink-2 text-[13px] underline-offset-2 hover:underline"
            onClick={async () => {
              const ok = await confirm({
                title: t('confirm.signOut.title'),
                body: t('confirm.signOut.body'),
                confirmLabel: t('confirm.signOut.yes'),
              })
              if (!ok) return
              await signOut('signedOut')
              void navigate({ to: '/', hash: 'signin' })
            }}
          >
            {t('lock.switch')}
          </button>
        </div>
      </form>
    </div>
  )
}

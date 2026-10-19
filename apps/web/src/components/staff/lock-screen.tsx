import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { useSession } from '@/store/session'

const ACTIVITY_EVENTS = [
  'pointerdown',
  'pointermove',
  'keydown',
  'touchstart',
  'wheel',
  'scroll',
] as const
/** Seconds of warning before the screen locks. */
export const LOCK_WARNING_S = 60

/**
 * Locks the staff screen after `minutes` without input. One minute before, it returns the
 * time left so the shell can show "Still there?"; any touch, key or mouse move resets it.
 * The page underneath stays as it was, so unlocking with the PIN loses no work.
 */
export function useIdleLock(minutes = 15): number | null {
  const [left, setLeft] = useState<number | null>(null)
  useEffect(() => {
    let lockAt = 0
    let lastArm = 0
    const arm = () => {
      lockAt = Date.now() + minutes * 60_000
      lastArm = Date.now()
      setLeft(null)
    }
    const onActivity = () => {
      // pointermove fires constantly: re-arm at most once a second.
      if (useSession.getState().locked || Date.now() - lastArm < 1000) return
      arm()
    }
    arm()
    const tick = window.setInterval(() => {
      if (useSession.getState().locked) return
      const remaining = Math.ceil((lockAt - Date.now()) / 1000)
      if (remaining <= 0) {
        setLeft(null)
        useSession.getState().lock()
      } else if (remaining <= LOCK_WARNING_S) setLeft(remaining)
    }, 1000)
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onActivity, { passive: true })
    return () => {
      window.clearInterval(tick)
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity)
    }
  }, [minutes])
  return left
}

/** Small bar shown during the last minute before the lock. */
export function IdleWarning({ seconds }: { seconds: number }) {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      className="bg-amber-bg text-ink border-amber shadow-card fixed right-4 bottom-4 z-[90] flex max-w-[360px] items-center gap-3 rounded-xl border px-4 py-3"
    >
      <Lock size={18} aria-hidden="true" className="flex-none" />
      <span className="flex-1 text-[13px] font-semibold">{t('lock.soon', { count: seconds })}</span>
      <Button size="sm" variant="primary">
        {t('lock.stay')}
      </Button>
    </div>
  )
}

/** Full-screen PIN prompt shown while the session is locked. */
export function LockScreen() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const user = useSession((s) => s.user)
  const unlock = useSession((s) => s.unlock)
  const signOut = useSession((s) => s.signOut)
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
      setError(t('lock.wrong'))
      setPin('')
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('lock.title')}
      className="band-gradient text-ink fixed inset-0 z-[100] flex items-center justify-center p-4"
    >
      <form
        onSubmit={submit}
        className="bg-card shadow-sheet flex w-full max-w-[400px] flex-col gap-4 rounded-2xl p-6"
      >
        <div className="flex items-center gap-3">
          <span className="icon-gradient inline-flex size-11 flex-none items-center justify-center rounded-xl text-white">
            <Lock size={22} aria-hidden="true" />
          </span>
          <span>
            <span className="block text-lg font-bold">{t('lock.title')}</span>
            <span className="text-ink-3 text-[13px]">{t('lock.body', { name: user.name })}</span>
          </span>
        </div>
        <div className="bg-surface flex items-center gap-3 rounded-lg px-3 py-2">
          <Avatar name={user.name} size="md" />
          <span>
            <span className="block font-semibold">{user.name}</span>
            <span className="text-ink-3 text-xs">{user.username}</span>
          </span>
        </div>
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
            className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
          >
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" size="lg" disabled={busy}>
          {t('lock.unlock')}
        </Button>
        <button
          type="button"
          className="text-ink-2 text-[13px] underline-offset-2 hover:underline"
          onClick={async () => {
            await signOut()
            void navigate({ to: '/', hash: 'signin' })
          }}
        >
          {t('lock.switch')}
        </button>
      </form>
    </div>
  )
}

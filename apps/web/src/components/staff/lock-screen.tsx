import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { useSession } from '@/store/session'

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const

/** Locks the staff screen after `minutes` without input (doc §14: auto-lock after 5 minutes). */
export function useIdleLock(minutes = 5) {
  useEffect(() => {
    let timer = 0
    const arm = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => useSession.getState().lock(), minutes * 60_000)
    }
    const onActivity = () => {
      if (!useSession.getState().locked) arm()
    }
    arm()
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onActivity, { passive: true })
    return () => {
      window.clearTimeout(timer)
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity)
    }
  }, [minutes])
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

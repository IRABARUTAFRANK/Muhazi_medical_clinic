import { useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { homeRouteFor } from '@/lib/roles'
import { isLive } from '@/lib/supabase'
import { useSession } from '@/store/session'

/** Staff sign-in card on the landing hero. Live: Supabase Auth; sample: any PIN for a known username. */
export function SignInCard() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const signIn = useSession((s) => s.signIn)
  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await signIn(username, pin)
      if (!result.ok) {
        setError(
          t(
            result.reason === 'inactive'
              ? 'landing.signin.inactive'
              : isLive
                ? 'landing.signin.failed'
                : 'landing.signin.unknown',
          ),
        )
        return
      }
      void navigate({
        to: result.user.mustChangePin ? '/app/change-pin' : homeRouteFor(result.user),
      })
    } catch {
      setError(t('landing.signin.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      id="signin"
      onSubmit={onSubmit}
      aria-label={t('landing.signin.title')}
      className="text-ink flex min-w-0 scroll-mt-24 flex-col gap-3.5 rounded-2xl border border-white/60 bg-white p-6 shadow-[0_24px_64px_rgba(11,34,82,.35)]"
    >
      <div className="flex items-center gap-3">
        <span className="icon-gradient inline-flex size-11 flex-none items-center justify-center rounded-xl text-white">
          <Lock size={22} strokeWidth={2} aria-hidden="true" />
        </span>
        <span>
          <span className="block text-lg font-bold">{t('landing.signin.title')}</span>
          <span className="text-ink-3 text-[13px]">{t('landing.signin.sub')}</span>
        </span>
      </div>
      <Field
        label={t('landing.signin.username')}
        placeholder={t('landing.signin.usernamePh')}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoComplete="username"
        autoCapitalize="none"
        required
      />
      <Field
        label={t('landing.signin.pin')}
        type="password"
        inputMode="numeric"
        placeholder={t('landing.signin.pinPh')}
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        autoComplete="current-password"
        required
      />
      <div className="flex items-center justify-between text-[13px]">
        <label className="text-ink-2 flex min-h-11 items-center gap-2">
          <input type="checkbox" defaultChecked className="accent-primary size-[18px]" />
          {t('landing.signin.remember')}
        </label>
        <a href="#signin">{t('landing.signin.forgot')}</a>
      </div>
      {error && (
        <p
          role="alert"
          className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
        >
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" size="lg" disabled={busy}>
        {busy ? t('landing.signin.signingIn') : t('landing.signin.button')}
      </Button>
      <p className="text-ink-3 m-0 text-center text-xs">{t('landing.signin.note')}</p>
    </form>
  )
}

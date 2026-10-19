import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Lock, MailCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Logo } from '@/components/public/logo'
import { homeRouteFor } from '@/lib/roles'
import { isLive } from '@/lib/supabase'
import { MISMATCH_KEY, maskEmail, useSession } from '@/store/session'

const CODE_RE = /^[0-9]{6}$/

/**
 * Staff login after the staff-ID check on the landing page.
 * Step 2: username + PIN (Supabase Auth checks the PIN and e-mails a six-digit code).
 * Step 3: the code. Only then does the session exist in the app.
 */
export function LoginPage({ staffId }: { staffId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const pending = useSession((s) => s.pending)
  const signIn = useSession((s) => s.signIn)
  const verifyOtp = useSession((s) => s.verifyOtp)
  const resendOtp = useSession((s) => s.resendOtp)
  const cancelSignIn = useSession((s) => s.cancelSignIn)

  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  // A sign-in link for another account was refused (see session.ts): say which one.
  const [error, setError] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(MISMATCH_KEY)
      if (!raw) return null
      localStorage.removeItem(MISMATCH_KEY)
      const m = JSON.parse(raw) as { expected: string; got: string }
      return t('login.linkMismatch', { expected: m.expected, got: m.got })
    } catch {
      return null
    }
  })
  const [notice, setNotice] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)
  // On by default: the clinic's mail budget is limited and staff use their own devices.
  const [trustDevice, setTrustDevice] = useState(true)
  const codeRef = useRef<HTMLInputElement>(null)

  const step: 'credentials' | 'otp' = pending && pending.staffId === staffId ? 'otp' : 'credentials'

  useEffect(() => {
    if (step === 'otp') codeRef.current?.focus()
  }, [step])

  useEffect(() => {
    if (cooldown <= 0) return
    const id = window.setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => window.clearTimeout(id)
  }, [cooldown])

  const submitCredentials = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await signIn(staffId, username, pin)
      if (!result.ok) {
        setError(
          t(
            result.reason === 'inactive'
              ? 'login.inactive'
              : result.reason === 'otp'
                ? 'login.otpSendFailed'
                : result.reason === 'error'
                  ? 'login.error'
                  : 'login.failed',
          ),
        )
        return
      }
      setPin('')
      if (result.step === 'done') {
        // Trusted device: no e-mailed code this time.
        void navigate({
          to: result.user.mustChangePin ? '/app/change-pin' : homeRouteFor(result.user),
        })
        return
      }
      setCode('')
      setCooldown(30)
    } catch {
      setError(t('login.error'))
    } finally {
      setBusy(false)
    }
  }

  const submitCode = async (e: FormEvent) => {
    e.preventDefault()
    if (!CODE_RE.test(code)) return setError(t('login.codeFormat'))
    setBusy(true)
    setError(null)
    try {
      const result = await verifyOtp(code, trustDevice)
      if (!result.ok) {
        setError(
          t(
            result.reason === 'expired'
              ? 'login.codeExpired'
              : result.reason === 'inactive'
                ? 'login.inactive'
                : result.reason === 'error'
                  ? 'login.error'
                  : 'login.codeWrong',
          ),
        )
        setCode('')
        return
      }
      void navigate({
        to: result.user.mustChangePin ? '/app/change-pin' : homeRouteFor(result.user),
      })
    } catch {
      setError(t('login.error'))
    } finally {
      setBusy(false)
    }
  }

  const resend = async () => {
    setError(null)
    const ok = await resendOtp()
    setNotice(ok ? t('login.codeResent') : null)
    if (!ok) setError(t('login.otpSendFailed'))
    setCooldown(30)
  }

  const back = () => {
    cancelSignIn()
    setCode('')
    setError(null)
    setNotice(null)
  }

  return (
    <div className="theme-public band-gradient flex min-h-dvh flex-col items-center justify-center gap-6 p-4 text-white">
      <Logo subtitle={t('app.place')} className="text-white [&_span]:text-white" />
      <div className="text-ink flex w-full max-w-[440px] flex-col gap-4 rounded-2xl border border-white/60 bg-white p-6 shadow-[0_24px_64px_rgba(11,34,82,.35)]">
        <div className="flex items-center gap-3">
          <span className="icon-gradient inline-flex size-11 flex-none items-center justify-center rounded-xl text-white">
            {step === 'otp' ? (
              <MailCheck size={22} aria-hidden="true" />
            ) : (
              <Lock size={22} aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0">
            <span className="block text-lg font-bold">
              {t(step === 'otp' ? 'login.codeTitle' : 'login.title')}
            </span>
            <span className="text-ink-3 block text-[13px]">
              {t('login.staffId')} <b className="text-ink tabular-nums">{staffId}</b>
            </span>
          </span>
        </div>

        {step === 'credentials' ? (
          <form onSubmit={submitCredentials} className="flex flex-col gap-3.5">
            <p className="text-ink-2 m-0 text-[13px]">{t('login.lead')}</p>
            <Field
              label={t('landing.signin.username')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoFocus
              required
            />
            <Field
              label={t('landing.signin.pin')}
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoComplete="current-password"
              required
            />
            {error && <Alert>{error}</Alert>}
            <Button type="submit" variant="primary" size="lg" disabled={busy}>
              {busy ? t('landing.signin.signingIn') : t('login.continue')}
            </Button>
            <Link
              to="/"
              hash="signin"
              className="text-ink-2 inline-flex items-center justify-center gap-1 text-[13px]"
            >
              <ArrowLeft size={14} aria-hidden="true" />
              {t('login.otherId')}
            </Link>
          </form>
        ) : (
          <form onSubmit={submitCode} className="flex flex-col gap-3.5">
            <p className="text-ink-2 m-0 text-[13px]">
              {t('login.codeLead', { email: maskEmail(pending?.email ?? '') })}
            </p>
            {!isLive && <p className="text-ink-3 m-0 text-xs">{t('login.codeSample')}</p>}
            {isLive && <p className="text-ink-3 m-0 text-xs">{t('login.codeOrLink')}</p>}
            <Field
              ref={codeRef}
              label={t('login.code')}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="text-center text-2xl font-bold tracking-[.4em] tabular-nums"
              required
            />
            {isLive && (
              <label className="border-border flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[13px]">
                <input
                  type="checkbox"
                  className="accent-primary mt-0.5 size-[18px] flex-none"
                  checked={trustDevice}
                  onChange={(e) => setTrustDevice(e.target.checked)}
                />
                <span>
                  <span className="text-ink block font-semibold">{t('login.trust')}</span>
                  <span className="text-ink-3 block text-xs">{t('login.trustHint')}</span>
                </span>
              </label>
            )}
            {error && <Alert>{error}</Alert>}
            {notice && (
              <p className="bg-green-bg text-green m-0 rounded-lg px-3 py-2 text-[13px] font-semibold">
                {notice}
              </p>
            )}
            <Button type="submit" variant="primary" size="lg" disabled={busy}>
              {busy ? t('landing.signin.signingIn') : t('login.verify')}
            </Button>
            <div className="flex items-center justify-between text-[13px]">
              <button
                type="button"
                className="text-ink-2 inline-flex items-center gap-1"
                onClick={back}
              >
                <ArrowLeft size={14} aria-hidden="true" />
                {t('login.back')}
              </button>
              <button
                type="button"
                className="text-primary font-semibold disabled:opacity-50"
                disabled={cooldown > 0}
                onClick={() => void resend()}
              >
                {cooldown > 0 ? t('login.resendIn', { s: cooldown }) : t('login.resend')}
              </button>
            </div>
          </form>
        )}
      </div>
      <p className="m-0 text-center text-xs text-white/80">{t('landing.signin.note')}</p>
    </div>
  )
}

function Alert({ children }: { children: string }) {
  return (
    <p
      role="alert"
      className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
    >
      {children}
    </p>
  )
}

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Clock, KeyRound, Lock, MailCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Logo } from '@/components/public/logo'
import { PIN_RE } from '@/lib/api/staff'
import { homeRouteFor } from '@/lib/roles'
import { isLive } from '@/lib/supabase'
import {
  clearSignOutNote,
  MISMATCH_KEY,
  maskEmail,
  readSignOutNote,
  useSession,
  type SignOutNote,
} from '@/store/session'

const CODE_RE = /^[0-9]{6}$/

/**
 * Staff login after the staff-ID check on the landing page.
 * Step 2: username + PIN (Supabase Auth checks the PIN and e-mails a six-digit code).
 * Step 3: the code. Only then does the session exist in the app.
 * First sign-in with the manager's temporary PIN: the person chooses their own PIN between
 * steps 2 and 3, so the e-mailed code approves the account with the PIN they will keep.
 * The tab then stays signed in while it is used; after some hours without activity (5 by
 * default), or after any sign-out, the page says why the person is here and that a new e-mailed
 * code is needed.
 */
export function LoginPage({ staffId }: { staffId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const pending = useSession((s) => s.pending)
  const signIn = useSession((s) => s.signIn)
  const verifyOtp = useSession((s) => s.verifyOtp)
  const resendOtp = useSession((s) => s.resendOtp)
  const setFirstPin = useSession((s) => s.setFirstPin)
  const [newPin, setNewPin] = useState('')
  const [newPin2, setNewPin2] = useState('')
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
  // Why this tab was signed out (hours without activity, sign-out, wrong PINs): read once, then
  // forgotten so it is not shown again after the next sign-in.
  const [note] = useState<SignOutNote | null>(() => readSignOutNote())
  useEffect(() => {
    if (note) clearSignOutNote()
  }, [note])
  const codeRef = useRef<HTMLInputElement>(null)

  const step: 'credentials' | 'new-pin' | 'otp' =
    pending && pending.staffId === staffId
      ? pending.needsNewPin
        ? 'new-pin'
        : 'otp'
      : 'credentials'

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
      if (result.step === 'new-pin') return
      if (result.step === 'done') {
        // Another tab of this browser while the person is active: no new code.
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

  const submitNewPin = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!PIN_RE.test(newPin)) return setError(t('pin.format'))
    if (newPin !== newPin2) return setError(t('pin.mismatch'))
    setBusy(true)
    try {
      const r = await setFirstPin(newPin)
      if (r === 'same') return setError(t('pin.same'))
      if (r === 'error') return setError(t('pin.failed'))
      setNewPin('')
      setNewPin2('')
      setCode('')
      setCooldown(30)
      if (r === 'otp') setError(t('login.otpSendFailed'))
      else setNotice(t('login.firstPinSaved'))
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
      const result = await verifyOtp(code)
      if (!result.ok) {
        setError(
          t(
            result.reason === 'expired'
              ? 'login.codeExpired'
              : result.reason === 'inactive'
                ? 'login.inactive'
                : result.reason === 'notApproved'
                  ? 'login.notApproved'
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
            ) : step === 'new-pin' ? (
              <KeyRound size={22} aria-hidden="true" />
            ) : (
              <Lock size={22} aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0">
            <span className="block text-lg font-bold">
              {t(
                step === 'otp'
                  ? 'login.codeTitle'
                  : step === 'new-pin'
                    ? 'pin.changeTitle'
                    : 'login.title',
              )}
            </span>
            <span className="text-ink-3 block text-[13px]">
              {t('login.staffId')} <b className="text-ink tabular-nums">{staffId}</b>
            </span>
          </span>
        </div>

        {step === 'credentials' ? (
          <form onSubmit={submitCredentials} className="flex flex-col gap-3.5">
            {note && <SignedOutNote note={note} />}
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
        ) : step === 'new-pin' ? (
          <form onSubmit={submitNewPin} className="flex flex-col gap-3.5">
            <p className="text-ink-2 m-0 text-[13px]">{t('login.firstPinLead')}</p>
            <Field
              label={t('pin.new')}
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              autoFocus
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              required
            />
            <Field
              label={t('pin.confirm')}
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={newPin2}
              onChange={(e) => setNewPin2(e.target.value.replace(/\D/g, '').slice(0, 6))}
              required
            />
            {error && <Alert>{error}</Alert>}
            <Button type="submit" variant="primary" size="lg" disabled={busy}>
              {busy ? t('pin.saving') : t('login.firstPinSave')}
            </Button>
            <button
              type="button"
              className="text-ink-2 inline-flex items-center justify-center gap-1 text-[13px]"
              onClick={back}
            >
              <ArrowLeft size={14} aria-hidden="true" />
              {t('login.back')}
            </button>
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
            <p className="bg-surface text-ink-2 m-0 flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs">
              <Clock size={14} aria-hidden="true" className="mt-0.5 flex-none" />
              <span>{t('login.sessionHint')}</span>
            </p>
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

/** Why the person is on the login page again, and what signing in now takes. */
function SignedOutNote({ note }: { note: SignOutNote }) {
  const { t } = useTranslation()
  const why =
    note.reason === 'idle'
      ? t('login.ended.idle', { count: note.hours })
      : note.reason === 'signedOut'
        ? t('login.ended.signedOut')
        : note.reason === 'wrongPins'
          ? t('login.ended.wrongPins')
          : note.reason === 'inactive'
            ? t('login.inactive')
            : note.reason === 'security'
              ? t('login.ended.security')
              : t('login.ended.ended')
  return (
    <div
      role="status"
      className="bg-amber-bg border-amber flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[13px]"
    >
      <Clock size={16} aria-hidden="true" className="mt-0.5 flex-none" />
      <span>
        <span className="text-ink block font-semibold">{why}</span>
        {note.reason !== 'inactive' && (
          <span className="text-ink-2 block">{t('login.ended.next')}</span>
        )}
      </span>
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

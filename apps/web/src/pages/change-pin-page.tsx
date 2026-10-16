import { useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { KeyRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { PIN_RE } from '@/lib/api/staff'
import { homeRouteFor } from '@/lib/roles'
import { useSession } from '@/store/session'

/** Forced at first sign-in (and whenever the manager resets a PIN): replace the handed-over PIN. */
export function ChangePinPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const changePin = useSession((s) => s.changePin)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!PIN_RE.test(next)) return setError(t('pin.format'))
    if (next !== confirm) return setError(t('pin.mismatch'))
    if (next === current) return setError(t('pin.same'))
    setBusy(true)
    const ok = await changePin(current, next)
    setBusy(false)
    if (!ok) return setError(t('pin.failed'))
    void navigate({ to: homeRouteFor(user) })
  }

  return (
    <div className="bg-surface text-ink flex min-h-dvh items-center justify-center p-4">
      <form
        onSubmit={submit}
        className="border-border bg-card flex w-full max-w-[440px] flex-col gap-4 rounded-2xl border p-6"
      >
        <div className="flex items-center gap-3">
          <span className="icon-gradient inline-flex size-11 flex-none items-center justify-center rounded-xl text-white">
            <KeyRound size={22} aria-hidden="true" />
          </span>
          <span>
            <span className="block text-lg font-bold">{t('pin.changeTitle')}</span>
            <span className="text-ink-3 text-[13px]">
              {user.name} · {user.username}
            </span>
          </span>
        </div>
        <p className="text-ink-2 m-0">{t('pin.changeLead')}</p>
        <Field
          label={t('pin.current')}
          type="password"
          inputMode="numeric"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          required
        />
        <Field
          label={t('pin.new')}
          type="password"
          inputMode="numeric"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          required
        />
        <Field
          label={t('pin.confirm')}
          type="password"
          inputMode="numeric"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
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
          {busy ? t('pin.saving') : t('pin.save')}
        </Button>
      </form>
    </div>
  )
}

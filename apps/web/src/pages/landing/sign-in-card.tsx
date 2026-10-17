import { useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRight, IdCard } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { normalizeStaffId } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { useSession } from '@/store/session'

/**
 * Step 1 of the staff sign-in, on the public landing page: the employee types the staff ID the
 * manager gave them. Only a known, active ID opens the login page (username + PIN, then the
 * e-mailed code). Nothing about the employee is shown here.
 */
export function SignInCard() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const checkStaffId = useSession((s) => s.checkStaffId)
  const [staffId, setStaffId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const id = normalizeStaffId(staffId)
      const ok = await checkStaffId(id)
      if (!ok) {
        setError(t('landing.signin.notStaff'))
        return
      }
      void navigate({ to: '/login', search: { staff: id } })
    } catch {
      setError(t('landing.signin.checkFailed'))
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
          <IdCard size={22} strokeWidth={2} aria-hidden="true" />
        </span>
        <span>
          <span className="block text-lg font-bold">{t('landing.signin.title')}</span>
          <span className="text-ink-3 text-[13px]">{t('landing.signin.sub')}</span>
        </span>
      </div>
      <Field
        label={t('landing.signin.staffId')}
        placeholder={t('landing.signin.staffIdPh')}
        value={staffId}
        onChange={(e) => setStaffId(e.target.value.toUpperCase())}
        autoComplete="off"
        autoCapitalize="characters"
        className="font-semibold tracking-[.08em] uppercase"
        required
      />
      <p className="text-ink-3 m-0 text-xs">{t('landing.signin.staffIdHint')}</p>
      {error && (
        <p
          role="alert"
          className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
        >
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" size="lg" disabled={busy}>
        {busy ? t('landing.signin.checking') : t('landing.signin.continue')}
        <ArrowRight size={18} aria-hidden="true" />
      </Button>
      <p className="text-ink-3 m-0 text-center text-xs">{t('landing.signin.note')}</p>
    </form>
  )
}

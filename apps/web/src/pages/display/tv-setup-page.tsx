import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Check, LogOut, Tv } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { useCan } from '@/lib/api/permissions'
import { storeDisplayKey, useSetupTv, useTvScreens } from '@/lib/api/display'
import { ApiError } from '@/lib/api/errors'
import { useSession } from '@/store/session'
import '@fontsource-variable/sora'
import '@fontsource-variable/manrope'
import './display.css'

/**
 * 0158: the TV is set up by signing in on it. After the staff sign-in (started from the
 * waiting-room screen's "Set up this TV"), this page lists the clinic's screens; one tap gives
 * this TV its own key, kept in its browser, and the staff session ends on the TV at once: the
 * TV is never signed in as a person. Without a screen in the clinic yet, the first one is made
 * on the spot ("Waiting room", every desk).
 */
export function TvSetupPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const can = useCan(user)
  const allowed = user.role === 'manager' || can('display.setup')
  const { data: screens = [], isLoading, error: loadError } = useTvScreens(allowed)
  const setup = useSetupTv()
  const signOut = useSession((s) => s.signOut)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const use = async (screenId: string | null) => {
    setError(null)
    try {
      const r = await setup.mutateAsync({ screenId, name: name.trim() || null })
      storeDisplayKey(r.key)
      setDone(r.screenName)
      // the TV is not a person: the session ends here, the screen opens with the TV's own key
      await signOut('ended')
      void navigate({ to: '/display', search: { key: '' } })
    } catch (e) {
      setError(
        e instanceof ApiError && e.hint === 'device_name'
          ? t('tvSetup.errors.name')
          : e instanceof Error
            ? e.message
            : String(e),
      )
    }
  }
  const leave = async () => {
    await signOut('signedOut')
    void navigate({ to: '/display', search: { key: '' } })
  }

  return (
    <div className="qd qd-setup">
      <div className="qd-setup-card">
        <div className="qd-setup-head">
          <span className="qd-icon" aria-hidden="true">
            <Tv />
          </span>
          <div className="min-w-0">
            <h1 className="qd-setup-title">{t('tvSetup.title')}</h1>
            <p className="qd-setup-sub">{t('tvSetup.signedInAs', { name: user.name })}</p>
          </div>
        </div>
        {!allowed ? (
          <p className="qd-setup-note">{t('tvSetup.notAllowed')}</p>
        ) : done ? (
          <p className="qd-setup-note">
            <Check size={18} aria-hidden="true" className="inline" />{' '}
            {t('tvSetup.done', { name: done })}
          </p>
        ) : (
          <>
            <p className="qd-setup-lead">{t('tvSetup.lead')}</p>
            <Field
              label={t('tvSetup.tvName')}
              placeholder={t('tvSetup.tvNamePh')}
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
            />
            {loadError && <p className="qd-setup-error">{loadError.message}</p>}
            {isLoading && <div className="skeleton h-12 rounded-md" aria-busy="true" />}
            {!isLoading && screens.length === 0 && (
              <div className="qd-setup-list">
                <p className="qd-setup-note">{t('tvSetup.noScreens')}</p>
                <button
                  type="button"
                  className="qd-setup-choice"
                  disabled={setup.isPending}
                  onClick={() => void use(null)}
                >
                  <span className="qd-setup-choice-name">{t('tvSetup.defaultScreen')}</span>
                  <span className="qd-setup-choice-sub">{t('tvSetup.defaultScreenSub')}</span>
                  <span className="qd-setup-choice-go">{t('tvSetup.useHere')}</span>
                </button>
              </div>
            )}
            {screens.length > 0 && (
              <div className="qd-setup-list" role="list">
                {screens.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="listitem"
                    className="qd-setup-choice"
                    disabled={setup.isPending}
                    onClick={() => void use(s.id)}
                  >
                    <span className="qd-setup-choice-name">{s.name}</span>
                    <span className="qd-setup-choice-sub">
                      {[
                        s.desks.length
                          ? s.desks
                              .map((d) => t(`register.stations.${d}`, { defaultValue: d }))
                              .join(', ')
                          : t('displayScreens.allDesks'),
                        s.languages.map((l) => l.toUpperCase()).join(' · '),
                        t('tvSetup.devices', { count: s.devices }),
                      ].join(' · ')}
                    </span>
                    <span className="qd-setup-choice-go">{t('tvSetup.useHere')}</span>
                  </button>
                ))}
              </div>
            )}
            {error && (
              <p role="alert" className="qd-setup-error">
                {error}
              </p>
            )}
          </>
        )}
        <div className="qd-setup-foot">
          <Button type="button" variant="ghost" onClick={() => void leave()}>
            <LogOut size={16} aria-hidden="true" />
            {t('tvSetup.cancel')}
          </Button>
        </div>
      </div>
    </div>
  )
}
